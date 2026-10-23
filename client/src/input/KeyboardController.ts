import { InputFrame } from '@shared/index.js';
import { SoundManager } from '../audio/SoundManager.js';

export class KeyboardController {
  private heldCodes = new Set<string>();
  private latchedCodes = new Set<string>();
  private seq = 0;
  private sound: SoundManager;
  private onEscapeToggle?: () => void;
  private onShortcutKey?: (code: string, e: KeyboardEvent) => boolean;

  constructor(sound: SoundManager) {
    this.sound = sound;
    this.bindEvents();
  }

  public setCallbacks(
    onEscapeToggle: () => void,
    onShortcutKey: (code: string, e: KeyboardEvent) => boolean
  ): void {
    this.onEscapeToggle = onEscapeToggle;
    this.onShortcutKey = onShortcutKey;
  }

  private bindEvents(): void {
    window.addEventListener('keydown', (e) => this.handleKeyDown(e));
    window.addEventListener('keyup', (e) => this.handleKeyUp(e));
    window.addEventListener('blur', () => this.clearAllKeys());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.clearAllKeys();
      }
    });
  }

  public clearAllKeys(): void {
    this.heldCodes.clear();
    this.latchedCodes.clear();
  }

  private isTypingInInput(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      const inp = target as HTMLInputElement;
      if (inp.readOnly) return false;
      return inp.type === 'text' || inp.type === 'search' || !inp.type;
    }
    return false;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    // Unlock audio on first valid keyboard press
    this.sound.unlockFromGesture();

    const code = e.code;
    const typing = this.isTypingInInput(e.target);

    if (code === 'Escape') {
      e.preventDefault();
      if (typing && e.target instanceof HTMLElement) {
        e.target.blur();
      }
      this.onEscapeToggle?.();
      return;
    }

    // Check global menu navigation & shortcuts when menu elements exist
    if (this.onShortcutKey && this.onShortcutKey(code, e)) {
      return;
    }

    // Handle keyboard focus navigation (ArrowUp/Down/Left/Right & Enter) when a menu is open
    const focusables = this.getVisibleFocusableElements();
    if (focusables.length > 0) {
      if (code === 'ArrowDown' || code === 'ArrowRight' || code === 'ArrowUp' || code === 'ArrowLeft') {
        // Only intercept Left/Right if not actively editing text inside an input
        if (!typing || code === 'ArrowDown' || code === 'ArrowUp') {
          e.preventDefault();
          const dir = code === 'ArrowDown' || code === 'ArrowRight' ? 1 : -1;
          this.moveFocus(focusables, dir);
          return;
        }
      }

      if (code === 'Enter') {
        const active = document.activeElement as HTMLElement | null;
        if (active && focusables.includes(active)) {
          if (active.tagName.toLowerCase() === 'input') {
            // Pressing Enter inside a text input triggers the primary action button or moves next
            e.preventDefault();
            const primaryBtn = document.querySelector<HTMLButtonElement>('[data-primary-action="true"]');
            if (primaryBtn) {
              this.sound.play('ui_confirm');
              primaryBtn.click();
            } else {
              this.moveFocus(focusables, 1);
            }
            return;
          } else {
            e.preventDefault();
            this.sound.play('ui_confirm');
            active.click();
            return;
          }
        } else if (!typing && focusables[0]) {
          e.preventDefault();
          focusables[0].focus();
          return;
        }
      }
    }

    // Do not capture gameplay movement keys while user is typing in nickname/room code input
    if (typing) {
      return;
    }

    // Prevent Space or Arrow keys from scrolling page during gameplay
    if (
      code === 'Space' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight'
    ) {
      e.preventDefault();
    }

    this.heldCodes.add(code);
    this.latchedCodes.add(code);
  }

  private handleKeyUp(e: KeyboardEvent): void {
    this.heldCodes.delete(e.code);
  }

  public getVisibleFocusableElements(): HTMLElement[] {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>('[data-nav="true"]:not([disabled])')
    );
    return nodes.filter((el) => el.offsetParent !== null);
  }

  public ensureInitialFocus(): void {
    const focusables = this.getVisibleFocusableElements();
    if (focusables.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    if (!active || !focusables.includes(active)) {
      const preferred =
        focusables.find((el) => el.dataset.autofocus === 'true') ?? focusables[0];
      preferred.focus();
    }
  }

  private moveFocus(focusables: HTMLElement[], delta: number): void {
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? focusables.indexOf(active) : -1;
    let nextIdx = 0;
    if (idx === -1) {
      nextIdx = delta > 0 ? 0 : focusables.length - 1;
    } else {
      nextIdx = (idx + delta + focusables.length) % focusables.length;
    }
    focusables[nextIdx].focus();
    this.sound.play('ui_focus');
  }

  /**
   * Samples the current 60Hz gameplay input frame from held KeyboardEvent.code keys.
   * Fixed camera orientation:
   * - W (KeyW): -Z (into screen / North)
   * - S (KeyS): +Z (toward camera / South)
   * - A (KeyA): -X (West / Left)
   * - D (KeyD): +X (East / Right)
   */
  public sampleGameplayInput(menuBlockingGameplay: boolean): InputFrame {
    this.seq++;
    if (menuBlockingGameplay) {
      return {
        seq: this.seq,
        moveX: 0,
        moveZ: 0,
        jumpPressed: false,
        dodgePressed: false,
        lightPressed: false,
        heavyPressed: false,
        recoveryPressed: false,
        weaponPressed: false,
        clientTime: Date.now(),
      };
    }

    const isActive = (code: string) => this.heldCodes.has(code) || this.latchedCodes.has(code);

    const left = isActive('KeyA') || isActive('ArrowLeft') ? -1 : 0;
    const right = isActive('KeyD') || isActive('ArrowRight') ? 1 : 0;
    const up = isActive('KeyW') || isActive('ArrowUp') ? -1 : 0;
    const down = isActive('KeyS') || isActive('ArrowDown') ? 1 : 0;

    const frame: InputFrame = {
      seq: this.seq,
      moveX: left + right,
      moveZ: up + down,
      jumpPressed: isActive('Space'),
      dodgePressed: isActive('ShiftLeft') || isActive('ShiftRight'),
      lightPressed: isActive('KeyJ'),
      heavyPressed: isActive('KeyK'),
      recoveryPressed: isActive('KeyL'),
      weaponPressed: isActive('KeyE'),
      clientTime: Date.now(),
    };

    this.latchedCodes.clear();
    return frame;
  }
}
