import * as THREE from 'three';

export type GraphicsQuality = 'high' | 'low';

export class SceneManager {
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer | null = null;
  public webglSupported = true;

  private dirLight: THREE.DirectionalLight;
  private rimLightCyan: THREE.DirectionalLight;
  private rimLightCrimson: THREE.DirectionalLight;

  private quality: GraphicsQuality = 'high';
  private screenShakeEnabled = true;
  private trauma = 0;
  private shakeSeedTime = 0;
  private fovPunchOffset = 0;
  private readonly baseFov = 46;

  private camTargetPos = new THREE.Vector3(0, 10.5, 14.5);
  private camTargetLook = new THREE.Vector3(0, 0.8, 0);
  private camCurrentLook = new THREE.Vector3(0, 0.8, 0);

  constructor(canvas: HTMLCanvasElement) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070913);
    this.scene.fog = new THREE.FogExp2(0x070913, 0.018);

    this.camera = new THREE.PerspectiveCamera(
      46,
      window.innerWidth / Math.max(1, window.innerHeight),
      0.5,
      120
    );
    this.camera.position.copy(this.camTargetPos);
    this.camera.lookAt(this.camTargetLook);

    // Lighting setup: Ambient + Soft Shadow Key Light + Dual Rim Lights (Cyan & Crimson)
    const hemi = new THREE.HemisphereLight(0xcffafe, 0x1e1b4b, 1.05);
    this.scene.add(hemi);

    this.dirLight = new THREE.DirectionalLight(0xfffbeb, 1.85);
    this.dirLight.position.set(9, 18, 12);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.set(1024, 1024);
    this.dirLight.shadow.camera.near = 2;
    this.dirLight.shadow.camera.far = 42;
    const d = 13;
    this.dirLight.shadow.camera.left = -d;
    this.dirLight.shadow.camera.right = d;
    this.dirLight.shadow.camera.top = d;
    this.dirLight.shadow.camera.bottom = -d;
    this.dirLight.shadow.bias = -0.0005;
    this.scene.add(this.dirLight);

    this.rimLightCyan = new THREE.DirectionalLight(0x00f0ff, 0.95);
    this.rimLightCyan.position.set(-14, 6, -10);
    this.scene.add(this.rimLightCyan);

    this.rimLightCrimson = new THREE.DirectionalLight(0xff4d29, 0.85);
    this.rimLightCrimson.position.set(14, 6, -10);
    this.scene.add(this.rimLightCrimson);

    // Load saved settings
    const savedQ = localStorage.getItem('rift_duel_quality');
    if (savedQ === 'low' || savedQ === 'high') this.quality = savedQ;
    const savedShake = localStorage.getItem('rift_duel_shake');
    if (savedShake !== null) this.screenShakeEnabled = savedShake === 'true';

    this.initRenderer(canvas);
    window.addEventListener('resize', () => this.handleResize());
  }

  private initRenderer(canvas: HTMLCanvasElement): void {
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: this.quality === 'high',
        powerPreference: 'high-performance',
      });
      this.applyQualitySettings();
      this.handleResize();
    } catch {
      this.webglSupported = false;
      this.renderer = null;
    }
  }

  public getQuality(): GraphicsQuality {
    return this.quality;
  }

  public setQuality(q: GraphicsQuality): void {
    this.quality = q;
    localStorage.setItem('rift_duel_quality', q);
    this.applyQualitySettings();
  }

  public toggleQuality(): GraphicsQuality {
    this.setQuality(this.quality === 'high' ? 'low' : 'high');
    return this.quality;
  }

  public isScreenShakeEnabled(): boolean {
    return this.screenShakeEnabled;
  }

  public toggleScreenShake(): boolean {
    this.screenShakeEnabled = !this.screenShakeEnabled;
    localStorage.setItem('rift_duel_shake', String(this.screenShakeEnabled));
    return this.screenShakeEnabled;
  }

  private applyQualitySettings(): void {
    if (!this.renderer) return;
    const maxDpr = this.quality === 'high' ? Math.min(window.devicePixelRatio || 1, 1.75) : 1.0;
    this.renderer.setPixelRatio(maxDpr);
    this.renderer.shadowMap.enabled = this.quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.dirLight.castShadow = this.quality === 'high';
  }

  public triggerCameraShake(intensity: number, _durationSec = 0.18): void {
    if (!this.screenShakeEnabled) return;
    // Trauma-squared model (scenario-godot-vfx): additive trauma clamped to [0, 1] + subtle FOV punch
    const addedTrauma = THREE.MathUtils.clamp(intensity * 1.65, 0.15, 0.95);
    this.trauma = Math.min(1.0, this.trauma + addedTrauma);
    if (intensity >= 0.25) {
      this.fovPunchOffset = Math.max(this.fovPunchOffset, Math.min(2.2, intensity * 4.2));
    }
  }

  /**
   * Dynamically tracks both fighters in 3D while keeping a FIXED camera orientation
   * looking from +Z (South-Up) toward -Z (North-Down) so WASD never flips meaning.
   */
  public updateCameraForFighters(
    p1: { x: number; y: number; z: number } | null,
    p2: { x: number; y: number; z: number } | null,
    dt: number
  ): void {
    if (p1 && p2) {
      const midX = THREE.MathUtils.clamp((p1.x + p2.x) * 0.5, -5.5, 5.5);
      const midY = THREE.MathUtils.clamp((p1.y + p2.y) * 0.5, -1.5, 4.0);
      const midZ = THREE.MathUtils.clamp((p1.z + p2.z) * 0.5, -3.5, 3.5);

      const dist3D = Math.hypot(p1.x - p2.x, (p1.y - p2.y) * 0.7, (p1.z - p2.z) * 1.25);
      const zoomDist = THREE.MathUtils.clamp(12.2 + dist3D * 0.52, 12.8, 21.5);
      const camHeight = THREE.MathUtils.clamp(8.6 + dist3D * 0.34, 9.0, 15.2);

      this.camTargetLook.set(midX, midY + 0.65, midZ * 0.65);
      this.camTargetPos.set(midX * 0.78, midY + camHeight, midZ * 0.65 + zoomDist);
    } else if (p1) {
      this.camTargetLook.set(p1.x * 0.5, 0.8, p1.z * 0.5);
      this.camTargetPos.set(p1.x * 0.5, 10.2, p1.z * 0.5 + 14.2);
    } else {
      this.camTargetLook.set(0, 0.8, 0);
      this.camTargetPos.set(0, 10.5, 14.5);
    }

    const smooth = 1 - Math.exp(-7.5 * dt);
    this.camera.position.lerp(this.camTargetPos, smooth);
    this.camCurrentLook.lerp(this.camTargetLook, smooth);

    // Smooth multi-frequency trauma-squared 3D camera shake + decay (1.8/s per scenario-godot-vfx)
    this.shakeSeedTime += dt;
    if (this.trauma > 0) {
      const shake = this.trauma * this.trauma;
      const t = this.shakeSeedTime * 38.0;
      const ox = (Math.sin(t * 1.13) * 0.6 + Math.cos(t * 2.41) * 0.4) * 0.34 * shake;
      const oy = (Math.cos(t * 1.37) * 0.6 + Math.sin(t * 2.83) * 0.4) * 0.24 * shake;
      const oz = Math.sin(t * 1.79) * 0.14 * shake;
      this.camera.position.x += ox;
      this.camera.position.y += oy;
      this.camera.position.z += oz;
      this.trauma = Math.max(0, this.trauma - 2.1 * dt);
    }

    if (this.fovPunchOffset > 0.01) {
      this.fovPunchOffset *= Math.exp(-14 * dt);
      this.camera.fov = this.baseFov - this.fovPunchOffset;
      this.camera.updateProjectionMatrix();
    } else if (this.camera.fov !== this.baseFov) {
      this.fovPunchOffset = 0;
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }

    this.camera.lookAt(this.camCurrentLook);
  }

  public render(): void {
    this.renderer?.render(this.scene, this.camera);
  }

  private handleResize(): void {
    if (!this.renderer) return;
    const w = window.innerWidth;
    const h = Math.max(1, window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
