import { ATTACK_CONFIGS, SIM_CONFIG } from './config.js';
import {
  AttackId,
  CharacterArchetype,
  CombatEvent,
  CombatEventType,
  FighterSimState,
  InputFrame,
  SimulationWorld,
  WeaponSimState,
} from './types.js';

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function sanitizeInput(raw: Partial<InputFrame> | undefined): InputFrame {
  const moveX = typeof raw?.moveX === 'number' && Number.isFinite(raw.moveX) ? clamp(Math.round(raw.moveX), -1, 1) : 0;
  const moveZ = typeof raw?.moveZ === 'number' && Number.isFinite(raw.moveZ) ? clamp(Math.round(raw.moveZ), -1, 1) : 0;
  return {
    seq: typeof raw?.seq === 'number' && Number.isFinite(raw.seq) ? Math.max(0, Math.floor(raw.seq)) : 0,
    moveX,
    moveZ,
    jumpPressed: Boolean(raw?.jumpPressed),
    dodgePressed: Boolean(raw?.dodgePressed),
    lightPressed: Boolean(raw?.lightPressed),
    heavyPressed: Boolean(raw?.heavyPressed),
    recoveryPressed: Boolean(raw?.recoveryPressed),
    weaponPressed: Boolean(raw?.weaponPressed),
    clientTime: typeof raw?.clientTime === 'number' ? raw.clientTime : 0,
  };
}

/**
 * Explicit knockback formula: strictly increasing with target's accumulated damage.
 */
export function computeKnockbackMagnitude(
  baseKnockback: number,
  knockbackScaling: number,
  targetDamageAfterHit: number
): number {
  const dmgRatio = Math.max(0, targetDamageAfterHit) / 100;
  return baseKnockback + knockbackScaling * Math.pow(dmgRatio, 1.15);
}

/**
 * True 3D intersection between a sphere (hitbox / projectile) and a vertical capsule (fighter hurtbox).
 */
export function intersectSphereHurtbox3D(
  sx: number,
  sy: number,
  sz: number,
  sRadius: number,
  target: Pick<FighterSimState, 'x' | 'y' | 'z'>
): boolean {
  const cRadius = SIM_CONFIG.HURTBOX_RADIUS;
  const cyBottom = target.y + cRadius;
  const cyTop = target.y + SIM_CONFIG.HURTBOX_HEIGHT - cRadius;
  const closestY = clamp(sy, cyBottom, Math.max(cyBottom, cyTop));
  const dx = sx - target.x;
  const dy = sy - closestY;
  const dz = sz - target.z;
  const combinedRadius = sRadius + cRadius;
  return dx * dx + dy * dy + dz * dz <= combinedRadius * combinedRadius;
}

export function isPointOverStageXZ(x: number, z: number, margin = 0): boolean {
  return (
    Math.abs(x) <= SIM_CONFIG.ARENA_HALF_WIDTH_X + margin &&
    Math.abs(z) <= SIM_CONFIG.ARENA_HALF_DEPTH_Z + margin
  );
}

export function createInitialFighterState(
  sessionId: string,
  slot: 1 | 2,
  nickname: string,
  archetype: CharacterArchetype
): FighterSimState {
  const spawn = slot === 1 ? SIM_CONFIG.SPAWN_P1 : SIM_CONFIG.SPAWN_P2;
  return {
    sessionId,
    slot,
    nickname: nickname.trim().slice(0, 16) || `Fighter ${slot}`,
    archetype,
    ready: false,
    rematchVote: false,
    connected: true,

    x: spawn.x,
    y: spawn.y,
    z: spawn.z,
    vx: 0,
    vy: 0,
    vz: 0,
    facingAngle: spawn.facingAngle,

    grounded: true,
    groundJumpsLeft: SIM_CONFIG.MAX_GROUND_JUMPS,
    airJumpsLeft: SIM_CONFIG.MAX_AIR_JUMPS,
    airRecoveriesLeft: SIM_CONFIG.MAX_AIR_RECOVERIES,
    coyoteTicks: SIM_CONFIG.COYOTE_TICKS,
    jumpBufferTicks: 0,

    stocks: SIM_CONFIG.INITIAL_STOCKS,
    damage: 0,
    state: 'idle',
    stateTicks: 0,
    activeAttackId: '',
    attackInstanceId: 0,
    attackCooldownTicks: 0,
    dodgeCooldownTicks: 0,
    dodgeDirX: 0,
    dodgeDirZ: 0,
    hitstunTicks: 0,
    hitstopTicks: 0,
    invulnerableTicks: 0,
    respawnTicks: 0,

    hasWeapon: false,
    weaponDurability: 0,

    lastProcessedInputSeq: 0,
    bufferedAction: '',
    bufferedActionTicks: 0,
    prevJumpDown: false,
    prevDodgeDown: false,
    prevLightDown: false,
    prevHeavyDown: false,
    prevRecoveryDown: false,
    prevWeaponDown: false,
  };
}

export function createInitialWeaponState(): WeaponSimState {
  return {
    id: 1,
    status: 'on_ground',
    holderSlot: 0,
    throwerSlot: 0,
    throwInstanceId: 0,
    x: SIM_CONFIG.WEAPON_SPAWN_POS.x,
    y: 0,
    z: SIM_CONFIG.WEAPON_SPAWN_POS.z,
    vx: 0,
    vy: 0,
    vz: 0,
    rotationY: 0,
    respawnTimerTicks: 0,
    flightTicksLeft: 0,
  };
}

export function createSimulationWorld(): SimulationWorld {
  return {
    tick: 0,
    phase: 'waiting',
    countdownTicks: SIM_CONFIG.COUNTDOWN_TICKS,
    timerTicks: SIM_CONFIG.MATCH_DURATION_TICKS,
    winnerSlot: 0,
    winReason: '',
    disconnectGraceTicks: 0,
    disconnectedSlot: 0,
    nextEventId: 1,
    nextAttackInstanceId: 1,
    fighters: new Map(),
    weapon: createInitialWeaponState(),
    attackHits: new Map(),
    thrownWeaponHits: new Map(),
    events: [],
  };
}

export function resetFighterForMatch(fighter: FighterSimState): void {
  const spawn = fighter.slot === 1 ? SIM_CONFIG.SPAWN_P1 : SIM_CONFIG.SPAWN_P2;
  fighter.x = spawn.x;
  fighter.y = spawn.y;
  fighter.z = spawn.z;
  fighter.vx = 0;
  fighter.vy = 0;
  fighter.vz = 0;
  fighter.facingAngle = spawn.facingAngle;

  fighter.grounded = true;
  fighter.groundJumpsLeft = SIM_CONFIG.MAX_GROUND_JUMPS;
  fighter.airJumpsLeft = SIM_CONFIG.MAX_AIR_JUMPS;
  fighter.airRecoveriesLeft = SIM_CONFIG.MAX_AIR_RECOVERIES;
  fighter.coyoteTicks = SIM_CONFIG.COYOTE_TICKS;
  fighter.jumpBufferTicks = 0;

  fighter.stocks = SIM_CONFIG.INITIAL_STOCKS;
  fighter.damage = 0;
  fighter.state = 'idle';
  fighter.stateTicks = 0;
  fighter.activeAttackId = '';
  fighter.attackInstanceId = 0;
  fighter.attackCooldownTicks = 0;
  fighter.dodgeCooldownTicks = 0;
  fighter.dodgeDirX = 0;
  fighter.dodgeDirZ = 0;
  fighter.hitstunTicks = 0;
  fighter.hitstopTicks = 0;
  fighter.invulnerableTicks = 0;
  fighter.respawnTicks = 0;

  fighter.hasWeapon = false;
  fighter.weaponDurability = 0;
  fighter.rematchVote = false;

  fighter.bufferedAction = '';
  fighter.bufferedActionTicks = 0;
  fighter.prevJumpDown = false;
  fighter.prevDodgeDown = false;
  fighter.prevLightDown = false;
  fighter.prevHeavyDown = false;
  fighter.prevRecoveryDown = false;
  fighter.prevWeaponDown = false;
}

export function startMatchCountdown(world: SimulationWorld): void {
  world.phase = 'countdown';
  world.countdownTicks = SIM_CONFIG.COUNTDOWN_TICKS;
  world.timerTicks = SIM_CONFIG.MATCH_DURATION_TICKS;
  world.winnerSlot = 0;
  world.winReason = '';
  world.disconnectGraceTicks = 0;
  world.disconnectedSlot = 0;
  world.attackHits.clear();
  world.thrownWeaponHits.clear();
  world.weapon = createInitialWeaponState();
  for (const fighter of world.fighters.values()) {
    resetFighterForMatch(fighter);
  }
}

function pushEvent(
  world: SimulationWorld,
  type: CombatEventType,
  sourceSlot: 0 | 1 | 2,
  targetSlot: 0 | 1 | 2,
  x: number,
  y: number,
  z: number,
  damageDealt = 0,
  knockbackSpeed = 0
): void {
  const evt: CombatEvent = {
    eventId: world.nextEventId++,
    type,
    tick: world.tick,
    sourceSlot,
    targetSlot,
    x,
    y,
    z,
    damageDealt,
    knockbackSpeed,
  };
  world.events.push(evt);
  if (world.events.length > 32) {
    world.events.splice(0, world.events.length - 32);
  }
}

/**
 * Pure kinematic movement & stage collision step for a fighter.
 * Used both on server and for client-side local prediction.
 */
export function stepFighterKinematicMovement(
  fighter: FighterSimState,
  moveX: number,
  moveZ: number,
  jumpJustPressed: boolean,
  dt: number = SIM_CONFIG.DT
): boolean {
  let didJump = false;

  // Normalize diagonal input on X/Z plane
  let dirX = moveX;
  let dirZ = moveZ;
  const len = Math.hypot(dirX, dirZ);
  if (len > 1e-4) {
    dirX /= len;
    dirZ /= len;
  }

  if (jumpJustPressed) {
    fighter.jumpBufferTicks = SIM_CONFIG.JUMP_BUFFER_TICKS;
  } else if (fighter.jumpBufferTicks > 0) {
    fighter.jumpBufferTicks--;
  }

  if (fighter.grounded) {
    fighter.coyoteTicks = SIM_CONFIG.COYOTE_TICKS;
    fighter.groundJumpsLeft = SIM_CONFIG.MAX_GROUND_JUMPS;
    fighter.airJumpsLeft = SIM_CONFIG.MAX_AIR_JUMPS;
    fighter.airRecoveriesLeft = SIM_CONFIG.MAX_AIR_RECOVERIES;
  } else if (fighter.coyoteTicks > 0) {
    fighter.coyoteTicks--;
  }

  const canAct =
    fighter.state === 'idle' ||
    fighter.state === 'move' ||
    fighter.state === 'jump' ||
    fighter.state === 'fall';

  // Execute buffered or immediate jump if allowed
  if (canAct && fighter.jumpBufferTicks > 0) {
    if (fighter.grounded || fighter.coyoteTicks > 0) {
      fighter.vy = SIM_CONFIG.GROUND_JUMP_SPEED;
      fighter.grounded = false;
      fighter.coyoteTicks = 0;
      fighter.groundJumpsLeft = 0;
      fighter.jumpBufferTicks = 0;
      fighter.state = 'jump';
      fighter.stateTicks = 0;
      didJump = true;
    } else if (fighter.airJumpsLeft > 0) {
      fighter.vy = SIM_CONFIG.AIR_JUMP_SPEED;
      fighter.airJumpsLeft--;
      fighter.jumpBufferTicks = 0;
      fighter.state = 'jump';
      fighter.stateTicks = 0;
      // Allow crisp directional air-jump redirect
      if (len > 1e-4) {
        const maxAir = SIM_CONFIG.MAX_AIR_SPEED;
        fighter.vx = dirX * maxAir * 0.88;
        fighter.vz = dirZ * maxAir * 0.88;
        fighter.facingAngle = Math.atan2(dirX, dirZ);
      }
      didJump = true;
    }
  }

  // Horizontal acceleration & friction (scaled by archetype speedMult)
  if (canAct) {
    const archMod = SIM_CONFIG.ARCHETYPE_MODIFIERS[fighter.archetype] ?? SIM_CONFIG.ARCHETYPE_MODIFIERS.vanguard;
    const baseMaxSpeed = fighter.grounded
      ? fighter.hasWeapon
        ? SIM_CONFIG.MAX_GROUND_SPEED_ARMED
        : SIM_CONFIG.MAX_GROUND_SPEED_UNARMED
      : SIM_CONFIG.MAX_AIR_SPEED;
    const maxSpeed = baseMaxSpeed * archMod.speedMult;

    const accel = fighter.grounded ? SIM_CONFIG.GROUND_ACCEL : SIM_CONFIG.AIR_ACCEL;
    const friction = fighter.grounded ? SIM_CONFIG.GROUND_FRICTION : SIM_CONFIG.AIR_DRAG;

    if (len > 1e-4) {
      fighter.vx += dirX * accel * dt;
      fighter.vz += dirZ * accel * dt;
      const curSpeedXZ = Math.hypot(fighter.vx, fighter.vz);
      if (curSpeedXZ > maxSpeed) {
        const scale = maxSpeed / curSpeedXZ;
        fighter.vx *= scale;
        fighter.vz *= scale;
      }
      fighter.facingAngle = Math.atan2(dirX, dirZ);
    } else {
      const curSpeedXZ = Math.hypot(fighter.vx, fighter.vz);
      if (curSpeedXZ > 0) {
        const drop = Math.max(0, curSpeedXZ - friction * dt);
        const scale = drop / curSpeedXZ;
        fighter.vx *= scale;
        fighter.vz *= scale;
      }
    }
  } else if (fighter.state === 'dodge') {
    fighter.vx = fighter.dodgeDirX * SIM_CONFIG.DODGE_SPEED_XZ;
    fighter.vz = fighter.dodgeDirZ * SIM_CONFIG.DODGE_SPEED_XZ;
    if (!fighter.grounded) {
      fighter.vy = Math.max(fighter.vy, -2.0);
    }
  } else if (fighter.state === 'hitstun') {
    // Directional influence (DI) + knockback air drag
    if (len > 1e-4) {
      fighter.vx += dirX * 10.0 * dt;
      fighter.vz += dirZ * 10.0 * dt;
    }
    const drag = fighter.grounded ? SIM_CONFIG.GROUND_FRICTION * 0.45 : SIM_CONFIG.KNOCKBACK_AIR_DRAG;
    const curSpeedXZ = Math.hypot(fighter.vx, fighter.vz);
    if (curSpeedXZ > 0) {
      const drop = Math.max(0, curSpeedXZ - drag * dt);
      const scale = drop / curSpeedXZ;
      fighter.vx *= scale;
      fighter.vz *= scale;
    }
  } else {
    // During attack_startup / attack_active / attack_recovery / pickup / throw
    const drag = fighter.grounded ? SIM_CONFIG.GROUND_FRICTION * 0.65 : SIM_CONFIG.AIR_DRAG * 0.7;
    const curSpeedXZ = Math.hypot(fighter.vx, fighter.vz);
    if (curSpeedXZ > 0) {
      const drop = Math.max(0, curSpeedXZ - drag * dt);
      const scale = drop / curSpeedXZ;
      fighter.vx *= scale;
      fighter.vz *= scale;
    }
  }

  // Gravity
  if (!fighter.grounded) {
    fighter.vy -= SIM_CONFIG.GRAVITY * dt;
    if (fighter.vy < SIM_CONFIG.MAX_FALL_SPEED) {
      fighter.vy = SIM_CONFIG.MAX_FALL_SPEED;
    }
  }

  // Integrate position in 3D space
  const prevY = fighter.y;
  const prevX = fighter.x;
  const prevZ = fighter.z;

  fighter.x += fighter.vx * dt;
  fighter.y += fighter.vy * dt;
  fighter.z += fighter.vz * dt;

  // Stage 3D Platform Collision (Top surface Y=0, slab down to -ARENA_SLAB_THICKNESS_Y, plus under-island rock)
  const overStageNow = isPointOverStageXZ(fighter.x, fighter.z, 0.25);
  const wasAboveTop = prevY >= -0.18;

  if (overStageNow && wasAboveTop && fighter.y <= 0 && fighter.vy <= 0) {
    fighter.y = 0;
    fighter.vy = 0;
    fighter.grounded = true;
    fighter.groundJumpsLeft = SIM_CONFIG.MAX_GROUND_JUMPS;
    fighter.airJumpsLeft = SIM_CONFIG.MAX_AIR_JUMPS;
    fighter.airRecoveriesLeft = SIM_CONFIG.MAX_AIR_RECOVERIES;
    fighter.coyoteTicks = SIM_CONFIG.COYOTE_TICKS;
  } else if (!overStageNow && fighter.grounded) {
    // Walked or knocked off any of the 4 edges of the 3D arena
    fighter.grounded = false;
  } else if (fighter.y < -0.05 && fighter.y > -9.6) {
    // Watertight 3D Side-Wall, Under-Cone & Ceiling Collision so fighters NEVER clip into the stage or under-rock
    const slabBottom = -SIM_CONFIG.ARENA_SLAB_THICKNESS_Y;
    const taper =
      fighter.y >= slabBottom
        ? 1.0
        : Math.max(0.25, 1.0 - (-fighter.y - SIM_CONFIG.ARENA_SLAB_THICKNESS_Y) / 7.5);
    const wallHalfW = SIM_CONFIG.ARENA_HALF_WIDTH_X * taper + 0.34;
    const wallHalfD = SIM_CONFIG.ARENA_HALF_DEPTH_Z * taper + 0.34;

    if (Math.abs(fighter.x) < wallHalfW && Math.abs(fighter.z) < wallHalfD) {
      // Check if hitting ceiling from underneath the island
      const headY = fighter.y + SIM_CONFIG.HURTBOX_HEIGHT;
      const prevHeadY = prevY + SIM_CONFIG.HURTBOX_HEIGHT;
      if (prevHeadY <= slabBottom + 0.15 && headY > slabBottom && fighter.vy > 0) {
        fighter.y = slabBottom - SIM_CONFIG.HURTBOX_HEIGHT;
        fighter.vy = -fighter.vy * 0.25;
      } else {
        const distLeft = Math.abs(prevX - -wallHalfW);
        const distRight = Math.abs(prevX - wallHalfW);
        const distFront = Math.abs(prevZ - wallHalfD);
        const distBack = Math.abs(prevZ - -wallHalfD);
        const minDist = Math.min(distLeft, distRight, distFront, distBack);

        if (minDist === distLeft) {
          fighter.x = -wallHalfW;
          fighter.vx = Math.min(0, fighter.vx);
        } else if (minDist === distRight) {
          fighter.x = wallHalfW;
          fighter.vx = Math.max(0, fighter.vx);
        } else if (minDist === distFront) {
          fighter.z = wallHalfD;
          fighter.vz = Math.max(0, fighter.vz);
        } else {
          fighter.z = -wallHalfD;
          fighter.vz = Math.min(0, fighter.vz);
        }
      }
    }
  }

  // Solid 3D Stage Corner Pillars Collision (prevents walking or dashing through pillars)
  for (const pillar of SIM_CONFIG.STAGE_PILLARS) {
    if (fighter.y < pillar.height && fighter.y + SIM_CONFIG.HURTBOX_HEIGHT > 0) {
      const dx = fighter.x - pillar.x;
      const dz = fighter.z - pillar.z;
      const distXZ = Math.hypot(dx, dz);
      const minRadius = pillar.radius + SIM_CONFIG.FIGHTER_PUSH_RADIUS;
      if (distXZ < minRadius) {
        const nx = distXZ > 1e-4 ? dx / distXZ : 0;
        const nz = distXZ > 1e-4 ? dz / distXZ : 1;
        fighter.x = pillar.x + nx * minRadius;
        fighter.z = pillar.z + nz * minRadius;
        const vn = fighter.vx * nx + fighter.vz * nz;
        if (vn < 0) {
          fighter.vx -= vn * nx;
          fighter.vz -= vn * nz;
        }
      }
    }
  }

  // Update locomotion state labels when not in special states
  if (canAct) {
    if (!fighter.grounded) {
      fighter.state = fighter.vy > 0.2 ? 'jump' : 'fall';
    } else {
      const speedXZ = Math.hypot(fighter.vx, fighter.vz);
      fighter.state = speedXZ > 0.35 ? 'move' : 'idle';
    }
  }

  return didJump;
}

export function canFighterStartAction(
  fighter: Pick<FighterSimState, 'state'>
): boolean {
  return (
    fighter.state === 'idle' ||
    fighter.state === 'move' ||
    fighter.state === 'jump' ||
    fighter.state === 'fall'
  );
}

export function chooseAttackId(
  fighter: Pick<
    FighterSimState,
    'state' | 'attackCooldownTicks' | 'airRecoveriesLeft' | 'hasWeapon' | 'grounded'
  >,
  recoveryPressed: boolean,
  heavyPressed: boolean,
  lightPressed: boolean
): AttackId | null {
  if (!canFighterStartAction(fighter) || fighter.attackCooldownTicks > 0) {
    return null;
  }
  if (recoveryPressed && fighter.airRecoveriesLeft > 0) {
    return fighter.hasWeapon ? 'sword_recovery' : 'unarmed_recovery';
  }
  if (heavyPressed) {
    return fighter.hasWeapon
      ? fighter.grounded
        ? 'sword_heavy_ground'
        : 'sword_heavy_air'
      : fighter.grounded
        ? 'unarmed_heavy_ground'
        : 'unarmed_heavy_air';
  }
  if (lightPressed) {
    return fighter.hasWeapon
      ? fighter.grounded
        ? 'sword_light_ground'
        : 'sword_light_air'
      : fighter.grounded
        ? 'unarmed_light_ground'
        : 'unarmed_light_air';
  }
  return null;
}

function getOpponent(world: SimulationWorld, self: FighterSimState): FighterSimState | undefined {
  for (const f of world.fighters.values()) {
    if (f.sessionId !== self.sessionId) {
      return f;
    }
  }
  return undefined;
}

function startAttack(
  world: SimulationWorld,
  fighter: FighterSimState,
  attackId: AttackId,
  moveX: number,
  moveZ: number
): void {
  const cfg = ATTACK_CONFIGS[attackId];
  fighter.state = 'attack_startup';
  fighter.stateTicks = 0;
  fighter.activeAttackId = attackId;
  fighter.attackInstanceId = world.nextAttackInstanceId++;
  fighter.attackCooldownTicks = cfg.cooldownTicks;
  world.attackHits.set(fighter.attackInstanceId, new Set());

  // Requirement 6: Auto-orient fighter toward opponent at attack startup if within reasonable range;
  // otherwise orient to movement input or keep current facing. Lock facing during attack.
  const opponent = getOpponent(world, fighter);
  const inputLen = Math.hypot(moveX, moveZ);

  if (
    opponent &&
    opponent.state !== 'ko' &&
    opponent.state !== 'respawn' &&
    Math.hypot(opponent.x - fighter.x, opponent.z - fighter.z) <= SIM_CONFIG.AUTO_AIM_MAX_DISTANCE
  ) {
    const dx = opponent.x - fighter.x;
    const dz = opponent.z - fighter.z;
    if (Math.hypot(dx, dz) > 0.05) {
      fighter.facingAngle = Math.atan2(dx, dz);
    }
  } else if (inputLen > 1e-4) {
    fighter.facingAngle = Math.atan2(moveX, moveZ);
  }

  // Apply forward lunge & vertical recovery boost
  const fx = Math.sin(fighter.facingAngle);
  const fz = Math.cos(fighter.facingAngle);
  fighter.vx = fx * cfg.lungeSpeedXZ;
  fighter.vz = fz * cfg.lungeSpeedXZ;
  if (cfg.boostY > 0) {
    fighter.vy = cfg.boostY;
    fighter.grounded = false;
  }
}

export function stepWorldTick(
  world: SimulationWorld,
  inputsBySession: Map<string, InputFrame>
): void {
  world.tick++;
  const dt = SIM_CONFIG.DT;

  if (world.phase === 'paused_disconnect') {
    if (world.disconnectGraceTicks > 0) {
      world.disconnectGraceTicks--;
      if (world.disconnectGraceTicks <= 0) {
        // Grace period expired -> Remaining connected player wins by FORFEIT
        let remainingSlot: 0 | 1 | 2 = 0;
        for (const f of world.fighters.values()) {
          if (f.connected && f.slot !== world.disconnectedSlot) {
            remainingSlot = f.slot;
          }
        }
        world.phase = 'finished';
        world.winnerSlot = remainingSlot;
        world.winReason = 'FORFEIT';
        pushEvent(world, 'match_end', remainingSlot, world.disconnectedSlot, 0, 1, 0);
      }
    }
    return;
  }

  if (world.phase === 'countdown') {
    if (world.countdownTicks % 60 === 0 && world.countdownTicks > 0) {
      pushEvent(world, 'countdown_tick', 0, 0, 0, 1, 0, Math.ceil(world.countdownTicks / 60), 0);
    }
    world.countdownTicks--;
    if (world.countdownTicks <= 0) {
      world.phase = 'fighting';
      pushEvent(world, 'match_start', 0, 0, 0, 1, 0);
    }
    return;
  }

  if (world.phase !== 'fighting') {
    return;
  }

  // 1. Update each fighter
  for (const fighter of world.fighters.values()) {
    const rawInput = inputsBySession.get(fighter.sessionId);
    const input = sanitizeInput(rawInput);
    if (input.seq > fighter.lastProcessedInputSeq) {
      fighter.lastProcessedInputSeq = input.seq;
    }

    // Edge-trigger detection
    const jumpJustPressed = input.jumpPressed && !fighter.prevJumpDown;
    const dodgeJustPressed = input.dodgePressed && !fighter.prevDodgeDown;
    const lightJustPressed = input.lightPressed && !fighter.prevLightDown;
    const heavyJustPressed = input.heavyPressed && !fighter.prevHeavyDown;
    const recoveryJustPressed = input.recoveryPressed && !fighter.prevRecoveryDown;
    const weaponJustPressed = input.weaponPressed && !fighter.prevWeaponDown;

    fighter.prevJumpDown = input.jumpPressed;
    fighter.prevDodgeDown = input.dodgePressed;
    fighter.prevLightDown = input.lightPressed;
    fighter.prevHeavyDown = input.heavyPressed;
    fighter.prevRecoveryDown = input.recoveryPressed;
    fighter.prevWeaponDown = input.weaponPressed;

    // Cooldowns & timers
    if (fighter.attackCooldownTicks > 0) fighter.attackCooldownTicks--;
    if (fighter.dodgeCooldownTicks > 0) fighter.dodgeCooldownTicks--;
    if (fighter.invulnerableTicks > 0) fighter.invulnerableTicks--;

    // Respawn handling after KO
    if (fighter.state === 'respawn') {
      fighter.respawnTicks--;
      if (fighter.respawnTicks <= 0) {
        const spawn = fighter.slot === 1 ? SIM_CONFIG.SPAWN_P1 : SIM_CONFIG.SPAWN_P2;
        fighter.x = spawn.x * 0.65;
        fighter.y = SIM_CONFIG.RESPAWN_HEIGHT_Y;
        fighter.z = 0;
        fighter.vx = 0;
        fighter.vy = 0;
        fighter.vz = 0;
        fighter.facingAngle = spawn.facingAngle;
        fighter.grounded = false;
        fighter.groundJumpsLeft = SIM_CONFIG.MAX_GROUND_JUMPS;
        fighter.airJumpsLeft = SIM_CONFIG.MAX_AIR_JUMPS;
        fighter.airRecoveriesLeft = SIM_CONFIG.MAX_AIR_RECOVERIES;
        fighter.damage = 0;
        fighter.hasWeapon = false;
        fighter.weaponDurability = 0;
        fighter.invulnerableTicks = SIM_CONFIG.RESPAWN_INVULN_TICKS;
        fighter.state = 'fall';
        fighter.stateTicks = 0;
        pushEvent(world, 'respawn', fighter.slot, 0, fighter.x, fighter.y, fighter.z);
      }
      continue;
    }

    if (fighter.state === 'ko') {
      continue;
    }

    // Deterministic Hit-stop (freeze frame on impact for both attacker & defender)
    if (fighter.hitstopTicks > 0) {
      fighter.hitstopTicks--;
      continue;
    }

    fighter.stateTicks++;

    // State machine transitions
    if (fighter.state === 'hitstun') {
      fighter.bufferedAction = '';
      fighter.bufferedActionTicks = 0;
      fighter.hitstunTicks--;
      if (fighter.hitstunTicks <= 0) {
        fighter.state = fighter.grounded ? 'idle' : 'fall';
        fighter.stateTicks = 0;
      }
    } else if (fighter.state === 'dodge') {
      if (
        fighter.stateTicks >= SIM_CONFIG.DODGE_IFRAME_START_TICK &&
        fighter.stateTicks <= SIM_CONFIG.DODGE_IFRAME_END_TICK
      ) {
        fighter.invulnerableTicks = Math.max(fighter.invulnerableTicks, 2);
      }
      if (fighter.stateTicks >= SIM_CONFIG.DODGE_DURATION_TICKS) {
        fighter.state = fighter.grounded ? 'idle' : 'fall';
        fighter.stateTicks = 0;
      }
    } else if (fighter.state === 'pickup') {
      if (fighter.stateTicks >= SIM_CONFIG.WEAPON_PICKUP_TICKS) {
        fighter.state = fighter.grounded ? 'idle' : 'fall';
        fighter.stateTicks = 0;
      }
    } else if (fighter.state === 'throw') {
      if (fighter.stateTicks >= SIM_CONFIG.WEAPON_THROW_TICKS) {
        fighter.state = fighter.grounded ? 'idle' : 'fall';
        fighter.stateTicks = 0;
      }
    } else if (
      fighter.state === 'attack_startup' ||
      fighter.state === 'attack_active' ||
      fighter.state === 'attack_recovery'
    ) {
      const cfg = fighter.activeAttackId ? ATTACK_CONFIGS[fighter.activeAttackId] : undefined;
      if (!cfg) {
        fighter.state = fighter.grounded ? 'idle' : 'fall';
        fighter.stateTicks = 0;
      } else {
        if (fighter.state === 'attack_startup' && fighter.stateTicks >= cfg.startupTicks) {
          fighter.state = 'attack_active';
          fighter.stateTicks = 0;
        } else if (fighter.state === 'attack_active' && fighter.stateTicks >= cfg.activeTicks) {
          fighter.state = 'attack_recovery';
          fighter.stateTicks = 0;
        } else if (fighter.state === 'attack_recovery' && fighter.stateTicks >= cfg.recoveryTicks) {
          fighter.state = fighter.grounded ? 'idle' : 'fall';
          fighter.stateTicks = 0;
          fighter.activeAttackId = '';
        }
      }
    }

    // 6-Tick Action Input Buffer (for recovery/heavy/light/dodge/weapon during non-hitstun states)
    const pressedNow = recoveryJustPressed
      ? 'recovery'
      : heavyJustPressed
        ? 'heavy'
        : lightJustPressed
          ? 'light'
          : dodgeJustPressed
            ? 'dodge'
            : weaponJustPressed
              ? 'weapon'
              : '';

    if (pressedNow && fighter.state !== 'hitstun') {
      fighter.bufferedAction = pressedNow;
      fighter.bufferedActionTicks = SIM_CONFIG.ACTION_BUFFER_TICKS;
    } else if (fighter.bufferedActionTicks > 0) {
      fighter.bufferedActionTicks--;
      if (fighter.bufferedActionTicks <= 0) {
        fighter.bufferedAction = '';
      }
    }

    const canStartAction = canFighterStartAction(fighter);
    const effectiveDodge = dodgeJustPressed || fighter.bufferedAction === 'dodge';
    const effectiveWeapon = weaponJustPressed || fighter.bufferedAction === 'weapon';
    const effectiveRecovery = recoveryJustPressed || fighter.bufferedAction === 'recovery';
    const effectiveHeavy = heavyJustPressed || fighter.bufferedAction === 'heavy';
    const effectiveLight = lightJustPressed || fighter.bufferedAction === 'light';

    // Handle Dodge input
    if (canStartAction && effectiveDodge && fighter.dodgeCooldownTicks <= 0) {
      fighter.bufferedAction = '';
      fighter.bufferedActionTicks = 0;
      fighter.state = 'dodge';
      fighter.stateTicks = 0;
      fighter.dodgeCooldownTicks = fighter.grounded
        ? SIM_CONFIG.DODGE_COOLDOWN_GROUND_TICKS
        : SIM_CONFIG.DODGE_COOLDOWN_AIR_TICKS;
      fighter.invulnerableTicks = Math.max(
        fighter.invulnerableTicks,
        SIM_CONFIG.DODGE_IFRAME_END_TICK
      );

      const moveLen = Math.hypot(input.moveX, input.moveZ);
      if (moveLen > 1e-4) {
        fighter.dodgeDirX = input.moveX / moveLen;
        fighter.dodgeDirZ = input.moveZ / moveLen;
        fighter.facingAngle = Math.atan2(fighter.dodgeDirX, fighter.dodgeDirZ);
      } else {
        // Spot dodge in place
        fighter.dodgeDirX = 0;
        fighter.dodgeDirZ = 0;
      }
      pushEvent(world, 'dodge', fighter.slot, 0, fighter.x, fighter.y + 0.8, fighter.z);
    }

    // Handle Weapon Pickup / Throw (KeyE)
    if (canFighterStartAction(fighter) && effectiveWeapon) {
      if (fighter.hasWeapon) {
        fighter.bufferedAction = '';
        fighter.bufferedActionTicks = 0;
        // Throw held weapon in 3D space along facing direction
        const opponent = getOpponent(world, fighter);
        if (
          opponent &&
          opponent.state !== 'ko' &&
          opponent.state !== 'respawn' &&
          Math.hypot(opponent.x - fighter.x, opponent.z - fighter.z) <= SIM_CONFIG.AUTO_AIM_MAX_DISTANCE
        ) {
          fighter.facingAngle = Math.atan2(opponent.x - fighter.x, opponent.z - fighter.z);
        } else if (Math.hypot(input.moveX, input.moveZ) > 1e-4) {
          fighter.facingAngle = Math.atan2(input.moveX, input.moveZ);
        }

        fighter.hasWeapon = false;
        fighter.weaponDurability = 0;
        fighter.state = 'throw';
        fighter.stateTicks = 0;

        const fx = Math.sin(fighter.facingAngle);
        const fz = Math.cos(fighter.facingAngle);
        world.weapon.status = 'thrown';
        world.weapon.holderSlot = 0;
        world.weapon.throwerSlot = fighter.slot;
        world.weapon.throwInstanceId = world.nextAttackInstanceId++;
        world.thrownWeaponHits.set(world.weapon.throwInstanceId, new Set());
        world.weapon.x = fighter.x + fx * 0.85;
        world.weapon.y = fighter.y + 1.0;
        world.weapon.z = fighter.z + fz * 0.85;
        world.weapon.vx = fx * SIM_CONFIG.WEAPON_THROW_SPEED_XZ;
        world.weapon.vy = SIM_CONFIG.WEAPON_THROW_SPEED_Y;
        world.weapon.vz = fz * SIM_CONFIG.WEAPON_THROW_SPEED_XZ;
        world.weapon.rotationY = fighter.facingAngle;
        world.weapon.flightTicksLeft = SIM_CONFIG.WEAPON_FLIGHT_MAX_TICKS;

        pushEvent(world, 'throw', fighter.slot, 0, world.weapon.x, world.weapon.y, world.weapon.z);
      } else if (world.weapon.status === 'on_ground' && world.weapon.y <= 2.2) {
        const distXZ = Math.hypot(
          fighter.x - world.weapon.x,
          fighter.z - world.weapon.z
        );
        if (distXZ <= SIM_CONFIG.WEAPON_PICKUP_RADIUS && Math.abs(fighter.y - world.weapon.y) <= 2.0) {
          fighter.bufferedAction = '';
          fighter.bufferedActionTicks = 0;
          fighter.hasWeapon = true;
          fighter.weaponDurability = SIM_CONFIG.WEAPON_MAX_DURABILITY;
          fighter.state = 'pickup';
          fighter.stateTicks = 0;
          // Immediately schedule the next weapon drop from the sky at a new arena spawn pad!
          const opp = getOpponent(world, fighter);
          world.weapon.status = 'respawning';
          world.weapon.holderSlot = 0;
          world.weapon.respawnTimerTicks =
            opp && !opp.hasWeapon ? 45 : SIM_CONFIG.WEAPON_RESPAWN_TICKS;
          pushEvent(world, 'pickup', fighter.slot, 0, fighter.x, fighter.y + 0.8, fighter.z);
        }
      }
    }

    // Handle Attacks (Light J, Heavy K, Recovery L)
    const chosenAtk = chooseAttackId(fighter, effectiveRecovery, effectiveHeavy, effectiveLight);
    if (chosenAtk) {
      fighter.bufferedAction = '';
      fighter.bufferedActionTicks = 0;
      if (ATTACK_CONFIGS[chosenAtk].isRecovery) {
        fighter.airRecoveriesLeft = Math.max(0, fighter.airRecoveriesLeft - 1);
      }
      startAttack(world, fighter, chosenAtk, input.moveX, input.moveZ);
    }

    // Step 3D kinematic movement
    const jumped = stepFighterKinematicMovement(
      fighter,
      input.moveX,
      input.moveZ,
      jumpJustPressed,
      dt
    );
    if (jumped) {
      pushEvent(world, 'jump', fighter.slot, 0, fighter.x, fighter.y, fighter.z);
    }
  }

  // 2. Solid fighter-to-fighter 3D body separation on X/Z when overlapping at similar Y
  const fighterArr = Array.from(world.fighters.values());
  if (fighterArr.length === 2) {
    const [a, b] = fighterArr;
    if (
      a.state !== 'ko' &&
      a.state !== 'respawn' &&
      b.state !== 'ko' &&
      b.state !== 'respawn' &&
      a.state !== 'dodge' &&
      b.state !== 'dodge' &&
      Math.abs(a.y - b.y) < 1.5
    ) {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const distXZ = Math.hypot(dx, dz);
      const minSep = SIM_CONFIG.FIGHTER_PUSH_RADIUS * 2;
      if (distXZ < minSep) {
        const nx = distXZ > 1e-4 ? dx / distXZ : 1;
        const nz = distXZ > 1e-4 ? dz / distXZ : 0;
        const overlap = (minSep - distXZ) * 0.5;
        a.x -= nx * overlap;
        a.z -= nz * overlap;
        b.x += nx * overlap;
        b.z += nz * overlap;

        // Dampen closing velocity along collision normal so fighters don't phase into each other
        const relVx = b.vx - a.vx;
        const relVz = b.vz - a.vz;
        const closingSpeed = relVx * nx + relVz * nz;
        if (closingSpeed < 0) {
          a.vx += nx * closingSpeed * 0.5;
          a.vz += nz * closingSpeed * 0.5;
          b.vx -= nx * closingSpeed * 0.5;
          b.vz -= nz * closingSpeed * 0.5;
        }
      }
    }
  }

  // 3. Update Weapon Drop / Thrown Projectile in 3D space
  updateWeaponSim(world, dt);

  // 4. Resolve 3D Melee Hitboxes vs Independent Hurtboxes
  for (const attacker of world.fighters.values()) {
    if (attacker.state !== 'attack_active' || !attacker.activeAttackId) {
      continue;
    }
    const cfg = ATTACK_CONFIGS[attacker.activeAttackId];
    const hitSet = world.attackHits.get(attacker.attackInstanceId);
    if (!cfg || !hitSet) continue;

    const fx = Math.sin(attacker.facingAngle);
    const fz = Math.cos(attacker.facingAngle);
    const hx = attacker.x + fx * cfg.hitboxOffsetForward;
    const hy = attacker.y + cfg.hitboxOffsetY;
    const hz = attacker.z + fz * cfg.hitboxOffsetForward;

    for (const target of world.fighters.values()) {
      if (target.sessionId === attacker.sessionId) continue;
      if (target.state === 'ko' || target.state === 'respawn') continue;
      if (target.invulnerableTicks > 0) continue;
      if (hitSet.has(target.sessionId)) continue; // Anti-multi-hit rule

      if (intersectSphereHurtbox3D(hx, hy, hz, cfg.hitboxRadius, target)) {
        hitSet.add(target.sessionId);
        const atkMod =
          SIM_CONFIG.ARCHETYPE_MODIFIERS[attacker.archetype] ??
          SIM_CONFIG.ARCHETYPE_MODIFIERS.vanguard;
        const scaledDamage = Math.round(cfg.damage * atkMod.attackDamageMult);

        applyHitToTarget(
          world,
          attacker.slot,
          target,
          scaledDamage,
          cfg.baseKnockback,
          cfg.knockbackScaling,
          cfg.launchAngleDeg,
          cfg.hitstunTicks,
          cfg.hitstopTicks,
          attacker.x,
          attacker.z,
          fx,
          fz,
          cfg.isHeavy ? 'hit_heavy' : 'hit_light'
        );
        attacker.hitstopTicks = cfg.hitstopTicks;

        // Deplete weapon durability on landed sword attacks (P1-6)
        if (cfg.requiresWeapon && attacker.hasWeapon) {
          attacker.weaponDurability = Math.max(
            0,
            attacker.weaponDurability - SIM_CONFIG.WEAPON_DURABILITY_COST_PER_HIT
          );
          if (attacker.weaponDurability <= 0) {
            attacker.hasWeapon = false;
          }
        }
      }
    }
  }

  // 5. Check 3D Blast Zone KOs & Match Win / Simultaneous KO Draw
  const koThisTick: FighterSimState[] = [];
  for (const fighter of world.fighters.values()) {
    if (fighter.state === 'ko' || fighter.state === 'respawn') continue;

    const outOfBounds =
      fighter.y < SIM_CONFIG.BLAST_ZONE_MIN_Y ||
      fighter.y > SIM_CONFIG.BLAST_ZONE_MAX_Y ||
      Math.abs(fighter.x) > SIM_CONFIG.BLAST_ZONE_MAX_X ||
      Math.abs(fighter.z) > SIM_CONFIG.BLAST_ZONE_MAX_Z;

    if (outOfBounds) {
      fighter.stocks = Math.max(0, fighter.stocks - 1);
      if (fighter.hasWeapon) {
        fighter.hasWeapon = false;
        fighter.weaponDurability = 0;
        if (world.weapon.status !== 'on_ground') {
          world.weapon.status = 'respawning';
          world.weapon.holderSlot = 0;
          world.weapon.respawnTimerTicks = 60;
        }
      }
      pushEvent(world, 'ko', 0, fighter.slot, fighter.x, fighter.y, fighter.z);

      if (fighter.stocks <= 0) {
        fighter.state = 'ko';
        fighter.stateTicks = 0;
        fighter.vx = 0;
        fighter.vy = 0;
        fighter.vz = 0;
        koThisTick.push(fighter);
      } else {
        fighter.state = 'respawn';
        fighter.stateTicks = 0;
        fighter.respawnTicks = SIM_CONFIG.RESPAWN_DELAY_TICKS;
        fighter.vx = 0;
        fighter.vy = 0;
        fighter.vz = 0;
      }
    }
  }

  if (koThisTick.length >= 2) {
    // Both fighters lost their final stock in the exact same simulation tick -> DRAW
    world.phase = 'finished';
    world.winnerSlot = 0;
    world.winReason = 'DRAW';
    pushEvent(world, 'match_end', 0, 0, 0, 1, 0);
    return;
  } else if (koThisTick.length === 1) {
    const loser = koThisTick[0];
    const winner = getOpponent(world, loser);
    world.phase = 'finished';
    world.winnerSlot = winner ? winner.slot : 0;
    world.winReason = 'KO';
    pushEvent(world, 'match_end', world.winnerSlot, loser.slot, 0, 1, 0);
    return;
  }

  // 6. Match Timer & Timeout Tiebreaker
  if (world.timerTicks > 0) {
    world.timerTicks--;
    if (world.timerTicks <= 0) {
      resolveTimeoutWinner(world);
    }
  }
}

function applyHitToTarget(
  world: SimulationWorld,
  sourceSlot: 0 | 1 | 2,
  target: FighterSimState,
  damage: number,
  baseKnockback: number,
  knockbackScaling: number,
  launchAngleDeg: number,
  hitstunTicks: number,
  hitstopTicks: number,
  originX: number,
  originZ: number,
  fallbackDirX: number,
  fallbackDirZ: number,
  eventType: CombatEventType
): void {
  target.damage = Math.min(999, target.damage + damage);

  const defMod =
    SIM_CONFIG.ARCHETYPE_MODIFIERS[target.archetype] ??
    SIM_CONFIG.ARCHETYPE_MODIFIERS.vanguard;
  const kbSpeed =
    computeKnockbackMagnitude(baseKnockback, knockbackScaling, target.damage) *
    defMod.knockbackReceivedMult;
  const angleRad = (launchAngleDeg * Math.PI) / 180;
  const horizSpeed = kbSpeed * Math.cos(angleRad);
  const vertSpeed = kbSpeed * Math.sin(angleRad);

  let dx = target.x - originX;
  let dz = target.z - originZ;
  const distXZ = Math.hypot(dx, dz);
  if (distXZ > 0.05) {
    dx /= distXZ;
    dz /= distXZ;
    // Blend 65% radial direction + 35% attack facing direction so 3D side-angles knock out toward closest arena edge
    const bx = dx * 0.65 + fallbackDirX * 0.35;
    const bz = dz * 0.65 + fallbackDirZ * 0.35;
    const blen = Math.hypot(bx, bz);
    if (blen > 1e-4) {
      dx = bx / blen;
      dz = bz / blen;
    }
  } else {
    dx = fallbackDirX;
    dz = fallbackDirZ;
  }

  target.vx = dx * horizSpeed;
  target.vz = dz * horizSpeed;
  target.vy = vertSpeed;
  target.grounded = false;

  // Getting hit restores 1 air recovery so players knocked far off-stage have a fighting chance
  target.airRecoveriesLeft = SIM_CONFIG.MAX_AIR_RECOVERIES;
  target.state = 'hitstun';
  target.stateTicks = 0;
  target.activeAttackId = '';
  target.hitstunTicks = Math.round(hitstunTicks + (target.damage / 100) * 6);
  target.hitstopTicks = hitstopTicks;

  const impactX = (originX + target.x) * 0.5;
  const impactY = target.y + 0.95;
  const impactZ = (originZ + target.z) * 0.5;

  pushEvent(
    world,
    eventType,
    sourceSlot,
    target.slot,
    impactX,
    impactY,
    impactZ,
    damage,
    kbSpeed
  );
}

function updateWeaponSim(world: SimulationWorld, dt: number): void {
  const w = world.weapon;

  if (w.status === 'held') {
    for (const f of world.fighters.values()) {
      if (f.slot === w.holderSlot) {
        w.x = f.x;
        w.y = f.y + 0.9;
        w.z = f.z;
        w.rotationY = f.facingAngle;
        return;
      }
    }
    w.status = 'respawning';
    w.holderSlot = 0;
    w.respawnTimerTicks = SIM_CONFIG.WEAPON_RESPAWN_TICKS;
    return;
  }

  if (w.status === 'respawning') {
    w.respawnTimerTicks--;
    if (w.respawnTimerTicks <= 0) {
      const pads = SIM_CONFIG.WEAPON_SPAWN_PADS;
      const pad = pads[w.id % pads.length];
      w.id++;
      w.status = 'on_ground';
      w.holderSlot = 0;
      w.throwerSlot = 0;
      w.x = pad.x;
      w.y = 5.4; // Drop from the sky onto the arena!
      w.z = pad.z;
      w.vx = 0;
      w.vy = -14.0;
      w.vz = 0;
    }
    return;
  }

  if (w.status === 'on_ground') {
    if (w.y > 0) {
      w.y = Math.max(0, w.y + w.vy * dt);
      if (w.y === 0) {
        w.vy = 0;
      }
    }
    w.rotationY += 1.8 * dt;
    return;
  }

  if (w.status === 'thrown') {
    w.flightTicksLeft--;
    w.vy -= SIM_CONFIG.GRAVITY * 0.28 * dt;
    w.x += w.vx * dt;
    w.y += w.vy * dt;
    w.z += w.vz * dt;
    w.rotationY += 18.0 * dt;

    const hitSet = world.thrownWeaponHits.get(w.throwInstanceId);
    for (const target of world.fighters.values()) {
      if (target.slot === w.throwerSlot) continue;
      if (target.state === 'ko' || target.state === 'respawn') continue;
      if (target.invulnerableTicks > 0) continue;
      if (hitSet?.has(target.sessionId)) continue;

      if (intersectSphereHurtbox3D(w.x, w.y, w.z, SIM_CONFIG.WEAPON_THROW_RADIUS, target)) {
        hitSet?.add(target.sessionId);
        const speedXZ = Math.hypot(w.vx, w.vz);
        const dirX = speedXZ > 1e-4 ? w.vx / speedXZ : 1;
        const dirZ = speedXZ > 1e-4 ? w.vz / speedXZ : 0;

        applyHitToTarget(
          world,
          w.throwerSlot,
          target,
          SIM_CONFIG.WEAPON_THROW_DAMAGE,
          SIM_CONFIG.WEAPON_THROW_BASE_KB,
          SIM_CONFIG.WEAPON_THROW_KB_SCALING,
          SIM_CONFIG.WEAPON_THROW_LAUNCH_DEG,
          SIM_CONFIG.WEAPON_THROW_HITSTUN_TICKS,
          SIM_CONFIG.WEAPON_THROW_HITSTOP_TICKS,
          w.x - dirX * 0.5,
          w.z - dirZ * 0.5,
          dirX,
          dirZ,
          'hit_throw'
        );

        // Sword shatters into energy after hitting target and schedules respawn
        w.status = 'respawning';
        w.respawnTimerTicks = SIM_CONFIG.WEAPON_RESPAWN_TICKS;
        return;
      }
    }

    // Check if thrown sword landed back on stage or expired
    if (isPointOverStageXZ(w.x, w.z, -0.4) && w.y <= 0.15 && w.vy <= 0) {
      w.y = 0;
      w.vx = 0;
      w.vy = 0;
      w.vz = 0;
      w.status = 'on_ground';
      w.throwerSlot = 0;
      return;
    }

    if (w.flightTicksLeft <= 0 || w.y < SIM_CONFIG.BLAST_ZONE_MIN_Y) {
      w.status = 'respawning';
      w.respawnTimerTicks = SIM_CONFIG.WEAPON_RESPAWN_TICKS;
    }
  }
}

export function resolveTimeoutWinner(world: SimulationWorld): void {
  const fighters = Array.from(world.fighters.values());
  if (fighters.length < 2) {
    world.phase = 'finished';
    world.winnerSlot = fighters[0]?.slot ?? 0;
    world.winReason = 'TIMEOUT';
    return;
  }

  const p1 = fighters.find((f) => f.slot === 1) ?? fighters[0];
  const p2 = fighters.find((f) => f.slot === 2) ?? fighters[1];

  world.phase = 'finished';
  if (p1.stocks > p2.stocks) {
    world.winnerSlot = 1;
    world.winReason = 'TIMEOUT';
  } else if (p2.stocks > p1.stocks) {
    world.winnerSlot = 2;
    world.winReason = 'TIMEOUT';
  } else if (p1.damage < p2.damage) {
    world.winnerSlot = 1;
    world.winReason = 'TIMEOUT';
  } else if (p2.damage < p1.damage) {
    world.winnerSlot = 2;
    world.winReason = 'TIMEOUT';
  } else {
    world.winnerSlot = 0;
    world.winReason = 'DRAW';
  }

  pushEvent(world, 'match_end', world.winnerSlot, 0, 0, 1, 0);
}
