export type SoundEffectName =
  | 'ui_focus'
  | 'ui_confirm'
  | 'ui_error'
  | 'countdown_tick'
  | 'match_start'
  | 'jump'
  | 'dodge'
  | 'hit_light'
  | 'hit_heavy'
  | 'hit_throw'
  | 'pickup'
  | 'throw'
  | 'ko'
  | 'respawn'
  | 'match_end';

const AUDIO_FILE_MAP: Record<string, string> = {
  chop: '/assets/audio/chop.ogg',
  pot_clank: '/assets/audio/pot_clank.ogg',
  plate_break: '/assets/audio/plate_break.ogg',
  pickup: '/assets/audio/pickup.ogg',
  drop: '/assets/audio/drop.ogg',
  bell: '/assets/audio/bell.ogg',
  click: '/assets/audio/click.ogg',
  error: '/assets/audio/error.ogg',
  order_complete: '/assets/audio/order_complete.ogg',
  footstep1: '/assets/audio/footstep1.ogg',
};

export class SoundManager {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private unlocked = false;
  private muted = false;
  private volume = 0.7;

  constructor() {
    const savedMute = localStorage.getItem('rift_duel_muted');
    const savedVol = localStorage.getItem('rift_duel_volume');
    if (savedMute !== null) this.muted = savedMute === 'true';
    if (savedVol !== null) {
      const v = Number(savedVol);
      if (Number.isFinite(v)) this.volume = Math.max(0, Math.min(1, v));
    }
  }

  /**
   * Called ONLY after a valid user keyboard gesture to respect Browser Autoplay Policy.
   */
  public unlockFromGesture(): void {
    if (this.unlocked && this.ctx) {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return;
    }
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      this.unlocked = true;
      void this.preloadOggBuffers();
    } catch {
      // Ignore if audio context unavailable in headless environment
    }
  }

  private async preloadOggBuffers(): Promise<void> {
    if (!this.ctx) return;
    const entries = Object.entries(AUDIO_FILE_MAP);
    await Promise.all(
      entries.map(async ([key, url]) => {
        try {
          const res = await fetch(url);
          if (!res.ok || !this.ctx) return;
          const arr = await res.arrayBuffer();
          const buf = await this.ctx.decodeAudioData(arr);
          this.buffers.set(key, buf);
        } catch {
          // Fallback to WebAudio synth if sample fails
        }
      })
    );
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(mute: boolean): void {
    this.muted = mute;
    localStorage.setItem('rift_duel_muted', String(mute));
  }

  public toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  public getVolume(): number {
    return this.volume;
  }

  public setVolume(val: number): void {
    this.volume = Math.max(0, Math.min(1, Math.round(val * 100) / 100));
    localStorage.setItem('rift_duel_volume', String(this.volume));
  }

  public adjustVolume(delta: number): number {
    this.setVolume(this.volume + delta);
    return this.volume;
  }

  private playSample(key: string, playbackRate = 1.0, gainScale = 1.0): void {
    if (!this.ctx || !this.unlocked || this.muted || this.volume <= 0) return;
    const buf = this.buffers.get(key);
    if (!buf) return;
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = playbackRate;
      const gain = this.ctx.createGain();
      gain.gain.value = Math.min(1, this.volume * gainScale);
      src.connect(gain);
      gain.connect(this.ctx.destination);
      src.start(0);
    } catch {
      // Ignore audio playback errors
    }
  }

  private playTone(
    freqStart: number,
    freqEnd: number,
    durationSec: number,
    type: OscillatorType = 'triangle',
    gainScale = 0.25
  ): void {
    if (!this.ctx || !this.unlocked || this.muted || this.volume <= 0) return;
    try {
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freqStart, now);
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), now + durationSec);

      gain.gain.setValueAtTime(this.volume * gainScale, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + durationSec);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + durationSec);
    } catch {
      // Ignore synth errors
    }
  }

  public play(effect: SoundEffectName): void {
    if (!this.unlocked || this.muted || this.volume <= 0) return;

    switch (effect) {
      case 'ui_focus':
        this.playSample('click', 1.25, 0.45);
        this.playTone(520, 680, 0.04, 'sine', 0.12);
        break;
      case 'ui_confirm':
        this.playSample('click', 0.95, 0.7);
        this.playTone(440, 880, 0.09, 'triangle', 0.2);
        break;
      case 'ui_error':
        this.playSample('error', 1.0, 0.8);
        this.playTone(220, 110, 0.18, 'sawtooth', 0.22);
        break;
      case 'countdown_tick':
        this.playSample('bell', 1.0, 0.75);
        this.playTone(587.33, 587.33, 0.14, 'sine', 0.2);
        break;
      case 'match_start':
        this.playSample('bell', 1.35, 0.95);
        this.playTone(587.33, 1174.66, 0.28, 'triangle', 0.3);
        break;
      case 'jump':
        this.playSample('footstep1', 1.3, 0.55);
        this.playTone(240, 520, 0.11, 'sine', 0.16);
        break;
      case 'dodge':
        this.playSample('drop', 1.4, 0.6);
        this.playTone(620, 260, 0.12, 'sine', 0.18);
        break;
      case 'hit_light':
        this.playSample('chop', 1.12, 0.85);
        this.playTone(320, 140, 0.1, 'triangle', 0.28);
        break;
      case 'hit_heavy':
        this.playSample('pot_clank', 0.92, 1.0);
        this.playSample('chop', 0.78, 0.9);
        this.playTone(180, 55, 0.22, 'sawtooth', 0.42);
        break;
      case 'hit_throw':
        this.playSample('pot_clank', 1.18, 0.95);
        this.playTone(420, 95, 0.18, 'square', 0.32);
        break;
      case 'pickup':
        this.playSample('pickup', 1.05, 0.85);
        this.playTone(380, 760, 0.14, 'triangle', 0.22);
        break;
      case 'throw':
        this.playSample('drop', 0.95, 0.8);
        this.playTone(540, 210, 0.13, 'sine', 0.22);
        break;
      case 'ko':
        this.playSample('plate_break', 0.88, 1.0);
        this.playSample('pot_clank', 0.65, 0.95);
        this.playTone(150, 38, 0.45, 'sawtooth', 0.48);
        break;
      case 'respawn':
        this.playSample('pickup', 1.2, 0.65);
        this.playTone(330, 660, 0.2, 'sine', 0.2);
        break;
      case 'match_end':
        this.playSample('order_complete', 1.0, 0.95);
        this.playTone(440, 880, 0.35, 'triangle', 0.32);
        break;
    }
  }
}
