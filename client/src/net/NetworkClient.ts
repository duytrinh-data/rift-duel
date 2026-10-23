import * as Colyseus from 'colyseus.js';
import {
  AttackId,
  CharacterArchetype,
  CombatEvent,
  CombatEventType,
  FighterSimState,
  InputFrame,
  MatchPhase,
  SIM_CONFIG,
  WinReason,
  canFighterStartAction,
  chooseAttackId,
  createInitialFighterState,
  stepFighterKinematicMovement,
} from '@shared/index.js';
import { FighterRenderInput } from '../render/FighterVisual.js';

export type ConnectionStatus =
  | 'idle'
  | 'waking_server'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

interface PendingInput {
  frame: InputFrame;
  jumpEdge: boolean;
}

interface VisualActionOverride {
  state: string;
  activeAttackId: string;
  attackInstanceId: number;
  expiresAtMs: number;
}

interface RemoteSnapshot {
  serverTick: number;
  timestamp: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  facingAngle: number;
  grounded: boolean;
  state: string;
  activeAttackId: string;
  attackInstanceId: number;
  hasWeapon: boolean;
  invulnerableTicks: number;
  damage: number;
}

export interface RoomViewSummary {
  roomCode: string;
  phase: MatchPhase;
  serverTick: number;
  countdownSeconds: number;
  timerSeconds: number;
  winnerSlot: 0 | 1 | 2;
  winReason: WinReason;
  disconnectGraceSeconds: number;
  disconnectedSlot: 0 | 1 | 2;
  mySessionId: string;
  mySlot: 0 | 1 | 2;
  fighters: Array<{
    sessionId: string;
    slot: 1 | 2;
    nickname: string;
    archetype: CharacterArchetype;
    ready: boolean;
    rematchVote: boolean;
    connected: boolean;
    stocks: number;
    damage: number;
    hasWeapon: boolean;
    x: number;
    y: number;
    z: number;
    state: string;
  }>;
}

function generateSecurePlayerToken(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const hex = Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `pt_${hex}`;
    }
  } catch {
    // Fallback for test environments without Web Crypto
  }
  return `pt_${Math.random().toString(36).slice(2, 12)}_${Date.now().toString(36)}`;
}

function normalizeEndpointUrl(raw: string): { wsUrl: string; httpUrl: string } {
  const clean = raw.trim().replace(/\/+$/, '');
  if (clean.startsWith('wss://')) {
    return { wsUrl: clean, httpUrl: clean.replace(/^wss:\/\//, 'https://') };
  }
  if (clean.startsWith('ws://')) {
    return { wsUrl: clean, httpUrl: clean.replace(/^ws:\/\//, 'http://') };
  }
  if (clean.startsWith('https://')) {
    return { wsUrl: clean.replace(/^https:\/\//, 'wss://'), httpUrl: clean };
  }
  if (clean.startsWith('http://')) {
    return { wsUrl: clean.replace(/^http:\/\//, 'ws://'), httpUrl: clean };
  }
  return { wsUrl: `wss://${clean}`, httpUrl: `https://${clean}` };
}

function resolveServerUrls(): { wsUrl: string; httpUrl: string } {
  // P2-4: Only allow ?server= override in DEV mode, and never persist to localStorage
  const isDev = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  if (isDev && typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const queryServer = params.get('server')?.trim();
    if (queryServer) {
      return normalizeEndpointUrl(queryServer);
    }
  }

  if (typeof localStorage !== 'undefined') {
    const savedServer = localStorage.getItem('rift_duel_server_url')?.trim();
    if (savedServer && isDev) {
      return normalizeEndpointUrl(savedServer);
    }
  }

  const envUrl = (
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env
      ?.VITE_GAME_SERVER_URL
  )?.trim();
  if (envUrl) {
    return normalizeEndpointUrl(envUrl);
  }

  const host = typeof window !== 'undefined' && window.location?.hostname ? window.location.hostname : 'localhost';
  return {
    wsUrl: `ws://${host}:2567`,
    httpUrl: `http://${host}:2567`,
  };
}

export class NetworkClient {
  private client: Colyseus.Client;
  private httpBaseUrl: string;
  private room: Colyseus.Room | null = null;
  private playerToken: string;
  private lastJoinNickname = 'Fighter';
  private lastJoinArchetype: CharacterArchetype = 'vanguard';
  private isAutoReconnecting = false;

  public status: ConnectionStatus = 'idle';
  public statusMessage = 'Sẵn sàng kết nối';
  public pingMs = 0;

  private pendingInputs: PendingInput[] = [];
  private predictedSelf: FighterSimState | null = null;
  private visualSelfPos = { x: 0, y: 0, z: 0, facingAngle: 0 };
  private visualActionOverride: VisualActionOverride | null = null;
  private localPredictedAttackCounter = 90000;
  private prevActionInput = {
    dodge: false,
    light: false,
    heavy: false,
    recovery: false,
    weapon: false,
  };

  private remoteSnapshots = new Map<string, RemoteSnapshot[]>();
  private lastProcessedEventId = 0;
  private pingIntervalId: ReturnType<typeof setInterval> | null = null;

  // Simulated extra latency (in ms) for testing lag resilience
  public simulatedLatencyMs = 0;

  private onStateChangeCallback?: (summary: RoomViewSummary) => void;
  private onCombatEventCallback?: (evt: CombatEvent) => void;
  private onErrorCallback?: (code: string, message: string) => void;

  constructor() {
    const { wsUrl, httpUrl } = resolveServerUrls();
    this.httpBaseUrl = httpUrl;
    this.client = new Colyseus.Client(wsUrl);

    let savedToken =
      typeof sessionStorage !== 'undefined'
        ? sessionStorage.getItem('rift_duel_player_token')
        : null;
    if (!savedToken) {
      savedToken = generateSecurePlayerToken();
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem('rift_duel_player_token', savedToken);
      }
    }
    this.playerToken = savedToken;
  }

  public setCallbacks(
    onStateChange: (summary: RoomViewSummary) => void,
    onCombatEvent: (evt: CombatEvent) => void,
    onError: (code: string, message: string) => void
  ): void {
    this.onStateChangeCallback = onStateChange;
    this.onCombatEventCallback = onCombatEvent;
    this.onErrorCallback = onError;
  }

  public async ensureServerAwake(
    onProgress?: (msg: string) => void,
    timeoutMs = 65000
  ): Promise<boolean> {
    try {
      const cfgRes = await fetch('/server-config.json', { cache: 'no-store' });
      if (cfgRes.ok) {
        const cfg = (await cfgRes.json()) as { serverUrl?: string };
        if (cfg?.serverUrl && cfg.serverUrl.trim()) {
          const { wsUrl, httpUrl } = normalizeEndpointUrl(cfg.serverUrl);
          if (httpUrl !== this.httpBaseUrl) {
            this.httpBaseUrl = httpUrl;
            this.client = new Colyseus.Client(wsUrl);
          }
        }
      }
    } catch {
      // Ignore if server-config.json not present or relative fetch skipped in test shim
    }

    this.status = 'waking_server';
    this.statusMessage = 'Đang kiểm tra / đánh thức máy chủ trận đấu...';
    onProgress?.(this.statusMessage);

    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < timeoutMs) {
      attempt++;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3500);
        const res = await fetch(`${this.httpBaseUrl}/health`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (res.ok) {
          this.status = 'connected';
          this.statusMessage = 'Máy chủ trực tuyến';
          return true;
        }
      } catch {
        // Server might be waking from cold start
      }
      this.statusMessage = `Server đang khởi động, thử lại sau ít giây (lần thử ${attempt})...`;
      onProgress?.(this.statusMessage);
      await new Promise((r) => setTimeout(r, 1000));
    }

    this.status = 'error';
    this.statusMessage = 'Máy chủ phản hồi chậm hoặc chưa sẵn sàng. Hãy bấm Thử lại.';
    return false;
  }

  public async createRoom(
    nickname: string,
    archetype: CharacterArchetype,
    customRoomCode?: string
  ): Promise<string> {
    this.lastJoinNickname = nickname;
    this.lastJoinArchetype = archetype;

    const awake = await this.ensureServerAwake();
    if (!awake) {
      throw new Error('SERVER_UNAVAILABLE: Không thể kết nối tới máy chủ trận đấu.');
    }

    await this.leaveCurrentRoom(true);
    const room = await this.client.create('rift_room', {
      mode: 'create',
      nickname,
      archetype,
      roomCode: customRoomCode,
      playerToken: this.playerToken,
    });

    this.attachRoomHandlers(room);
    const code = await this.waitForRoomCode(room);
    this.saveReconnectSession(room.roomId, code, room.reconnectionToken);
    this.updateUrlRoomParam(code);
    return code;
  }

  public async joinRoomByCode(
    rawCode: string,
    nickname: string,
    archetype: CharacterArchetype
  ): Promise<string> {
    this.lastJoinNickname = nickname;
    this.lastJoinArchetype = archetype;

    const code = rawCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) {
      throw new Error('INVALID_CODE: Vui lòng nhập mã phòng hợp lệ.');
    }

    const awake = await this.ensureServerAwake();
    if (!awake) {
      throw new Error('SERVER_UNAVAILABLE: Không thể kết nối tới máy chủ trận đấu.');
    }

    const res = await fetch(
      `${this.httpBaseUrl}/api/rooms/${encodeURIComponent(code)}?token=${encodeURIComponent(this.playerToken)}`
    );
    const data = (await res.json()) as {
      ok: boolean;
      roomId?: string;
      roomCode?: string;
      error?: string;
      message?: string;
    };

    if (!res.ok || !data.ok || !data.roomId) {
      const errCode = data.error || 'ROOM_ERROR';
      const errMsg = data.message || 'Không thể vào phòng đấu.';
      throw new Error(`${errCode}: ${errMsg}`);
    }

    await this.leaveCurrentRoom(true);
    const room = await this.client.joinById(data.roomId, {
      mode: 'join',
      roomCode: code,
      nickname,
      archetype,
      playerToken: this.playerToken,
    });

    this.attachRoomHandlers(room);
    this.saveReconnectSession(room.roomId, code, room.reconnectionToken);
    this.updateUrlRoomParam(code);
    return code;
  }

  /**
   * Automatically attempts to reconnect within the server's 15s grace window
   * when an unconsented WebSocket drop occurs (P0-4).
   */
  private async autoReconnect(
    droppedRoom: Colyseus.Room,
    roomCodeFallback?: string
  ): Promise<void> {
    if (this.isAutoReconnecting) return;
    this.isAutoReconnecting = true;

    const token = droppedRoom.reconnectionToken;
    const savedInfo = this.loadReconnectSession();
    const code = roomCodeFallback || savedInfo?.roomCode || '';
    const deadline = Date.now() + 14000;

    this.status = 'reconnecting';
    this.statusMessage = 'Mất kết nối — Đang tự động kết nối lại...';

    try {
      while (Date.now() < deadline) {
        if (token) {
          try {
            const reconnected = await this.client.reconnect(token);
            this.attachRoomHandlers(reconnected);
            this.saveReconnectSession(reconnected.roomId, code, reconnected.reconnectionToken);
            return;
          } catch {
            // Fall through to playerToken-based slot reclaim
          }
        }

        if (code) {
          try {
            const res = await fetch(
              `${this.httpBaseUrl}/api/rooms/${encodeURIComponent(code)}?token=${encodeURIComponent(this.playerToken)}`
            );
            if (res.ok) {
              const data = (await res.json()) as { ok?: boolean; roomId?: string };
              if (data.ok && data.roomId) {
                const rejoined = await this.client.joinById(data.roomId, {
                  mode: 'join',
                  roomCode: code,
                  nickname: this.lastJoinNickname,
                  archetype: this.lastJoinArchetype,
                  playerToken: this.playerToken,
                });
                this.attachRoomHandlers(rejoined);
                this.saveReconnectSession(rejoined.roomId, code, rejoined.reconnectionToken);
                return;
              }
            }
          } catch {
            // Wait and retry
          }
        }

        await new Promise((r) => setTimeout(r, 800));
      }

      this.status = 'disconnected';
      this.statusMessage = 'Không thể kết nối lại. Hãy tải lại trang.';
    } finally {
      this.isAutoReconnecting = false;
    }
  }

  /**
   * Simulates an abrupt network drop and reconnects to the exact same room slot
   * using the saved reconnection token or playerToken (used both in real network recovery & E2E tests).
   */
  public async forceReconnectCurrentRoom(
    nickname: string,
    archetype: CharacterArchetype
  ): Promise<void> {
    this.lastJoinNickname = nickname;
    this.lastJoinArchetype = archetype;

    const currentCode = this.getRoomSummary()?.roomCode;
    const oldRoom = this.room;

    if (oldRoom) {
      this.room = null;
      try {
        const conn = (oldRoom as unknown as { connection?: { close?: () => void } }).connection;
        conn?.close?.();
      } catch {
        // Ignore
      }
      await this.autoReconnect(oldRoom, currentCode);
      return;
    }

    if (currentCode) {
      await this.joinRoomByCode(currentCode, nickname, archetype);
    }
  }

  public async leaveCurrentRoom(consented = true): Promise<void> {
    if (this.pingIntervalId !== null) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
    if (this.room) {
      const r = this.room;
      this.room = null;
      try {
        await r.leave(consented);
      } catch {
        // Ignore leave errors
      }
    }
    this.pendingInputs = [];
    this.predictedSelf = null;
    this.visualActionOverride = null;
    this.remoteSnapshots.clear();
    this.lastProcessedEventId = 0;
  }

  private waitForRoomCode(room: Colyseus.Room): Promise<string> {
    return new Promise((resolve) => {
      const existing = (room.state as { roomCode?: string })?.roomCode;
      if (existing) {
        resolve(existing);
        return;
      }
      const timeout = setTimeout(() => resolve('RIFT01'), 2000);
      room.onStateChange.once((state: { roomCode?: string }) => {
        clearTimeout(timeout);
        resolve(state?.roomCode || 'RIFT01');
      });
    });
  }

  private attachRoomHandlers(room: Colyseus.Room): void {
    this.room = room;
    this.status = 'connected';
    this.statusMessage = 'Đã kết nối phòng đấu';
    this.pendingInputs = [];
    this.predictedSelf = null;
    this.visualActionOverride = null;
    this.remoteSnapshots.clear();
    this.lastProcessedEventId = 0;

    room.onMessage('assigned_token', (payload: { playerToken?: string }) => {
      if (payload?.playerToken && payload.playerToken.length >= 12) {
        this.playerToken = payload.playerToken;
        if (typeof sessionStorage !== 'undefined') {
          sessionStorage.setItem('rift_duel_player_token', this.playerToken);
        }
      }
    });

    room.onMessage('pong_check', (payload: { clientSentAt?: number }) => {
      if (typeof payload?.clientSentAt === 'number') {
        const rtt = Math.max(1, Date.now() - payload.clientSentAt + this.simulatedLatencyMs);
        this.pingMs = Math.round(this.pingMs === 0 ? rtt : this.pingMs * 0.7 + rtt * 0.3);
      }
    });

    room.onStateChange((state) => {
      this.handleServerStatePatch(state);
    });

    if (room.state && Object.keys(room.state as object).length > 0) {
      this.handleServerStatePatch(room.state);
    }

    room.onError((code, message) => {
      this.status = 'error';
      this.statusMessage = message || `Lỗi kết nối (${code})`;
      this.onErrorCallback?.(String(code), this.statusMessage);
    });

    room.onLeave((code) => {
      if (this.room !== room) return;
      if (code === 1000) {
        this.status = 'idle';
        this.statusMessage = 'Đã rời phòng';
        return;
      }
      const currentCode = (room.state as { roomCode?: string })?.roomCode;
      void this.autoReconnect(room, currentCode);
    });

    if (this.pingIntervalId !== null) {
      clearInterval(this.pingIntervalId);
    }
    this.pingIntervalId = setInterval(() => {
      if (this.room) {
        this.room.send('ping_check', { clientSentAt: Date.now() });
      }
    }, 1500);
    this.room.send('ping_check', { clientSentAt: Date.now() });
    this.room.send('assets_loaded', {});
  }

  private handleServerStatePatch(rawState: unknown): void {
    if (!this.room || !rawState) return;
    const state = rawState as {
      roomCode: string;
      phase: MatchPhase;
      serverTick: number;
      countdownTicks: number;
      timerTicks: number;
      winnerSlot: 0 | 1 | 2;
      winReason: WinReason;
      disconnectGraceTicks: number;
      disconnectedSlot: 0 | 1 | 2;
      fighters: Map<string, Record<string, unknown>>;
      weapon: Record<string, unknown>;
      events: unknown;
    };

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const serverTick = Number(state.serverTick || 0);

    // 1. Reconcile local fighter & push snapshot for remote fighter
    if (state.fighters && typeof state.fighters.forEach === 'function') {
      state.fighters.forEach((netF, sessionId) => {
        const slot = (Number(netF.slot) || 1) as 1 | 2;
        const arch = (netF.archetype === 'reaver' ? 'reaver' : 'vanguard') as CharacterArchetype;
        const x = Number(netF.x) || 0;
        const y = Number(netF.y) || 0;
        const z = Number(netF.z) || 0;
        const vx = Number(netF.vx) || 0;
        const vy = Number(netF.vy) || 0;
        const vz = Number(netF.vz) || 0;
        const facingAngle = Number(netF.facingAngle) || 0;
        const netStateStr = String(netF.state || 'idle') as FighterSimState['state'];
        const netAttackId = String(netF.activeAttackId || '') as FighterSimState['activeAttackId'];
        const netAttackInstId = Number(netF.attackInstanceId ?? 0);

        if (sessionId === this.room?.sessionId) {
          if (!this.predictedSelf) {
            this.predictedSelf = createInitialFighterState(
              sessionId,
              slot,
              String(netF.nickname || 'Me'),
              arch
            );
            this.visualSelfPos = { x, y, z, facingAngle };
          }
          // Copy authoritative state + kinematic counters from server (P1-1)
          const self = this.predictedSelf;
          self.slot = slot;
          self.archetype = arch;
          self.x = x;
          self.y = y;
          self.z = z;
          self.vx = vx;
          self.vy = vy;
          self.vz = vz;
          self.facingAngle = facingAngle;
          self.grounded = Boolean(netF.grounded);
          self.groundJumpsLeft = Number(netF.groundJumpsLeft ?? 1);
          self.airJumpsLeft = Number(netF.airJumpsLeft ?? 2);
          self.airRecoveriesLeft = Number(netF.airRecoveriesLeft ?? 1);
          self.coyoteTicks = Number(netF.coyoteTicks ?? 0);
          self.jumpBufferTicks = Number(netF.jumpBufferTicks ?? 0);
          self.stocks = Number(netF.stocks ?? 3);
          self.damage = Number(netF.damage ?? 0);
          self.state = netStateStr;
          self.stateTicks = Number(netF.stateTicks ?? 0);
          self.activeAttackId = netAttackId;
          self.attackInstanceId = netAttackInstId;
          self.attackCooldownTicks = Number(netF.attackCooldownTicks ?? 0);
          self.dodgeCooldownTicks = Number(netF.dodgeCooldownTicks ?? 0);
          self.dodgeDirX = Number(netF.dodgeDirX ?? 0);
          self.dodgeDirZ = Number(netF.dodgeDirZ ?? 0);
          self.hitstopTicks = Number(netF.hitstopTicks ?? 0);
          self.invulnerableTicks = Number(netF.invulnerableTicks ?? 0);
          self.hasWeapon = Boolean(netF.hasWeapon);
          self.weaponDurability = Number(netF.weaponDurability ?? 0);

          const ackSeq = Number(netF.lastProcessedInputSeq ?? 0);
          this.pendingInputs = this.pendingInputs.filter((p) => p.frame.seq > ackSeq);

          // Reconcile cosmetic action override (P1-2):
          // Clear override if server confirmed action or rejected it via hitstun/ko/respawn or when no unacked inputs remain
          if (this.visualActionOverride) {
            const isServerActionActive =
              netStateStr === 'attack_startup' ||
              netStateStr === 'attack_active' ||
              netStateStr === 'attack_recovery' ||
              netStateStr === 'dodge' ||
              netStateStr === 'pickup' ||
              netStateStr === 'throw';
            const isRejectedByHit =
              netStateStr === 'hitstun' || netStateStr === 'ko' || netStateStr === 'respawn';

            if (isServerActionActive || isRejectedByHit || this.pendingInputs.length === 0 || now > this.visualActionOverride.expiresAtMs) {
              this.visualActionOverride = null;
            }
          }

          // Server reconciliation: replay unacknowledged local movement + jumpEdge inputs (P1-1)
          if (state.phase === 'fighting') {
            for (const pending of this.pendingInputs) {
              stepFighterKinematicMovement(
                self,
                pending.frame.moveX,
                pending.frame.moveZ,
                pending.jumpEdge,
                SIM_CONFIG.DT
              );
            }
          }
        } else {
          // Buffer remote opponent snapshot with full visual state for smooth interpolation (P1-5)
          let buf = this.remoteSnapshots.get(sessionId);
          if (!buf) {
            buf = [];
            this.remoteSnapshots.set(sessionId, buf);
          }
          buf.push({
            serverTick,
            timestamp: now,
            x,
            y,
            z,
            vx,
            vy,
            vz,
            facingAngle,
            grounded: Boolean(netF.grounded),
            state: netStateStr,
            activeAttackId: netAttackId,
            attackInstanceId: netAttackInstId,
            hasWeapon: Boolean(netF.hasWeapon),
            invulnerableTicks: Number(netF.invulnerableTicks ?? 0),
            damage: Number(netF.damage ?? 0),
          });
          if (buf.length > 24) {
            buf.shift();
          }
        }
      });
    }

    // 2. Deduplicate and emit combat events from Colyseus ArraySchema or plain Array (P0-1)
    const rawEvents: Array<Record<string, unknown>> = [];
    const evSource = state.events as
      | { forEach?: (cb: (e: Record<string, unknown>) => void) => void }
      | undefined;
    if (evSource && typeof evSource.forEach === 'function') {
      evSource.forEach((e) => rawEvents.push(e));
    }

    rawEvents.sort((a, b) => Number(a.eventId || 0) - Number(b.eventId || 0));

    for (const rawEvt of rawEvents) {
      const eid = Number(rawEvt.eventId || 0);
      if (eid > this.lastProcessedEventId) {
        this.lastProcessedEventId = eid;
        this.onCombatEventCallback?.({
          eventId: eid,
          type: String(rawEvt.type) as CombatEventType,
          tick: Number(rawEvt.tick || 0),
          sourceSlot: (Number(rawEvt.sourceSlot) || 0) as 0 | 1 | 2,
          targetSlot: (Number(rawEvt.targetSlot) || 0) as 0 | 1 | 2,
          x: Number(rawEvt.x || 0),
          y: Number(rawEvt.y || 0),
          z: Number(rawEvt.z || 0),
          damageDealt: Number(rawEvt.damageDealt || 0),
          knockbackSpeed: Number(rawEvt.knockbackSpeed || 0),
        });
      }
    }

    const summary = this.getRoomSummary();
    if (summary) {
      this.onStateChangeCallback?.(summary);
    }
  }

  public sendGameplayInput(input: InputFrame): void {
    if (!this.room) return;
    const state = this.room.state as { phase?: string } | undefined;
    if (state?.phase === 'fighting' && this.predictedSelf) {
      const jumpEdge = input.jumpPressed && !this.predictedSelf.prevJumpDown;
      const dodgeEdge = input.dodgePressed && !this.prevActionInput.dodge;
      const lightEdge = input.lightPressed && !this.prevActionInput.light;
      const heavyEdge = input.heavyPressed && !this.prevActionInput.heavy;
      const recoveryEdge = input.recoveryPressed && !this.prevActionInput.recovery;
      const weaponEdge = input.weaponPressed && !this.prevActionInput.weapon;

      this.predictedSelf.prevJumpDown = input.jumpPressed;
      this.prevActionInput.dodge = input.dodgePressed;
      this.prevActionInput.light = input.lightPressed;
      this.prevActionInput.heavy = input.heavyPressed;
      this.prevActionInput.recovery = input.recoveryPressed;
      this.prevActionInput.weapon = input.weaponPressed;

      // Cosmetic immediate action prediction for local fighter (P1-2)
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (canFighterStartAction(this.predictedSelf) && !this.visualActionOverride) {
        if (dodgeEdge && this.predictedSelf.dodgeCooldownTicks <= 0) {
          this.visualActionOverride = {
            state: 'dodge',
            activeAttackId: '',
            attackInstanceId: 0,
            expiresAtMs: now + 260,
          };
        } else if (weaponEdge && this.predictedSelf.hasWeapon) {
          this.visualActionOverride = {
            state: 'throw',
            activeAttackId: '',
            attackInstanceId: 0,
            expiresAtMs: now + 220,
          };
        } else {
          const predictedAtk: AttackId | null = chooseAttackId(
            this.predictedSelf,
            recoveryEdge,
            heavyEdge,
            lightEdge
          );
          if (predictedAtk) {
            this.localPredictedAttackCounter++;
            this.visualActionOverride = {
              state: 'attack_startup',
              activeAttackId: predictedAtk,
              attackInstanceId: this.localPredictedAttackCounter,
              expiresAtMs: now + 320,
            };
          }
        }
      }

      stepFighterKinematicMovement(
        this.predictedSelf,
        input.moveX,
        input.moveZ,
        jumpEdge,
        SIM_CONFIG.DT
      );
      this.pendingInputs.push({ frame: input, jumpEdge });
      if (this.pendingInputs.length > 60) {
        this.pendingInputs.shift();
      }
    }

    const dispatch = () => {
      this.room?.send('input', input);
    };

    if (this.simulatedLatencyMs > 0) {
      setTimeout(dispatch, this.simulatedLatencyMs * 0.5);
    } else {
      dispatch();
    }
  }

  public sendSelectArchetype(archetype: CharacterArchetype): void {
    this.room?.send('select_archetype', { archetype });
  }

  public sendSetNickname(nickname: string): void {
    this.room?.send('set_nickname', { nickname });
  }

  public sendToggleReady(ready?: boolean): void {
    this.room?.send('set_ready', { ready });
  }

  public sendVoteRematch(): void {
    this.room?.send('vote_rematch', {});
  }

  public getRoomSummary(): RoomViewSummary | null {
    if (!this.room || !this.room.state) return null;
    const s = this.room.state as {
      roomCode?: string;
      phase?: MatchPhase;
      serverTick?: number;
      countdownTicks?: number;
      timerTicks?: number;
      winnerSlot?: number;
      winReason?: WinReason;
      disconnectGraceTicks?: number;
      disconnectedSlot?: number;
      fighters?: Map<string, Record<string, unknown>>;
    };

    const fighters: RoomViewSummary['fighters'] = [];
    let mySlot: 0 | 1 | 2 = 0;

    s.fighters?.forEach((f, sid) => {
      const slot = (Number(f.slot) || 1) as 1 | 2;
      if (sid === this.room?.sessionId) {
        mySlot = slot;
      }
      fighters.push({
        sessionId: sid,
        slot,
        nickname: String(f.nickname || `Fighter ${slot}`),
        archetype: (f.archetype === 'reaver' ? 'reaver' : 'vanguard') as CharacterArchetype,
        ready: Boolean(f.ready),
        rematchVote: Boolean(f.rematchVote),
        connected: Boolean(f.connected),
        stocks: Number(f.stocks ?? 3),
        damage: Number(f.damage ?? 0),
        hasWeapon: Boolean(f.hasWeapon),
        x: Number(f.x ?? 0),
        y: Number(f.y ?? 0),
        z: Number(f.z ?? 0),
        state: String(f.state || 'idle'),
      });
    });

    fighters.sort((a, b) => a.slot - b.slot);

    return {
      roomCode: String(s.roomCode || ''),
      phase: (s.phase || 'waiting') as MatchPhase,
      serverTick: Number(s.serverTick || 0),
      countdownSeconds: Math.ceil(Number(s.countdownTicks ?? 180) / 60),
      timerSeconds: Math.ceil(Number(s.timerTicks ?? 14400) / 60),
      winnerSlot: (Number(s.winnerSlot) || 0) as 0 | 1 | 2,
      winReason: (s.winReason || '') as WinReason,
      disconnectGraceSeconds: Math.ceil(Number(s.disconnectGraceTicks ?? 0) / 60),
      disconnectedSlot: (Number(s.disconnectedSlot) || 0) as 0 | 1 | 2,
      mySessionId: this.room.sessionId,
      mySlot,
      fighters,
    };
  }

  /**
   * Produces smoothed 3D render states for both fighters and the world weapon
   * (applying client-side prediction + cosmetic action override for local player
   * and buffered snapshot interpolation for remote player).
   */
  public getRenderSnapshot(dt: number): {
    fighters: FighterRenderInput[];
    weapon: { status: string; x: number; y: number; z: number; rotationY: number };
  } {
    if (!this.room || !this.room.state) {
      return {
        fighters: [],
        weapon: { status: 'on_ground', x: 0, y: 0, z: 0, rotationY: 0 },
      };
    }

    const s = this.room.state as {
      fighters?: Map<string, Record<string, unknown>>;
      weapon?: Record<string, unknown>;
    };

    const outFighters: FighterRenderInput[] = [];
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const interpDelayMs = 90; // ~2.7 patch intervals at 30Hz to absorb network jitter smoothly (P1-5)

    s.fighters?.forEach((netF, sid) => {
      const slot = (Number(netF.slot) || 1) as 1 | 2;
      const arch = (netF.archetype === 'reaver' ? 'reaver' : 'vanguard') as CharacterArchetype;

      if (sid === this.room?.sessionId && this.predictedSelf) {
        const blend = 1 - Math.exp(-26 * dt);
        this.visualSelfPos.x += (this.predictedSelf.x - this.visualSelfPos.x) * blend;
        this.visualSelfPos.y += (this.predictedSelf.y - this.visualSelfPos.y) * blend;
        this.visualSelfPos.z += (this.predictedSelf.z - this.visualSelfPos.z) * blend;
        this.visualSelfPos.facingAngle = this.predictedSelf.facingAngle;

        if (this.visualActionOverride && now > this.visualActionOverride.expiresAtMs) {
          this.visualActionOverride = null;
        }

        const effectiveState =
          this.visualActionOverride?.state ||
          String(netF.state || this.predictedSelf.state);
        const effectiveAttackId =
          this.visualActionOverride?.activeAttackId ||
          String(netF.activeAttackId || '');
        const effectiveAttackInstId =
          this.visualActionOverride?.attackInstanceId ||
          Number(netF.attackInstanceId ?? 0);

        outFighters.push({
          slot,
          archetype: arch,
          x: this.visualSelfPos.x,
          y: this.visualSelfPos.y,
          z: this.visualSelfPos.z,
          vx: this.predictedSelf.vx,
          vy: this.predictedSelf.vy,
          vz: this.predictedSelf.vz,
          facingAngle: this.visualSelfPos.facingAngle,
          grounded: this.predictedSelf.grounded,
          state: effectiveState,
          activeAttackId: effectiveAttackId,
          attackInstanceId: effectiveAttackInstId,
          hasWeapon: Boolean(netF.hasWeapon),
          invulnerableTicks: Number(netF.invulnerableTicks ?? 0),
          damage: Number(netF.damage ?? 0),
        });
      } else {
        // Interpolate remote player between buffered snapshots (including discrete state/attackId - P1-5)
        const buf = this.remoteSnapshots.get(sid);
        let rx = Number(netF.x) || 0;
        let ry = Number(netF.y) || 0;
        let rz = Number(netF.z) || 0;
        let rvx = Number(netF.vx) || 0;
        let rvy = Number(netF.vy) || 0;
        let rvz = Number(netF.vz) || 0;
        let rAngle = Number(netF.facingAngle) || 0;
        let rGrounded = Boolean(netF.grounded);
        let rState = String(netF.state || 'idle');
        let rAttackId = String(netF.activeAttackId || '');
        let rAttackInstId = Number(netF.attackInstanceId ?? 0);
        let rHasWeapon = Boolean(netF.hasWeapon);
        let rInvuln = Number(netF.invulnerableTicks ?? 0);
        let rDamage = Number(netF.damage ?? 0);

        if (buf && buf.length >= 2) {
          const renderTime = now - interpDelayMs;
          let older = buf[0];
          let newer = buf[buf.length - 1];
          for (let i = 0; i < buf.length - 1; i++) {
            if (buf[i].timestamp <= renderTime && buf[i + 1].timestamp >= renderTime) {
              older = buf[i];
              newer = buf[i + 1];
              break;
            }
          }
          const span = newer.timestamp - older.timestamp;
          const alpha = span > 1 ? Math.max(0, Math.min(1, (renderTime - older.timestamp) / span)) : 1;
          rx = older.x + (newer.x - older.x) * alpha;
          ry = older.y + (newer.y - older.y) * alpha;
          rz = older.z + (newer.z - older.z) * alpha;
          rvx = older.vx + (newer.vx - older.vx) * alpha;
          rvy = older.vy + (newer.vy - older.vy) * alpha;
          rvz = older.vz + (newer.vz - older.vz) * alpha;
          rAngle = alpha < 0.5 ? older.facingAngle : newer.facingAngle;

          // Match discrete visual fields to the interpolated snapshot timeline
          const snapRef = alpha < 0.65 ? older : newer;
          rGrounded = snapRef.grounded;
          rState = snapRef.state;
          rAttackId = snapRef.activeAttackId;
          rAttackInstId = snapRef.attackInstanceId;
          rHasWeapon = snapRef.hasWeapon;
          rInvuln = snapRef.invulnerableTicks;
          rDamage = snapRef.damage;
        }

        outFighters.push({
          slot,
          archetype: arch,
          x: rx,
          y: ry,
          z: rz,
          vx: rvx,
          vy: rvy,
          vz: rvz,
          facingAngle: rAngle,
          grounded: rGrounded,
          state: rState,
          activeAttackId: rAttackId,
          attackInstanceId: rAttackInstId,
          hasWeapon: rHasWeapon,
          invulnerableTicks: rInvuln,
          damage: rDamage,
        });
      }
    });

    outFighters.sort((a, b) => a.slot - b.slot);

    const w = s.weapon || {};
    return {
      fighters: outFighters,
      weapon: {
        status: String(w.status || 'on_ground'),
        x: Number(w.x || 0),
        y: Number(w.y || 0),
        z: Number(w.z || 0),
        rotationY: Number(w.rotationY || 0),
      },
    };
  }

  private saveReconnectSession(roomId: string, roomCode: string, reconnectionToken?: string): void {
    if (typeof sessionStorage === 'undefined') return;
    try {
      sessionStorage.setItem(
        'rift_duel_reconnect_info',
        JSON.stringify({ roomId, roomCode, reconnectionToken, savedAt: Date.now() })
      );
    } catch {
      // Ignore storage errors
    }
  }

  private loadReconnectSession(): { roomId?: string; roomCode?: string; reconnectionToken?: string } | null {
    if (typeof sessionStorage === 'undefined') return null;
    try {
      const raw = sessionStorage.getItem('rift_duel_reconnect_info');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private updateUrlRoomParam(code: string): void {
    if (typeof window === 'undefined' || !window.location || !window.history) return;
    const url = new URL(window.location.href);
    if (code) {
      url.searchParams.set('room', code);
    } else {
      url.searchParams.delete('room');
    }
    window.history.replaceState({}, '', url.toString());
  }
}
