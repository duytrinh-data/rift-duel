import { CharacterArchetype, SIM_CONFIG } from '@shared/index.js';
import { SoundManager } from '../audio/SoundManager.js';
import { KeyboardController } from '../input/KeyboardController.js';
import { ConnectionStatus, RoomViewSummary } from '../net/NetworkClient.js';
import { SceneManager } from '../render/SceneManager.js';

export interface UIActions {
  onCreateRoom: (nickname: string, archetype: CharacterArchetype) => void;
  onJoinRoom: (roomCode: string, nickname: string, archetype: CharacterArchetype) => void;
  onStartLocalPractice: (nickname: string, archetype: CharacterArchetype) => void;
  onSelectArchetype: (archetype: CharacterArchetype) => void;
  onToggleReady: () => void;
  onVoteRematch: () => void;
  onLeaveRoom: () => void;
  onRetryAssetLoad: () => void;
}

export class UIManager {
  private root: HTMLElement;
  private sound: SoundManager;
  private kb: KeyboardController;
  private sceneManager: SceneManager;
  private actions: UIActions;

  private nickname = 'DấuSĩRift';
  private roomCodeInput = '';
  private selectedArchetype: CharacterArchetype = 'vanguard';

  private currentScreen:
    | 'loading'
    | 'webgl_error'
    | 'home'
    | 'lobby'
    | 'hud'
    | 'result' = 'loading';
  private optionsOpen = false;
  private bannerMessage = '';
  private bannerType: 'info' | 'error' | 'warn' = 'info';

  private lastSummary: RoomViewSummary | null = null;
  private isLocalPractice = false;
  private lastRenderSig = '';
  private prevP1Damage = 0;
  private prevP2Damage = 0;
  private prevCountdownText = '';
  private p1DmgBumpTimeout = 0;
  private p2DmgBumpTimeout = 0;
  private countdownPopTimeout = 0;

  constructor(
    root: HTMLElement,
    sound: SoundManager,
    kb: KeyboardController,
    sceneManager: SceneManager,
    actions: UIActions
  ) {
    this.root = root;
    this.sound = sound;
    this.kb = kb;
    this.sceneManager = sceneManager;
    this.actions = actions;

    const savedNick = localStorage.getItem('rift_duel_nickname');
    if (savedNick) {
      this.nickname = savedNick;
    } else {
      this.nickname = `Fighter${Math.floor(10 + Math.random() * 89)}`;
    }

    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam) {
      this.roomCodeInput = roomParam.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    }
  }

  public getInitialRoomCodeFromUrl(): string {
    return this.roomCodeInput;
  }

  public getNickname(): string {
    return this.nickname;
  }

  public getSelectedArchetype(): CharacterArchetype {
    return this.selectedArchetype;
  }

  public isOptionsOpen(): boolean {
    return this.optionsOpen;
  }

  public isMenuBlockingGameplay(): boolean {
    return (
      this.optionsOpen ||
      this.currentScreen === 'home' ||
      this.currentScreen === 'lobby' ||
      this.currentScreen === 'loading' ||
      this.currentScreen === 'result'
    );
  }

  public showBanner(msg: string, type: 'info' | 'error' | 'warn' = 'info'): void {
    this.bannerMessage = msg;
    this.bannerType = type;
    const alertEl = document.getElementById('status-alert');
    if (alertEl) {
      alertEl.className = `status-banner ${type}`;
      alertEl.style.display = msg ? '' : 'none';
      const span = alertEl.querySelector('span');
      if (span) {
        span.textContent = msg;
      } else {
        alertEl.textContent = msg;
      }
      return;
    }
    this.renderCurrentScreen();
  }

  public clearBanner(): void {
    this.bannerMessage = '';
    const alertEl = document.getElementById('status-alert');
    if (alertEl) {
      alertEl.style.display = 'none';
    }
  }

  public showWebGLError(): void {
    this.currentScreen = 'webgl_error';
    this.renderCurrentScreen();
  }

  public showLoadingProgress(percent: number, label: string, errorMsg?: string): void {
    this.currentScreen = 'loading';
    this.root.innerHTML = `
      <div class="top-status-bar">
        <div class="brand-mini"><span class="brand-diamond"></span> RIFT DUEL</div>
      </div>
      <div class="screen-center">
        <div class="rift-panel" style="max-width: 520px; text-align: center;">
          <h1 class="hero-title" style="font-size: 2.3rem;">RIFT DUEL</h1>
          <p class="hero-subtitle" style="margin-bottom: 14px;">${label}</p>
          <div class="loading-bar-track">
            <div class="loading-bar-fill" style="transform: scaleX(${Math.max(0, Math.min(1, percent / 100))});"></div>
          </div>
          <div style="font-family: var(--font-display); font-weight: 700; color: var(--aether-cyan);">
            ${percent}%
          </div>
          ${
            errorMsg
              ? `
            <div class="status-banner error" style="margin-top: 14px; text-align: left;">
              <span>${errorMsg}</span>
            </div>
            <button id="btn-retry-load" class="rift-btn primary" data-nav="true" data-autofocus="true" data-primary-action="true" style="width: 100%; margin-top: 12px;">
              <span>Thử Tải Lại Asset</span>
              <span class="kbd-hint">Enter</span>
            </button>
          `
              : ''
          }
        </div>
      </div>
    `;

    document.getElementById('btn-retry-load')?.addEventListener('click', () => {
      this.actions.onRetryAssetLoad();
    });
    this.kb.ensureInitialFocus();
  }

  public showHomeScreen(): void {
    this.currentScreen = 'home';
    this.isLocalPractice = false;
    this.lastSummary = null;
    this.lastRenderSig = '';
    this.renderCurrentScreen();
  }

  public updateFromRoomSummary(summary: RoomViewSummary, isLocalPractice = false): void {
    this.lastSummary = summary;
    this.isLocalPractice = isLocalPractice;

    const targetScreen =
      summary.phase === 'waiting' || summary.phase === 'lobby'
        ? 'lobby'
        : summary.phase === 'finished'
          ? 'result'
          : 'hud';

    if (this.currentScreen !== targetScreen) {
      this.currentScreen = targetScreen;
      this.lastRenderSig = '';
      this.clearBanner();
      this.renderCurrentScreen();
    } else if (this.currentScreen === 'lobby' || this.currentScreen === 'result') {
      const sig = JSON.stringify({
        roomCode: summary.roomCode,
        phase: summary.phase,
        winnerSlot: summary.winnerSlot,
        winReason: summary.winReason,
        optionsOpen: this.optionsOpen,
        bannerMessage: this.bannerMessage,
        bannerType: this.bannerType,
        fighters: summary.fighters.map((f) => ({
          slot: f.slot,
          nickname: f.nickname,
          archetype: f.archetype,
          ready: f.ready,
          rematchVote: f.rematchVote,
          connected: f.connected,
          stocks: f.stocks,
          damage: f.damage,
        })),
      });
      if (sig !== this.lastRenderSig) {
        this.lastRenderSig = sig;
        this.renderCurrentScreen();
      }
    } else if (this.currentScreen === 'hud') {
      this.updateHUDValuesOnly(summary);
    }
  }

  public updateTopStatusBar(status: ConnectionStatus, statusMsg: string, pingMs: number): void {
    const pillEl = document.getElementById('net-status-text');
    const dotEl = document.getElementById('net-status-dot');
    const pingEl = document.getElementById('net-ping-text');

    if (pillEl) {
      pillEl.textContent = this.isLocalPractice ? 'Chế độ Đấu Tập (Offline)' : statusMsg;
    }
    if (dotEl) {
      dotEl.className =
        'net-dot ' +
        (status === 'connected' || this.isLocalPractice
          ? ''
          : status === 'waking_server' || status === 'reconnecting'
            ? 'warn'
            : 'err');
    }
    if (pingEl) {
      if (this.isLocalPractice) {
        pingEl.textContent = '0 ms (Local)';
      } else if (pingMs > 0) {
        const quality = pingMs < 65 ? 'Tốt' : pingMs <= 150 ? 'TB' : 'Ping cao';
        pingEl.textContent = `${pingMs} ms (${quality})`;
      } else {
        pingEl.textContent = '-- ms';
      }
    }
  }

  public toggleOptionsModal(): void {
    this.optionsOpen = !this.optionsOpen;
    this.sound.play('ui_focus');
    this.renderCurrentScreen();
  }

  public handleGlobalShortcut(code: string, e: KeyboardEvent): boolean {
    if (this.optionsOpen) {
      if (code === 'KeyM') {
        e.preventDefault();
        this.sound.toggleMute();
        this.renderCurrentScreen();
        return true;
      }
      if (code === 'Minus' || code === 'NumpadSubtract') {
        e.preventDefault();
        this.sound.adjustVolume(-0.1);
        this.renderCurrentScreen();
        return true;
      }
      if (code === 'Equal' || code === 'NumpadAdd') {
        e.preventDefault();
        this.sound.adjustVolume(0.1);
        this.renderCurrentScreen();
        return true;
      }
      if (code === 'KeyG') {
        e.preventDefault();
        this.sceneManager.toggleQuality();
        this.renderCurrentScreen();
        return true;
      }
      if (code === 'KeyV') {
        e.preventDefault();
        this.sceneManager.toggleScreenShake();
        this.renderCurrentScreen();
        return true;
      }
      return false;
    }

    const activeEl = document.activeElement as HTMLInputElement | null;
    const activeTag = activeEl?.tagName?.toLowerCase();
    const isTyping =
      (activeTag === 'input' && !activeEl?.readOnly) || activeTag === 'textarea';

    if (this.currentScreen === 'lobby' && !isTyping) {
      if (code === 'KeyC') {
        e.preventDefault();
        this.copyInviteLink();
        return true;
      }
      if (code === 'Digit1') {
        e.preventDefault();
        this.selectedArchetype = 'vanguard';
        this.actions.onSelectArchetype('vanguard');
        this.sound.play('ui_focus');
        return true;
      }
      if (code === 'Digit2') {
        e.preventDefault();
        this.selectedArchetype = 'reaver';
        this.actions.onSelectArchetype('reaver');
        this.sound.play('ui_focus');
        return true;
      }
      if (code === 'KeyR') {
        e.preventDefault();
        this.sound.play('ui_confirm');
        this.actions.onToggleReady();
        return true;
      }
    }

    if (this.currentScreen === 'result' && !isTyping) {
      if (code === 'KeyR') {
        e.preventDefault();
        this.sound.play('ui_confirm');
        this.actions.onVoteRematch();
        return true;
      }
      if (code === 'KeyL') {
        e.preventDefault();
        this.sound.play('ui_confirm');
        this.actions.onLeaveRoom();
        return true;
      }
    }

    return false;
  }

  private renderTopBarHtml(): string {
    const muted = this.sound.isMuted();
    const volPct = Math.round(this.sound.getVolume() * 100);
    return `
      <header class="top-status-bar">
        <div class="brand-mini">
          <span class="brand-diamond"></span>
          <span>RIFT DUEL</span>
        </div>
        <div class="net-pill-group">
          <div class="net-pill">
            <span id="net-status-dot" class="net-dot"></span>
            <span id="net-status-text">Sẵn sàng</span>
          </div>
          <div class="net-pill">
            <span>Ping:</span>
            <strong id="net-ping-text">-- ms</strong>
          </div>
          <button id="btn-top-options" class="net-pill" data-nav="true" style="cursor: pointer; color: var(--ivory-ink);">
            <span>Âm thanh: ${muted ? 'TẮT' : `${volPct}%`} · Tùy chọn</span>
            <span class="kbd-hint">Esc</span>
          </button>
        </div>
      </header>
    `;
  }

  private renderOptionsModalHtml(): string {
    if (!this.optionsOpen) return '';
    const muted = this.sound.isMuted();
    const volPct = Math.round(this.sound.getVolume() * 100);
    const quality = this.sceneManager.getQuality();
    const shake = this.sceneManager.isScreenShakeEnabled();

    return `
      <div class="screen-center" style="position: fixed; inset: 0; background: rgba(7, 9, 19, 0.78); z-index: 50;">
        <div class="rift-panel" style="max-width: 520px;">
          <div class="hero-header">
            <h2 class="hero-title" style="font-size: 2rem;">TÙY CHỌN TRẬN ĐẤU</h2>
            <p class="hero-subtitle">Mở menu này không làm tạm dừng trận đấu online của đối thủ</p>
          </div>
          <div style="display: flex; flex-direction: column; gap: 12px;">
            <button id="opt-mute" class="rift-btn" data-nav="true" data-autofocus="true">
              <span>Âm thanh: <strong>${muted ? 'ĐANG TẮT (MUTE)' : 'ĐANG BẬT'}</strong></span>
              <span class="kbd-hint">Phím M / Enter</span>
            </button>
            <div class="btn-row" style="margin-top: 0;">
              <button id="opt-vol-down" class="rift-btn" data-nav="true">
                <span>Giảm Âm Lượng (${volPct}%)</span>
                <span class="kbd-hint">-</span>
              </button>
              <button id="opt-vol-up" class="rift-btn" data-nav="true">
                <span>Tăng Âm Lượng (${volPct}%)</span>
                <span class="kbd-hint">+</span>
              </button>
            </div>
            <button id="opt-quality" class="rift-btn" data-nav="true">
              <span>Chế độ Đồ họa: <strong>${quality === 'high' ? 'CAO (Bóng đổ + Hạt)' : 'THẤP (Tối ưu FPS)'}</strong></span>
              <span class="kbd-hint">Phím G / Enter</span>
            </button>
            <button id="opt-shake" class="rift-btn" data-nav="true">
              <span>Rung Camera khi va chạm: <strong>${shake ? 'BẬT' : 'TẮT'}</strong></span>
              <span class="kbd-hint">Phím V / Enter</span>
            </button>
            ${
              this.currentScreen !== 'home'
                ? `
              <button id="opt-leave" class="rift-btn crimson" data-nav="true">
                <span>Rời Phòng Đấu Về Trang Chủ</span>
                <span class="kbd-hint">Enter</span>
              </button>
            `
                : ''
            }
            <button id="opt-close" class="rift-btn primary" data-nav="true" data-primary-action="true">
              <span>Quay Lại Trận Đấu</span>
              <span class="kbd-hint">Esc / Enter</span>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  public renderCurrentScreen(): void {
    const activeId = (document.activeElement as HTMLElement | null)?.id;

    if (this.currentScreen === 'webgl_error') {
      this.root.innerHTML = `
        <div class="screen-center">
          <div class="rift-panel" style="max-width: 540px; text-align: center;">
            <h1 class="hero-title" style="font-size: 2.2rem;">KHÔNG HỖ TRỢ WEBGL</h1>
            <p class="hero-subtitle" style="margin-top: 12px;">
              Trình duyệt hoặc thiết bị của bạn hiện đang tắt tăng tốc phần cứng WebGL.
              Hãy bật Hardware Acceleration trong cài đặt trình duyệt rồi tải lại trang.
            </p>
          </div>
        </div>
      `;
      return;
    }

    if (this.currentScreen === 'home') {
      const hasUrlRoom = Boolean(this.roomCodeInput);
      this.root.innerHTML = `
        ${this.renderTopBarHtml()}
        <main class="screen-center">
          <section class="rift-panel" aria-label="Menu Chính Rift Duel">
            <div class="hero-header">
              <h1 class="hero-title">RIFT DUEL</h1>
              <p class="hero-subtitle">
                Đấu trường đối kháng 3D thời gian thực · Tích sát thương · Đánh văng khỏi sàn đấu
              </p>
            </div>

            <div
              id="status-alert"
              class="status-banner ${this.bannerType}"
              role="alert"
              style="${this.bannerMessage ? '' : 'display: none;'}"
            >
              <span>${this.bannerMessage}</span>
            </div>

            <div class="form-row">
              <div class="field-group">
                <label class="field-label" for="nickname-input">BIỆT DANH ĐẤU SĨ (NICKNAME)</label>
                <input
                  id="nickname-input"
                  class="rift-input"
                  type="text"
                  maxlength="16"
                  value="${this.escapeAttr(this.nickname)}"
                  placeholder="Nhập tên của bạn..."
                  data-nav="true"
                />
              </div>
              <div class="field-group">
                <label class="field-label" for="room-code-input">MÃ PHÒNG MỜI (NẾU CÓ)</label>
                <input
                  id="room-code-input"
                  class="rift-input"
                  type="text"
                  maxlength="8"
                  value="${this.escapeAttr(this.roomCodeInput)}"
                  placeholder="VD: ABC123"
                  style="text-transform: uppercase;"
                  data-nav="true"
                />
              </div>
            </div>

            <div class="field-group" style="margin-bottom: 14px;">
              <span class="field-label">CHỌN NGOẠI HÌNH ĐẤU SĨ KHỞI ĐẦU</span>
              <div class="archetype-selector">
                <button
                  id="home-arch-vanguard"
                  type="button"
                  class="arch-btn ${this.selectedArchetype === 'vanguard' ? 'selected-cyan' : ''}"
                  data-nav="true"
                >
                  <div style="font-family: var(--font-display); font-weight: 700; color: var(--aether-cyan);">
                    AETHER VANGUARD
                  </div>
                  <div style="font-size: 0.8rem; color: var(--muted-steel);">
                    Hiệp Sĩ Giáp Lam Quang (Cyan)
                  </div>
                </button>
                <button
                  id="home-arch-reaver"
                  type="button"
                  class="arch-btn ${this.selectedArchetype === 'reaver' ? 'selected-crimson' : ''}"
                  data-nav="true"
                >
                  <div style="font-family: var(--font-display); font-weight: 700; color: var(--ember-crimson);">
                    CRIMSON REAVER
                  </div>
                  <div style="font-size: 0.8rem; color: var(--muted-steel);">
                    Chiến Binh Giáp Hỏa Ngục (Đỏ Cam)
                  </div>
                </button>
              </div>
            </div>

            <div class="btn-row">
              <button
                id="btn-create-room"
                type="button"
                class="rift-btn ${hasUrlRoom ? '' : 'primary'}"
                data-nav="true"
                ${!hasUrlRoom ? 'data-autofocus="true" data-primary-action="true"' : ''}
              >
                <span>Tạo Phòng Đấu Mới</span>
                <span class="kbd-hint">Enter</span>
              </button>
              <button
                id="btn-join-room"
                type="button"
                class="rift-btn ${hasUrlRoom ? 'gold' : 'crimson'}"
                data-nav="true"
                ${hasUrlRoom ? 'data-autofocus="true" data-primary-action="true"' : ''}
              >
                <span>${hasUrlRoom ? `Vào Phòng ${this.escapeAttr(this.roomCodeInput)}` : 'Vào Phòng Theo Mã'}</span>
                <span class="kbd-hint">Enter</span>
              </button>
            </div>

            <div style="margin-top: 12px;">
              <button
                id="btn-practice-local"
                type="button"
                class="rift-btn"
                style="width: 100%;"
                data-nav="true"
              >
                <span>Đấu Tập Nhanh Với Máy 3D (Kiểm tra điều khiển & combo ngay)</span>
                <span class="kbd-hint">Enter</span>
              </button>
            </div>

            <div class="controls-strip">
              <span class="ctrl-item"><span class="kbd-hint">Tab / ↑↓←→</span> Di chuyển menu</span>
              <span class="ctrl-item"><span class="kbd-hint">Enter</span> Chọn</span>
              <span class="ctrl-item"><span class="kbd-hint">W A S D</span> Di chuyển 3D</span>
              <span class="ctrl-item"><span class="kbd-hint">Space</span> Nhảy (x3)</span>
              <span class="ctrl-item"><span class="kbd-hint">Shift</span> Né (Dodge)</span>
              <span class="ctrl-item"><span class="kbd-hint">J / K / L</span> Đánh Nhẹ / Mạnh / Recovery</span>
              <span class="ctrl-item"><span class="kbd-hint">E</span> Nhặt / Ném Kiếm</span>
            </div>
          </section>
        </main>
        ${this.renderOptionsModalHtml()}
      `;

      this.bindHomeEvents();
      this.bindOptionsEvents();
      this.restoreOrEnsureFocus(activeId);
      return;
    }

    if (this.currentScreen === 'lobby' && this.lastSummary) {
      const s = this.lastSummary;
      const p1 = s.fighters.find((f) => f.slot === 1);
      const p2 = s.fighters.find((f) => f.slot === 2);
      const me = s.fighters.find((f) => f.sessionId === s.mySessionId);
      const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(s.roomCode)}`;
      const bothPresent = s.fighters.length === 2;

      this.root.innerHTML = `
        ${this.renderTopBarHtml()}
        <main class="screen-center">
          <section class="rift-panel" aria-label="Phòng Chờ Trận Đấu">
            <div class="hero-header" style="margin-bottom: 14px;">
              <h2 class="hero-title" style="font-size: 2.2rem;">PHÒNG ĐẤU: ${this.escapeAttr(s.roomCode)}</h2>
              <p class="hero-subtitle">
                ${
                  bothPresent
                    ? 'Đã đủ 2 đấu sĩ! Chọn ngoại hình và bấm SẴN SÀNG (READY) để bắt đầu.'
                    : 'Gửi link phòng bên dưới cho bạn chơi mở trên máy thứ hai.'
                }
              </p>
            </div>

            <div
              id="status-alert"
              class="status-banner ${this.bannerType}"
              role="alert"
              style="${this.bannerMessage ? '' : 'display: none;'}"
            >
              <span>${this.bannerMessage}</span>
            </div>

            <div class="invite-box">
              <div>
                <div class="field-label">MÃ PHÒNG</div>
                <div id="lobby-room-code" class="room-code-badge">${this.escapeAttr(s.roomCode)}</div>
              </div>
              <input
                id="invite-link-input"
                class="invite-url-input"
                type="text"
                readonly
                value="${this.escapeAttr(inviteUrl)}"
                aria-label="Link mời vào phòng"
                data-nav="true"
              />
              <button id="btn-copy-link" type="button" class="rift-btn primary" data-nav="true">
                <span>Copy Link Mời</span>
                <span class="kbd-hint">Phím C</span>
              </button>
            </div>

            <div class="lobby-slots">
              <div class="slot-card p1">
                <div class="slot-header">
                  <span class="slot-name" style="color: var(--aether-cyan);">
                    P1 · ${p1 ? this.escapeAttr(p1.nickname) : 'Đang chờ...'}
                  </span>
                  <span class="ready-badge ${p1?.ready ? 'is-ready' : ''}">
                    ${p1 ? (p1.ready ? 'SẴN SÀNG' : 'CHƯA READY') : 'TRỐNG'}
                  </span>
                </div>
                <div style="font-size: 0.86rem; color: var(--muted-steel);">
                  Ngoại hình: <strong>${p1?.archetype === 'reaver' ? 'Crimson Reaver' : 'Aether Vanguard'}</strong>
                </div>
              </div>

              <div class="slot-card p2">
                <div class="slot-header">
                  <span class="slot-name" style="color: var(--ember-crimson);">
                    P2 · ${p2 ? this.escapeAttr(p2.nickname) : 'Đang chờ người thứ 2...'}
                  </span>
                  <span class="ready-badge ${p2?.ready ? 'is-ready' : ''}">
                    ${p2 ? (p2.ready ? 'SẴN SÀNG' : 'CHƯA READY') : 'CHỜ VÀO'}
                  </span>
                </div>
                <div style="font-size: 0.86rem; color: var(--muted-steel);">
                  Ngoại hình: <strong>${p2 ? (p2.archetype === 'reaver' ? 'Crimson Reaver' : 'Aether Vanguard') : '--'}</strong>
                </div>
              </div>
            </div>

            <div class="field-group" style="margin-bottom: 16px;">
              <span class="field-label">ĐỔI NGOẠI HÌNH ĐẤU SĨ CỦA BẠN (PHÍM 1 HOẶC 2)</span>
              <div class="archetype-selector">
                <button
                  id="lobby-arch-vanguard"
                  type="button"
                  class="arch-btn ${me?.archetype === 'vanguard' ? 'selected-cyan' : ''}"
                  data-nav="true"
                >
                  <strong style="color: var(--aether-cyan);">[1] Aether Vanguard</strong>
                  <div style="font-size: 0.78rem; color: var(--muted-steel);">Giáp Hiệp Sĩ Cyan</div>
                </button>
                <button
                  id="lobby-arch-reaver"
                  type="button"
                  class="arch-btn ${me?.archetype === 'reaver' ? 'selected-crimson' : ''}"
                  data-nav="true"
                >
                  <strong style="color: var(--ember-crimson);">[2] Crimson Reaver</strong>
                  <div style="font-size: 0.78rem; color: var(--muted-steel);">Giáp Chiến Binh Đỏ Cam</div>
                </button>
              </div>
            </div>

            <div class="btn-row">
              <button
                id="btn-toggle-ready"
                type="button"
                class="rift-btn ${me?.ready ? 'gold' : 'primary'}"
                data-nav="true"
                data-autofocus="true"
                data-primary-action="true"
              >
                <span>${me?.ready ? 'ĐÃ SẴN SÀNG (Bấm để Hủy)' : 'BẤM SẴN SÀNG (READY)'}</span>
                <span class="kbd-hint">Phím R / Enter</span>
              </button>
              <button id="btn-leave-room" type="button" class="rift-btn crimson" data-nav="true">
                <span>Rời Phòng</span>
                <span class="kbd-hint">Enter</span>
              </button>
            </div>
          </section>
        </main>
        ${this.renderOptionsModalHtml()}
      `;

      this.bindLobbyEvents();
      this.bindOptionsEvents();
      this.restoreOrEnsureFocus(activeId);
      return;
    }

    if (this.currentScreen === 'hud' && this.lastSummary) {
      this.root.innerHTML = `
        ${this.renderTopBarHtml()}
        <div class="hud-wrapper">
          <div class="hud-top">
            <div style="width: 140px;"></div>
            <div class="match-timer-box">
              <div id="hud-timer" class="match-timer-val">04:00</div>
              <div id="hud-room-tag" class="match-room-tag">PHÒNG ${this.escapeAttr(this.lastSummary.roomCode)}</div>
            </div>
            <div style="width: 140px;"></div>
          </div>

          <div id="hud-center-banner" class="center-announcement"></div>

          <div class="hud-bottom">
            <div id="hud-card-p1" class="fighter-hud-card p1">
              <div class="fighter-hud-info">
                <div id="hud-p1-name" class="fighter-hud-name" style="color: var(--aether-cyan);">P1</div>
                <div id="hud-p1-stocks" class="stocks-row">
                  <span class="stock-orb active-p1" data-stock-active="true"></span>
                  <span class="stock-orb active-p1" data-stock-active="true"></span>
                  <span class="stock-orb active-p1" data-stock-active="true"></span>
                </div>
                <div id="hud-p1-weapon" style="font-size: 0.74rem; color: var(--muted-steel);">Tay không</div>
              </div>
              <div id="hud-p1-dmg" class="damage-readout">0%</div>
            </div>

            <div id="hud-card-p2" class="fighter-hud-card p2">
              <div id="hud-p2-dmg" class="damage-readout">0%</div>
              <div class="fighter-hud-info" style="align-items: flex-end;">
                <div id="hud-p2-name" class="fighter-hud-name" style="color: var(--ember-crimson);">P2</div>
                <div id="hud-p2-stocks" class="stocks-row">
                  <span class="stock-orb active-p2" data-stock-active="true"></span>
                  <span class="stock-orb active-p2" data-stock-active="true"></span>
                  <span class="stock-orb active-p2" data-stock-active="true"></span>
                </div>
                <div id="hud-p2-weapon" style="font-size: 0.74rem; color: var(--muted-steel);">Tay không</div>
              </div>
            </div>
          </div>
        </div>
        ${this.renderOptionsModalHtml()}
      `;

      this.updateHUDValuesOnly(this.lastSummary);
      this.bindOptionsEvents();
      if (this.optionsOpen) {
        this.restoreOrEnsureFocus(activeId);
      }
      return;
    }

    if (this.currentScreen === 'result' && this.lastSummary) {
      const s = this.lastSummary;
      const p1 = s.fighters.find((f) => f.slot === 1);
      const p2 = s.fighters.find((f) => f.slot === 2);
      const me = s.fighters.find((f) => f.sessionId === s.mySessionId);
      const winner = s.fighters.find((f) => f.slot === s.winnerSlot);

      const titleText =
        s.winnerSlot === 0 || s.winReason === 'DRAW'
          ? 'HÒA TRẬN (DRAW)!'
          : `CHIẾN THẮNG: ${winner ? this.escapeAttr(winner.nickname) : `Đấu sĩ ${s.winnerSlot}`}`;

      const reasonMap: Record<string, string> = {
        KO: 'Áp đảo hoàn toàn — Đánh văng hết 3 Stocks của đối thủ',
        TIMEOUT: 'Hết thời gian thi đấu — Phân thắng bại theo Stocks & Damage',
        FORFEIT: 'Đối thủ mất kết nối quá 15 giây (Thắng xử cuộc)',
        DRAW: 'Cả hai mất mạng cuối trong cùng tích tắc hoặc cân bằng điểm tuyệt đối',
      };

      const rematchCount = s.fighters.filter((f) => f.rematchVote).length;

      this.root.innerHTML = `
        ${this.renderTopBarHtml()}
        <main class="screen-center">
          <section class="rift-panel" aria-label="Kết Quả Trận Đấu" style="max-width: 640px; text-align: center;">
            <div class="hero-header">
              <h2 id="result-winner-title" class="hero-title" style="font-size: 2.5rem;">${titleText}</h2>
              <p class="hero-subtitle">${reasonMap[s.winReason] || 'Trận đấu đã kết thúc'}</p>
            </div>

            <div class="lobby-slots">
              <div class="slot-card p1">
                <div class="slot-name" style="color: var(--aether-cyan);">${p1 ? this.escapeAttr(p1.nickname) : 'P1'}</div>
                <div style="margin-top: 8px; font-size: 0.9rem;">
                  Stocks còn lại: <strong>${p1?.stocks ?? 0}</strong> · Damage: <strong>${p1?.damage ?? 0}%</strong>
                </div>
                <div style="margin-top: 6px; font-size: 0.8rem; color: var(--emerald-ok);">
                  ${p1?.rematchVote ? '✓ Đã đồng ý đấu lại' : 'Đang chờ xác nhận...'}
                </div>
              </div>

              <div class="slot-card p2">
                <div class="slot-name" style="color: var(--ember-crimson);">${p2 ? this.escapeAttr(p2.nickname) : 'P2'}</div>
                <div style="margin-top: 8px; font-size: 0.9rem;">
                  Stocks còn lại: <strong>${p2?.stocks ?? 0}</strong> · Damage: <strong>${p2?.damage ?? 0}%</strong>
                </div>
                <div style="margin-top: 6px; font-size: 0.8rem; color: var(--emerald-ok);">
                  ${p2?.rematchVote ? '✓ Đã đồng ý đấu lại' : 'Đang chờ xác nhận...'}
                </div>
              </div>
            </div>

            <div class="btn-row">
              <button
                id="btn-vote-rematch"
                type="button"
                class="rift-btn gold"
                data-nav="true"
                data-autofocus="true"
                data-primary-action="true"
              >
                <span>${me?.rematchVote ? `Đã Chọn Đấu Lại (${rematchCount}/2)` : `Đấu Lại (Rematch ${rematchCount}/2)`}</span>
                <span class="kbd-hint">Phím R / Enter</span>
              </button>
              <button id="btn-back-home" type="button" class="rift-btn" data-nav="true">
                <span>Về Trang Chủ</span>
                <span class="kbd-hint">Phím L / Enter</span>
              </button>
            </div>
          </section>
        </main>
        ${this.renderOptionsModalHtml()}
      `;

      document.getElementById('btn-vote-rematch')?.addEventListener('click', () => {
        this.actions.onVoteRematch();
      });
      document.getElementById('btn-back-home')?.addEventListener('click', () => {
        this.actions.onLeaveRoom();
      });

      this.bindOptionsEvents();
      this.restoreOrEnsureFocus(activeId);
    }
  }

  private updateHUDValuesOnly(s: RoomViewSummary): void {
    const timerEl = document.getElementById('hud-timer');
    if (timerEl) {
      const mins = Math.floor(s.timerSeconds / 60);
      const secs = s.timerSeconds % 60;
      timerEl.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    const centerEl = document.getElementById('hud-center-banner');
    if (centerEl) {
      if (s.phase === 'countdown') {
        const nextText = s.countdownSeconds > 0 ? String(s.countdownSeconds) : 'CHIẾN ĐẤU!';
        if (nextText !== this.prevCountdownText) {
          this.prevCountdownText = nextText;
          centerEl.textContent = nextText;
          centerEl.classList.add('countdown-pop');
          if (this.countdownPopTimeout) window.clearTimeout(this.countdownPopTimeout);
          this.countdownPopTimeout = window.setTimeout(() => {
            centerEl.classList.remove('countdown-pop');
          }, 150);
        }
      } else if (s.phase === 'paused_disconnect') {
        this.prevCountdownText = '';
        centerEl.innerHTML = `
          <div style="font-size: 1.7rem; background: rgba(7,9,19,0.9); padding: 16px 26px; border-radius: 10px; border: 1px solid var(--runic-gold);">
            ĐỐI THỦ MẤT KẾT NỐI — Chờ kết nối lại (${s.disconnectGraceSeconds}s)...
          </div>
        `;
      } else {
        this.prevCountdownText = '';
        centerEl.textContent = '';
      }
    }

    const p1 = s.fighters.find((f) => f.slot === 1);
    const p2 = s.fighters.find((f) => f.slot === 2);

    if (p1) {
      const n1 = document.getElementById('hud-p1-name');
      const d1 = document.getElementById('hud-p1-dmg');
      const c1 = document.getElementById('hud-card-p1');
      const st1 = document.getElementById('hud-p1-stocks');
      const w1 = document.getElementById('hud-p1-weapon');
      if (n1) n1.textContent = `P1 · ${p1.nickname}`;
      if (d1) {
        d1.textContent = `${p1.damage}%`;
        d1.style.color = this.getDamageColor(p1.damage);
        if (p1.damage > this.prevP1Damage) {
          d1.classList.add('dmg-bump');
          c1?.classList.add('hud-hit-shake');
          if (this.p1DmgBumpTimeout) window.clearTimeout(this.p1DmgBumpTimeout);
          this.p1DmgBumpTimeout = window.setTimeout(() => {
            d1.classList.remove('dmg-bump');
            c1?.classList.remove('hud-hit-shake');
          }, 150);
        }
        this.prevP1Damage = p1.damage;
      }
      if (st1) {
        const orbs = st1.querySelectorAll('.stock-orb');
        orbs.forEach((orb, i) => {
          const active = i < p1.stocks;
          orb.classList.toggle('active-p1', active);
          orb.setAttribute('data-stock-active', String(active));
        });
      }
      if (w1) {
        w1.textContent = p1.hasWeapon ? '⚔ Đang cầm RIFT BLADE [E: Ném]' : 'Tay không [E: Nhặt kiếm]';
        w1.style.color = p1.hasWeapon ? 'var(--runic-gold)' : 'var(--muted-steel)';
      }
    }

    if (p2) {
      const n2 = document.getElementById('hud-p2-name');
      const d2 = document.getElementById('hud-p2-dmg');
      const c2 = document.getElementById('hud-card-p2');
      const st2 = document.getElementById('hud-p2-stocks');
      const w2 = document.getElementById('hud-p2-weapon');
      if (n2) n2.textContent = `P2 · ${p2.nickname}`;
      if (d2) {
        d2.textContent = `${p2.damage}%`;
        d2.style.color = this.getDamageColor(p2.damage);
        if (p2.damage > this.prevP2Damage) {
          d2.classList.add('dmg-bump');
          c2?.classList.add('hud-hit-shake');
          if (this.p2DmgBumpTimeout) window.clearTimeout(this.p2DmgBumpTimeout);
          this.p2DmgBumpTimeout = window.setTimeout(() => {
            d2.classList.remove('dmg-bump');
            c2?.classList.remove('hud-hit-shake');
          }, 150);
        }
        this.prevP2Damage = p2.damage;
      }
      if (st2) {
        const orbs = st2.querySelectorAll('.stock-orb');
        orbs.forEach((orb, i) => {
          const active = i < p2.stocks;
          orb.classList.toggle('active-p2', active);
          orb.setAttribute('data-stock-active', String(active));
        });
      }
      if (w2) {
        w2.textContent = p2.hasWeapon ? '⚔ Đang cầm RIFT BLADE' : 'Tay không';
        w2.style.color = p2.hasWeapon ? 'var(--runic-gold)' : 'var(--muted-steel)';
      }
    }
  }

  private getDamageColor(dmg: number): string {
    if (dmg < 45) return '#f8fafc';
    if (dmg < 90) return '#fde047';
    if (dmg < 140) return '#fb923c';
    return '#ef4444';
  }

  private bindHomeEvents(): void {
    const nickInput = document.getElementById('nickname-input') as HTMLInputElement | null;
    const codeInput = document.getElementById('room-code-input') as HTMLInputElement | null;

    nickInput?.addEventListener('input', () => {
      this.nickname = nickInput.value.trim().slice(0, 16) || 'Fighter';
      localStorage.setItem('rift_duel_nickname', this.nickname);
    });

    codeInput?.addEventListener('input', () => {
      this.roomCodeInput = codeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      codeInput.value = this.roomCodeInput;
    });

    document.getElementById('home-arch-vanguard')?.addEventListener('click', () => {
      this.selectedArchetype = 'vanguard';
      this.renderCurrentScreen();
    });

    document.getElementById('home-arch-reaver')?.addEventListener('click', () => {
      this.selectedArchetype = 'reaver';
      this.renderCurrentScreen();
    });

    document.getElementById('btn-create-room')?.addEventListener('click', () => {
      this.clearBanner();
      this.actions.onCreateRoom(this.nickname, this.selectedArchetype);
    });

    document.getElementById('btn-join-room')?.addEventListener('click', () => {
      this.clearBanner();
      this.actions.onJoinRoom(this.roomCodeInput, this.nickname, this.selectedArchetype);
    });

    document.getElementById('btn-practice-local')?.addEventListener('click', () => {
      this.clearBanner();
      this.actions.onStartLocalPractice(this.nickname, this.selectedArchetype);
    });
  }

  private bindLobbyEvents(): void {
    document.getElementById('btn-copy-link')?.addEventListener('click', () => {
      this.copyInviteLink();
    });

    document.getElementById('lobby-arch-vanguard')?.addEventListener('click', () => {
      this.selectedArchetype = 'vanguard';
      this.actions.onSelectArchetype('vanguard');
    });

    document.getElementById('lobby-arch-reaver')?.addEventListener('click', () => {
      this.selectedArchetype = 'reaver';
      this.actions.onSelectArchetype('reaver');
    });

    document.getElementById('btn-toggle-ready')?.addEventListener('click', () => {
      this.actions.onToggleReady();
    });

    document.getElementById('btn-leave-room')?.addEventListener('click', () => {
      this.actions.onLeaveRoom();
    });
  }

  private bindOptionsEvents(): void {
    document.getElementById('btn-top-options')?.addEventListener('click', () => {
      this.toggleOptionsModal();
    });

    document.getElementById('opt-mute')?.addEventListener('click', () => {
      this.sound.toggleMute();
      this.renderCurrentScreen();
    });

    document.getElementById('opt-vol-down')?.addEventListener('click', () => {
      this.sound.adjustVolume(-0.1);
      this.renderCurrentScreen();
    });

    document.getElementById('opt-vol-up')?.addEventListener('click', () => {
      this.sound.adjustVolume(0.1);
      this.renderCurrentScreen();
    });

    document.getElementById('opt-quality')?.addEventListener('click', () => {
      this.sceneManager.toggleQuality();
      this.renderCurrentScreen();
    });

    document.getElementById('opt-shake')?.addEventListener('click', () => {
      this.sceneManager.toggleScreenShake();
      this.renderCurrentScreen();
    });

    document.getElementById('opt-leave')?.addEventListener('click', () => {
      this.optionsOpen = false;
      this.actions.onLeaveRoom();
    });

    document.getElementById('opt-close')?.addEventListener('click', () => {
      this.optionsOpen = false;
      this.renderCurrentScreen();
    });
  }

  private copyInviteLink(): void {
    const input = document.getElementById('invite-link-input') as HTMLInputElement | null;
    const url = input?.value || window.location.href;
    if (input) {
      input.focus();
      input.select();
    }
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(url);
    }
    this.sound.play('ui_confirm');
    this.showBanner('Đã sao chép link mời! Gửi link này cho người chơi thứ hai.', 'info');
  }

  private restoreOrEnsureFocus(previousId?: string): void {
    if (previousId) {
      const prevEl = document.getElementById(previousId);
      if (prevEl && prevEl.offsetParent !== null) {
        prevEl.focus();
        return;
      }
    }
    this.kb.ensureInitialFocus();
  }

  private escapeAttr(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
