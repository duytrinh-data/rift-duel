import * as THREE from 'three';
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

export class VFXManager {
  private scene: THREE.Scene;
  private sparks: PooledSpark[] = [];
  private rings: PooledRing[] = [];
  private worldWeaponGroup: THREE.Group;
  private worldWeaponBeacon: THREE.Mesh;

  constructor(scene: THREE.Scene, assets: AssetLoader) {
    this.scene = scene;

    // Pre-allocate 36 spark particles (object pool - zero runtime GC allocation)
    const sparkGeo = new THREE.OctahedronGeometry(0.14, 0);
    for (let i = 0; i < 36; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00f0ff,
        transparent: true,
        opacity: 1,
      });
      const mesh = new THREE.Mesh(sparkGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.sparks.push({ mesh, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 0.3 });
    }

    // Pre-allocate 10 expanding shockwave rings (hit impact, dodge, KO blast)
    const ringGeo = new THREE.RingGeometry(0.35, 0.55, 24);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 10; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
      });
      const mesh = new THREE.Mesh(ringGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this.rings.push({ mesh, life: 0, maxLife: 0.35, maxScale: 3.0 });
    }

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
      depthWrite: false,
    });
    this.worldWeaponBeacon = new THREE.Mesh(beaconGeo, beaconMat);
    this.worldWeaponBeacon.position.set(0, 1.1, 0);
    this.scene.add(this.worldWeaponBeacon);
  }

  public spawnHitSparks(
    x: number,
    y: number,
    z: number,
    isHeavy: boolean,
    colorHex = 0x00f0ff
  ): void {
    const count = isHeavy ? 14 : 8;
    let spawned = 0;
    for (const s of this.sparks) {
      if (s.life <= 0) {
        s.mesh.visible = true;
        s.mesh.position.set(x, y, z);
        (s.mesh.material as THREE.MeshBasicMaterial).color.setHex(
          spawned % 2 === 0 ? colorHex : 0xffffff
        );
        const angle = Math.random() * Math.PI * 2;
        const speed = (isHeavy ? 6.5 : 4.2) + Math.random() * 4.5;
        s.vx = Math.cos(angle) * speed;
        s.vy = (Math.random() - 0.2) * speed;
        s.vz = Math.sin(angle) * speed;
        s.maxLife = isHeavy ? 0.36 : 0.24;
        s.life = s.maxLife;
        spawned++;
        if (spawned >= count) break;
      }
    }

    this.spawnShockwaveRing(x, y, z, isHeavy ? 0xff4d29 : colorHex, isHeavy ? 3.4 : 2.1, 0.26);
  }

  public spawnKOBlast(x: number, y: number, z: number, slot: number): void {
    const color = slot === 1 ? 0x00f0ff : 0xff4d29;
    this.spawnHitSparks(x, Math.max(-4, y), z, true, color);
    this.spawnShockwaveRing(x, Math.max(-2, y), z, color, 7.5, 0.55);
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
        r.mesh.scale.setScalar(0.3);
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
      const bobY = y + 0.55 + Math.sin(elapsedSec * 3.5) * 0.16;
      this.worldWeaponGroup.position.set(x, bobY, z);
      this.worldWeaponGroup.rotation.set(0.35, rotationY, Math.PI * 0.15);
      this.worldWeaponBeacon.position.set(x, y + 1.1, z);
      (this.worldWeaponBeacon.material as THREE.MeshBasicMaterial).opacity =
        0.16 + Math.sin(elapsedSec * 4.0) * 0.08;
    } else if (status === 'thrown') {
      this.worldWeaponGroup.visible = true;
      this.worldWeaponBeacon.visible = false;
      this.worldWeaponGroup.position.set(x, y, z);
      this.worldWeaponGroup.rotation.set(Math.PI * 0.5, rotationY, elapsedSec * 22);
    } else {
      this.worldWeaponGroup.visible = false;
      this.worldWeaponBeacon.visible = false;
    }
  }

  public update(dt: number): void {
    for (const s of this.sparks) {
      if (s.life > 0) {
        s.life -= dt;
        if (s.life <= 0) {
          s.mesh.visible = false;
        } else {
          s.vy -= 15.0 * dt;
          s.mesh.position.x += s.vx * dt;
          s.mesh.position.y += s.vy * dt;
          s.mesh.position.z += s.vz * dt;
          const ratio = s.life / s.maxLife;
          s.mesh.scale.setScalar(ratio);
          (s.mesh.material as THREE.MeshBasicMaterial).opacity = ratio;
        }
      }
    }

    for (const r of this.rings) {
      if (r.life > 0) {
        r.life -= dt;
        if (r.life <= 0) {
          r.mesh.visible = false;
        } else {
          const progress = 1 - r.life / r.maxLife;
          const scale = 0.4 + progress * r.maxScale;
          r.mesh.scale.setScalar(scale);
          (r.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - progress) * 0.85;
        }
      }
    }
  }
}
