import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ATTACK_CONFIGS, AttackId, CharacterArchetype, isPointOverStageXZ } from '@shared/index.js';
import { AssetLoader } from './AssetLoader.js';

export interface FighterRenderInput {
  slot: 1 | 2;
  archetype: CharacterArchetype;
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
  hasWeapon: boolean;
  invulnerableTicks: number;
  damage: number;
}

const DEFAULT_HAND_PROPS = [
  '1H_Sword',
  '2H_Sword',
  '1H_Sword_Offhand',
  'Badge_Shield',
  'Rectangle_Shield',
  'Round_Shield',
  'Spike_Shield',
  '1H_Axe',
  '2H_Axe',
  '1H_Axe_Offhand',
  'Barbarian_Round_Shield',
  'Mug',
];

export class FighterVisual {
  public readonly root = new THREE.Group();
  private modelGroup = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private currentClip = '';

  private slot: 1 | 2;
  private archetype: CharacterArchetype;
  private assets: AssetLoader;

  private equippedBlade: THREE.Group | null = null;
  private customMaterials: THREE.MeshStandardMaterial[] = [];
  private hitFlashTimer = 0;

  // Spatial 3D readability indicators (Section 2 requirements)
  private shadowBlob: THREE.Mesh;
  private footRing: THREE.Mesh;
  private landingRing: THREE.Mesh;
  private verticalDropLine: THREE.Line;
  private invulnSphere: THREE.Mesh;
  private weaponTrailMesh: THREE.Mesh;
  private trailPoints: THREE.Vector3[] = [];

  private primaryColorHex: number;

  constructor(slot: 1 | 2, archetype: CharacterArchetype, assets: AssetLoader, scene: THREE.Scene) {
    this.slot = slot;
    this.archetype = archetype;
    this.assets = assets;
    this.primaryColorHex = slot === 1 ? 0x00f0ff : 0xff4d29;

    this.root.add(this.modelGroup);

    // 1. Contact Shadow Blob on stage surface (Y = 0.02)
    const shadowGeo = new THREE.CircleGeometry(0.62, 24);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      color: 0x02040a,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
    });
    this.shadowBlob = new THREE.Mesh(shadowGeo, shadowMat);
    scene.add(this.shadowBlob);

    // 2. Colored Foot Ring attached to fighter feet
    const footGeo = new THREE.RingGeometry(0.54, 0.68, 28);
    footGeo.rotateX(-Math.PI / 2);
    const footMat = new THREE.MeshBasicMaterial({
      color: this.primaryColorHex,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.88,
    });
    this.footRing = new THREE.Mesh(footGeo, footMat);
    this.footRing.position.y = 0.03;
    this.root.add(this.footRing);

    // 3. Airborne Landing Indicator Ring & Vertical Drop Line
    const landGeo = new THREE.RingGeometry(0.32, 0.48, 24);
    landGeo.rotateX(-Math.PI / 2);
    const landMat = new THREE.MeshBasicMaterial({
      color: this.primaryColorHex,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });
    this.landingRing = new THREE.Mesh(landGeo, landMat);
    this.landingRing.visible = false;
    scene.add(this.landingRing);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 1, 0),
    ]);
    const lineMat = new THREE.LineBasicMaterial({
      color: this.primaryColorHex,
      transparent: true,
      opacity: 0.45,
    });
    this.verticalDropLine = new THREE.Line(lineGeo, lineMat);
    this.verticalDropLine.visible = false;
    scene.add(this.verticalDropLine);

    // 4. Spawn / Dodge Invulnerability Shield Aura
    const invGeo = new THREE.SphereGeometry(0.95, 18, 14);
    const invMat = new THREE.MeshBasicMaterial({
      color: this.primaryColorHex,
      wireframe: true,
      transparent: true,
      opacity: 0.38,
    });
    this.invulnSphere = new THREE.Mesh(invGeo, invMat);
    this.invulnSphere.position.y = 0.9;
    this.invulnSphere.visible = false;
    this.root.add(this.invulnSphere);

    // 5. Dynamic 3D Weapon / Attack Trail Ribbon
    const trailGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(12 * 3);
    trailGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const trailMat = new THREE.MeshBasicMaterial({
      color: this.primaryColorHex,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.65,
      depthWrite: false,
    });
    this.weaponTrailMesh = new THREE.Mesh(trailGeo, trailMat);
    this.weaponTrailMesh.frustumCulled = false;
    this.weaponTrailMesh.visible = false;
    scene.add(this.weaponTrailMesh);

    this.buildCharacterModel(archetype);
    scene.add(this.root);
  }

  public setArchetypeIfChanged(archetype: CharacterArchetype): void {
    if (this.archetype === archetype) return;
    this.archetype = archetype;
    this.buildCharacterModel(archetype);
  }

  private buildCharacterModel(archetype: CharacterArchetype): void {
    this.modelGroup.clear();
    this.actions.clear();
    this.customMaterials = [];
    this.currentClip = '';

    const modelKey = archetype === 'reaver' ? 'barbarian' : 'knight';
    const gltf = this.assets.getGLTF(modelKey);
    const clonedScene = SkeletonUtils.clone(gltf.scene);

    // Scale to match 1.65m hurtbox height cleanly
    clonedScene.scale.setScalar(0.88);

    // Hide default embedded weapons/shields so unarmed state is truly unarmed
    for (const propName of DEFAULT_HAND_PROPS) {
      const obj = clonedScene.getObjectByName(propName);
      if (obj) {
        obj.visible = false;
      }
    }

    // Attach our glowing Rift Blade to right hand bone (`handslot.r`)
    const handRight =
      clonedScene.getObjectByName('handslot.r') || clonedScene.getObjectByName('hand.r');
    this.equippedBlade = this.assets.createRiftBladeInstance(this.primaryColorHex);
    this.equippedBlade.visible = false;
    if (handRight) {
      handRight.add(this.equippedBlade);
    } else {
      this.equippedBlade.position.set(0.45, 0.9, 0.35);
      clonedScene.add(this.equippedBlade);
    }

    // Customize materials with slot signature rim/emissive tint so Cyan vs Crimson-Orange stand out vividly
    const accentColor = new THREE.Color(this.primaryColorHex);
    clonedScene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const prepareMat = (orig: THREE.Material): THREE.Material => {
          const mat = orig.clone() as THREE.MeshStandardMaterial;
          if ('emissive' in mat && mat.emissive) {
            mat.emissive = accentColor.clone();
            mat.emissiveIntensity = 0.14;
            mat.roughness = 0.55;
            this.customMaterials.push(mat);
          }
          return mat;
        };
        if (Array.isArray(mesh.material)) {
          mesh.material = mesh.material.map(prepareMat);
        } else if (mesh.material) {
          mesh.material = prepareMat(mesh.material);
        }
      }
    });

    this.modelGroup.add(clonedScene);

    // Setup AnimationMixer for all 76 in-place skeletal animations
    this.mixer = new THREE.AnimationMixer(clonedScene);
    for (const clip of gltf.animations) {
      const action = this.mixer.clipAction(clip);
      this.actions.set(clip.name, action);
    }

    this.playAnimation('Unarmed_Idle', true);
  }

  public triggerHitFlash(): void {
    this.hitFlashTimer = 0.14;
  }

  private playAnimation(clipName: string, loop = true, timeScale = 1.0): void {
    if (!this.mixer) return;
    if (this.currentClip === clipName) return;

    const nextAction =
      this.actions.get(clipName) ||
      this.actions.get('Idle') ||
      this.actions.values().next().value;
    if (!nextAction) return;

    const prevAction = this.actions.get(this.currentClip);
    this.currentClip = clipName;

    nextAction.reset();
    nextAction.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    nextAction.clampWhenFinished = !loop;
    nextAction.timeScale = timeScale;
    nextAction.play();

    if (prevAction && prevAction !== nextAction) {
      prevAction.crossFadeTo(nextAction, 0.1, false);
    }
  }

  public update(state: FighterRenderInput, dt: number, elapsedSec: number): void {
    this.setArchetypeIfChanged(state.archetype);

    const isHidden = state.state === 'ko' || state.state === 'respawn';
    this.root.visible = !isHidden;
    this.shadowBlob.visible = !isHidden;
    this.landingRing.visible = !isHidden && !state.grounded && state.y > 0.12;
    this.verticalDropLine.visible = !isHidden && !state.grounded && state.y > 0.12;

    if (isHidden) {
      this.weaponTrailMesh.visible = false;
      return;
    }

    // Update 3D position & facing rotation
    this.root.position.set(state.x, state.y, state.z);
    this.root.rotation.y = state.facingAngle;

    // Update equipped weapon visibility
    if (this.equippedBlade) {
      this.equippedBlade.visible = state.hasWeapon;
    }

    // Choose matching animation clip for current fighter state
    this.updateAnimationForState(state);
    this.mixer?.update(dt);

    // Hit flash & Invulnerability visual feedback
    if (this.hitFlashTimer > 0) {
      this.hitFlashTimer = Math.max(0, this.hitFlashTimer - dt);
    }

    const isFlashingHit = this.hitFlashTimer > 0;
    const isInvuln = state.invulnerableTicks > 0;
    this.invulnSphere.visible = isInvuln;
    if (isInvuln) {
      this.invulnSphere.rotation.y = elapsedSec * 4.5;
      const pulse = 0.92 + Math.sin(elapsedSec * 18) * 0.08;
      this.invulnSphere.scale.setScalar(pulse);
    }

    for (const mat of this.customMaterials) {
      if (isFlashingHit) {
        mat.emissive.setHex(0xffffff);
        mat.emissiveIntensity = 0.85;
      } else if (isInvuln) {
        mat.emissive.setHex(this.primaryColorHex);
        mat.emissiveIntensity = 0.35 + Math.sin(elapsedSec * 20) * 0.2;
      } else {
        mat.emissive.setHex(this.primaryColorHex);
        mat.emissiveIntensity = 0.14;
      }
    }

    // Update Contact Shadow & Airborne Landing Indicator on Y=0 plane
    const overStage = isPointOverStageXZ(state.x, state.z, 0.2);
    const groundY = 0.025;
    this.shadowBlob.position.set(state.x, groundY, state.z);
    if (overStage && state.y >= -0.2) {
      const heightScale = Math.max(0.32, 1 - state.y * 0.08);
      this.shadowBlob.scale.setScalar(heightScale);
      (this.shadowBlob.material as THREE.MeshBasicMaterial).opacity = 0.62 * heightScale;
    } else {
      this.shadowBlob.scale.setScalar(0.25);
      (this.shadowBlob.material as THREE.MeshBasicMaterial).opacity = 0.18;
    }

    if (this.landingRing.visible) {
      const landY = overStage ? 0.03 : Math.max(state.y - 2.5, -2.2);
      this.landingRing.position.set(state.x, landY, state.z);
      const landMat = this.landingRing.material as THREE.MeshBasicMaterial;
      // Turn warning red-orange when airborne off-stage over the abyss
      landMat.color.setHex(overStage ? this.primaryColorHex : 0xff2a55);

      const posAttr = this.verticalDropLine.geometry.getAttribute(
        'position'
      ) as THREE.BufferAttribute;
      posAttr.setXYZ(0, state.x, landY, state.z);
      posAttr.setXYZ(1, state.x, state.y + 0.1, state.z);
      posAttr.needsUpdate = true;
    }

    // Update 3D Weapon Trail during active/startup attack swings
    const inAttackSwing =
      state.state === 'attack_startup' || state.state === 'attack_active';
    if (inAttackSwing) {
      const fx = Math.sin(state.facingAngle);
      const fz = Math.cos(state.facingAngle);
      const reach = state.hasWeapon ? 1.55 : 1.05;
      const tip = new THREE.Vector3(
        state.x + fx * reach,
        state.y + 0.95,
        state.z + fz * reach
      );
      this.trailPoints.unshift(tip);
      if (this.trailPoints.length > 6) {
        this.trailPoints.pop();
      }
      this.updateWeaponTrailGeometry(state.y + 0.75);
      this.weaponTrailMesh.visible = this.trailPoints.length >= 2;
    } else {
      this.trailPoints.length = 0;
      this.weaponTrailMesh.visible = false;
    }
  }

  private updateAnimationForState(state: FighterRenderInput): void {
    switch (state.state) {
      case 'idle':
        this.playAnimation(state.hasWeapon ? 'Idle' : 'Unarmed_Idle', true, 1.0);
        break;
      case 'move':
        this.playAnimation('Running_A', true, 1.15);
        break;
      case 'jump':
        this.playAnimation('Jump_Idle', true, 1.0);
        break;
      case 'fall':
        this.playAnimation('Jump_Idle', true, 0.85);
        break;
      case 'dodge':
        this.playAnimation('Dodge_Forward', false, 1.6);
        break;
      case 'pickup':
        this.playAnimation('PickUp', false, 2.2);
        break;
      case 'throw':
        this.playAnimation('Throw', false, 1.8);
        break;
      case 'hitstun':
        this.playAnimation('Hit_A', false, 1.3);
        break;
      case 'attack_startup':
      case 'attack_active':
      case 'attack_recovery': {
        const cfg = state.activeAttackId
          ? ATTACK_CONFIGS[state.activeAttackId as AttackId]
          : undefined;
        const clip = cfg?.animClip || (state.hasWeapon ? '1H_Melee_Attack_Slice_Horizontal' : 'Unarmed_Melee_Attack_Punch_A');
        const speed = cfg?.isHeavy ? 1.35 : 1.75;
        this.playAnimation(clip, false, speed);
        break;
      }
      default:
        this.playAnimation('Idle', true, 1.0);
        break;
    }
  }

  private updateWeaponTrailGeometry(innerY: number): void {
    const posAttr = this.weaponTrailMesh.geometry.getAttribute(
      'position'
    ) as THREE.BufferAttribute;
    const count = Math.min(6, this.trailPoints.length);
    for (let i = 0; i < 6; i++) {
      const pt = this.trailPoints[Math.min(i, count - 1)] || new THREE.Vector3();
      posAttr.setXYZ(i * 2, pt.x, pt.y + 0.18, pt.z);
      posAttr.setXYZ(i * 2 + 1, pt.x, innerY, pt.z);
    }
    posAttr.needsUpdate = true;
  }

  public dispose(scene: THREE.Scene): void {
    scene.remove(this.root);
    scene.remove(this.shadowBlob);
    scene.remove(this.landingRing);
    scene.remove(this.verticalDropLine);
    scene.remove(this.weaponTrailMesh);
  }
}
