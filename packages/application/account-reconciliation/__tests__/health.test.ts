/**
 * Health сверки: статусы, времена от инъецированных часов, конфликт ≠ отказ.
 *
 * @remarks
 * Каждое время в health проверяется ТОЧНЫМ значением `PaperClock`: если бы
 * где-то остался `Date.now()`, значение совпало бы с часами теста только
 * случайно.
 */
import { describe, expect, it } from '@jest/globals';
import {
  SECOND_WALLET,
  VENUE,
  openOrder,
  portfolio,
  walletAccount,
} from './helpers/fixtures.js';
import { buildRuntime, versionOf } from './helpers/runtime.js';

describe('health сверки', () => {
  it('аккаунт, по которому сверку не запрашивали → INITIALIZING без времён', () => {
    const runtime = buildRuntime();
    const health = runtime.coordinator.health().get(VENUE, walletAccount());

    expect(health).toEqual({ status: 'INITIALIZING' });
  });

  it('идущий первый проход → всё ещё INITIALIZING, но с временем попытки и причиной', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId }));

    const hold = runtime.source.holdNext('getPortfolio');
    runtime.clock.setTime(new Date(5_000));
    const request = runtime.coordinator.request(VENUE, accountId, 'STARTUP');
    await hold.entered;

    const during = runtime.coordinator.health().get(VENUE, accountId);
    expect(during.status).toBe('INITIALIZING');
    expect(during.lastTrigger).toBe('STARTUP');
    expect(during.lastAttemptAt?.toNumber()).toBe(5_000);
    expect(during.lastSuccessAt).toBeUndefined();

    hold.release();
    await request;
  });

  it('успешная коррекция → READY, lastSuccessAt — время завершения по часам', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId, available: 7_777 }));

    const hold = runtime.source.holdNext('getPortfolio');
    runtime.clock.setTime(new Date(5_000));
    const request = runtime.coordinator.request(VENUE, accountId, 'STARTUP');
    await hold.entered;
    runtime.clock.setTime(new Date(6_000));
    hold.release();
    await request;

    expect(versionOf(runtime.view, accountId)).toBe(2);
    const health = runtime.coordinator.health().get(VENUE, accountId);
    expect(health.status).toBe('READY');
    expect(health.lastAttemptAt?.toNumber()).toBe(5_000);
    expect(health.lastSuccessAt?.toNumber()).toBe(6_000);
    expect(health.failureCode).toBeUndefined();
  });

  it('успешный no-op → READY и обновлённый lastSuccessAt, версии не меняются', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId, available: 7_000 }));

    // Первая сверка исправляет портфель — это мутация.
    runtime.clock.setTime(new Date(5_000));
    await runtime.coordinator.request(VENUE, accountId, 'STARTUP');
    const versionAfterFirst = versionOf(runtime.view, accountId);
    const globalAfterFirst = runtime.view.getVersion();
    expect(versionAfterFirst).toBe(2);

    runtime.clock.setTime(new Date(9_000));
    const result = await runtime.coordinator.request(VENUE, accountId, 'PERIODIC');

    expect(result.ok).toBe(true);
    expect(versionOf(runtime.view, accountId)).toBe(versionAfterFirst);
    expect(runtime.view.getVersion()).toBe(globalAfterFirst);
    const health = runtime.coordinator.health().get(VENUE, accountId);
    expect(health.status).toBe('READY');
    expect(health.lastSuccessAt?.toNumber()).toBe(9_000);
    expect(health.lastTrigger).toBe('PERIODIC');
  });

  it('отказ источника → UNHEALTHY с кодом, текстом и временем отказа', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId }));
    runtime.source.fail('getFills');

    runtime.clock.setTime(new Date(5_000));
    const result = await runtime.coordinator.request(VENUE, accountId, 'STARTUP');

    expect(result.ok).toBe(false);
    const health = runtime.coordinator.health().get(VENUE, accountId);
    expect(health.status).toBe('UNHEALTHY');
    expect(health.failureCode).toBe('SOURCE_FAILED');
    expect(health.failureReason).toMatch(/getFills failed/);
    expect(health.lastFailureAt?.toNumber()).toBe(5_000);
    expect(health.lastSuccessAt).toBeUndefined();
  });

  it('после отказа успешная сверка → READY, описание отказа снято, время отказа осталось', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId }));
    runtime.source.fail('getPortfolio');
    runtime.clock.setTime(new Date(5_000));
    await runtime.coordinator.request(VENUE, accountId, 'STARTUP');

    runtime.source.recover('getPortfolio');
    runtime.clock.setTime(new Date(8_000));
    await runtime.coordinator.request(VENUE, accountId, 'MANUAL');

    const health = runtime.coordinator.health().get(VENUE, accountId);
    expect(health.status).toBe('READY');
    expect(health.failureCode).toBeUndefined();
    expect(health.failureReason).toBeUndefined();
    expect(health.lastFailureAt?.toNumber()).toBe(5_000);
    expect(health.lastSuccessAt?.toNumber()).toBe(8_000);
  });

  it('неразрешённая заявка → UNHEALTHY UNRESOLVED_ORDER', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    await runtime.commitOrder(accountId, openOrder('order-123', accountId));
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId })).setOpenOrders([]);

    await runtime.coordinator.request(VENUE, accountId, 'RECONNECT');

    const health = runtime.coordinator.health().get(VENUE, accountId);
    expect(health.status).toBe('UNHEALTHY');
    expect(health.failureCode).toBe('UNRESOLVED_ORDER');
    expect(health.failureReason).toMatch(/order-123/);
    expect(runtime.reconciledEvents).toHaveLength(0);
  });

  it('снимок, отвергнутый состоянием, → UNHEALTHY VALIDATION_FAILED', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    runtime.source
      .account(accountId)
      .setPortfolio(portfolio({ accountId: walletAccount('0x9999999999999999999999999999999999999999') }));

    await runtime.coordinator.request(VENUE, accountId, 'INCONSISTENCY');

    const health = runtime.coordinator.health().get(VENUE, accountId);
    expect(health.status).toBe('UNHEALTHY');
    expect(health.failureCode).toBe('VALIDATION_FAILED');
    expect(health.lastTrigger).toBe('INCONSISTENCY');
  });

  it('аккаунт, не принятый состоянием, → UNHEALTHY VALIDATION_FAILED без обращения к источнику', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();

    await runtime.coordinator.request(VENUE, accountId, 'STARTUP');

    const health = runtime.coordinator.health().get(VENUE, accountId);
    expect(health.status).toBe('UNHEALTHY');
    expect(health.failureCode).toBe('VALIDATION_FAILED');
    expect(runtime.source.calls.getPortfolio).toBe(0);
  });

  it('конфликт версий после READY → статус остаётся READY, свежий проход снова успешен', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId }));
    runtime.clock.setTime(new Date(5_000));
    await runtime.coordinator.request(VENUE, accountId, 'STARTUP');
    expect(runtime.coordinator.health().get(VENUE, accountId).status).toBe('READY');

    const firstHold = runtime.source.holdNext('getPortfolio');
    runtime.clock.setTime(new Date(10_000));
    const request = runtime.coordinator.request(VENUE, accountId, 'PERIODIC');
    await firstHold.entered;
    const live = openOrder('order-live', accountId);
    await runtime.commitOrder(accountId, live);
    runtime.source.account(accountId).setOpenOrders([live]);

    const secondHold = runtime.source.holdNext('getPortfolio');
    firstHold.release();
    await secondHold.entered;
    const during = runtime.coordinator.health().get(VENUE, accountId);
    expect(during.status).toBe('READY');
    expect(during.lastSuccessAt?.toNumber()).toBe(5_000);
    expect(during.failureCode).toBeUndefined();

    runtime.clock.setTime(new Date(11_000));
    secondHold.release();
    await request;

    const after = runtime.coordinator.health().get(VENUE, accountId);
    expect(after.status).toBe('READY');
    expect(after.lastSuccessAt?.toNumber()).toBe(11_000);
    expect(after.lastFailureAt).toBeUndefined();
  });

  it('health аккаунтов независим', async () => {
    const runtime = buildRuntime();
    const healthy = walletAccount();
    const broken = walletAccount(SECOND_WALLET);
    await runtime.initializeAccount(healthy);
    await runtime.initializeAccount(broken);
    runtime.source.account(healthy).setPortfolio(portfolio({ accountId: healthy }));
    // У второго аккаунта источник портфеля не знает.

    await Promise.all([
      runtime.coordinator.request(VENUE, healthy, 'STARTUP'),
      runtime.coordinator.request(VENUE, broken, 'STARTUP'),
    ]);

    expect(runtime.coordinator.health().get(VENUE, healthy).status).toBe('READY');
    expect(runtime.coordinator.health().get(VENUE, broken).status).toBe('UNHEALTHY');
  });

  it('запись health — immutable snapshot: обновление не меняет уже выданный объект', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId }));

    const before = runtime.coordinator.health().get(VENUE, accountId);
    await runtime.coordinator.request(VENUE, accountId, 'STARTUP');

    expect(before.status).toBe('INITIALIZING');
    expect(runtime.coordinator.health().get(VENUE, accountId).status).toBe('READY');
  });
});
