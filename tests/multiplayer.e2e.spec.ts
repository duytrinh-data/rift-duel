import { test, expect } from '@playwright/test';

interface BridgeSummary {
  roomCode: string;
  phase: string;
  serverTick: number;
  timerSeconds: number;
  winnerSlot: number;
  winReason: string;
  mySlot: number;
  fighters: Array<{
    sessionId: string;
    slot: number;
    nickname: string;
    archetype: string;
    ready: boolean;
    rematchVote: boolean;
    connected: boolean;
    stocks: number;
    damage: number;
    hasWeapon: boolean;
    x: number;
    y: number;
    z: number;
    state: string;
  }>;
}

test.describe('RIFT DUEL - 2-Context Online Multiplayer, Keyboard UX, Reconnect & Rematch E2E', () => {
  test('Full keyboard flow: Invalid room error, Create room, Invite link join, 3rd player Room Full, 3D Combat, Latency, Reconnect, KO & Rematch', async ({
    browser,
  }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    const context3 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();
    const page3 = await context3.newPage();

    const consoleErrors: string[] = [];
    const failedAssets: string[] = [];

    for (const [idx, p] of [page1, page2, page3].entries()) {
      p.on('pageerror', (err) => consoleErrors.push(`Page${idx + 1}: ${err.stack || err.message}`));
      p.on('response', (res) => {
        if (res.url().includes('/assets/') && res.status() >= 400) {
          failedAssets.push(`${res.status()} ${res.url()}`);
        }
      });
    }

    // 1. Verify invalid/expired room code handling on Page 2 first
    await page2.goto('/?room=ZZZZ99');
    await expect(page2.locator('#btn-join-room')).toBeVisible({ timeout: 25000 });
    await page2.keyboard.press('Enter'); // Triggers primary action: Join Room ZZZZ99
    await expect(page2.locator('#status-alert')).toContainText('không tồn tại hoặc đã hết hạn', {
      timeout: 10000,
    });

    // 2. Player 1 opens homepage, creates room using keyboard Enter
    await page1.goto('/');
    await expect(page1.locator('#btn-create-room')).toBeVisible({ timeout: 25000 });
    await page1.keyboard.press('Enter'); // Autofocused on #btn-create-room

    await expect(page1.locator('#lobby-room-code')).toBeVisible({ timeout: 15000 });
    const roomCode = (await page1.locator('#lobby-room-code').textContent())?.trim() || '';
    expect(roomCode.length).toBeGreaterThanOrEqual(4);

    // Verify keyboard shortcut 'KeyC' copies invite link in lobby
    await page1.keyboard.press('KeyC');
    await expect(page1.locator('#status-alert')).toContainText('Đã sao chép link mời');

    // 3. Player 2 opens the exact invite link (?room=CODE) and presses Enter to join
    await page2.goto(`/?room=${roomCode}`);
    await expect(page2.locator('#btn-join-room')).toBeVisible({ timeout: 15000 });
    await page2.keyboard.press('Enter'); // Autofocused on #btn-join-room when ?room= is present

    await expect(page2.locator('#lobby-room-code')).toHaveText(roomCode, { timeout: 15000 });

    // 4. Player 3 opens the same invite link and gets ROOM_FULL message
    await page3.goto(`/?room=${roomCode}`);
    await expect(page3.locator('#btn-join-room')).toBeVisible({ timeout: 15000 });
    await page3.keyboard.press('Enter');
    await expect(page3.locator('#status-alert')).toContainText('đủ 2 người chơi', {
      timeout: 10000,
    });

    // 5. Player 2 selects Crimson Reaver via keyboard shortcut Digit2, then both Ready via KeyR
    await page2.keyboard.press('Digit2');
    await page1.keyboard.press('KeyR');
    await page2.keyboard.press('KeyR');

    // Wait for server countdown to transition to 'fighting'
    await expect
      .poll(
        async () => {
          const s1 = await page1.evaluate(
            () => (window as unknown as { __RIFT_DUEL__: { getRoomSummary: () => BridgeSummary } }).__RIFT_DUEL__.getRoomSummary()?.phase
          );
          return s1;
        },
        { timeout: 15000 }
      )
      .toBe('fighting');

    // 6. Verify input isolation: P1 moving in 3D (W + D) changes P1's X and Z, not P2's
    const initialSum = await page1.evaluate(
      () => (window as unknown as { __RIFT_DUEL__: { getRoomSummary: () => BridgeSummary } }).__RIFT_DUEL__.getRoomSummary()
    );
    const p1Start = initialSum.fighters.find((f) => f.slot === 1)!;
    const p2Start = initialSum.fighters.find((f) => f.slot === 2)!;

    await page1.keyboard.down('KeyD');
    await page1.keyboard.down('KeyW');
    await page1.waitForTimeout(450);
    await page1.keyboard.up('KeyD');
    await page1.keyboard.up('KeyW');
    await page1.waitForTimeout(100);

    const movedSum = await page2.evaluate(
      () => (window as unknown as { __RIFT_DUEL__: { getRoomSummary: () => BridgeSummary } }).__RIFT_DUEL__.getRoomSummary()
    );
    const p1After = movedSum.fighters.find((f) => f.slot === 1)!;
    const p2After = movedSum.fighters.find((f) => f.slot === 2)!;

    expect(p1After.x).toBeGreaterThan(p1Start.x + 0.5);
    expect(p1After.z).toBeLessThan(p1Start.z - 0.5); // Moved in 3D Z depth!
    expect(Math.abs(p2After.x - p2Start.x)).toBeLessThan(0.05);

    // 7. Enable 90ms simulated latency and test combat synchronization (P1 moves to P2 and attacks)
    await page1.evaluate(() => {
      (window as unknown as { __RIFT_DUEL__: { setSimulatedLatencyMs: (ms: number) => void } }).__RIFT_DUEL__.setSimulatedLatencyMs(90);
    });
    await page2.evaluate(() => {
      (window as unknown as { __RIFT_DUEL__: { setSimulatedLatencyMs: (ms: number) => void } }).__RIFT_DUEL__.setSimulatedLatencyMs(90);
    });

    // Guide P1 directly into melee range (< 1.25m in 3D X/Z) of P2 under 90ms latency
    for (let step = 0; step < 25; step++) {
      const s = await page1.evaluate(
        () => (window as unknown as { __RIFT_DUEL__: { getRoomSummary: () => BridgeSummary } }).__RIFT_DUEL__.getRoomSummary()
      );
      const f1 = s.fighters.find((f) => f.slot === 1)!;
      const f2 = s.fighters.find((f) => f.slot === 2)!;
      const dx = f2.x - f1.x;
      const dz = f2.z - f1.z;
      if (Math.hypot(dx, dz) <= 1.25) {
        break;
      }
      if (Math.abs(dx) > 0.4) {
        const keyX = dx > 0 ? 'KeyD' : 'KeyA';
        await page1.keyboard.down(keyX);
        await page1.waitForTimeout(90);
        await page1.keyboard.up(keyX);
      }
      if (Math.abs(dz) > 0.4) {
        const keyZ = dz > 0 ? 'KeyS' : 'KeyW';
        await page1.keyboard.down(keyZ);
        await page1.waitForTimeout(90);
        await page1.keyboard.up(keyZ);
      }
      await page1.waitForTimeout(80);
    }

    // Execute Light (KeyJ) and Heavy (KeyK) attacks in melee range
    await page1.keyboard.press('KeyJ');
    await page1.waitForTimeout(450);
    await page1.keyboard.press('KeyK');
    await page1.waitForTimeout(600);

    const [sum1AfterHit, sum2AfterHit] = await Promise.all([
      page1.evaluate(() => (window as unknown as { __RIFT_DUEL__: { getRoomSummary: () => BridgeSummary } }).__RIFT_DUEL__.getRoomSummary()),
      page2.evaluate(() => (window as unknown as { __RIFT_DUEL__: { getRoomSummary: () => BridgeSummary } }).__RIFT_DUEL__.getRoomSummary()),
    ]);

    const p2DmgOn1 = sum1AfterHit.fighters.find((f) => f.slot === 2)?.damage ?? 0;
    const p2DmgOn2 = sum2AfterHit.fighters.find((f) => f.slot === 2)?.damage ?? 0;
    expect(p2DmgOn1).toBeGreaterThan(0);
    expect(p2DmgOn1).toBe(p2DmgOn2); // Both clients see exact same authoritative damage!

    // Reset simulated latency to 0 for fast remaining steps
    await page1.evaluate(() => {
      (window as unknown as { __RIFT_DUEL__: { setSimulatedLatencyMs: (ms: number) => void } }).__RIFT_DUEL__.setSimulatedLatencyMs(0);
    });
    await page2.evaluate(() => {
      (window as unknown as { __RIFT_DUEL__: { setSimulatedLatencyMs: (ms: number) => void } }).__RIFT_DUEL__.setSimulatedLatencyMs(0);
    });

    // 8. Test Disconnect & Reconnect within 15s grace window:
    // Force P2 to drop connection and reconnect; verify no duplicate players and stocks/damage preserved
    await page2.evaluate(async () => {
      await (
        window as unknown as { __RIFT_DUEL__: { forceDisconnectAndReconnect: () => Promise<void> } }
      ).__RIFT_DUEL__.forceDisconnectAndReconnect();
    });

    await expect
      .poll(
        async () => {
          const s = await page1.evaluate(
            () => (window as unknown as { __RIFT_DUEL__: { getRoomSummary: () => BridgeSummary } }).__RIFT_DUEL__.getRoomSummary()
          );
          return s?.phase === 'fighting' && s?.fighters.length === 2 && s.fighters.every((f) => f.connected);
        },
        { timeout: 10000 }
      )
      .toBe(true);

    const sumAfterReconnect = await page1.evaluate(
      () => (window as unknown as { __RIFT_DUEL__: { getRoomSummary: () => BridgeSummary } }).__RIFT_DUEL__.getRoomSummary()
    );
    expect(sumAfterReconnect.fighters.length).toBe(2);
    expect(sumAfterReconnect.fighters.find((f) => f.slot === 2)?.damage).toBe(p2DmgOn1);

    // 9. Test KO stock deduction -> Match Finish -> Rematch via Keyboard
    // Run P2 off the right blast zone 3 times to trigger 3 KOs and finish the match
    for (let koIdx = 0; koIdx < 3; koIdx++) {
      await page2.keyboard.down('KeyD');
      await expect
        .poll(
          async () => {
            const s = await page1.evaluate(
              () => (window as unknown as { __RIFT_DUEL__: { getRoomSummary: () => BridgeSummary } }).__RIFT_DUEL__.getRoomSummary()
            );
            const p2Stocks = s?.fighters.find((f) => f.slot === 2)?.stocks ?? 3;
            return p2Stocks <= 2 - koIdx || s?.phase === 'finished';
          },
          { timeout: 15000 }
        )
        .toBe(true);
      await page2.keyboard.up('KeyD');

      if (koIdx < 2) {
        // Wait for respawn (damage resets to 0)
        await page2.waitForTimeout(1100);
      }
    }

    // Verify match finished and P1 is the winner
    await expect(page1.locator('#result-winner-title')).toBeVisible({ timeout: 10000 });
    await expect(page2.locator('#result-winner-title')).toBeVisible({ timeout: 10000 });

    // Both players vote Rematch using keyboard KeyR
    await page1.keyboard.press('KeyR');
    await page2.keyboard.press('KeyR');

    // Verify Rematch resets stocks to 3, damage to 0, and transitions back to countdown/fighting
    await expect
      .poll(
        async () => {
          const s = await page1.evaluate(
            () => (window as unknown as { __RIFT_DUEL__: { getRoomSummary: () => BridgeSummary } }).__RIFT_DUEL__.getRoomSummary()
          );
          const p2 = s?.fighters.find((f) => f.slot === 2);
          return (
            (s?.phase === 'countdown' || s?.phase === 'fighting') &&
            p2?.stocks === 3 &&
            p2?.damage === 0
          );
        },
        { timeout: 10000 }
      )
      .toBe(true);

    expect(consoleErrors).toEqual([]);
    expect(failedAssets).toEqual([]);

    await context1.close();
    await context2.close();
    await context3.close();
  });
});
