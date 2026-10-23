import * as Colyseus from 'colyseus.js';
import {
  CharacterArchetype,
  CombatEvent,
  CombatEventType,
  FighterSimState,
  InputFrame,
  MatchPhase,
  SIM_CONFIG,
  WinReason,
  createInitialFighterState,
  stepFighterKinematicMovement,
} from '@shared/index.js';
import { FighterRenderInput } from '../render/FighterVisual.js';
import {
  PeerGuestRoom,
  PeerHostRoom,
  RoomLike,
  generateP2PRoomCode,
} from './PeerRoomAdapter.js';

export type ConnectionStatus =
  | 'idle'
  | 'waking_server'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

interface RemoteSnapshot {
  timestamp: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  facingAngle: number;
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
  const params = new URLSearchParams(window.location.search);
  const queryServer = params.get('server')?.trim();
  if (queryServer) {
    localStorage.setItem('rift_duel_server_url', queryServer);
    return normalizeEndpointUrl(queryServer);
  }

  const savedServer = localStorage.getItem('rift_duel_server_url')?.trim();
  if (savedServer) {
    return normalizeEndpointUrl(savedServer);
  }

  const envUrl = (import.meta.env.VITE_GAME_SERVER_URL as string | undefined)?.trim();
  if (envUrl) {
    return normalizeEndpointUrl(envUrl);
  }

  const host = window.location.hostname || 'localhost';
  return {
    wsUrl: `ws://${host}:2567`,
    httpUrl: `http://${host}:2567`,
  };
}

export class NetworkClient {
  private client: Colyseus.Client;
  private httpBaseUrl: string;
  private room: RoomLike | null = null;
  private playerToken: string;
  private usePeerFallback = false;

  public status: ConnectionStatus = 'idle';
  public statusMessage = 'Sẵn sàng kết nối';
  public pingMs = 0;

  private pendingInputs: InputFrame[] = [];
  private predictedSelf: FighterSimState | null = null;
  private visualSelfPos = { x: 0, y: 0, z: 0, facingAngle: 0 };
  private remoteSnapshots = new Map<string, RemoteSnapshot[]>();
  private lastProcessedEventId = 0;
  private pingIntervalId: number | null = null;

  // Simulated extra latency (in ms) for testing lag resilience
  public simulatedLatencyMs = 0;

  private onStateChangeCallback?: (summary: RoomViewSummary) => void;
  private onCombatEventCallback?: (evt: CombatEvent) => void;
  private onErrorCallback?: (code: string, message: string) => void;

  constructor() {
    const { wsUrl, httpUrl } = resolveServerUrls();
    this.httpBaseUrl = httpUrl;
    this.client = new Colyseus.Client(wsUrl);

    let savedToken = sessionStorage.getItem('rift_duel_player_token');
    if (!savedToken) {
      savedToken = `pt_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
      sessionStorage.setItem('rift_duel_player_token', savedToken);
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
    timeoutMs = 15000
  ): Promise<boolean> {
    let explicitServerConfigured = Boolean(
      new URLSearchParams(window.location.search).get('server')?.trim() ||
      localStorage.getItem('rift_duel_server_url')?.trim() ||
      (import.meta.env.VITE_GAME_SERVER_URL as string | undefined)?.trim()
    );

    try {
      const cfgRes = await fetch('/server-config.json', { cache: 'no-store' });
      if (cfgRes.ok) {
        const cfg = (await cfgRes.json()) as { serverUrl?: string };
        if (cfg?.serverUrl && cfg.serverUrl.trim()) {
          explicitServerConfigured = true;
          const { wsUrl, httpUrl } = normalizeEndpointUrl(cfg.serverUrl);
          if (httpUrl !== this.httpBaseUrl) {
            this.httpBaseUrl = httpUrl;
            this.client = new Colyseus.Client(wsUrl);
          }
        }
      }
    } catch {
      // Ignore if server-config.json not present
    }

    const isLocalhost =
      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

    // When deployed on Netlify or another static domain without an explicit Render URL yet,
    // immediately enable built-in WebRTC Cloud Relay (PeerJS) so rooms work out-of-the-box!
    if (!isLocalhost && !explicitServerConfigured) {
      this.usePeerFallback = true;
      this.status = 'connected';
      this.statusMessage = 'Máy chủ trực tuyến sẵn sàng';
      return true;
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
        const timer = window.setTimeout(() => ctrl.abort(), 3500);
        const res = await fetch(`${this.httpBaseUrl}/health`, { signal: ctrl.signal });
        window.clearTimeout(timer);
        if (res.ok) {
          this.usePeerFallback = false;
          this.status = 'connected';
          this.statusMessage = 'Máy chủ trực tuyến';
          return true;
        }
      } catch {
        // Server might be waking from cold start
      }
      this.statusMessage = `Đang đánh thức máy chủ (lần thử ${attempt})...`;
      onProgress?.(this.statusMessage);
      await new Promise((r) => setTimeout(r, 900));
    }

    // Fallback to PeerJS Cloud Relay if Colyseus endpoint could not be reached
    this.usePeerFallback = true;
    this.status = 'connected';
    this.statusMessage = 'Máy chủ trực tuyến sẵn sàng (Cloud P2P)';
    return true;
  }

  public async createRoom(
    nickname: string,
    archetype: CharacterArchetype,
    customRoomCode?: string
  ): Promise<string> {
    const awake = await this.ensureServerAwake();
    if (!awake) {
      throw new Error('SERVER_UNAVAILABLE: Không thể kết nối tới máy chủ trận đấu.');
    }

    await this.leaveCurrentRoom(true);

    if (this.usePeerFallback) {
      const code = generateP2PRoomCode(customRoomCode);
      const hostRoom = new PeerHostRoom(code, nickname, archetype, this.playerToken);
      await hostRoom.startHost();
      this.attachRoomHandlers(hostRoom);
      this.updateUrlRoomParam(code);
      return code;
    }

    const room = (await this.client.create('rift_room', {
      mode: 'create',
      nickname,
      archetype,
      roomCode: customRoomCode,
      playerToken: this.playerToken,
    })) as unknown as RoomLike;

    this.attachRoomHandlers(room);
    const code = await this.waitForRoomCode(room);
    this.updateUrlRoomParam(code);
    return code;
  }

  public async joinRoomByCode(
    rawCode: string,
    nickname: string,
    archetype: CharacterArchetype
  ): Promise<string> {
    const code = rawCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) {
      throw new Error('INVALID_CODE: Vui lòng nhập mã phòng hợp lệ.');
    }

    const awake = await this.ensureServerAwake();
    if (!awake) {
      throw new Error('SERVER_UNAVAILABLE: Không thể kết nối tới máy chủ trận đấu.');
    }

    if (this.usePeerFallback) {
      await this.leaveCurrentRoom(true);
      const guestRoom = new PeerGuestRoom(code);
      await guestRoom.connectToHost(nickname, archetype, this.playerToken);
      this.attachRoomHandlers(guestRoom);
      this.updateUrlRoomParam(code);
      return code;
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
    const room = (await this.client.joinById(data.roomId, {
      mode: 'join',
      roomCode: code,
      nickname,
      archetype,
      playerToken: this.playerToken,
    })) as unknown as RoomLike;

    this.attachRoomHandlers(room);
    this.updateUrlRoomParam(code);
    return code;
  }

  /**
   * Simulates an abrupt network drop and reconnects to the exact same room slot
   * using the saved reconnection token or playerToken (used both in real network recovery & E2E tests).
   */
  public async forceReconnectCurrentRoom(
    nickname: string,
    archetype: CharacterArchetype
  ): Promise<void> {
    const currentCode = this.getRoomSummary()?.roomCode;
    const reconnectToken = this.room?.reconnectionToken;

    if (this.room) {
      try {
        // Close underlying WebSocket unconsented to trigger server 15s grace window
        const conn = (this.room as unknown as { connection?: { close?: () => void } }).connection;
        conn?.close?.();
      } catch {
        // Ignore
      }
      this.room = null;
    }

    this.status = 'reconnecting';
    this.statusMessage = 'Đang kết nối lại vào trận đấu...';

    if (reconnectToken) {
      try {
        const reconnectedRoom = (await this.client.reconnect(reconnectToken)) as unknown as RoomLike;
        this.attachRoomHandlers(reconnectedRoom);
        return;
      } catch {
        // Fallback to token-based slot reclaim via joinRoomByCode
      }
    }

    if (currentCode) {
      await this.joinRoomByCode(currentCode, nickname, archetype);
    }
  }

  public async leaveCurrentRoom(consented = true): Promise<void> {
    if (this.pingIntervalId !== null) {
      window.clearInterval(this.pingIntervalId);
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
    this.remoteSnapshots.clear();
    this.lastProcessedEventId = 0;
  }

  private waitForRoomCode(room: RoomLike): Promise<string> {
    return new Promise((resolve) => {
      const existing = (room.state as { roomCode?: string })?.roomCode;
      if (existing) {
        resolve(existing);
        return;
      }
      const timeout = window.setTimeout(() => resolve('RIFT01'), 2000);
      room.onStateChange.once((state: { roomCode?: string }) => {
        window.clearTimeout(timeout);
        resolve(state?.roomCode || 'RIFT01');
      });
    });
  }

  private attachRoomHandlers(room: RoomLike): void {
    this.room = room;
    this.status = 'connected';
    this.statusMessage = 'Đã kết nối phòng đấu';
    this.pendingInputs = [];
    this.predictedSelf = null;
    this.remoteSnapshots.clear();
    this.lastProcessedEventId = 0;

    room.onMessage('pong_check', (payload: { clientSentAt?: number }) => {
      if (typeof payload?.clientSentAt === 'number') {
        const rtt = Math.max(1, Date.now() - payload.clientSentAt + this.simulatedLatencyMs);
        this.pingMs = Math.round(this.pingMs === 0 ? rtt : this.pingMs * 0.7 + rtt * 0.3);
      }
    });

    room.onStateChange((state) => {
      this.handleServerStatePatch(state);
    });

    if (room.state && Object.keys(room.state).length > 0) {
      this.handleServerStatePatch(room.state);
    }

    room.onError((code, message) => {
      this.status = 'error';
      this.statusMessage = message || `Lỗi kết nối (${code})`;
      this.onErrorCallback?.(String(code), this.statusMessage);
    });

    room.onLeave((code) => {
      if (this.room !== room) return;
      if (code !== 1000) {
        this.status = 'disconnected';
        this.statusMessage = 'Mất kết nối với máy chủ — Đang thử kết nối lại...';
      } else {
        this.status = 'idle';
        this.statusMessage = 'Đã rời phòng';
      }
    });

    if (this.pingIntervalId !== null) {
      window.clearInterval(this.pingIntervalId);
    }
    this.pingIntervalId = window.setInterval(() => {
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
      events: Array<Record<string, unknown>>;
    };

    const now = performance.now();

    // 1. Reconcile local fighter & push snapshot for remote fighter
    if (state.fighters) {
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
          // Copy authoritative state from server
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
          self.stocks = Number(netF.stocks ?? 3);
          self.damage = Number(netF.damage ?? 0);
          self.state = String(netF.state || 'idle') as FighterSimState['state'];
          self.activeAttackId = String(netF.activeAttackId || '') as FighterSimState['activeAttackId'];
          self.invulnerableTicks = Number(netF.invulnerableTicks ?? 0);
          self.hasWeapon = Boolean(netF.hasWeapon);

          const ackSeq = Number(netF.lastProcessedInputSeq ?? 0);
          this.pendingInputs = this.pendingInputs.filter((inp) => inp.seq > ackSeq);

          // Server reconciliation: replay unacknowledged local movement inputs
          if (state.phase === 'fighting') {
            for (const pending of this.pendingInputs) {
              stepFighterKinematicMovement(
                self,
                pending.moveX,
                pending.moveZ,
                false,
                SIM_CONFIG.DT
              );
            }
          }
        } else {
          // Buffer remote opponent snapshot for smooth interpolation
          let buf = this.remoteSnapshots.get(sessionId);
          if (!buf) {
            buf = [];
            this.remoteSnapshots.set(sessionId, buf);
          }
          buf.push({
            timestamp: now,
            x,
            y,
            z,
            vx,
            vy,
            vz,
            facingAngle,
          });
          if (buf.length > 12) {
            buf.shift();
          }
        }
      });
    }

    // 2. Deduplicate and emit combat events by monotonically increasing eventId
    if (state.events && Array.isArray(state.events)) {
      for (const rawEvt of state.events) {
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
      const jumpJustPressed = input.jumpPressed && !this.predictedSelf.prevJumpDown;
      this.predictedSelf.prevJumpDown = input.jumpPressed;
      stepFighterKinematicMovement(
        this.predictedSelf,
        input.moveX,
        input.moveZ,
        jumpJustPressed,
        SIM_CONFIG.DT
      );
      this.pendingInputs.push(input);
      if (this.pendingInputs.length > 45) {
        this.pendingInputs.shift();
      }
    }

    const dispatch = () => {
      this.room?.send('input', input);
    };

    if (this.simulatedLatencyMs > 0) {
      window.setTimeout(dispatch, this.simulatedLatencyMs * 0.5);
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
   * (applying client-side prediction smoothing for local player and snapshot interpolation for remote player).
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
    const now = performance.now();
    const interpDelayMs = 48; // ~1.5 patch intervals at 30Hz

    s.fighters?.forEach((netF, sid) => {
      const slot = (Number(netF.slot) || 1) as 1 | 2;
      const arch = (netF.archetype === 'reaver' ? 'reaver' : 'vanguard') as CharacterArchetype;

      if (sid === this.room?.sessionId && this.predictedSelf) {
        const blend = 1 - Math.exp(-22 * dt);
        this.visualSelfPos.x += (this.predictedSelf.x - this.visualSelfPos.x) * blend;
        this.visualSelfPos.y += (this.predictedSelf.y - this.visualSelfPos.y) * blend;
        this.visualSelfPos.z += (this.predictedSelf.z - this.visualSelfPos.z) * blend;
        this.visualSelfPos.facingAngle = this.predictedSelf.facingAngle;

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
          state: String(netF.state || this.predictedSelf.state),
          activeAttackId: String(netF.activeAttackId || ''),
          hasWeapon: Boolean(netF.hasWeapon),
          invulnerableTicks: Number(netF.invulnerableTicks ?? 0),
          damage: Number(netF.damage ?? 0),
        });
      } else {
        // Interpolate remote player between buffered snapshots
        const buf = this.remoteSnapshots.get(sid);
        let rx = Number(netF.x) || 0;
        let ry = Number(netF.y) || 0;
        let rz = Number(netF.z) || 0;
        let rAngle = Number(netF.facingAngle) || 0;

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
          rAngle = newer.facingAngle;
        }

        outFighters.push({
          slot,
          archetype: arch,
          x: rx,
          y: ry,
          z: rz,
          vx: Number(netF.vx) || 0,
          vy: Number(netF.vy) || 0,
          vz: Number(netF.vz) || 0,
          facingAngle: rAngle,
          grounded: Boolean(netF.grounded),
          state: String(netF.state || 'idle'),
          activeAttackId: String(netF.activeAttackId || ''),
          hasWeapon: Boolean(netF.hasWeapon),
          invulnerableTicks: Number(netF.invulnerableTicks ?? 0),
          damage: Number(netF.damage ?? 0),
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

  private updateUrlRoomParam(code: string): void {
    const url = new URL(window.location.href);
    if (code) {
      url.searchParams.set('room', code);
    } else {
      url.searchParams.delete('room');
    }
    window.history.replaceState({}, '', url.toString());
  }
}
