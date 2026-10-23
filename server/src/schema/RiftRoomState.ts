import { Schema, MapSchema, ArraySchema, type } from '@colyseus/schema';

export class FighterNetSchema extends Schema {
  @type('string') sessionId: string = '';
  @type('uint8') slot: number = 1;
  @type('string') nickname: string = 'Fighter';
  @type('string') archetype: string = 'vanguard';
  @type('boolean') ready: boolean = false;
  @type('boolean') assetsLoaded: boolean = false;
  @type('boolean') rematchVote: boolean = false;
  @type('boolean') connected: boolean = true;

  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('float32') z: number = 0;
  @type('float32') vx: number = 0;
  @type('float32') vy: number = 0;
  @type('float32') vz: number = 0;
  @type('float32') facingAngle: number = 0;

  @type('boolean') grounded: boolean = true;
  @type('uint8') groundJumpsLeft: number = 1;
  @type('uint8') airJumpsLeft: number = 2;
  @type('uint8') airRecoveriesLeft: number = 1;

  @type('uint8') stocks: number = 3;
  @type('uint16') damage: number = 0;
  @type('string') state: string = 'idle';
  @type('uint16') stateTicks: number = 0;
  @type('string') activeAttackId: string = '';
  @type('uint16') attackCooldownTicks: number = 0;
  @type('uint16') dodgeCooldownTicks: number = 0;
  @type('uint16') invulnerableTicks: number = 0;
  @type('boolean') hasWeapon: boolean = false;
  @type('uint32') lastProcessedInputSeq: number = 0;
}

export class WeaponNetSchema extends Schema {
  @type('uint16') id: number = 1;
  @type('string') status: string = 'on_ground';
  @type('uint8') holderSlot: number = 0;
  @type('uint8') throwerSlot: number = 0;
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('float32') z: number = 0;
  @type('float32') vx: number = 0;
  @type('float32') vy: number = 0;
  @type('float32') vz: number = 0;
  @type('float32') rotationY: number = 0;
}

export class CombatEventNetSchema extends Schema {
  @type('uint32') eventId: number = 0;
  @type('string') type: string = '';
  @type('uint32') tick: number = 0;
  @type('uint8') sourceSlot: number = 0;
  @type('uint8') targetSlot: number = 0;
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('float32') z: number = 0;
  @type('uint16') damageDealt: number = 0;
  @type('float32') knockbackSpeed: number = 0;
}

export class RiftRoomState extends Schema {
  @type('string') roomCode: string = '';
  @type('string') phase: string = 'waiting';
  @type('uint32') serverTick: number = 0;
  @type('uint16') countdownTicks: number = 180;
  @type('uint16') timerTicks: number = 14400;
  @type('uint8') winnerSlot: number = 0;
  @type('string') winReason: string = '';
  @type('uint16') disconnectGraceTicks: number = 0;
  @type('uint8') disconnectedSlot: number = 0;
  @type('uint32') seed: number = 12345;

  @type({ map: FighterNetSchema }) fighters = new MapSchema<FighterNetSchema>();
  @type(WeaponNetSchema) weapon = new WeaponNetSchema();
  @type([CombatEventNetSchema]) events = new ArraySchema<CombatEventNetSchema>();
}
