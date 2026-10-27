import {
  CharacterArchetype,
  CombatEvent,
  InputFrame,
  SIM_CONFIG,
  SimulationWorld,
  createInitialFighterState,
  createSimulationWorld,
  startMatchCountdown,
  stepWorldTick,
} from '@shared/index.js';
import { SoundManager } from './audio/SoundManager.js';
import { KeyboardController } from './input/KeyboardController.js';
import { NetworkClient, RoomViewSummary } from './net/NetworkClient.js';
import { ArenaBuilder } from './render/ArenaBuilder.js';
import { AssetLoader } from './render/AssetLoader.js';
import { FighterRenderInput, FighterVisual } from './render/FighterVisual.js';
import { SceneManager } from './render/SceneManager.js';
import { VFXManager } from './render/VFXManager.js';
import { UIManager } from './ui/UIManager.js';

class RiftDuelGameApp {
  private canvas: HTMLCanvasElement;
  private uiRoot: HTMLElement;

  private sound = new SoundManager();
  private kb: KeyboardController;
  private sceneManager: SceneManager;
  private assets = new AssetLoader();
  private arena = new ArenaBuilder();
  private vfx!: VFXManager;
  private net = new NetworkClient();
  private ui: UIManager;

  private fighterVisuals = new Map<1 | 2, FighterVisual>();

  // Local practice simulation world (for offline 1P vs Bot mode)
  private isLocalPractice = false;
  private localWorld: SimulationWorld | null = null;
  private localBotSeq = 1;
  private localLastEventId = 0;

  private lastFrameTime = performance.now();
  private fixedAccumulatorMs = 0;
  private lastFixedTimeMs = performance.now();
  private readonly STEP_MS = 1000 / SIM_CONFIG.TICK_RATE;
  private readonly MAX_STEPS_PER_FRAME = 5;

  constructor() {
    this.canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    this.uiRoot = document.getElementById('ui-root') as HTMLElement;

    this.kb = new KeyboardController(this.sound);
    this.sceneManager = new SceneManager(this.canvas);

    this.ui = new UIManager(this.uiRoot, this.sound, this.kb, this.sceneManager, {
      onCreateRoom: (nick, arch) => void this.handleCreateRoom(nick, arch),
      onJoinRoom: (code, nick, arch) => void this.handleJoinRoom(code, nick, arch),
      onStartLocalPractice: (nick, arch) => this.startLocalPractice(nick, arch),
      onSelectArchetype: (arch) => this.net.sendSelectArchetype(arch),
      onToggleReady: () => this.net.sendToggleReady(),
      onVoteRematch: () => {
        if (this.isLocalPractice && this.localWorld) {
          startMatchCountdown(this.localWorld);
          this.syncLocalPracticeUI();
        } else {
          this.net.sendVoteRematch();
        }
      },
      onLeaveRoom: () => void this.handleLeaveRoom(),
      onRetryAssetLoad: () => void this.bootstrap(),
    });

    this.kb.setCallbacks(
      () => this.ui.toggleOptionsModal(),
      (code, e) => this.ui.handleGlobalShortcut(code, e)
    );

    this.net.setCallbacks(
      (summary) => this.ui.updateFromRoomSummary(summary, false),
      (evt) => this.handleCombatEvent(evt),
      (_code, msg) => {
        this.sound.play('ui_error');
        this.ui.showBanner(msg, 'error');
      }
    );

    // Expose debug/test bridge only in DEV or automated E2E mode (?e2e=1)
    if (
      import.meta.env.DEV ||
      new URLSearchParams(window.location.search).get('e2e') === '1'
    ) {
      (window as unknown as Record<string, unknown>).__RIFT_DUEL__ = {
        app: this,
        net: this.net,
        setSimulatedLatencyMs: (ms: number) => {
          this.net.simulatedLatencyMs = ms;
        },
        forceDisconnectAndReconnect: () =>
          this.net.forceReconnectCurrentRoom(
            this.ui.getNickname(),
            this.ui.getSelectedArchetype()
          ),
        getRoomSummary: () =>
          this.isLocalPractice ? this.buildLocalSummary() : this.net.getRoomSummary(),
      };
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.lastFixedTimeMs = performance.now();
        this.fixedAccumulatorMs = 0;
      }
    });

    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    if (!this.sceneManager.webglSupported) {
      this.ui.showWebGLError();
      return;
    }

    try {
      await this.assets.loadAll((_loaded, _total, pct, label) => {
        this.ui.showLoadingProgress(pct, label);
      });
    } catch (err) {
      this.ui.showLoadingProgress(
        0,
        'Lỗi tải tài nguyên 3D',
        err instanceof Error ? err.message : String(err)
      );
      return;
    }

    this.arena.build(this.assets, this.sceneManager.scene);
    this.vfx = new VFXManager(this.sceneManager.scene, this.assets);

    // Create the two 3D animated fighter visuals on the stage
    const f1 = new FighterVisual(1, 'vanguard', this.assets, this.sceneManager.scene);
    const f2 = new FighterVisual(2, 'reaver', this.assets, this.sceneManager.scene);
    this.fighterVisuals.set(1, f1);
    this.fighterVisuals.set(2, f2);

    this.ui.showHomeScreen();
    const now = performance.now();
    this.lastFrameTime = now;
    this.lastFixedTimeMs = now;
    this.fixedAccumulatorMs = 0;
    requestAnimationFrame((t) => this.animate(t));
  }

  private async handleCreateRoom(nickname: string, archetype: CharacterArchetype): Promise<void> {
    this.isLocalPractice = false;
    this.localWorld = null;
    try {
      this.ui.showBanner('Đang kết nối máy chủ và khởi tạo phòng đấu...', 'info');
      await this.net.createRoom(nickname, archetype);
    } catch (err) {
      this.sound.play('ui_error');
      const msg = err instanceof Error ? err.message : String(err);
      this.ui.showBanner(msg.replace(/^[A-Z_]+:\s*/, ''), 'error');
    }
  }

  private async handleJoinRoom(
    roomCode: string,
    nickname: string,
    archetype: CharacterArchetype
  ): Promise<void> {
    this.isLocalPractice = false;
    this.localWorld = null;
    if (!roomCode.trim()) {
      this.sound.play('ui_error');
      this.ui.showBanner('Vui lòng nhập Mã Phòng (ví dụ: ABC123) trước khi vào.', 'error');
      return;
    }
    try {
      this.ui.showBanner(`Đang kết nối vào phòng ${roomCode}...`, 'info');
      await this.net.joinRoomByCode(roomCode, nickname, archetype);
    } catch (err) {
      this.sound.play('ui_error');
      const msg = err instanceof Error ? err.message : String(err);
      this.ui.showBanner(msg.replace(/^[A-Z_]+:\s*/, ''), 'error');
    }
  }

  private startLocalPractice(nickname: string, archetype: CharacterArchetype): void {
    void this.net.leaveCurrentRoom(true);
    this.isLocalPractice = true;
    this.localLastEventId = 0;

    const world = createSimulationWorld();
    const p1 = createInitialFighterState('local_p1', 1, nickname, archetype);
    const botArch: CharacterArchetype = archetype === 'vanguard' ? 'reaver' : 'vanguard';
    const p2 = createInitialFighterState('local_bot', 2, 'Aether Bot', botArch);
    p1.ready = true;
    p2.ready = true;
    world.fighters.set('local_p1', p1);
    world.fighters.set('local_bot', p2);
    startMatchCountdown(world);
    this.localWorld = world;
    this.syncLocalPracticeUI();
  }

  private async handleLeaveRoom(): Promise<void> {
    this.isLocalPractice = false;
    this.localWorld = null;
    await this.net.leaveCurrentRoom(true);
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url.toString());
    this.ui.showHomeScreen();
  }

  private handleCombatEvent(evt: CombatEvent): void {
    switch (evt.type) {
      case 'countdown_tick':
        this.sound.play('countdown_tick');
        break;
      case 'match_start':
        this.sound.play('match_start');
        break;
      case 'jump':
        this.sound.play('jump');
        this.vfx?.spawnSmokeBurst(
          evt.x,
          Math.max(0.05, evt.y - 0.75),
          evt.z,
          4,
          evt.sourceSlot === 1 ? 0x38bdf8 : 0xfb923c,
          1.4
        );
        break;
      case 'dodge':
        this.sound.play('dodge');
        this.vfx?.spawnShockwaveRing(
          evt.x,
          evt.y - 0.7,
          evt.z,
          evt.sourceSlot === 1 ? 0x00f0ff : 0xff4d29,
          1.6,
          0.2
        );
        this.vfx?.spawnSmokeBurst(
          evt.x,
          Math.max(0.05, evt.y - 0.7),
          evt.z,
          5,
          evt.sourceSlot === 1 ? 0x00f0ff : 0xff4d29,
          2.0
        );
        break;
      case 'pickup':
        this.sound.play('pickup');
        break;
      case 'throw':
        this.sound.play('throw');
        break;
      case 'hit_light':
        this.sound.play('hit_light');
        this.vfx?.spawnHitSparks(evt.x, evt.y, evt.z, false, 0x00f0ff);
        this.sceneManager.triggerCameraShake(0.14, 0.12);
        if (evt.targetSlot === 1 || evt.targetSlot === 2) {
          this.fighterVisuals.get(evt.targetSlot)?.triggerHitFlash();
        }
        break;
      case 'hit_heavy':
      case 'hit_throw':
        this.sound.play(evt.type === 'hit_heavy' ? 'hit_heavy' : 'hit_throw');
        this.vfx?.spawnHitSparks(evt.x, evt.y, evt.z, true, 0xff4d29);
        this.sceneManager.triggerCameraShake(0.32, 0.22);
        if (evt.targetSlot === 1 || evt.targetSlot === 2) {
          this.fighterVisuals.get(evt.targetSlot)?.triggerHitFlash();
        }
        break;
      case 'ko':
        this.sound.play('ko');
        this.vfx?.spawnKOBlast(evt.x, evt.y, evt.z, evt.targetSlot);
        this.sceneManager.triggerCameraShake(0.55, 0.38);
        break;
      case 'respawn':
        this.sound.play('respawn');
        break;
      case 'match_end':
        this.sound.play('match_end');
        break;
    }
  }

  private computeBotInput(world: SimulationWorld): InputFrame {
    this.localBotSeq++;
    const bot = world.fighters.get('local_bot');
    const player = world.fighters.get('local_p1');
    if (!bot || !player || world.phase !== 'fighting') {
      return {
        seq: this.localBotSeq,
        moveX: 0,
        moveZ: 0,
        jumpPressed: false,
        dodgePressed: false,
        lightPressed: false,
        heavyPressed: false,
        recoveryPressed: false,
        weaponPressed: false,
      };
    }

    // Simple smart sparring AI: recover if off-stage, otherwise approach player and mix light/heavy attacks
    const offStage =
      Math.abs(bot.x) > SIM_CONFIG.ARENA_HALF_WIDTH_X - 0.6 ||
      Math.abs(bot.z) > SIM_CONFIG.ARENA_HALF_DEPTH_Z - 0.6;

    if (offStage) {
      const toCenterX = bot.x > 0.4 ? -1 : bot.x < -0.4 ? 1 : 0;
      const toCenterZ = bot.z > 0.4 ? -1 : bot.z < -0.4 ? 1 : 0;
      return {
        seq: this.localBotSeq,
        moveX: toCenterX,
        moveZ: toCenterZ,
        jumpPressed: bot.y < 0.2 && world.tick % 16 === 0,
        dodgePressed: false,
        lightPressed: false,
        heavyPressed: false,
        recoveryPressed: bot.y < -1.2 && bot.airJumpsLeft === 0,
        weaponPressed: false,
      };
    }

    const dx = player.x - bot.x;
    const dz = player.z - bot.z;
    const dist = Math.hypot(dx, dz);

    const moveX = dist > 1.35 ? (dx > 0.25 ? 1 : dx < -0.25 ? -1 : 0) : 0;
    const moveZ = dist > 1.35 ? (dz > 0.25 ? 1 : dz < -0.25 ? -1 : 0) : 0;

    const canPickWeapon =
      !bot.hasWeapon &&
      world.weapon.status === 'on_ground' &&
      Math.hypot(bot.x - world.weapon.x, bot.z - world.weapon.z) < 2.0;

    return {
      seq: this.localBotSeq,
      moveX,
      moveZ,
      jumpPressed: player.y > bot.y + 1.5 && world.tick % 30 === 0,
      dodgePressed: dist < 1.5 && player.state === 'attack_startup' && world.tick % 10 === 0,
      lightPressed: dist <= 1.75 && world.tick % 22 === 0,
      heavyPressed: dist <= 1.65 && player.damage >= 60 && world.tick % 45 === 0,
      recoveryPressed: false,
      weaponPressed: canPickWeapon,
    };
  }

  private buildLocalSummary(): RoomViewSummary | null {
    if (!this.localWorld) return null;
    const w = this.localWorld;
    const fighters = Array.from(w.fighters.values()).map((f) => ({
      sessionId: f.sessionId,
      slot: f.slot,
      nickname: f.nickname,
      archetype: f.archetype,
      ready: true,
      rematchVote: f.rematchVote,
      connected: true,
      stocks: f.stocks,
      damage: f.damage,
      hasWeapon: f.hasWeapon,
      x: f.x,
      y: f.y,
      z: f.z,
      state: f.state,
    }));

    return {
      roomCode: 'PRACTICE',
      phase: w.phase,
      serverTick: w.tick,
      countdownSeconds: Math.ceil(w.countdownTicks / 60),
      timerSeconds: Math.ceil(w.timerTicks / 60),
      winnerSlot: w.winnerSlot,
      winReason: w.winReason,
      disconnectGraceSeconds: 0,
      disconnectedSlot: 0,
      mySessionId: 'local_p1',
      mySlot: 1,
      fighters,
    };
  }

  private syncLocalPracticeUI(): void {
    const summary = this.buildLocalSummary();
    if (summary) {
      this.ui.updateFromRoomSummary(summary, true);
    }
  }

  private runFixedSteps(now: number): void {
    const frameDeltaMs = Math.min(250, Math.max(0, now - this.lastFixedTimeMs));
    this.lastFixedTimeMs = now;
    this.fixedAccumulatorMs += frameDeltaMs;

    let steps = 0;
    while (this.fixedAccumulatorMs >= this.STEP_MS && steps < this.MAX_STEPS_PER_FRAME) {
      this.fixedUpdateStep();
      this.fixedAccumulatorMs -= this.STEP_MS;
      steps++;
    }
    if (steps === this.MAX_STEPS_PER_FRAME) {
      this.fixedAccumulatorMs = 0;
    }
  }

  private fixedUpdateStep(): void {
    if (this.isLocalPractice && this.localWorld && this.ui.isOptionsOpen()) {
      return;
    }

    const input = this.kb.sampleGameplayInput(this.ui.isMenuBlockingGameplay());

    if (this.isLocalPractice && this.localWorld) {
      const botInput = this.computeBotInput(this.localWorld);
      stepWorldTick(
        this.localWorld,
        new Map([
          ['local_p1', input],
          ['local_bot', botInput],
        ])
      );
      for (const evt of this.localWorld.events) {
        if (evt.eventId > this.localLastEventId) {
          this.localLastEventId = evt.eventId;
          this.handleCombatEvent(evt);
        }
      }
      if (this.localWorld.tick % 2 === 0 || this.localWorld.phase === 'finished') {
        this.syncLocalPracticeUI();
      }
    } else {
      this.net.sendGameplayInput(input);
    }
  }

  private animate(now: number): void {
    this.runFixedSteps(now);
    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    const elapsedSec = now / 1000;

    this.ui.updateTopStatusBar(this.net.status, this.net.statusMessage, this.net.pingMs);
    this.arena.update(elapsedSec);
    this.vfx?.update(dt);

    // Update 3D Fighters & Camera
    let renderFighters: FighterRenderInput[] = [];
    let renderWeapon = { status: 'on_ground', x: 0, y: 0, z: 0, rotationY: elapsedSec };

    if (this.isLocalPractice && this.localWorld) {
      renderFighters = Array.from(this.localWorld.fighters.values()).map((f) => ({
        slot: f.slot,
        archetype: f.archetype,
        x: f.x,
        y: f.y,
        z: f.z,
        vx: f.vx,
        vy: f.vy,
        vz: f.vz,
        facingAngle: f.facingAngle,
        grounded: f.grounded,
        state: f.state,
        activeAttackId: f.activeAttackId,
        attackInstanceId: f.attackInstanceId,
        hasWeapon: f.hasWeapon,
        invulnerableTicks: f.invulnerableTicks,
        damage: f.damage,
      }));
      renderWeapon = {
        status: this.localWorld.weapon.status,
        x: this.localWorld.weapon.x,
        y: this.localWorld.weapon.y,
        z: this.localWorld.weapon.z,
        rotationY: this.localWorld.weapon.rotationY,
      };
    } else {
      const snap = this.net.getRenderSnapshot(dt);
      renderFighters = snap.fighters;
      renderWeapon = snap.weapon;
    }

    if (renderFighters.length === 0) {
      // Idle showcase on Home screen
      const p1Idle: FighterRenderInput = {
        slot: 1,
        archetype: this.ui.getSelectedArchetype(),
        x: -3.2,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        facingAngle: Math.PI / 2,
        grounded: true,
        state: 'idle',
        activeAttackId: '',
        attackInstanceId: 0,
        hasWeapon: true,
        invulnerableTicks: 0,
        damage: 0,
      };
      const p2Idle: FighterRenderInput = {
        slot: 2,
        archetype: this.ui.getSelectedArchetype() === 'vanguard' ? 'reaver' : 'vanguard',
        x: 3.2,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        facingAngle: -Math.PI / 2,
        grounded: true,
        state: 'idle',
        activeAttackId: '',
        attackInstanceId: 0,
        hasWeapon: false,
        invulnerableTicks: 0,
        damage: 0,
      };
      this.fighterVisuals.get(1)?.update(p1Idle, dt, elapsedSec);
      this.fighterVisuals.get(2)?.update(p2Idle, dt, elapsedSec);
      this.vfx?.updateWorldWeapon('on_ground', 0, 0, 0, elapsedSec * 1.4, elapsedSec);
      this.sceneManager.updateCameraForFighters(p1Idle, p2Idle, dt);
    } else {
      const f1State = renderFighters.find((f) => f.slot === 1) || null;
      const f2State = renderFighters.find((f) => f.slot === 2) || null;

      if (f1State) {
        this.fighterVisuals.get(1)?.update(f1State, dt, elapsedSec);
      }
      if (f2State) {
        this.fighterVisuals.get(2)?.update(f2State, dt, elapsedSec);
      }
      this.vfx?.updateWorldWeapon(
        renderWeapon.status,
        renderWeapon.x,
        renderWeapon.y,
        renderWeapon.z,
        renderWeapon.rotationY,
        elapsedSec
      );
      this.sceneManager.updateCameraForFighters(f1State, f2State, dt);
    }

    this.sceneManager.render();
    requestAnimationFrame((t) => this.animate(t));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  new RiftDuelGameApp();
});
