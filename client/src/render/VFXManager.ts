import * as THREE from 'three';
import { isPointOverStageXZ } from '@shared/index.js';
import { AssetLoader } from './AssetLoader.js';

interface PooledSpark {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
}

interface PooledRing {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  maxScale: number;
}

interface PooledFlash {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  maxScale: number;
}

interface PooledSmokePuff {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  startScale: number;
  endScale: number;
}

/**
 * Multi-Layer 3D VFX Manager (built on scenario-godot-vfx principles):
 * Layer 1: Additive HDR Core Flash (reads on frame 1, never starts from scale 0)
 * Layer 2: Ease-Out Shockwave Ring
 * Layer 3: Velocity-Aligned Sparks with 3D Stage Floor Bounce Collision
 * Layer 4: Rising Volumetric Smoke / Aether Puffs
 * Layer 5: Dynamic Impact PointLight
 */
export class VFXManager {
  private scene: THREE.Scene;
  private sparks: PooledSpark[] = [];
  private rings: PooledRing[] = [];
  private flashes: PooledFlash[] = [];
  private smokePuffs: PooledSmokePuff[] = [];
  private impactLight: THREE.PointLight;
  private impactLightLife = 0;
  private impactLightMaxLife = 0.18;

  private worldWeaponGroup: THREE.Group;
  private worldWeaponBeacon: THREE.Mesh;
  private worldWeaponGroundRing: THREE.Mesh;

  constructor(scene: THREE.Scene, assets: AssetLoader) {
    this.scene = scene;

    // Layer 1: Pre-allocate 8 Core Impact Flash Spheres (additive blending)
    const flashGeo = new THREE.SphereGeometry(0.38, 14, 12);
    for (let i = 0; i < 8; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(flashGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.flashes.push({ mesh, life: 0, maxLife: 0.11, maxScale: 2.4 });
    }

    // Layer 2: Pre-allocate 12 Expanding Shockwave Rings
    const ringGeo = new THREE.RingGeometry(0.35, 0.56, 28);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 12; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.rings.push({ mesh, life: 0, maxLife: 0.35, maxScale: 3.0 });
    }

    // Layer 3: Pre-allocate 44 Spark Particles (with floor bounce physics)
    const sparkGeo = new THREE.OctahedronGeometry(0.13, 0);
    for (let i = 0; i < 44; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00f0ff,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(sparkGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.sparks.push({ mesh, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0.32 });
    }

    // Layer 4: Pre-allocate 22 Volumetric Smoke / Aether Puffs
    const smokeGeo = new THREE.DodecahedronGeometry(0.26, 0);
    for (let i = 0; i < 22; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x94a3b8,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(smokeGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.smokePuffs.push({
        mesh,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 0,
        maxLife: 0.48,
        startScale: 0.92,
        endScale: 2.1,
      });
    }

    // Layer 5: Dynamic Impact PointLight
    this.impactLight = new THREE.PointLight(0x00f0ff, 0, 9.5, 1.5);
    this.impactLight.visible = false;
    this.scene.add(this.impactLight);

    // World Pickup / Thrown Rift Blade visual
    this.worldWeaponGroup = assets.createRiftBladeInstance(0xf5b700);
    this.worldWeaponGroup.scale.setScalar(1.25);
    this.scene.add(this.worldWeaponGroup);

    const beaconGeo = new THREE.CylinderGeometry(0.45, 0.45, 2.2, 16, 1, true);
    const beaconMat = new THREE.MeshBasicMaterial({
      color: 0xf5b700,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.worldWeaponBeacon = new THREE.Mesh(beaconGeo, beaconMat);
    this.worldWeaponBeacon.position.set(0, 1.1, 0);
    this.scene.add(this.worldWeaponBeacon);

    const groundRingGeo = new THREE.RingGeometry(0.42, 0.62, 24);
    groundRingGeo.rotateX(-Math.PI / 2);
    const groundRingMat = new THREE.MeshBasicMaterial({
      color: 0xf5b700,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.worldWeaponGroundRing = new THREE.Mesh(groundRingGeo, groundRingMat);
    this.worldWeaponGroundRing.position.set(0, 0.03, 0);
    this.scene.add(this.worldWeaponGroundRing);
  }

  private spawnCoreFlash(x: number, y: number, z: number, colorHex: number, maxScale = 2.2, duration = 0.1): void {
    for (const f of this.flashes) {
      if (f.life <= 0) {
        f.mesh.visible = true;
        f.mesh.position.set(x, y, z);
        f.mesh.scale.setScalar(0.92);
        (f.mesh.material as THREE.MeshBasicMaterial).color.setHex(colorHex);
        f.maxLife = duration;
        f.life = duration;
        f.maxScale = maxScale;
        break;
      }
    }
  }

  public spawnSmokeBurst(
    x: number,
    y: number,
    z: number,
    count: number,
    colorHex: number,
    spreadSpeed = 2.2
  ): void {
    let spawned = 0;
    for (const p of this.smokePuffs) {
      if (p.life <= 0) {
        p.mesh.visible = true;
        const angle = (spawned / Math.max(1, count)) * Math.PI * 2 + Math.random() * 0.5;
        const r = 0.15 + Math.random() * 0.25;
        p.mesh.position.set(x + Math.cos(angle) * r, y + 0.08, z + Math.sin(angle) * r);
        p.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
        (p.mesh.material as THREE.MeshBasicMaterial).color.setHex(colorHex);
        const spd = spreadSpeed * (0.65 + Math.random() * 0.6);
        p.vx = Math.cos(angle) * spd;
        p.vy = 1.1 + Math.random() * 1.4;
        p.vz = Math.sin(angle) * spd;
        p.startScale = 0.9;
        p.endScale = 1.85 + Math.random() * 0.5;
        p.maxLife = 0.36 + Math.random() * 0.16;
        p.life = p.maxLife;
        spawned++;
        if (spawned >= count) break;
      }
    }
  }

  public spawnHitSparks(
    x: number,
    y: number,
    z: number,
    isHeavy: boolean,
    colorHex = 0x00f0ff
  ): void {
    // 1. Core flash (reads immediately on frame 1)
    this.spawnCoreFlash(x, y, z, 0xffffff, isHeavy ? 2.8 : 1.8, isHeavy ? 0.12 : 0.08);

    // 2. Shockwave ring
    this.spawnShockwaveRing(x, y, z, isHeavy ? 0xff4d29 : colorHex, isHeavy ? 3.6 : 2.2, 0.26);

    // 3. Colliding velocity sparks
    const count = isHeavy ? 16 : 9;
    let spawned = 0;
    for (const s of this.sparks) {
      if (s.life <= 0) {
        s.mesh.visible = true;
        s.mesh.position.set(x, y, z);
        (s.mesh.material as THREE.MeshBasicMaterial).color.setHex(
          spawned % 3 === 0 ? 0xffffff : spawned % 2 === 0 ? colorHex : 0xf5b700
        );
        const angle = Math.random() * Math.PI * 2;
        const speed = (isHeavy ? 7.2 : 4.6) + Math.random() * 4.8;
        s.vx = Math.cos(angle) * speed;
        s.vy = 1.8 + Math.random() * 4.5;
        s.vz = Math.sin(angle) * speed;
        s.maxLife = isHeavy ? 0.42 : 0.28;
        s.life = s.maxLife;
        spawned++;
        if (spawned >= count) break;
      }
    }

    // 4. Volumetric smoke puffs
    this.spawnSmokeBurst(x, y - 0.2, z, isHeavy ? 6 : 3, isHeavy ? 0xfb923c : 0x38bdf8, isHeavy ? 2.8 : 1.6);

    // 5. Dynamic Impact PointLight
    this.impactLight.color.setHex(isHeavy ? 0xff4d29 : colorHex);
    this.impactLight.position.set(x, y + 0.4, z);
    this.impactLight.intensity = isHeavy ? 6.5 : 3.8;
    this.impactLight.visible = true;
    this.impactLightMaxLife = isHeavy ? 0.22 : 0.14;
    this.impactLightLife = this.impactLightMaxLife;
  }

  public spawnKOBlast(x: number, y: number, z: number, slot: number): void {
    const color = slot === 1 ? 0x00f0ff : 0xff4d29;
    const clampedY = Math.max(-3.5, y);
    this.spawnCoreFlash(x, clampedY, z, 0xffffff, 4.8, 0.18);
    this.spawnHitSparks(x, clampedY, z, true, color);
    this.spawnShockwaveRing(x, Math.max(-1.8, y), z, color, 8.2, 0.55);
    this.spawnShockwaveRing(x, Math.max(-1.8, y), z, 0xffffff, 5.2, 0.36);
    this.spawnSmokeBurst(x, clampedY, z, 9, color, 4.2);
  }

  public spawnShockwaveRing(
    x: number,
    y: number,
    z: number,
    colorHex: number,
    maxScale = 2.8,
    duration = 0.3
  ): void {
    for (const r of this.rings) {
      if (r.life <= 0) {
        r.mesh.visible = true;
        r.mesh.position.set(x, y, z);
        r.mesh.scale.setScalar(0.92);
        (r.mesh.material as THREE.MeshBasicMaterial).color.setHex(colorHex);
        r.maxLife = duration;
        r.life = duration;
        r.maxScale = maxScale;
        break;
      }
    }
  }

  public updateWorldWeapon(
    status: string,
    x: number,
    y: number,
    z: number,
    rotationY: number,
    elapsedSec: number
  ): void {
    if (status === 'on_ground') {
      this.worldWeaponGroup.visible = true;
      this.worldWeaponBeacon.visible = true;
      this.worldWeaponGroundRing.visible = true;
      const isFallingFromSky = y > 0.15;
      const bobY = isFallingFromSky ? y : y + 0.55 + Math.sin(elapsedSec * 3.5) * 0.16;
      this.worldWeaponGroup.position.set(x, bobY, z);
      this.worldWeaponGroup.rotation.set(
        isFallingFromSky ? Math.PI : 0.35,
        rotationY,
        isFallingFromSky ? 0 : Math.PI * 0.15
      );
      this.worldWeaponBeacon.position.set(x, 1.1, z);
      (this.worldWeaponBeacon.material as THREE.MeshBasicMaterial).opacity =
        0.16 + Math.sin(elapsedSec * 4.5) * 0.08;

      this.worldWeaponGroundRing.position.set(x, 0.03, z);
      const pulse = 0.92 + Math.sin(elapsedSec * 6.0) * 0.14;
      this.worldWeaponGroundRing.scale.setScalar(pulse);
    } else if (status === 'thrown') {
      this.worldWeaponGroup.visible = true;
      this.worldWeaponBeacon.visible = false;
      this.worldWeaponGroundRing.visible = false;
      this.worldWeaponGroup.position.set(x, y, z);
      this.worldWeaponGroup.rotation.set(Math.PI * 0.5, rotationY, elapsedSec * 24);
    } else {
      this.worldWeaponGroup.visible = false;
      this.worldWeaponBeacon.visible = false;
      this.worldWeaponGroundRing.visible = false;
    }
  }

  public update(dt: number): void {
    // 1. Update Core Flashes
    for (const f of this.flashes) {
      if (f.life > 0) {
        f.life -= dt;
        if (f.life <= 0) {
          f.mesh.visible = false;
        } else {
          const progress = 1 - f.life / f.maxLife;
          const easeOut = 1 - Math.pow(1 - progress, 3);
          f.mesh.scale.setScalar(0.92 + easeOut * (f.maxScale - 0.92));
          (f.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - progress) * 0.95;
        }
      }
    }

    // 2. Update Floor-Colliding Sparks
    for (const s of this.sparks) {
      if (s.life > 0) {
        s.life -= dt;
        if (s.life <= 0) {
          s.mesh.visible = false;
        } else {
          s.vy -= 16.5 * dt;
          s.mesh.position.x += s.vx * dt;
          s.mesh.position.y += s.vy * dt;
          s.mesh.position.z += s.vz * dt;

          // Floor bounce when over stage slab (scenario-godot-vfx quality gate: "sparks bounce on the floor")
          if (
            s.mesh.position.y <= 0.06 &&
            s.mesh.position.y >= -0.4 &&
            s.vy < 0 &&
            isPointOverStageXZ(s.mesh.position.x, s.mesh.position.z, 0)
          ) {
            s.mesh.position.y = 0.06;
            s.vy = -s.vy * 0.46;
            s.vx *= 0.78;
            s.vz *= 0.78;
          }

          const ratio = s.life / s.maxLife;
          // Stretch spark slightly along motion vector
          s.mesh.scale.set(ratio * 0.85, ratio * 1.35, ratio * 0.85);
          s.mesh.rotation.x += 12 * dt;
          s.mesh.rotation.y += 15 * dt;
          (s.mesh.material as THREE.MeshBasicMaterial).opacity = ratio;
        }
      }
    }

    // 3. Update Shockwave Rings with Strong Ease-Out
    for (const r of this.rings) {
      if (r.life > 0) {
        r.life -= dt;
        if (r.life <= 0) {
          r.mesh.visible = false;
        } else {
          const progress = 1 - r.life / r.maxLife;
          const easeOut = 1 - Math.pow(1 - progress, 3);
          const scale = 0.92 + easeOut * (r.maxScale - 0.92);
          r.mesh.scale.setScalar(scale);
          (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - progress) * 0.88;
        }
      }
    }

    // 4. Update Volumetric Smoke Puffs
    for (const p of this.smokePuffs) {
      if (p.life > 0) {
        p.life -= dt;
        if (p.life <= 0) {
          p.mesh.visible = false;
        } else {
          const progress = 1 - p.life / p.maxLife;
          const easeOut = 1 - Math.pow(1 - progress, 2);
          p.vx *= 1 - 3.5 * dt;
          p.vz *= 1 - 3.5 * dt;
          p.mesh.position.x += p.vx * dt;
          p.mesh.position.y += p.vy * dt;
          p.mesh.position.z += p.vz * dt;
          p.mesh.rotation.y += 1.8 * dt;
          const scale = p.startScale + easeOut * (p.endScale - p.startScale);
          p.mesh.scale.setScalar(scale);
          (p.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - progress) * 0.38;
        }
      }
    }

    // 5. Update Dynamic Impact Light
    if (this.impactLightLife > 0) {
      this.impactLightLife -= dt;
      if (this.impactLightLife <= 0) {
        this.impactLight.visible = false;
        this.impactLight.intensity = 0;
      } else {
        const ratio = this.impactLightLife / this.impactLightMaxLife;
        this.impactLight.intensity = ratio * ratio * 6.0;
      }
    }
  }
}
