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

const UNARMED_LIGHT_COMBO = [
  'Unarmed_Melee_Attack_Punch_A',
  'Unarmed_Melee_Attack_Punch_B',
  'Unarmed_Melee_Attack_Kick',
];

const SWORD_LIGHT_COMBO = [
  '1H_Melee_Attack_Slice_Horizontal',
  '1H_Melee_Attack_Slice_Diagonal',
  '1H_Melee_Attack_Stab',
];

const HIT_REACT_CLIPS = ['Hit_A', 'Hit_B', 'Block_Hit'];

export class FighterVisual {
  public readonly root = new THREE.Group();
  private modelGroup = new THREE.Group();
  private characterScene: THREE.Object3D | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private currentClip = '';

  private slot: 1 | 2;
  private archetype: CharacterArchetype;
  private assets: AssetLoader;

  private equippedBlade: THREE.Group | null = null;
  private customMaterials: THREE.MeshStandardMaterial[] = [];
  private hitFlashTimer = 0;

  // Animation transition & procedural motion state
  private prevState = 'idle';
  private prevAttackId = '';
  private wasGrounded = true;
  private prevVy = 0;
  private prevFacingAngle = 0;
  private comboStep = 0;
  private hitStep = 0;
  private activeAttackClip = '';
  private activeHitClip = 'Hit_A';
  private activeDodgeClip = 'Dodge_Forward';
  private landAnimTimer = 0;
  private takeoffAnimTimer = 0;
  private airFlipTimer = 0;
  private airFlipDuration = 0.34;

  // Procedural squash/stretch & tilt
  private squashScale = new THREE.Vector3(1, 1, 1);
  private proceduralTiltX = 0;
  private proceduralTiltZ = 0;

  // Spatial 3D readability indicators & combat VFX meshes
  private shadowBlob: THREE.Mesh;
  private footRing: THREE.Mesh;
  private landingRing: THREE.Mesh;
  private verticalDropLine: THREE.Line;
  private invulnSphere: THREE.Mesh;
  private weaponTrailMesh: THREE.Mesh;
  private slashArcMesh: THREE.Mesh;
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
      opacity: 0.72,
      depthWrite: false,
    });
    this.weaponTrailMesh = new THREE.Mesh(trailGeo, trailMat);
    this.weaponTrailMesh.frustumCulled = false;
    this.weaponTrailMesh.visible = false;
    scene.add(this.weaponTrailMesh);

    // 6. 3D Crescent Attack Slash Arc attached to fighter root
    const slashGeo = new THREE.RingGeometry(0.65, 1.55, 20, 1, -Math.PI * 0.42, Math.PI * 0.84);
    slashGeo.rotateX(-Math.PI / 2);
    slashGeo.rotateY(-Math.PI / 2);
    const slashMat = new THREE.MeshBasicMaterial({
      color: this.primaryColorHex,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
    });
    this.slashArcMesh = new THREE.Mesh(slashGeo, slashMat);
    this.slashArcMesh.position.set(0, 0.95, 0.25);
    this.slashArcMesh.visible = false;
    this.root.add(this.slashArcMesh);

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
    this.characterScene = clonedScene;

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

    this.playAnimation('Unarmed_Idle', true, 1.0, true);
  }

  public triggerHitFlash(): void {
    this.hitFlashTimer = 0.15;
    this.hitStep = (this.hitStep + 1) % HIT_REACT_CLIPS.length;
    this.activeHitClip = HIT_REACT_CLIPS[this.hitStep];
    this.squashScale.set(1.22, 0.78, 1.22);
    // Force restart hit animation so consecutive hits always visibly flinch
    this.playAnimation(this.activeHitClip, false, 1.45, true);
  }

  private playAnimation(
    clipName: string,
    loop = true,
    timeScale = 1.0,
    forceRestart = false,
    fadeDuration = 0.09
  ): void {
    if (!this.mixer) return;

    const nextAction =
      this.actions.get(clipName) ||
      this.actions.get('Idle') ||
      this.actions.values().next().value;
    if (!nextAction) return;

    if (this.currentClip === clipName && !forceRestart) {
      nextAction.timeScale = timeScale;
      return;
    }

    const prevAction = this.actions.get(this.currentClip);
    this.currentClip = clipName;

    nextAction.enabled = true;
    nextAction.reset();
    nextAction.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    nextAction.clampWhenFinished = !loop;
    nextAction.timeScale = timeScale;
    nextAction.play();

    if (prevAction && prevAction !== nextAction) {
      prevAction.crossFadeTo(nextAction, fadeDuration, false);
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
      this.slashArcMesh.visible = false;
      this.prevState = state.state;
      return;
    }

    // Detect landing & air-jump impulses for squash/stretch and flip animations
    if (!this.wasGrounded && state.grounded) {
      // Just landed on the stage!
      this.landAnimTimer = 0.16;
      this.airFlipTimer = 0;
      this.squashScale.set(1.18, 0.8, 1.18);
    } else if (this.wasGrounded && !state.grounded && state.vy > 3.0) {
      // Ground jump takeoff!
      this.takeoffAnimTimer = 0.16;
      this.squashScale.set(0.85, 1.2, 0.85);
    } else if (!this.wasGrounded && !state.grounded && state.vy > this.prevVy + 5.5) {
      // Midair double/triple jump impulse! Trigger 360 somersault flip + fresh jump pose
      this.airFlipTimer = this.airFlipDuration;
      this.squashScale.set(0.86, 1.18, 0.86);
      this.playAnimation('Jump_Full_Short', false, 1.5, true, 0.06);
    }

    // Update timers
    if (this.landAnimTimer > 0) this.landAnimTimer = Math.max(0, this.landAnimTimer - dt);
    if (this.takeoffAnimTimer > 0) this.takeoffAnimTimer = Math.max(0, this.takeoffAnimTimer - dt);
    if (this.airFlipTimer > 0) this.airFlipTimer = Math.max(0, this.airFlipTimer - dt);

    // Update 3D position & smooth facing rotation
    this.root.position.set(state.x, state.y, state.z);
    this.root.rotation.y = state.facingAngle;

    // Update equipped weapon visibility
    if (this.equippedBlade) {
      this.equippedBlade.visible = state.hasWeapon;
    }

    // Choose matching animation clip for current fighter state
    this.updateAnimationForState(state);
    this.mixer?.update(dt);

    // Procedural secondary motion: velocity lean, turn bank, air flip, squash & stretch, hitstop shake
    this.updateProceduralSecondaryMotion(state, dt, elapsedSec);

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
        mat.emissiveIntensity = 0.9;
      } else if (isInvuln) {
        mat.emissive.setHex(this.primaryColorHex);
        mat.emissiveIntensity = 0.35 + Math.sin(elapsedSec * 20) * 0.2;
      } else {
        mat.emissive.setHex(this.primaryColorHex);
        mat.emissiveIntensity = 0.15;
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
      landMat.color.setHex(overStage ? this.primaryColorHex : 0xff2a55);

      const posAttr = this.verticalDropLine.geometry.getAttribute(
        'position'
      ) as THREE.BufferAttribute;
      posAttr.setXYZ(0, state.x, landY, state.z);
      posAttr.setXYZ(1, state.x, state.y + 0.1, state.z);
      posAttr.needsUpdate = true;
    }

    // Update 3D Weapon Trail & Crescent Slash Wave during active/startup attack swings
    const inAttackSwing =
      state.state === 'attack_startup' || state.state === 'attack_active';
    if (inAttackSwing) {
      const fx = Math.sin(state.facingAngle);
      const fz = Math.cos(state.facingAngle);
      const reach = state.hasWeapon ? 1.65 : 1.15;
      const swingWave = Math.sin(elapsedSec * 45) * 0.35;
      const px = -fz * swingWave;
      const pz = fx * swingWave;
      const tip = new THREE.Vector3(
        state.x + fx * reach + px,
        state.y + 0.95,
        state.z + fz * reach + pz
      );
      this.trailPoints.unshift(tip);
      if (this.trailPoints.length > 6) {
        this.trailPoints.pop();
      }
      this.updateWeaponTrailGeometry(state.y + 0.75);
      this.weaponTrailMesh.visible = this.trailPoints.length >= 2;

      // Show glowing 3D crescent slash arc during active attack frames
      this.slashArcMesh.visible = state.state === 'attack_active';
      if (this.slashArcMesh.visible) {
        const isRecovery = state.activeAttackId.includes('recovery');
        this.slashArcMesh.rotation.z = isRecovery ? Math.PI * 0.35 : Math.sin(elapsedSec * 30) * 0.25;
        this.slashArcMesh.rotation.y = -Math.PI / 2 + Math.sin(elapsedSec * 40) * 0.4;
        const scale = state.hasWeapon ? 1.15 : 0.82;
        this.slashArcMesh.scale.setScalar(scale);
      }
    } else {
      this.trailPoints.length = 0;
      this.weaponTrailMesh.visible = false;
      this.slashArcMesh.visible = false;
    }

    this.wasGrounded = state.grounded;
    this.prevVy = state.vy;
    this.prevState = state.state;
    this.prevAttackId = state.activeAttackId;
    this.prevFacingAngle = state.facingAngle;
  }

  private updateProceduralSecondaryMotion(
    state: FighterRenderInput,
    dt: number,
    elapsedSec: number
  ): void {
    // 1. Spring squash/stretch back toward (1, 1, 1)
    const springBlend = 1 - Math.exp(-18 * dt);
    this.squashScale.x += (1 - this.squashScale.x) * springBlend;
    this.squashScale.y += (1 - this.squashScale.y) * springBlend;
    this.squashScale.z += (1 - this.squashScale.z) * springBlend;

    if (this.characterScene) {
      this.characterScene.scale.set(
        0.88 * this.squashScale.x,
        0.88 * this.squashScale.y,
        0.88 * this.squashScale.z
      );
    }

    // 2. Forward speed lean & turning bank tilt
    const fx = Math.sin(state.facingAngle);
    const fz = Math.cos(state.facingAngle);
    const forwardSpeed = state.vx * fx + state.vz * fz;
    const strafeSpeed = state.vx * fz - state.vz * fx;

    let targetTiltX = 0;
    let targetTiltZ = 0;

    if (state.state === 'move') {
      targetTiltX = THREE.MathUtils.clamp(forwardSpeed * 0.024, -0.18, 0.22);
      targetTiltZ = THREE.MathUtils.clamp(-strafeSpeed * 0.025, -0.16, 0.16);
    } else if (state.state === 'dodge') {
      targetTiltX = 0.28;
    } else if (state.state === 'attack_active') {
      targetTiltX = 0.16;
    } else if (state.state === 'hitstun') {
      targetTiltX = -0.22;
    }

    const tiltBlend = 1 - Math.exp(-16 * dt);
    this.proceduralTiltX += (targetTiltX - this.proceduralTiltX) * tiltBlend;
    this.proceduralTiltZ += (targetTiltZ - this.proceduralTiltZ) * tiltBlend;

    // 3. Midair double-jump 360 somersault flip
    let flipAngleX = 0;
    if (this.airFlipTimer > 0) {
      const progress = 1 - this.airFlipTimer / this.airFlipDuration;
      flipAngleX = progress * Math.PI * 2;
    }

    this.modelGroup.rotation.set(this.proceduralTiltX + flipAngleX, 0, this.proceduralTiltZ);

    // 4. Hitstop / Impact Vibration Shake
    if (this.hitFlashTimer > 0.04) {
      const jx = Math.sin(elapsedSec * 190) * 0.065;
      const jz = Math.cos(elapsedSec * 170) * 0.065;
      this.modelGroup.position.set(jx, 0, jz);
    } else {
      this.modelGroup.position.set(0, 0, 0);
    }
  }

  private updateAnimationForState(state: FighterRenderInput): void {
    const isAttackState =
      state.state === 'attack_startup' ||
      state.state === 'attack_active' ||
      state.state === 'attack_recovery';
    const wasAttackState =
      this.prevState === 'attack_startup' ||
      this.prevState === 'attack_active' ||
      this.prevState === 'attack_recovery';

    switch (state.state) {
      case 'idle': {
        if (this.landAnimTimer > 0) {
          this.playAnimation('Jump_Land', false, 1.85, false, 0.05);
        } else {
          this.playAnimation(state.hasWeapon ? '2H_Melee_Idle' : 'Unarmed_Idle', true, 1.0, false, 0.14);
        }
        break;
      }

      case 'move': {
        if (this.landAnimTimer > 0.06) {
          this.playAnimation('Jump_Land', false, 2.1, false, 0.05);
          break;
        }
        const fx = Math.sin(state.facingAngle);
        const fz = Math.cos(state.facingAngle);
        const forward = state.vx * fx + state.vz * fz;
        const strafe = state.vx * fz - state.vz * fx;
        const speedXZ = Math.hypot(state.vx, state.vz);
        const rate = THREE.MathUtils.clamp(speedXZ / 7.2, 0.85, 1.38);

        if (Math.abs(strafe) > Math.abs(forward) * 1.25 && speedXZ > 2.0) {
          this.playAnimation(
            strafe > 0 ? 'Running_Strafe_Right' : 'Running_Strafe_Left',
            true,
            rate,
            false,
            0.1
          );
        } else if (forward < -1.5) {
          this.playAnimation('Walking_Backwards', true, rate * 1.15, false, 0.1);
        } else if (speedXZ < 3.2) {
          this.playAnimation('Walking_A', true, 1.15, false, 0.1);
        } else {
          this.playAnimation(state.hasWeapon ? 'Running_A' : 'Running_B', true, rate, false, 0.1);
        }
        break;
      }

      case 'jump': {
        if (this.airFlipTimer > 0) {
          this.playAnimation('Jump_Full_Short', false, 1.5, false, 0.06);
        } else if (this.takeoffAnimTimer > 0) {
          this.playAnimation('Jump_Start', false, 1.65, false, 0.05);
        } else {
          this.playAnimation('Jump_Idle', true, 1.05, false, 0.1);
        }
        break;
      }

      case 'fall': {
        this.playAnimation('Jump_Idle', true, 0.88, false, 0.12);
        break;
      }

      case 'dodge': {
        const justEnteredDodge = this.prevState !== 'dodge';
        if (justEnteredDodge) {
          const fx = Math.sin(state.facingAngle);
          const fz = Math.cos(state.facingAngle);
          const forward = state.vx * fx + state.vz * fz;
          const strafe = state.vx * fz - state.vz * fx;
          const speedXZ = Math.hypot(state.vx, state.vz);

          if (speedXZ < 1.0) {
            this.activeDodgeClip = 'Dodge_Backward';
          } else if (Math.abs(strafe) > Math.abs(forward)) {
            this.activeDodgeClip = strafe > 0 ? 'Dodge_Right' : 'Dodge_Left';
          } else {
            this.activeDodgeClip = forward >= 0 ? 'Dodge_Forward' : 'Dodge_Backward';
          }
          this.squashScale.set(1.16, 0.84, 1.16);
          this.playAnimation(this.activeDodgeClip, false, 1.75, true, 0.05);
        } else {
          this.playAnimation(this.activeDodgeClip, false, 1.75, false, 0.05);
        }
        break;
      }

      case 'pickup': {
        const justPicked = this.prevState !== 'pickup';
        this.playAnimation('PickUp', false, 2.3, justPicked, 0.05);
        break;
      }

      case 'throw': {
        const justThrew = this.prevState !== 'throw';
        this.playAnimation('Throw', false, 1.95, justThrew, 0.05);
        break;
      }

      case 'hitstun': {
        const justHit = this.prevState !== 'hitstun';
        const kbSpeed = Math.hypot(state.vx, state.vz, state.vy);
        if (justHit) {
          this.hitStep = (this.hitStep + 1) % HIT_REACT_CLIPS.length;
          this.activeHitClip = kbSpeed > 15.5 ? 'Death_A' : HIT_REACT_CLIPS[this.hitStep];
          this.playAnimation(this.activeHitClip, false, 1.4, true, 0.04);
        } else {
          this.playAnimation(this.activeHitClip, false, 1.4, false, 0.06);
        }
        break;
      }

      case 'attack_startup':
      case 'attack_active':
      case 'attack_recovery': {
        const isNewAttack =
          !wasAttackState ||
          state.activeAttackId !== this.prevAttackId ||
          (state.state === 'attack_startup' && this.prevState === 'attack_recovery');

        const cfg = state.activeAttackId
          ? ATTACK_CONFIGS[state.activeAttackId as AttackId]
          : undefined;

        if (isNewAttack || !this.activeAttackClip) {
          this.comboStep = (this.comboStep + 1) % 3;
          this.activeAttackClip = this.selectAttackAnimationClip(state, cfg?.animClip);
          this.squashScale.set(1.12, 0.9, 1.12);
          const speed = cfg?.isHeavy ? 1.45 : 1.85;
          this.playAnimation(this.activeAttackClip, false, speed, true, 0.05);
        } else {
          const speed = cfg?.isHeavy ? 1.45 : 1.85;
          this.playAnimation(this.activeAttackClip, false, speed, false, 0.05);
        }
        break;
      }

      default:
        this.playAnimation('Idle', true, 1.0);
        break;
    }
  }

  private selectAttackAnimationClip(state: FighterRenderInput, defaultClip?: string): string {
    switch (state.activeAttackId as AttackId) {
      case 'unarmed_light_ground':
        return UNARMED_LIGHT_COMBO[this.comboStep % UNARMED_LIGHT_COMBO.length];
      case 'unarmed_heavy_ground':
        return this.comboStep % 2 === 0 ? '2H_Melee_Attack_Spin' : 'Unarmed_Melee_Attack_Kick';
      case 'unarmed_light_air':
        return 'Unarmed_Melee_Attack_Kick';
      case 'unarmed_heavy_air':
        return '1H_Melee_Attack_Chop';
      case 'unarmed_recovery':
        return '2H_Melee_Attack_Spinning';
      case 'sword_light_ground':
        return SWORD_LIGHT_COMBO[this.comboStep % SWORD_LIGHT_COMBO.length];
      case 'sword_heavy_ground':
        return this.comboStep % 2 === 0 ? '2H_Melee_Attack_Chop' : '2H_Melee_Attack_Spin';
      case 'sword_light_air':
        return 'Dualwield_Melee_Attack_Slice';
      case 'sword_heavy_air':
        return '2H_Melee_Attack_Chop';
      case 'sword_recovery':
        return '2H_Melee_Attack_Spinning';
      default:
        return (
          defaultClip ||
          (state.hasWeapon ? '1H_Melee_Attack_Slice_Horizontal' : 'Unarmed_Melee_Attack_Punch_A')
        );
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
