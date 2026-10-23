import * as THREE from 'three';
import { SIM_CONFIG } from '@shared/index.js';
import { AssetLoader } from './AssetLoader.js';

export class ArenaBuilder {
  private group = new THREE.Group();
  private floatingMonoliths: { mesh: THREE.Object3D; baseY: number; phase: number; speed: number }[] = [];
  private runeMaterial!: THREE.MeshBasicMaterial;
  private altarRing!: THREE.Mesh;

  public build(assets: AssetLoader, scene: THREE.Scene): THREE.Group {
    this.group.clear();
    this.floatingMonoliths = [];

    const halfW = SIM_CONFIG.ARENA_HALF_WIDTH_X; // 9.0
    const halfD = SIM_CONFIG.ARENA_HALF_DEPTH_Z; // 6.0
    const slabH = SIM_CONFIG.ARENA_SLAB_THICKNESS_Y; // 2.4

    // 1. Core Playable Stone Slab Foundation (ensures crisp silhouette & shadow receiver at Y=0)
    const slabGeo = new THREE.BoxGeometry(halfW * 2, slabH, halfD * 2);
    const slabMat = new THREE.MeshStandardMaterial({
      color: 0x1a2238,
      roughness: 0.78,
      metalness: 0.22,
    });
    const baseSlab = new THREE.Mesh(slabGeo, slabMat);
    baseSlab.position.set(0, -slabH * 0.5 - 0.02, 0);
    baseSlab.receiveShadow = true;
    baseSlab.castShadow = true;
    this.group.add(baseSlab);

    // Lower tapered obsidian under-island rock
    const underGeo = new THREE.ConeGeometry(halfW * 1.15, 7.5, 8);
    const underMat = new THREE.MeshStandardMaterial({
      color: 0x0d1324,
      roughness: 0.9,
      metalness: 0.15,
    });
    const underRock = new THREE.Mesh(underGeo, underMat);
    underRock.rotation.x = Math.PI;
    underRock.position.set(0, -slabH - 3.7, 0);
    this.group.add(underRock);

    // 2. Tile the top surface with real 3D GLB stone floor models (floor_tile_large & floor_tile_small_decorated)
    const tileGltf = assets.getGLTF('floor_tile_large');
    const decTileGltf = assets.getGLTF('floor_tile_small_decorated');
    const foundGltf = assets.getGLTF('floor_foundation_allsides');

    // KayKit large floor tiles are 4x4 units
    for (let x = -6; x <= 6; x += 4) {
      for (let z = -4; z <= 4; z += 4) {
        const isCenter = Math.abs(x) <= 2 && Math.abs(z) <= 2;
        const src = isCenter ? decTileGltf.scene : tileGltf.scene;
        const tile = src.clone(true);
        tile.position.set(x, -0.045, z);
        if (isCenter) {
          // Flatten vertical relief on decorated center tiles so the combat floor at Y=0 is 100% flush
          tile.scale.set(2, 0.08, 2);
        }
        tile.traverse((c) => {
          if ((c as THREE.Mesh).isMesh) {
            c.receiveShadow = true;
          }
        });
        this.group.add(tile);
      }
    }

    // Perimeter stone foundation blocks UNDERNEATH the slab edges (top flush at Y = -0.02, never sticking above floor)
    for (let x = -8; x <= 8; x += 4) {
      const fNorth = foundGltf.scene.clone(true);
      fNorth.position.set(x, -3.02, -halfD + 0.4);
      fNorth.scale.set(2, 1.5, 1);
      this.group.add(fNorth);

      const fSouth = foundGltf.scene.clone(true);
      fSouth.position.set(x, -3.02, halfD - 0.4);
      fSouth.scale.set(2, 1.5, 1);
      this.group.add(fSouth);
    }

    // 3. Glowing Rune Circuit Lines & Ledge Boundary Markers on Y = 0.01
    this.runeMaterial = new THREE.MeshBasicMaterial({
      color: 0x00f0ff,
      transparent: true,
      opacity: 0.78,
    });

    const borderMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.85,
    });

    // Outer ledge boundary strips (clear visual indicator of stage edges)
    const northEdge = new THREE.Mesh(new THREE.BoxGeometry(halfW * 2, 0.06, 0.14), borderMat);
    northEdge.position.set(0, 0.01, -halfD);
    const southEdge = new THREE.Mesh(new THREE.BoxGeometry(halfW * 2, 0.06, 0.14), borderMat);
    southEdge.position.set(0, 0.01, halfD);
    const westEdge = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.06, halfD * 2), borderMat);
    westEdge.position.set(-halfW, 0.01, 0);
    const eastEdge = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.06, halfD * 2), borderMat);
    eastEdge.position.set(halfW, 0.01, 0);
    this.group.add(northEdge, southEdge, westEdge, eastEdge);

    // Corner danger accents in crimson-violet
    const cornerMat = new THREE.MeshBasicMaterial({ color: 0xff4d29 });
    const corners: [number, number][] = [
      [-halfW, -halfD],
      [halfW, -halfD],
      [-halfW, halfD],
      [halfW, halfD],
    ];
    for (const [cx, cz] of corners) {
      const cMesh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.9), cornerMat);
      cMesh.position.set(cx, 0.02, cz);
      this.group.add(cMesh);
    }

    // Center Rift Altar Ring (Weapon Spawn Point at 0,0,0)
    const ringGeo = new THREE.RingGeometry(1.15, 1.45, 32);
    ringGeo.rotateX(-Math.PI / 2);
    this.altarRing = new THREE.Mesh(ringGeo, this.runeMaterial);
    this.altarRing.position.set(0, 0.018, 0);
    this.group.add(this.altarRing);

    // Glowing rune lines connecting spawn pads to center altar
    const runeLineX = new THREE.Mesh(new THREE.PlaneGeometry(halfW * 1.6, 0.12), this.runeMaterial);
    runeLineX.rotation.x = -Math.PI / 2;
    runeLineX.position.set(0, 0.015, 0);
    const runeLineZ = new THREE.Mesh(new THREE.PlaneGeometry(0.12, halfD * 1.5), this.runeMaterial);
    runeLineZ.rotation.x = -Math.PI / 2;
    runeLineZ.position.set(0, 0.015, 0);
    this.group.add(runeLineX, runeLineZ);

    // 4. Solid Corner Pillars (matched 1:1 with SIM_CONFIG.STAGE_PILLARS physics colliders)
    const pillarGltf = assets.getGLTF('pillar_decorated');
    const torchGltf = assets.getGLTF('torch_lit');

    for (const colPillar of SIM_CONFIG.STAGE_PILLARS) {
      const p = pillarGltf.scene.clone(true);
      p.position.set(colPillar.x, 0, colPillar.z);
      p.scale.set(0.75, 0.85, 0.75);
      p.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) {
          c.castShadow = true;
          c.receiveShadow = true;
        }
      });
      this.group.add(p);

      // Glowing collider ring around the pillar base so players clearly see its physical boundary
      const pRingGeo = new THREE.RingGeometry(colPillar.radius - 0.08, colPillar.radius + 0.06, 24);
      pRingGeo.rotateX(-Math.PI / 2);
      const pRing = new THREE.Mesh(pRingGeo, borderMat);
      pRing.position.set(colPillar.x, 0.02, colPillar.z);
      this.group.add(pRing);

      const t = torchGltf.scene.clone(true);
      t.position.set(colPillar.x, 1.45, colPillar.z + 0.48);
      this.group.add(t);
    }

    // Rear Floating Shrine Pillars (outside the stage at Z = -8.4 so they never block gameplay)
    for (const px of [-4.2, 4.2]) {
      const p = pillarGltf.scene.clone(true);
      p.position.set(px, -0.6, -halfD - 2.4);
      p.scale.set(0.85, 0.85, 0.85);
      this.group.add(p);

      const t = torchGltf.scene.clone(true);
      t.position.set(px, 0.9, -halfD - 1.9);
      this.group.add(t);
    }

    // 5. Floating Abyss Monoliths around the void (Sci-Fi Fantasy Rift atmosphere)
    const colGltf = assets.getGLTF('column');
    const barrierGltf = assets.getGLTF('barrier_column');
    const monolithCoords = [
      { x: -15, y: -2.5, z: -10, s: 1.4, phase: 0.2 },
      { x: 15, y: -1.8, z: -9, s: 1.5, phase: 1.4 },
      { x: -17, y: -3.2, z: 4, s: 1.2, phase: 2.7 },
      { x: 17, y: -2.9, z: 5, s: 1.3, phase: 3.9 },
      { x: 0, y: -1.5, z: -13.5, s: 1.8, phase: 5.1 },
    ];

    for (const mc of monolithCoords) {
      const mGroup = new THREE.Group();
      const baseRock = new THREE.Mesh(
        new THREE.OctahedronGeometry(1.6 * mc.s, 0),
        new THREE.MeshStandardMaterial({
          color: 0x1e1b4b,
          roughness: 0.6,
          metalness: 0.4,
        })
      );
      mGroup.add(baseRock);

      const col = (mc.s > 1.4 ? colGltf : barrierGltf).scene.clone(true);
      col.position.set(0, 1.1 * mc.s, 0);
      col.scale.setScalar(mc.s * 0.9);
      mGroup.add(col);

      // Glowing floating rune crystal
      const crystal = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.45 * mc.s, 0),
        new THREE.MeshBasicMaterial({ color: mc.x < 0 ? 0x00f0ff : 0x9d4edd })
      );
      crystal.position.set(0, 3.8 * mc.s, 0);
      mGroup.add(crystal);

      mGroup.position.set(mc.x, mc.y, mc.z);
      this.group.add(mGroup);
      this.floatingMonoliths.push({
        mesh: mGroup,
        baseY: mc.y,
        phase: mc.phase,
        speed: 1.1 + (mc.phase % 0.7),
      });
    }

    scene.add(this.group);
    return this.group;
  }

  public update(elapsedSec: number): void {
    for (const item of this.floatingMonoliths) {
      item.mesh.position.y = item.baseY + Math.sin(elapsedSec * item.speed + item.phase) * 0.55;
      item.mesh.rotation.y = Math.sin(elapsedSec * 0.35 + item.phase) * 0.15;
    }
    if (this.altarRing) {
      this.altarRing.rotation.z = elapsedSec * 0.65;
    }
    if (this.runeMaterial) {
      this.runeMaterial.opacity = 0.62 + Math.sin(elapsedSec * 2.8) * 0.18;
    }
  }
}
