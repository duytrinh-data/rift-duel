import Peer, { DataConnection } from 'peerjs';
import {
  CharacterArchetype,
  InputFrame,
  SIM_CONFIG,
  SimulationWorld,
  createInitialFighterState,
  createSimulationWorld,
  sanitizeInput,
  startMatchCountdown,
  stepWorldTick,
} from '@shared/index.js';

const PEER_PREFIX = 'riftduel-v1-room-';
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomRoomCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

export interface RoomLike {
  sessionId: string;
  reconnectionToken?: string;
  state: Record<string, unknown>;
  send(type: string, payload?: unknown): void;
  leave(consented?: boolean): Promise<void>;
  onMessage(type: string, cb: (payload: any) => void): void;
  onStateChange: {
    (cb: (state: any) => void): void;
    once(cb: (state: any) => void): void;
  };
  onError(cb: (code: number, message?: string) => void): void;
  onLeave(cb: (code: number) => void): void;
}

interface SerializedNetState {
  roomCode: string;
  phase: string;
  serverTick: number;
  countdownTicks: number;
  timerTicks: number;
  winnerSlot: number;
  winReason: string;
  disconnectGraceTicks: number;
  disconnectedSlot: number;
  fighters: Array<[string, Record<string, unknown>]>;
  weapon: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
}

function hydrateState(raw: SerializedNetState): Record<string, unknown> {
  return {
    roomCode: raw.roomCode,
    phase: raw.phase,
    serverTick: raw.serverTick,
    countdownTicks: raw.countdownTicks,
    timerTicks: raw.timerTicks,
    winnerSlot: raw.winnerSlot,
    winReason: raw.winReason,
    disconnectGraceTicks: raw.disconnectGraceTicks,
    disconnectedSlot: raw.disconnectedSlot,
    fighters: new Map(raw.fighters),
    weapon: raw.weapon,
    events: raw.events,
  };
}

abstract class BasePeerRoom implements RoomLike {
  public sessionId: string;
  public state: Record<string, unknown> = {};
  protected msgHandlers = new Map<string, Array<(payload: any) => void>>();
  protected stateListeners: Array<(state: any) => void> = [];
  protected onceStateListeners: Array<(state: any) => void> = [];
  protected errorListeners: Array<(code: number, message?: string) => void> = [];
  protected leaveListeners: Array<(code: number) => void> = [];

  public onStateChange: RoomLike['onStateChange'];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    const fn = ((cb: (state: any) => void) => {
      this.stateListeners.push(cb);
    }) as RoomLike['onStateChange'];
    fn.once = (cb: (state: any) => void) => {
      this.onceStateListeners.push(cb);
    };
    this.onStateChange = fn;
  }

  public onMessage(type: string, cb: (payload: any) => void): void {
    const arr = this.msgHandlers.get(type) ?? [];
    arr.push(cb);
    this.msgHandlers.set(type, arr);
  }

  public onError(cb: (code: number, message?: string) => void): void {
    this.errorListeners.push(cb);
  }

  public onLeave(cb: (code: number) => void): void {
    this.leaveListeners.push(cb);
  }

  protected emitLocalMessage(type: string, payload: unknown): void {
    const arr = this.msgHandlers.get(type);
    if (arr) {
      for (const cb of arr) cb(payload);
    }
  }

  protected emitStateChange(hydrated: Record<string, unknown>): void {
    this.state = hydrated;
    while (this.onceStateListeners.length > 0) {
      const cb = this.onceStateListeners.shift();
      cb?.(this.state);
    }
    for (const cb of this.stateListeners) {
      cb(this.state);
    }
  }

  protected emitError(code: number, message?: string): void {
    for (const cb of this.errorListeners) cb(code, message);
  }

  protected emitLeave(code: number): void {
    for (const cb of this.leaveListeners) cb(code);
  }

  public abstract send(type: string, payload?: unknown): void;
  public abstract leave(consented?: boolean): Promise<void>;
}

/**
 * Authoritative 60Hz Host Room running directly in Player 1's browser over WebRTC (PeerJS)
 * when deployed to static hosts like Netlify Drop without a separate Render backend.
 */
export class PeerHostRoom extends BasePeerRoom {
  private peer: Peer | null = null;
  private world: SimulationWorld;
  private roomCode: string;
  private latestInputs = new Map<string, InputFrame>();
  private consumedSeq = new Map<string, number>();
  private lastInputTick = new Map<string, number>();
  private tokenToSessionId = new Map<string, string>();
  private guestConnections = new Map<string, DataConnection>();
  private simIntervalId: number | null = null;
  private disconnectTimeoutId: number | null = null;

  constructor(roomCode: string, nickname: string, archetype: CharacterArchetype, playerToken: string) {
    super('host_p1');
    this.roomCode = roomCode;
    this.world = createSimulationWorld();

    const cleanNick = nickname.trim().slice(0, 16) || 'Đấu sĩ 1';
    const p1 = createInitialFighterState(this.sessionId, 1, cleanNick, archetype);
    this.world.fighters.set(this.sessionId, p1);
    this.tokenToSessionId.set(playerToken, this.sessionId);
    this.lastInputTick.set(this.sessionId, 0);
  }

  public async startHost(): Promise<void> {
    return new Promise((resolve, reject) => {
      const peerId = `${PEER_PREFIX}${this.roomCode}`;
      const peer = new Peer(peerId);
      this.peer = peer;

      const timeout = window.setTimeout(() => {
        peer.destroy();
        reject(new Error('TIMEOUT: Không thể khởi tạo phòng trực tuyến.'));
      }, 9000);

      peer.on('open', () => {
        window.clearTimeout(timeout);
        this.syncAndBroadcastState();
        this.simIntervalId = window.setInterval(
          () => this.stepTick(),
          1000 / SIM_CONFIG.TICK_RATE
        );
        resolve();
      });

      peer.on('connection', (conn) => {
        this.handleIncomingGuest(conn);
      });

      peer.on('error', (err: any) => {
        window.clearTimeout(timeout);
        if (err?.type === 'unavailable-id') {
          reject(new Error('CODE_TAKEN: Mã phòng này đang được sử dụng.'));
        } else {
          reject(new Error(`PEER_ERROR: ${err?.message || 'Lỗi kết nối P2P'}`));
        }
      });
    });
  }

  private handleIncomingGuest(conn: DataConnection): void {
    conn.on('open', () => {
      const meta = (conn.metadata || {}) as {
        nickname?: string;
        archetype?: CharacterArchetype;
        playerToken?: string;
      };
      const token = (meta.playerToken || '').trim() || `tok_${conn.peer}`;
      const guestSid = `guest_${conn.peer.slice(0, 8)}`;

      // Reclaim disconnected slot if matching token
      const existingSid = this.tokenToSessionId.get(token);
      if (existingSid && existingSid !== this.sessionId) {
        const existingFighter = this.world.fighters.get(existingSid);
        if (existingFighter && !existingFighter.connected) {
          this.world.fighters.delete(existingSid);
          this.latestInputs.delete(existingSid);
          existingFighter.sessionId = guestSid;
          existingFighter.connected = true;
          this.world.fighters.set(guestSid, existingFighter);
          this.tokenToSessionId.set(token, guestSid);
          this.guestConnections.set(guestSid, conn);
          this.lastInputTick.set(guestSid, this.world.tick);

          if (this.disconnectTimeoutId !== null) {
            window.clearTimeout(this.disconnectTimeoutId);
            this.disconnectTimeoutId = null;
          }
          if (this.world.phase === 'paused_disconnect') {
            this.world.phase = 'fighting';
            this.world.disconnectGraceTicks = 0;
            this.world.disconnectedSlot = 0;
          }
          conn.send({ type: 'welcome', sessionId: guestSid, state: this.serializeWorld() });
          this.attachGuestHandlers(guestSid, conn);
          this.syncAndBroadcastState();
          return;
        }
      }

      if (this.world.fighters.size >= 2) {
        conn.send({
          type: 'error',
          code: 4001,
          message: 'ROOM_FULL: Phòng đấu đã đủ 2 người chơi.',
        });
        window.setTimeout(() => conn.close(), 250);
        return;
      }

      const arch: CharacterArchetype = meta.archetype === 'reaver' ? 'reaver' : 'vanguard';
      const nick = (meta.nickname || '').trim().slice(0, 16) || 'Đấu sĩ 2';
      const simF = createInitialFighterState(guestSid, 2, nick, arch);
      this.world.fighters.set(guestSid, simF);
      this.tokenToSessionId.set(token, guestSid);
      this.guestConnections.set(guestSid, conn);
      this.lastInputTick.set(guestSid, this.world.tick);

      if (this.world.fighters.size === 2 && this.world.phase === 'waiting') {
        this.world.phase = 'lobby';
      }

      conn.send({ type: 'welcome', sessionId: guestSid, state: this.serializeWorld() });
      this.attachGuestHandlers(guestSid, conn);
      this.syncAndBroadcastState();
    });
  }

  private attachGuestHandlers(guestSid: string, conn: DataConnection): void {
    conn.on('data', (raw: any) => {
      if (!raw || typeof raw !== 'object') return;
      this.handleClientCommand(guestSid, String(raw.type || ''), raw.payload, conn);
    });

    conn.on('close', () => {
      this.handleGuestDisconnect(guestSid);
    });

    conn.on('error', () => {
      this.handleGuestDisconnect(guestSid);
    });
  }

  private handleGuestDisconnect(guestSid: string): void {
    this.guestConnections.delete(guestSid);
    this.latestInputs.delete(guestSid);
    const fighter = this.world.fighters.get(guestSid);
    if (!fighter) return;

    fighter.connected = false;
    if (this.world.phase === 'waiting' || this.world.phase === 'lobby') {
      this.world.fighters.delete(guestSid);
      this.world.phase = 'waiting';
      for (const f of this.world.fighters.values()) {
        f.ready = false;
      }
      this.syncAndBroadcastState();
      return;
    }

    if (this.world.phase === 'fighting' || this.world.phase === 'countdown') {
      this.world.phase = 'paused_disconnect';
      this.world.disconnectGraceTicks = SIM_CONFIG.DISCONNECT_GRACE_TICKS;
      this.world.disconnectedSlot = fighter.slot;
      this.syncAndBroadcastState();

      if (this.disconnectTimeoutId !== null) {
        window.clearTimeout(this.disconnectTimeoutId);
      }
      this.disconnectTimeoutId = window.setTimeout(() => {
        const stillThere = this.world.fighters.get(guestSid);
        if (stillThere && !stillThere.connected && this.world.phase === 'paused_disconnect') {
          this.world.phase = 'finished';
          this.world.winnerSlot = 1;
          this.world.winReason = 'FORFEIT';
          this.world.fighters.delete(guestSid);
          this.syncAndBroadcastState();
        }
      }, SIM_CONFIG.DISCONNECT_GRACE_SECONDS * 1000);
    }
  }

  private handleClientCommand(
    sid: string,
    type: string,
    payload: any,
    conn?: DataConnection
  ): void {
    const f = this.world.fighters.get(sid);
    if (!f) return;

    switch (type) {
      case 'input': {
        const sanitized = sanitizeInput(payload || {});
        const prev = this.latestInputs.get(sid);
        if (prev && sanitized.seq < prev.seq) return;
        const lastConsumed = this.consumedSeq.get(sid) ?? 0;
        if (prev && prev.seq > lastConsumed) {
          sanitized.jumpPressed = sanitized.jumpPressed || prev.jumpPressed;
          sanitized.dodgePressed = sanitized.dodgePressed || prev.dodgePressed;
          sanitized.lightPressed = sanitized.lightPressed || prev.lightPressed;
          sanitized.heavyPressed = sanitized.heavyPressed || prev.heavyPressed;
          sanitized.recoveryPressed = sanitized.recoveryPressed || prev.recoveryPressed;
          sanitized.weaponPressed = sanitized.weaponPressed || prev.weaponPressed;
        }
        this.lastInputTick.set(sid, this.world.tick);
        this.latestInputs.set(sid, sanitized);
        break;
      }
      case 'select_archetype': {
        if (this.world.phase !== 'waiting' && this.world.phase !== 'lobby') return;
        f.archetype = payload?.archetype === 'reaver' ? 'reaver' : 'vanguard';
        this.syncAndBroadcastState();
        break;
      }
      case 'set_nickname': {
        const clean = String(payload?.nickname ?? '').trim().slice(0, 16);
        if (clean) {
          f.nickname = clean;
          this.syncAndBroadcastState();
        }
        break;
      }
      case 'set_ready': {
        if (this.world.phase !== 'waiting' && this.world.phase !== 'lobby') return;
        f.ready = typeof payload?.ready === 'boolean' ? payload.ready : !f.ready;
        this.checkStartCountdown();
        this.syncAndBroadcastState();
        break;
      }
      case 'vote_rematch': {
        if (this.world.phase !== 'finished') return;
        f.rematchVote = true;
        const fighters = Array.from(this.world.fighters.values());
        if (fighters.length === 2 && fighters.every((p) => p.connected && p.rematchVote)) {
          for (const p of fighters) {
            p.ready = true;
            p.rematchVote = false;
          }
          startMatchCountdown(this.world);
        }
        this.syncAndBroadcastState();
        break;
      }
      case 'ping_check': {
        const pong = {
          clientSentAt: payload?.clientSentAt ?? Date.now(),
          serverTime: Date.now(),
        };
        if (sid === this.sessionId) {
          this.emitLocalMessage('pong_check', pong);
        } else {
          conn?.send({ type: 'msg', msgType: 'pong_check', payload: pong });
        }
        break;
      }
    }
  }

  private checkStartCountdown(): void {
    if (this.world.phase !== 'waiting' && this.world.phase !== 'lobby') return;
    if (this.world.fighters.size !== 2) return;
    const allReady = Array.from(this.world.fighters.values()).every((f) => f.connected && f.ready);
    if (allReady) {
      startMatchCountdown(this.world);
    }
  }

  private stepTick(): void {
    for (const [sid, lastTick] of this.lastInputTick.entries()) {
      if (this.world.tick - lastTick > 15) {
        const last = this.latestInputs.get(sid);
        if (last) {
          this.latestInputs.set(sid, {
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

    // Broadcast at 30Hz (every 2 ticks)
    if (this.world.tick % 2 === 0) {
      this.syncAndBroadcastState();
    }
  }

  private serializeWorld(): SerializedNetState {
    const fighters: Array<[string, Record<string, unknown>]> = [];
    for (const [sid, simF] of this.world.fighters.entries()) {
      fighters.push([
        sid,
        {
          sessionId: sid,
          slot: simF.slot,
          nickname: simF.nickname,
          archetype: simF.archetype,
          ready: simF.ready,
          rematchVote: simF.rematchVote,
          connected: simF.connected,
          x: simF.x,
          y: simF.y,
          z: simF.z,
          vx: simF.vx,
          vy: simF.vy,
          vz: simF.vz,
          facingAngle: simF.facingAngle,
          grounded: simF.grounded,
          groundJumpsLeft: simF.groundJumpsLeft,
          airJumpsLeft: simF.airJumpsLeft,
          airRecoveriesLeft: simF.airRecoveriesLeft,
          stocks: simF.stocks,
          damage: simF.damage,
          state: simF.state,
          stateTicks: simF.stateTicks,
          activeAttackId: simF.activeAttackId,
          invulnerableTicks: simF.invulnerableTicks,
          hasWeapon: simF.hasWeapon,
          lastProcessedInputSeq: simF.lastProcessedInputSeq,
        },
      ]);
    }

    const w = this.world.weapon;
    return {
      roomCode: this.roomCode,
      phase: this.world.phase,
      serverTick: this.world.tick,
      countdownTicks: this.world.countdownTicks,
      timerTicks: this.world.timerTicks,
      winnerSlot: this.world.winnerSlot,
      winReason: this.world.winReason,
      disconnectGraceTicks: this.world.disconnectGraceTicks,
      disconnectedSlot: this.world.disconnectedSlot,
      fighters,
      weapon: {
        id: w.id,
        status: w.status,
        holderSlot: w.holderSlot,
        throwerSlot: w.throwerSlot,
        x: w.x,
        y: w.y,
        z: w.z,
        vx: w.vx,
        vy: w.vy,
        vz: w.vz,
        rotationY: w.rotationY,
      },
      events: this.world.events.slice(-8).map((e) => ({ ...e })),
    };
  }

  private syncAndBroadcastState(): void {
    const serialized = this.serializeWorld();
    const hydrated = hydrateState(serialized);
    this.emitStateChange(hydrated);

    for (const conn of this.guestConnections.values()) {
      if (conn.open) {
        conn.send({ type: 'state', state: serialized });
      }
    }
  }

  public send(type: string, payload?: unknown): void {
    this.handleClientCommand(this.sessionId, type, payload);
  }

  public async leave(): Promise<void> {
    if (this.simIntervalId !== null) {
      window.clearInterval(this.simIntervalId);
      this.simIntervalId = null;
    }
    if (this.disconnectTimeoutId !== null) {
      window.clearTimeout(this.disconnectTimeoutId);
      this.disconnectTimeoutId = null;
    }
    for (const conn of this.guestConnections.values()) {
      try {
        conn.close();
      } catch {
        // Ignore
      }
    }
    this.guestConnections.clear();
    try {
      this.peer?.destroy();
    } catch {
      // Ignore
    }
    this.peer = null;
    this.emitLeave(1000);
  }
}

/**
 * WebRTC Client Room for Player 2 joining Player 1's room code via PeerJS.
 */
export class PeerGuestRoom extends BasePeerRoom {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private roomCode: string;

  constructor(roomCode: string) {
    super('guest_pending');
    this.roomCode = roomCode;
  }

  public async connectToHost(
    nickname: string,
    archetype: CharacterArchetype,
    playerToken: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const peer = new Peer();
      this.peer = peer;
      let settled = false;

      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        peer.destroy();
        reject(new Error('ROOM_NOT_FOUND: Không tìm thấy phòng đấu hoặc chủ phòng đã thoát.'));
      }, 9000);

      peer.on('open', () => {
        const hostPeerId = `${PEER_PREFIX}${this.roomCode}`;
        const conn = peer.connect(hostPeerId, {
          reliable: true,
          metadata: { nickname, archetype, playerToken },
        });
        this.conn = conn;

        conn.on('data', (raw: any) => {
          if (!raw || typeof raw !== 'object') return;
          if (raw.type === 'error') {
            if (!settled) {
              settled = true;
              window.clearTimeout(timeout);
              peer.destroy();
              reject(new Error(String(raw.message || 'ROOM_FULL: Phòng đã đầy.')));
            } else {
              this.emitError(Number(raw.code || 4000), String(raw.message || 'Lỗi phòng đấu'));
            }
            return;
          }

          if (raw.type === 'welcome') {
            this.sessionId = String(raw.sessionId || 'guest_p2');
            if (raw.state) {
              this.emitStateChange(hydrateState(raw.state as SerializedNetState));
            }
            if (!settled) {
              settled = true;
              window.clearTimeout(timeout);
              resolve();
            }
            return;
          }

          if (raw.type === 'state' && raw.state) {
            this.emitStateChange(hydrateState(raw.state as SerializedNetState));
            return;
          }

          if (raw.type === 'msg' && raw.msgType) {
            this.emitLocalMessage(String(raw.msgType), raw.payload);
          }
        });

        conn.on('close', () => {
          if (!settled) {
            settled = true;
            window.clearTimeout(timeout);
            reject(new Error('CONNECTION_CLOSED: Kết nối tới chủ phòng bị đóng.'));
          } else {
            this.emitLeave(1006);
          }
        });
      });

      peer.on('error', (err: any) => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timeout);
          if (err?.type === 'peer-unavailable') {
            reject(new Error('ROOM_NOT_FOUND: Mã phòng không tồn tại hoặc đã đóng.'));
          } else {
            reject(new Error(`PEER_ERROR: ${err?.message || 'Không thể kết nối phòng đấu.'}`));
          }
        }
      });
    });
  }

  public send(type: string, payload?: unknown): void {
    if (this.conn?.open) {
      this.conn.send({ type, payload });
    }
  }

  public async leave(): Promise<void> {
    try {
      this.conn?.close();
    } catch {
      // Ignore
    }
    try {
      this.peer?.destroy();
    } catch {
      // Ignore
    }
    this.conn = null;
    this.peer = null;
    this.emitLeave(1000);
  }
}

export function generateP2PRoomCode(customCode?: string): string {
  const clean = (customCode || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length >= 4 && clean.length <= 8) return clean;
  return randomRoomCode();
}
