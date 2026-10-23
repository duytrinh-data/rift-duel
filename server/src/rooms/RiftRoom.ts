import crypto from 'crypto';
import colyseusPkg from 'colyseus';
import type { Client, Room as RoomType } from 'colyseus';
const { Room, ServerError } = colyseusPkg;
import {
  CharacterArchetype,
  FighterSimState,
  InputFrame,
  MatchPhase,
  SIM_CONFIG,
  SimulationWorld,
  createInitialFighterState,
  createSimulationWorld,
  sanitizeInput,
  startMatchCountdown,
  stepWorldTick,
} from '../../../shared/src/index.js';
import {
  CombatEventNetSchema,
  FighterNetSchema,
  RiftRoomState,
} from '../schema/RiftRoomState.js';

export interface RoomJoinOptions {
  mode?: 'create' | 'join';
  roomCode?: string;
  nickname?: string;
  archetype?: CharacterArchetype;
  playerToken?: string;
}

interface ClientRateMeta {
  windowStartMs: number;
  count: number;
  lastInputTick: number;
  playerToken: string;
}

// Active room code directory in RAM
export const activeRoomsByCode = new Map<string, RiftRoom>();
export const MAX_ACTIVE_ROOMS = 100;
const IDLE_LOBBY_TIMEOUT_TICKS = 10 * 60 * SIM_CONFIG.TICK_RATE; // 10 minutes

const tickLagSamples: number[] = [];
export function recordTickLagMs(lagMs: number): void {
  tickLagSamples.push(Math.max(0, lagMs));
  if (tickLagSamples.length > 300) {
    tickLagSamples.shift();
  }
}

export function getServerTickLagP95Ms(): number {
  if (tickLagSamples.length === 0) return 0;
  const sorted = [...tickLagSamples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return Number(sorted[idx].toFixed(2));
}

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateUniqueRoomCode(): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    if (!activeRoomsByCode.has(code)) {
      return code;
    }
  }
  return `RD${Math.floor(1000 + Math.random() * 9000)}`;
}

export class RiftRoom extends (Room as typeof RoomType<RiftRoomState>) {
  maxClients = 2;
  private world!: SimulationWorld;
  private latestInputs = new Map<string, InputFrame>();
  private consumedSeq = new Map<string, number>();
  private clientMeta = new Map<string, ClientRateMeta>();
  private tokenToSessionId = new Map<string, string>();
  private phaseBeforePause: MatchPhase = 'fighting';
  private idleLobbyTicks = 0;
  private lastSimTimeMs = Date.now();
  public roomCode: string = '';

  onCreate(options: RoomJoinOptions): void {
    if (activeRoomsByCode.size >= MAX_ACTIVE_ROOMS) {
      throw new ServerError(4002, 'SERVER_FULL: Máy chủ đã đạt giới hạn số phòng tối đa.');
    }

    this.setState(new RiftRoomState());
    this.world = createSimulationWorld();
    this.lastSimTimeMs = Date.now();

    // In production, always generate room code on server to prevent code squatting (P2-2)
    const allowCustomCode = process.env.NODE_ENV !== 'production';
    const requested = allowCustomCode
      ? options.roomCode?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
      : '';
    if (requested && requested.length >= 4 && requested.length <= 8 && !activeRoomsByCode.has(requested)) {
      this.roomCode = requested;
    } else {
      this.roomCode = generateUniqueRoomCode();
    }

    this.state.roomCode = this.roomCode;
    this.state.seed = Math.floor(Math.random() * 1_000_000_000);
    activeRoomsByCode.set(this.roomCode, this);

    // 30Hz state patch broadcast
    this.setPatchRate(Math.round(1000 / SIM_CONFIG.STATE_BROADCAST_HZ));

    // Fixed 60Hz authoritative simulation loop
    this.setSimulationInterval(() => this.updateSimulation(), 1000 / SIM_CONFIG.TICK_RATE);

    // Register message handlers
    this.onMessage('input', (client, payload: Partial<InputFrame>) => {
      this.handleInputMessage(client, payload);
    });

    this.onMessage('select_archetype', (client, payload: { archetype?: string }) => {
      const f = this.world.fighters.get(client.sessionId);
      const netF = this.state.fighters.get(client.sessionId);
      if (!f || !netF) return;
      if (this.world.phase !== 'waiting' && this.world.phase !== 'lobby') return;
      const arch: CharacterArchetype = payload?.archetype === 'reaver' ? 'reaver' : 'vanguard';
      f.archetype = arch;
      netF.archetype = arch;
    });

    this.onMessage('set_nickname', (client, payload: { nickname?: string }) => {
      const f = this.world.fighters.get(client.sessionId);
      const netF = this.state.fighters.get(client.sessionId);
      if (!f || !netF) return;
      const clean = (payload?.nickname ?? '').trim().slice(0, 16);
      if (clean) {
        f.nickname = clean;
        netF.nickname = clean;
      }
    });

    this.onMessage('assets_loaded', (client) => {
      const netF = this.state.fighters.get(client.sessionId);
      if (netF) {
        netF.assetsLoaded = true;
        this.checkStartCountdown();
      }
    });

    this.onMessage('set_ready', (client, payload: { ready?: boolean }) => {
      const f = this.world.fighters.get(client.sessionId);
      const netF = this.state.fighters.get(client.sessionId);
      if (!f || !netF) return;
      if (this.world.phase !== 'waiting' && this.world.phase !== 'lobby') return;
      const nextReady = typeof payload?.ready === 'boolean' ? payload.ready : !f.ready;
      f.ready = nextReady;
      netF.ready = nextReady;
      netF.assetsLoaded = true;
      this.checkStartCountdown();
    });

    this.onMessage('vote_rematch', (client) => {
      const f = this.world.fighters.get(client.sessionId);
      const netF = this.state.fighters.get(client.sessionId);
      if (!f || !netF) return;
      if (this.world.phase !== 'finished') return;

      f.rematchVote = true;
      netF.rematchVote = true;

      // If both players are connected and voted for rematch, reset & start countdown!
      const fighters = Array.from(this.world.fighters.values());
      if (fighters.length === 2 && fighters.every((p) => p.connected && p.rematchVote)) {
        for (const p of fighters) {
          p.ready = true;
          p.rematchVote = false;
          const nf = this.state.fighters.get(p.sessionId);
          if (nf) {
            nf.ready = true;
            nf.rematchVote = false;
          }
        }
        startMatchCountdown(this.world);
        this.syncWorldToNetState();
      }
    });

    this.onMessage('ping_check', (client, payload: { clientSentAt?: number }) => {
      client.send('pong_check', {
        clientSentAt: payload?.clientSentAt ?? Date.now(),
        serverTime: Date.now(),
      });
    });
  }

  onAuth(_client: Client, options: RoomJoinOptions): boolean {
    const token = (options?.playerToken ?? '').trim();
    if (token && this.tokenToSessionId.has(token)) {
      const prevSessionId = this.tokenToSessionId.get(token)!;
      const existingFighter = this.world.fighters.get(prevSessionId);
      if (existingFighter && !existingFighter.connected) {
        // Valid token reclaiming disconnected player slot
        return true;
      }
    }

    const connectedCount = Array.from(this.world.fighters.values()).filter((f) => f.connected).length;
    if (this.world.fighters.size >= 2 && connectedCount >= 2) {
      throw new ServerError(4001, 'ROOM_FULL: Phòng đấu đã đủ 2 người chơi.');
    }
    if (this.world.fighters.size >= 2 && connectedCount < 2) {
      // A slot is reserved for a disconnected player during the 15s grace window
      throw new ServerError(4001, 'ROOM_FULL: Phòng đấu đã đủ 2 người chơi (đang chờ kết nối lại).');
    }

    return true;
  }

  onJoin(client: Client, options: RoomJoinOptions): void {
    const rawToken = (options?.playerToken ?? '').trim();
    const token = rawToken.length >= 12 ? rawToken : crypto.randomUUID();
    client.send('assigned_token', { playerToken: token });

    // Check if this join is reclaiming a disconnected slot via playerToken
    if (this.tokenToSessionId.has(token)) {
      const oldSessionId = this.tokenToSessionId.get(token)!;
      const existingFighter = this.world.fighters.get(oldSessionId);
      const existingNet = this.state.fighters.get(oldSessionId);

      if (existingFighter && existingNet && !existingFighter.connected) {
        this.world.fighters.delete(oldSessionId);
        this.state.fighters.delete(oldSessionId);
        this.latestInputs.delete(oldSessionId);
        this.clientMeta.delete(oldSessionId);

        existingFighter.sessionId = client.sessionId;
        existingFighter.connected = true;
        existingNet.sessionId = client.sessionId;
        existingNet.connected = true;

        this.world.fighters.set(client.sessionId, existingFighter);
        this.state.fighters.set(client.sessionId, existingNet);
        this.tokenToSessionId.set(token, client.sessionId);
        this.clientMeta.set(client.sessionId, {
          windowStartMs: Date.now(),
          count: 0,
          lastInputTick: this.world.tick,
          playerToken: token,
        });

        if (this.world.phase === 'paused_disconnect') {
          this.world.phase = this.phaseBeforePause;
          this.world.disconnectGraceTicks = 0;
          this.world.disconnectedSlot = 0;
        }
        this.syncWorldToNetState();
        return;
      }
    }

    // Determine available slot (1 or 2)
    const usedSlots = new Set(Array.from(this.world.fighters.values()).map((f) => f.slot));
    const slot: 1 | 2 = usedSlots.has(1) ? 2 : 1;
    const defaultArch: CharacterArchetype = slot === 1 ? 'vanguard' : 'reaver';
    const arch: CharacterArchetype =
      options.archetype === 'vanguard' || options.archetype === 'reaver'
        ? options.archetype
        : defaultArch;
    const nickname = (options.nickname ?? '').trim().slice(0, 16) || `Đấu sĩ ${slot}`;

    const simFighter = createInitialFighterState(client.sessionId, slot, nickname, arch);
    this.world.fighters.set(client.sessionId, simFighter);

    const netFighter = new FighterNetSchema();
    netFighter.sessionId = client.sessionId;
    netFighter.slot = slot;
    netFighter.nickname = simFighter.nickname;
    netFighter.archetype = simFighter.archetype;
    netFighter.assetsLoaded = true;
    this.state.fighters.set(client.sessionId, netFighter);

    this.tokenToSessionId.set(token, client.sessionId);
    this.clientMeta.set(client.sessionId, {
      windowStartMs: Date.now(),
      count: 0,
      lastInputTick: this.world.tick,
      playerToken: token,
    });

    if (this.world.fighters.size === 2 && this.world.phase === 'waiting') {
      this.world.phase = 'lobby';
    }
    this.syncWorldToNetState();
  }

  async onLeave(client: Client, consented: boolean): Promise<void> {
    const fighter = this.world.fighters.get(client.sessionId);
    const netFighter = this.state.fighters.get(client.sessionId);
    if (!fighter || !netFighter) return;

    fighter.connected = false;
    netFighter.connected = false;
    // Neutralize any held input on disconnect
    this.latestInputs.delete(client.sessionId);

    // If the player intentionally left during waiting/lobby, remove them immediately
    if (consented && (this.world.phase === 'waiting' || this.world.phase === 'lobby')) {
      this.removePlayerCompletely(client.sessionId);
      return;
    }

    // During an active match or countdown or unconsented drop, pause and grant 15s reconnection grace period
    const wasInMatch =
      this.world.phase === 'fighting' ||
      this.world.phase === 'countdown';

    if (wasInMatch) {
      this.phaseBeforePause = this.world.phase;
      this.world.phase = 'paused_disconnect';
      this.world.disconnectGraceTicks = SIM_CONFIG.DISCONNECT_GRACE_TICKS;
      this.world.disconnectedSlot = fighter.slot;
      this.syncWorldToNetState();
    }

    try {
      await this.allowReconnection(client, SIM_CONFIG.DISCONNECT_GRACE_SECONDS);
      // Reconnected via Colyseus native reconnection token!
      const currentFighter = this.world.fighters.get(client.sessionId);
      const currentNet = this.state.fighters.get(client.sessionId);
      if (currentFighter && currentNet) {
        currentFighter.connected = true;
        currentNet.connected = true;
        if (this.world.phase === 'paused_disconnect') {
          this.world.phase = this.phaseBeforePause;
          this.world.disconnectGraceTicks = 0;
          this.world.disconnectedSlot = 0;
        }
        this.syncWorldToNetState();
      }
    } catch {
      // Did not reconnect via native Colyseus token within 15s.
      // Check if they already reclaimed the slot via token in onJoin:
      const stillDisconnected = this.world.fighters.get(client.sessionId);
      if (!stillDisconnected || stillDisconnected.connected) {
        return;
      }

      if (this.world.phase === 'paused_disconnect') {
        // Award FORFEIT to remaining connected player
        let remainingSlot: 0 | 1 | 2 = 0;
        for (const f of this.world.fighters.values()) {
          if (f.connected && f.sessionId !== client.sessionId) {
            remainingSlot = f.slot;
          }
        }
        this.world.phase = 'finished';
        this.world.winnerSlot = remainingSlot;
        this.world.winReason = 'FORFEIT';
      }
      this.removePlayerCompletely(client.sessionId);
    }
  }

  onDispose(): void {
    if (this.roomCode && activeRoomsByCode.get(this.roomCode) === this) {
      activeRoomsByCode.delete(this.roomCode);
    }
  }

  private removePlayerCompletely(sessionId: string): void {
    const meta = this.clientMeta.get(sessionId);
    if (meta?.playerToken) {
      this.tokenToSessionId.delete(meta.playerToken);
    }
    this.clientMeta.delete(sessionId);
    this.latestInputs.delete(sessionId);
    this.world.fighters.delete(sessionId);
    this.state.fighters.delete(sessionId);

    if (this.world.fighters.size < 2 && this.world.phase === 'lobby') {
      this.world.phase = 'waiting';
      for (const f of this.world.fighters.values()) {
        f.ready = false;
        const nf = this.state.fighters.get(f.sessionId);
        if (nf) nf.ready = false;
      }
    }
    this.syncWorldToNetState();
  }

  private checkStartCountdown(): void {
    if (this.world.phase !== 'waiting' && this.world.phase !== 'lobby') return;
    if (this.world.fighters.size !== 2) return;

    const allReady = Array.from(this.world.fighters.values()).every((f) => {
      const nf = this.state.fighters.get(f.sessionId);
      return f.connected && f.ready && (nf?.assetsLoaded ?? true);
    });

    if (allReady) {
      startMatchCountdown(this.world);
      this.syncWorldToNetState();
    }
  }

  private handleInputMessage(client: Client, payload: Partial<InputFrame>): void {
    const fighter = this.world.fighters.get(client.sessionId);
    if (!fighter || !fighter.connected) return;

    const now = Date.now();
    let meta = this.clientMeta.get(client.sessionId);
    if (!meta) {
      meta = {
        windowStartMs: now,
        count: 0,
        lastInputTick: this.world.tick,
        playerToken: '',
      };
      this.clientMeta.set(client.sessionId, meta);
    }

    // Rate limiting: max 120 inputs/sec
    if (now - meta.windowStartMs > 1000) {
      meta.windowStartMs = now;
      meta.count = 0;
    }
    meta.count++;
    if (meta.count > 120) {
      return;
    }

    const sanitized = sanitizeInput(payload);
    const prev = this.latestInputs.get(client.sessionId);
    if (prev && sanitized.seq < prev.seq) {
      return; // Ignore out-of-order stale packet
    }

    // Preserve unconsumed edge-triggered button presses if multiple packets arrive in the same server tick
    const lastConsumed = this.consumedSeq.get(client.sessionId) ?? 0;
    if (prev && prev.seq > lastConsumed) {
      sanitized.jumpPressed = sanitized.jumpPressed || prev.jumpPressed;
      sanitized.dodgePressed = sanitized.dodgePressed || prev.dodgePressed;
      sanitized.lightPressed = sanitized.lightPressed || prev.lightPressed;
      sanitized.heavyPressed = sanitized.heavyPressed || prev.heavyPressed;
      sanitized.recoveryPressed = sanitized.recoveryPressed || prev.recoveryPressed;
      sanitized.weaponPressed = sanitized.weaponPressed || prev.weaponPressed;
    }

    meta.lastInputTick = this.world.tick;
    this.latestInputs.set(client.sessionId, sanitized);
  }

  private updateSimulation(): void {
    const nowMs = Date.now();
    const expectedMs = 1000 / SIM_CONFIG.TICK_RATE;
    const lagMs = Math.max(0, nowMs - this.lastSimTimeMs - expectedMs);
    this.lastSimTimeMs = nowMs;
    recordTickLagMs(lagMs);

    // Auto-dispose idle waiting/lobby rooms after 10 minutes (P2-2)
    if (this.world.phase === 'waiting' || this.world.phase === 'lobby') {
      this.idleLobbyTicks++;
      if (this.idleLobbyTicks > IDLE_LOBBY_TIMEOUT_TICKS) {
        void this.disconnect();
        return;
      }
    } else {
      this.idleLobbyTicks = 0;
    }

    // Neutralize stale inputs if a client hasn't sent an update in >15 ticks (250ms)
    for (const [sessionId, meta] of this.clientMeta.entries()) {
      const silentTicks = this.world.tick - meta.lastInputTick;
      if (silentTicks > 15) {
        const last = this.latestInputs.get(sessionId);
        if (last) {
          this.latestInputs.set(sessionId, {
            seq: last.seq,
            moveX: 0,
            moveZ: 0,
            jumpPressed: false,
            dodgePressed: false,
            lightPressed: false,
            heavyPressed: false,
            recoveryPressed: false,
            weaponPressed: false,
          });
        }
      }
    }

    stepWorldTick(this.world, this.latestInputs);

    for (const [sid, inp] of this.latestInputs.entries()) {
      this.consumedSeq.set(sid, inp.seq);
    }

    this.syncWorldToNetState();
  }

  private syncWorldToNetState(): void {
    this.state.serverTick = this.world.tick;
    this.state.phase = this.world.phase;
    this.state.countdownTicks = this.world.countdownTicks;
    this.state.timerTicks = this.world.timerTicks;
    this.state.winnerSlot = this.world.winnerSlot;
    this.state.winReason = this.world.winReason;
    this.state.disconnectGraceTicks = this.world.disconnectGraceTicks;
    this.state.disconnectedSlot = this.world.disconnectedSlot;

    for (const [sessionId, simF] of this.world.fighters.entries()) {
      let netF = this.state.fighters.get(sessionId);
      if (!netF) {
        netF = new FighterNetSchema();
        netF.sessionId = sessionId;
        this.state.fighters.set(sessionId, netF);
      }
      netF.slot = simF.slot;
      netF.nickname = simF.nickname;
      netF.archetype = simF.archetype;
      netF.ready = simF.ready;
      netF.rematchVote = simF.rematchVote;
      netF.connected = simF.connected;

      netF.x = simF.x;
      netF.y = simF.y;
      netF.z = simF.z;
      netF.vx = simF.vx;
      netF.vy = simF.vy;
      netF.vz = simF.vz;
      netF.facingAngle = simF.facingAngle;

      netF.grounded = simF.grounded;
      netF.groundJumpsLeft = simF.groundJumpsLeft;
      netF.airJumpsLeft = simF.airJumpsLeft;
      netF.airRecoveriesLeft = simF.airRecoveriesLeft;
      netF.coyoteTicks = simF.coyoteTicks;
      netF.jumpBufferTicks = simF.jumpBufferTicks;

      netF.stocks = simF.stocks;
      netF.damage = simF.damage;
      netF.state = simF.state;
      netF.stateTicks = simF.stateTicks;
      netF.activeAttackId = simF.activeAttackId;
      netF.attackInstanceId = simF.attackInstanceId;
      netF.attackCooldownTicks = simF.attackCooldownTicks;
      netF.dodgeCooldownTicks = simF.dodgeCooldownTicks;
      netF.dodgeDirX = simF.dodgeDirX;
      netF.dodgeDirZ = simF.dodgeDirZ;
      netF.hitstopTicks = simF.hitstopTicks;
      netF.invulnerableTicks = simF.invulnerableTicks;
      netF.hasWeapon = simF.hasWeapon;
      netF.weaponDurability = simF.weaponDurability;
      netF.lastProcessedInputSeq = simF.lastProcessedInputSeq;
    }

    const w = this.world.weapon;
    this.state.weapon.id = w.id;
    this.state.weapon.status = w.status;
    this.state.weapon.holderSlot = w.holderSlot;
    this.state.weapon.throwerSlot = w.throwerSlot;
    this.state.weapon.x = w.x;
    this.state.weapon.y = w.y;
    this.state.weapon.z = w.z;
    this.state.weapon.vx = w.vx;
    this.state.weapon.vy = w.vy;
    this.state.weapon.vz = w.vz;
    this.state.weapon.rotationY = w.rotationY;

    // Sync recent combat events (keep last 8 in schema array so bandwidth stays tiny)
    const recentEvents = this.world.events.slice(-8);
    while (this.state.events.length > recentEvents.length) {
      this.state.events.shift();
    }
    for (let i = 0; i < recentEvents.length; i++) {
      const src = recentEvents[i];
      let targetEvt = this.state.events[i];
      if (!targetEvt) {
        targetEvt = new CombatEventNetSchema();
        this.state.events.push(targetEvt);
      }
      targetEvt.eventId = src.eventId;
      targetEvt.type = src.type;
      targetEvt.tick = src.tick;
      targetEvt.sourceSlot = src.sourceSlot;
      targetEvt.targetSlot = src.targetSlot;
      targetEvt.x = src.x;
      targetEvt.y = src.y;
      targetEvt.z = src.z;
      targetEvt.damageDealt = src.damageDealt;
      targetEvt.knockbackSpeed = src.knockbackSpeed;
    }
  }

  public getRoomStatusInfo(playerToken?: string): {
    roomId: string;
    roomCode: string;
    playerCount: number;
    canJoin: boolean;
    reason?: 'ROOM_FULL';
  } {
    const token = (playerToken ?? '').trim();
    if (token && this.tokenToSessionId.has(token)) {
      const sid = this.tokenToSessionId.get(token)!;
      const f = this.world.fighters.get(sid);
      if (f && !f.connected) {
        return {
          roomId: this.roomId,
          roomCode: this.roomCode,
          playerCount: this.world.fighters.size,
          canJoin: true,
        };
      }
    }

    const isFull = this.world.fighters.size >= 2;
    return {
      roomId: this.roomId,
      roomCode: this.roomCode,
      playerCount: this.world.fighters.size,
      canJoin: !isFull,
      reason: isFull ? 'ROOM_FULL' : undefined,
    };
  }
}
