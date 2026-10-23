export type CharacterArchetype = 'vanguard' | 'reaver';

export type FighterActionState =
  | 'idle'
  | 'move'
  | 'jump'
  | 'fall'
  | 'dodge'
  | 'attack_startup'
  | 'attack_active'
  | 'attack_recovery'
  | 'hitstun'
  | 'pickup'
  | 'throw'
  | 'ko'
  | 'respawn';

export type AttackId =
  | 'unarmed_light_ground'
  | 'unarmed_light_air'
  | 'unarmed_heavy_ground'
  | 'unarmed_heavy_air'
  | 'unarmed_recovery'
  | 'sword_light_ground'
  | 'sword_light_air'
  | 'sword_heavy_ground'
  | 'sword_heavy_air'
  | 'sword_recovery';

export type MatchPhase =
  | 'waiting'
  | 'lobby'
  | 'countdown'
  | 'fighting'
  | 'paused_disconnect'
  | 'finished';

export type WinReason = 'KO' | 'TIMEOUT' | 'FORFEIT' | 'DRAW' | '';

export interface InputFrame {
  seq: number;
  moveX: number; // -1, 0, 1
  moveZ: number; // -1, 0, 1
  jumpPressed: boolean;
  dodgePressed: boolean;
  lightPressed: boolean;
  heavyPressed: boolean;
  recoveryPressed: boolean;
  weaponPressed: boolean;
  clientTime?: number;
}

export interface AttackConfig {
  id: AttackId;
  name: string;
  isHeavy: boolean;
  isRecovery: boolean;
  requiresWeapon: boolean;
  isAerial: boolean;
  startupTicks: number;
  activeTicks: number;
  recoveryTicks: number;
  cooldownTicks: number;
  damage: number;
  baseKnockback: number;
  knockbackScaling: number;
  launchAngleDeg: number; // vertical angle above horizontal plane
  hitstunTicks: number;
  hitstopTicks: number;
  hitboxOffsetForward: number;
  hitboxOffsetY: number;
  hitboxRadius: number;
  lungeSpeedXZ: number;
  boostY: number;
  animClip: string;
}

export type BufferedActionType = '' | 'recovery' | 'heavy' | 'light' | 'dodge' | 'weapon';

export interface FighterSimState {
  sessionId: string;
  slot: 1 | 2;
  nickname: string;
  archetype: CharacterArchetype;
  ready: boolean;
  rematchVote: boolean;
  connected: boolean;

  // 3D Transform & Velocity (X/Z ground plane, Y vertical height)
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  facingAngle: number; // radians in X/Z plane: atan2(dx, dz), where 0 faces +Z, PI/2 faces +X

  // Grounding & Jumps
  grounded: boolean;
  groundJumpsLeft: number;
  airJumpsLeft: number;
  airRecoveriesLeft: number;
  coyoteTicks: number;
  jumpBufferTicks: number;

  // Combat & Status
  stocks: number;
  damage: number;
  state: FighterActionState;
  stateTicks: number;
  activeAttackId: AttackId | '';
  attackInstanceId: number;
  attackCooldownTicks: number;
  dodgeCooldownTicks: number;
  dodgeDirX: number;
  dodgeDirZ: number;
  hitstunTicks: number;
  hitstopTicks: number;
  invulnerableTicks: number;
  respawnTicks: number;

  // Weapon state
  hasWeapon: boolean;
  weaponDurability: number;

  // Input tracking & action buffer
  lastProcessedInputSeq: number;
  bufferedAction: BufferedActionType;
  bufferedActionTicks: number;
  prevJumpDown: boolean;
  prevDodgeDown: boolean;
  prevLightDown: boolean;
  prevHeavyDown: boolean;
  prevRecoveryDown: boolean;
  prevWeaponDown: boolean;
}

export type WeaponDropStatus = 'on_ground' | 'held' | 'thrown' | 'respawning';

export interface WeaponSimState {
  id: number;
  status: WeaponDropStatus;
  holderSlot: 0 | 1 | 2;
  throwerSlot: 0 | 1 | 2;
  throwInstanceId: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rotationY: number;
  respawnTimerTicks: number;
  flightTicksLeft: number;
}

export type CombatEventType =
  | 'hit_light'
  | 'hit_heavy'
  | 'hit_throw'
  | 'dodge'
  | 'jump'
  | 'pickup'
  | 'throw'
  | 'ko'
  | 'respawn'
  | 'countdown_tick'
  | 'match_start'
  | 'match_end';

export interface CombatEvent {
  eventId: number;
  type: CombatEventType;
  tick: number;
  sourceSlot: 0 | 1 | 2;
  targetSlot: 0 | 1 | 2;
  x: number;
  y: number;
  z: number;
  damageDealt: number;
  knockbackSpeed: number;
}

export interface SimulationWorld {
  tick: number;
  phase: MatchPhase;
  countdownTicks: number;
  timerTicks: number;
  winnerSlot: 0 | 1 | 2; // 0 = Draw or none
  winReason: WinReason;
  disconnectGraceTicks: number;
  disconnectedSlot: 0 | 1 | 2;
  nextEventId: number;
  nextAttackInstanceId: number;
  fighters: Map<string, FighterSimState>;
  weapon: WeaponSimState;
  attackHits: Map<number, Set<string>>;
  thrownWeaponHits: Map<number, Set<string>>;
  events: CombatEvent[];
}
