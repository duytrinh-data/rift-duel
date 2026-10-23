import { describe, expect, it } from 'vitest';
import {
  ATTACK_CONFIGS,
  SIM_CONFIG,
  computeKnockbackMagnitude,
  createInitialFighterState,
  createSimulationWorld,
  sanitizeInput,
  startMatchCountdown,
  stepWorldTick,
} from '../shared/src/index.js';

function createFightingWorld() {
  const world = createSimulationWorld();
  const p1 = createInitialFighterState('p1', 1, 'Duy', 'vanguard');
  const p2 = createInitialFighterState('p2', 2, 'Friend', 'reaver');
  p1.ready = true;
  p2.ready = true;
  world.fighters.set('p1', p1);
  world.fighters.set('p2', p2);
  startMatchCountdown(world);
  // Advance past countdown (180 ticks)
  for (let i = 0; i < SIM_CONFIG.COUNTDOWN_TICKS; i++) {
    stepWorldTick(world, new Map());
  }
  expect(world.phase).toBe('fighting');
  return { world, p1, p2 };
}

describe('RIFT DUEL - Authoritative 3D Combat & Rules Simulation', () => {
  it('1. Same attack produces strictly stronger knockback when target has higher damage', () => {
    const kb0 = computeKnockbackMagnitude(10, 15, 0);
    const kb50 = computeKnockbackMagnitude(10, 15, 50);
    const kb150 = computeKnockbackMagnitude(10, 15, 150);
    expect(kb50).toBeGreaterThan(kb0);
    expect(kb150).toBeGreaterThan(kb50);

    // Also test inside live simulation
    const { world: wLow, p1: a1, p2: b1 } = createFightingWorld();
    a1.x = 0;
    a1.z = 0;
    b1.x = 1.0;
    b1.z = 0;
    b1.damage = 0;

    stepWorldTick(wLow, new Map([['p1', sanitizeInput({ seq: 1, heavyPressed: true })]]));
    for (let i = 0; i < 20; i++) {
      stepWorldTick(wLow, new Map());
    }
    const lowDamageVel = Math.hypot(b1.vx, b1.vy, b1.vz);

    const { world: wHigh, p1: a2, p2: b2 } = createFightingWorld();
    a2.x = 0;
    a2.z = 0;
    b2.x = 1.0;
    b2.z = 0;
    b2.damage = 140;

    stepWorldTick(wHigh, new Map([['p1', sanitizeInput({ seq: 1, heavyPressed: true })]]));
    for (let i = 0; i < 20; i++) {
      stepWorldTick(wHigh, new Map());
    }
    const highDamageVel = Math.hypot(b2.vx, b2.vy, b2.vz);

    expect(highDamageVel).toBeGreaterThan(lowDamageVel);
  });

  it('2. Single attack only hits the same opponent once across all active ticks (anti-multi-hit)', () => {
    const { world, p1, p2 } = createFightingWorld();
    p1.x = 0;
    p1.z = 0;
    p2.x = 1.0;
    p2.z = 0;

    const cfg = ATTACK_CONFIGS.unarmed_light_ground;
    stepWorldTick(world, new Map([['p1', sanitizeInput({ seq: 1, lightPressed: true })]]));

    for (let i = 0; i < cfg.startupTicks + cfg.activeTicks + cfg.recoveryTicks + 5; i++) {
      // Keep p2 right inside hitbox to verify it still only triggers once
      p2.x = 1.0;
      p2.y = 0;
      p2.z = 0;
      stepWorldTick(world, new Map());
    }

    expect(p2.damage).toBe(cfg.damage);
  });

  it('3. Supports 1 ground jump + 2 air jumps, 1 airborne recovery reset on landing, and dodge invulnerability + cooldown', () => {
    const { world, p1, p2 } = createFightingWorld();
    p2.x = 8; // keep p2 far away

    // Ground jump (Jump #1)
    stepWorldTick(world, new Map([['p1', sanitizeInput({ seq: 1, jumpPressed: true })]]));
    expect(p1.grounded).toBe(false);
    expect(p1.groundJumpsLeft).toBe(0);
    expect(p1.airJumpsLeft).toBe(2);

    // Release jump for 1 tick
    stepWorldTick(world, new Map([['p1', sanitizeInput({ seq: 2, jumpPressed: false })]]));

    // Air jump #1 (Jump #2 total)
    stepWorldTick(world, new Map([['p1', sanitizeInput({ seq: 3, jumpPressed: true })]]));
    expect(p1.airJumpsLeft).toBe(1);

    stepWorldTick(world, new Map([['p1', sanitizeInput({ seq: 4, jumpPressed: false })]]));

    // Air jump #2 (Jump #3 total)
    stepWorldTick(world, new Map([['p1', sanitizeInput({ seq: 5, jumpPressed: true })]]));
    expect(p1.airJumpsLeft).toBe(0);

    stepWorldTick(world, new Map([['p1', sanitizeInput({ seq: 6, jumpPressed: false })]]));

    // Attempting a 3rd air jump should not consume or boost vy
    const vyBeforeExtraJump = p1.vy;
    stepWorldTick(world, new Map([['p1', sanitizeInput({ seq: 7, jumpPressed: true })]]));
    expect(p1.vy).toBeLessThan(vyBeforeExtraJump);

    // Recovery attack in air works once
    expect(p1.airRecoveriesLeft).toBe(1);
    stepWorldTick(world, new Map([['p1', sanitizeInput({ seq: 8, recoveryPressed: true })]]));
    expect(p1.airRecoveriesLeft).toBe(0);
    expect(p1.activeAttackId).toBe('unarmed_recovery');

    // Let p1 land back on stage and verify jumps & recovery reset
    for (let i = 0; i < 120; i++) {
      stepWorldTick(world, new Map());
    }
    expect(p1.grounded).toBe(true);
    expect(p1.groundJumpsLeft).toBe(1);
    expect(p1.airJumpsLeft).toBe(2);
    expect(p1.airRecoveriesLeft).toBe(1);

    // Dodge grants invulnerability and starts cooldown
    stepWorldTick(world, new Map([['p1', sanitizeInput({ seq: 9, moveX: 1, dodgePressed: true })]]));
    expect(p1.state).toBe('dodge');
    expect(p1.invulnerableTicks).toBeGreaterThan(0);
    expect(p1.dodgeCooldownTicks).toBeGreaterThan(0);
  });

  it('4. Crossing 3D blast zone deducts exactly 1 stock, resets damage on respawn, and grants spawn invulnerability', () => {
    const { world, p1 } = createFightingWorld();
    p1.damage = 125;
    p1.hasWeapon = true;
    p1.y = SIM_CONFIG.BLAST_ZONE_MIN_Y - 1.0; // Below abyss blast zone

    stepWorldTick(world, new Map());
    expect(p1.stocks).toBe(2);
    expect(p1.state).toBe('respawn');
    expect(p1.hasWeapon).toBe(false);

    // Advance through respawn delay
    for (let i = 0; i < SIM_CONFIG.RESPAWN_DELAY_TICKS + 2; i++) {
      stepWorldTick(world, new Map());
    }
    expect(p1.damage).toBe(0);
    expect(p1.invulnerableTicks).toBeGreaterThan(0);
  });

  it('5. Resolves timeout tiebreakers (stocks -> lower damage -> draw) and simultaneous final-stock KO as DRAW', () => {
    // Case A: Timeout with equal stocks, P2 has lower damage -> P2 wins
    const { world: wTimeout, p1: t1, p2: t2 } = createFightingWorld();
    t1.stocks = 2;
    t2.stocks = 2;
    t1.damage = 85;
    t2.damage = 30;
    wTimeout.timerTicks = 1;
    stepWorldTick(wTimeout, new Map());
    expect(wTimeout.phase).toBe('finished');
    expect(wTimeout.winnerSlot).toBe(2);
    expect(wTimeout.winReason).toBe('TIMEOUT');

    // Case B: Simultaneous final-stock KO in the exact same simulation tick -> DRAW
    const { world: wSimKO, p1: k1, p2: k2 } = createFightingWorld();
    k1.stocks = 1;
    k2.stocks = 1;
    k1.x = -SIM_CONFIG.BLAST_ZONE_MAX_X - 2;
    k2.x = SIM_CONFIG.BLAST_ZONE_MAX_X + 2;
    stepWorldTick(wSimKO, new Map());
    expect(wSimKO.phase).toBe('finished');
    expect(wSimKO.winnerSlot).toBe(0);
    expect(wSimKO.winReason).toBe('DRAW');
  });
});
