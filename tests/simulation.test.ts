import { describe, expect, it } from 'vitest';
import {
  ATTACK_CONFIGS,
  SIM_CONFIG,
  canFighterStartAction,
  chooseAttackId,
  computeKnockbackMagnitude,
  createInitialFighterState,
  createSimulationWorld,
  sanitizeInput,
  startMatchCountdown,
  stepFighterKinematicMovement,
  stepWorldTick,
} from '../shared/src/index.js';
import { CombatEventNetSchema, RiftRoomState } from '../server/src/schema/RiftRoomState.js';
import { isOriginAllowed } from '../server/src/index.js';

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

  it('6. [P0-1] Colyseus ArraySchema<CombatEventNetSchema> iterates via .forEach and preserves ascending eventId order', () => {
    const roomState = new RiftRoomState();
    const e1 = new CombatEventNetSchema();
    e1.eventId = 1;
    e1.type = 'countdown_tick';
    const e2 = new CombatEventNetSchema();
    e2.eventId = 2;
    e2.type = 'match_start';
    const e3 = new CombatEventNetSchema();
    e3.eventId = 3;
    e3.type = 'hit_light';
    roomState.events.push(e1, e2, e3);

    let lastProcessedEventId = 0;
    const collected: Array<{ eventId: number; type: string }> = [];
    roomState.events.forEach((evt) => {
      if (evt && evt.eventId > lastProcessedEventId) {
        collected.push({ eventId: evt.eventId, type: evt.type });
      }
    });
    collected.sort((a, b) => a.eventId - b.eventId);
    for (const evt of collected) {
      lastProcessedEventId = evt.eventId;
    }

    expect(collected.map((c) => c.type)).toEqual(['countdown_tick', 'match_start', 'hit_light']);
    expect(lastProcessedEventId).toBe(3);
  });

  it('7. [P1-1] Jump prediction reconciliation under 120ms latency keeps fighter ascending smoothly without dipping to Y=0', () => {
    // Simulate client sending seq 1..15 while server acks with 4-tick lag (~67ms one-way / ~133ms RTT)
    const serverFighter = createInitialFighterState('p1', 1, 'Duy', 'vanguard');
    const predictedFighter = { ...serverFighter };
    const pendingInputs: Array<{ frame: ReturnType<typeof sanitizeInput>; jumpEdge: boolean }> = [];
    let prevJumpHeld = false;

    const yHistory: number[] = [];

    for (let seq = 1; seq <= 14; seq++) {
      const jumpPressed = seq >= 2 && seq <= 6; // Player presses Space on seq=2 and holds for 5 ticks
      const frame = sanitizeInput({ seq, moveX: 1, jumpPressed });
      const jumpEdge = frame.jumpPressed && !prevJumpHeld;
      prevJumpHeld = frame.jumpPressed;
      pendingInputs.push({ frame, jumpEdge });

      // Client immediate step
      stepFighterKinematicMovement(predictedFighter, frame.moveX, frame.moveZ, jumpEdge);

      // Simulate server state patch arriving for (seq - 4)
      const ackSeq = seq - 4;
      if (ackSeq >= 1) {
        const serverInput = pendingInputs.find((p) => p.frame.seq === ackSeq)!;
        stepFighterKinematicMovement(
          serverFighter,
          serverInput.frame.moveX,
          serverInput.frame.moveZ,
          serverInput.jumpEdge
        );

        // Reconcile from authoritative serverFighter + replay remaining pendingInputs
        const replayed = { ...serverFighter };
        while (pendingInputs.length > 0 && pendingInputs[0].frame.seq <= ackSeq) {
          pendingInputs.shift();
        }
        for (const pending of pendingInputs) {
          stepFighterKinematicMovement(
            replayed,
            pending.frame.moveX,
            pending.frame.moveZ,
            pending.jumpEdge
          );
        }
        Object.assign(predictedFighter, replayed);
      }

      if (seq >= 2) {
        yHistory.push(predictedFighter.y);
      }
    }

    // Verify fighter left the ground on seq=2 and never dipped back to 0 during ascent
    expect(yHistory[0]).toBeGreaterThan(0);
    for (let i = 1; i < 8; i++) {
      expect(yHistory[i]).toBeGreaterThan(yHistory[i - 1]);
    }
  });

  it('8. [P1-2] Pure helpers canFighterStartAction and chooseAttackId predict local attack/dodge immediately', () => {
    const f = createInitialFighterState('p1', 1, 'Duy', 'vanguard');
    expect(canFighterStartAction(f)).toBe(true);
    expect(chooseAttackId(f, false, false, true)).toBe('unarmed_light_ground');
    f.hasWeapon = true;
    f.grounded = false;
    expect(chooseAttackId(f, false, true, false)).toBe('sword_heavy_air');
    f.state = 'hitstun';
    expect(canFighterStartAction(f)).toBe(false);
  });

  it('9. [P1-3] 6-tick Action Input Buffer executes attack pressed up to 6 ticks before recovery ends, and clears on hitstun', () => {
    const { world, p1, p2 } = createFightingWorld();
    p2.x = 8; // keep opponent away

    const cfg = ATTACK_CONFIGS.unarmed_light_ground;
    // Start attack 1
    stepWorldTick(world, new Map([['p1', sanitizeInput({ seq: 1, lightPressed: true })]]));
    const firstInstanceId = p1.attackInstanceId;
    expect(firstInstanceId).toBe(1);

    // Advance until 4 ticks remain in attack_recovery
    const totalAttackTicks = cfg.startupTicks + cfg.activeTicks + cfg.recoveryTicks;
    for (let i = 0; i < totalAttackTicks - 4; i++) {
      stepWorldTick(world, new Map());
    }
    expect(p1.state).toBe('attack_recovery');
    expect(p1.stateTicks).toBe(cfg.recoveryTicks - 4);

    // Press J (lightPressed) 4 ticks early while still in recovery!
    stepWorldTick(world, new Map([['p1', sanitizeInput({ seq: 2, lightPressed: true })]]));
    expect(p1.bufferedAction).toBe('light');

    // Step remaining 3 ticks of recovery with NO buttons pressed
    for (let i = 0; i < 3; i++) {
      stepWorldTick(world, new Map());
    }

    // On the exact tick recovery ends, buffered light attack fires automatically!
    expect(p1.state).toBe('attack_startup');
    expect(p1.activeAttackId).toBe('unarmed_light_ground');
    expect(p1.attackInstanceId).toBe(firstInstanceId + 1);
  });

  it('10. [P1-6] Archetype modifiers differentiate Vanguard vs Reaver and Rift Blade breaks after 4 hits (100 durability)', () => {
    // Reaver deals 15% more damage than Vanguard on the same attack
    const { world, p1, p2 } = createFightingWorld();
    p1.x = 0;
    p1.z = 0;
    p2.x = 1.0;
    p2.z = 0;

    // P2 is Reaver hitting P1 (Vanguard)
    stepWorldTick(world, new Map([['p2', sanitizeInput({ seq: 1, lightPressed: true })]]));
    for (let i = 0; i < 20; i++) {
      stepWorldTick(world, new Map());
    }
    expect(p1.damage).toBe(Math.round(ATTACK_CONFIGS.unarmed_light_ground.damage * 1.15));

    // Rift Blade durability: 4 hits * 25 durability = 100 -> breaks on 4th hit
    p1.hasWeapon = true;
    p1.weaponDurability = SIM_CONFIG.WEAPON_MAX_DURABILITY;
    world.weapon.status = 'held';
    world.weapon.holderSlot = 1;

    for (let hitNum = 1; hitNum <= 4; hitNum++) {
      p1.state = 'idle';
      p1.stateTicks = 0;
      p1.x = 0;
      p1.y = 0;
      p1.z = 0;
      p2.state = 'idle';
      p2.stateTicks = 0;
      p2.invulnerableTicks = 0;
      p2.x = 1.1;
      p2.y = 0;
      p2.z = 0;

      stepWorldTick(world, new Map([['p1', sanitizeInput({ seq: 10 + hitNum, lightPressed: true })]]));
      for (let t = 0; t < 18; t++) {
        p2.x = 1.1;
        p2.y = 0;
        p2.z = 0;
        stepWorldTick(world, new Map());
      }
    }

    expect(p1.hasWeapon).toBe(false);
    expect(p1.weaponDurability).toBe(0);
  });

  it('11. [P2-1] Strict CORS origin check allows configured origins and rejects arbitrary *.netlify.app domains', () => {
    const allowed = new Set(['http://localhost:5174', 'https://rift-duel.netlify.app']);
    expect(isOriginAllowed(undefined, allowed)).toBe(true);
    expect(isOriginAllowed('http://localhost:5174', allowed)).toBe(true);
    expect(isOriginAllowed('https://rift-duel.netlify.app', allowed)).toBe(true);
    expect(isOriginAllowed('https://evil-attacker.netlify.app', allowed)).toBe(false);
    expect(isOriginAllowed('https://example.com', allowed)).toBe(false);
  });
});
