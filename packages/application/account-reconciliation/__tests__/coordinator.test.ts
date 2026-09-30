/**
 * `AccountReconciliationCoordinator`: single-flight, coalescing, независимость
 * аккаунтов и свежий проход при конфликте версий.
 *
 * @remarks
 * Гонки воспроизводятся детерминированно: fake-источник удерживает вызов до
 * `release()`, а `entered` сообщает, что проход действительно дошёл до
 * источника. Ни одного `sleep` — порядок задаёт тест, а не планировщик.
 */
import { describe, expect, it } from '@jest/globals';
import {
  AccountReconciliationCoordinator,
  AccountReconciliationVersionConflictError,
} from '../src/index.js';
import {
  SECOND_WALLET,
  VENUE,
  openOrder,
  portfolio,
  walletAccount,
} from './helpers/fixtures.js';
import { buildRuntime, flushMicrotasks, versionOf } from './helpers/runtime.js';

describe('single-flight одного аккаунта', () => {
  it('10 запросов во время прохода → ни одного параллельного прохода и ОДИН свежий второй проход', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId }));

    const hold = runtime.source.holdNext('getPortfolio');
    const first = runtime.coordinator.request(VENUE, accountId, 'STARTUP');
    await hold.entered;

    const coalesced = Array.from({ length: 10 }, () =>
      runtime.coordinator.request(VENUE, accountId, 'MANUAL'),
    );
    await flushMicrotasks();
    // Пока первый проход держит источник, второго нет.
    expect(runtime.source.calls.getPortfolio).toBe(1);

    hold.release();
    const [firstResult, ...rest] = await Promise.all([first, ...coalesced]);

    expect(runtime.source.calls.getPortfolio).toBe(2);
    expect(runtime.source.peakConcurrency('getPortfolio', accountId)).toBe(1);
    expect(runtime.reconciledEvents).toHaveLength(2);
    // Первый запрос обслужен первым проходом, остальные — одним свежим вторым.
    expect(firstResult.ok && firstResult.value.event).toBe(runtime.reconciledEvents[0]);
    for (const result of rest) {
      expect(result.ok && result.value.event).toBe(runtime.reconciledEvents[1]);
    }
  });

  it('запросы во время второго прохода → ещё один свежий проход', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId }));

    const firstHold = runtime.source.holdNext('getPortfolio');
    const first = runtime.coordinator.request(VENUE, accountId, 'STARTUP');
    await firstHold.entered;

    const secondHold = runtime.source.holdNext('getPortfolio');
    const second = runtime.coordinator.request(VENUE, accountId, 'PERIODIC');
    firstHold.release();
    await secondHold.entered;

    const third = runtime.coordinator.request(VENUE, accountId, 'RECONNECT');
    const fourth = runtime.coordinator.request(VENUE, accountId, 'MANUAL');
    secondHold.release();

    const results = await Promise.all([first, second, third, fourth]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(runtime.source.calls.getPortfolio).toBe(3);
    expect(runtime.source.peakConcurrency('getPortfolio', accountId)).toBe(1);
    // Третий проход начат по самому свежему запросу.
    expect(runtime.coordinator.health().get(VENUE, accountId).lastTrigger).toBe('MANUAL');
  });

  it('после завершения цикла новый запрос запускает новый проход', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId }));

    await runtime.coordinator.request(VENUE, accountId, 'STARTUP');
    await runtime.coordinator.request(VENUE, accountId, 'PERIODIC');

    expect(runtime.source.calls.getPortfolio).toBe(2);
  });
});

describe('разные аккаунты независимы', () => {
  it('проходы A и B идут одновременно', async () => {
    const runtime = buildRuntime();
    const accountA = walletAccount();
    const accountB = walletAccount(SECOND_WALLET);
    await runtime.initializeAccount(accountA);
    await runtime.initializeAccount(accountB);
    runtime.source.account(accountA).setPortfolio(portfolio({ accountId: accountA }));
    runtime.source.account(accountB).setPortfolio(portfolio({ accountId: accountB }));

    const holdA = runtime.source.holdNext('getPortfolio', accountA);
    const holdB = runtime.source.holdNext('getPortfolio', accountB);
    const requestA = runtime.coordinator.request(VENUE, accountA, 'STARTUP');
    const requestB = runtime.coordinator.request(VENUE, accountB, 'STARTUP');

    // Оба прохода дошли до источника, ни один ещё не отпущен.
    await Promise.all([holdA.entered, holdB.entered]);
    expect(runtime.source.peakConcurrency('getPortfolio')).toBe(2);

    holdB.release();
    const resultB = await requestB;
    expect(resultB.ok).toBe(true);
    // B завершился, пока A всё ещё держит источник.
    expect(runtime.coordinator.health().get(VENUE, accountB).status).toBe('READY');
    expect(runtime.coordinator.health().get(VENUE, accountA).status).toBe('INITIALIZING');

    holdA.release();
    expect((await requestA).ok).toBe(true);
  });

  it('эквивалентный AccountId из другого объекта — тот же аккаунт, тот же single-flight', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId }));

    const hold = runtime.source.holdNext('getPortfolio');
    const first = runtime.coordinator.request(VENUE, accountId, 'STARTUP');
    await hold.entered;
    const second = runtime.coordinator.request(VENUE, walletAccount(), 'MANUAL');
    await flushMicrotasks();
    expect(runtime.source.calls.getPortfolio).toBe(1);

    hold.release();
    await Promise.all([first, second]);
    expect(runtime.source.peakConcurrency('getPortfolio', accountId)).toBe(1);
  });
});

describe('CAS-гонка: устаревший снимок отбрасывается, делается свежий проход', () => {
  it('v10 → источник заблокирован → живое событие v11 → expected=10 отвергнут → свежий проход expected=11 → успех', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    const openOrders = Array.from({ length: 9 }, (_, i) => openOrder(`order-${i}`, accountId));
    for (const order of openOrders) await runtime.commitOrder(accountId, order);
    expect(versionOf(runtime.view, accountId)).toBe(10);

    const stalePortfolio = portfolio({ accountId, available: 1_111 });
    const freshPortfolio = portfolio({ accountId, available: 2_222 });
    runtime.source.account(accountId).setPortfolio(stalePortfolio).setOpenOrders(openOrders);

    const firstHold = runtime.source.holdNext('getPortfolio');
    runtime.clock.setTime(new Date(10_000));
    const request = runtime.coordinator.request(VENUE, accountId, 'PERIODIC');
    await firstHold.entered;

    // Пока источник держит первый проход, живой контур меняет аккаунт.
    const live = openOrder('order-live', accountId);
    await runtime.commitOrder(accountId, live);
    expect(versionOf(runtime.view, accountId)).toBe(11);
    runtime.source.account(accountId).setOpenOrders([...openOrders, live]);

    const secondHold = runtime.source.holdNext('getPortfolio');
    firstHold.release();
    await secondHold.entered;

    // Устаревший снимок опубликован, отвергнут и НИЧЕГО не изменил.
    expect(runtime.reconciledEvents).toHaveLength(1);
    expect(runtime.reconciledEvents[0].payload.expectedAccountVersion).toBe(10);
    expect(runtime.reconciledEvents[0].payload.portfolio).toBe(stalePortfolio);
    const account = runtime.view.getAccount(VENUE, accountId);
    expect(account?.version).toBe(11);
    expect(account?.portfolio).not.toBe(stalePortfolio);
    expect(account?.portfolio.balance.available().value().toNumber()).not.toBe(1_111);
    // Конфликт — не отказ.
    const during = runtime.coordinator.health().get(VENUE, accountId);
    expect(during.status).toBe('INITIALIZING');
    expect(during.failureCode).toBeUndefined();
    expect(during.lastFailureAt).toBeUndefined();

    // Свежий проход заново читает источник, а не повторяет старый снимок.
    runtime.source.account(accountId).setPortfolio(freshPortfolio);
    runtime.clock.setTime(new Date(20_000));
    secondHold.release();
    const result = await request;

    expect(result.ok).toBe(true);
    expect(runtime.reconciledEvents).toHaveLength(2);
    expect(runtime.reconciledEvents[1].payload.expectedAccountVersion).toBe(11);
    expect(runtime.reconciledEvents[1].payload.portfolio).toBe(freshPortfolio);
    expect(result.ok && result.value.event).toBe(runtime.reconciledEvents[1]);
    expect(runtime.source.calls.getPortfolio).toBe(2);

    const after = runtime.view.getAccount(VENUE, accountId);
    expect(after?.version).toBe(12);
    expect(after?.portfolio).toBe(freshPortfolio);

    const health = runtime.coordinator.health().get(VENUE, accountId);
    expect(health.status).toBe('READY');
    expect(health.lastSuccessAt?.toNumber()).toBe(20_000);
    expect(health.lastFailureAt).toBeUndefined();
  });

  it('конфликты подряд ограничены: по исчерпании — Err(конфликт), health не меняется', async () => {
    const runtime = buildRuntime({ maxConsecutiveVersionConflicts: 2 });
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId, available: 5 }));

    const firstHold = runtime.source.holdNext('getPortfolio');
    const request = runtime.coordinator.request(VENUE, accountId, 'PERIODIC');
    await firstHold.entered;
    const liveOrders = [openOrder('order-1', accountId), openOrder('order-2', accountId)];
    await runtime.commitOrder(accountId, liveOrders[0]);
    runtime.source.account(accountId).setOpenOrders(liveOrders.slice(0, 1));

    const secondHold = runtime.source.holdNext('getPortfolio');
    firstHold.release();
    await secondHold.entered;
    await runtime.commitOrder(accountId, liveOrders[1]);
    runtime.source.account(accountId).setOpenOrders(liveOrders);
    secondHold.release();

    const result = await request;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeInstanceOf(AccountReconciliationVersionConflictError);
    expect(runtime.source.calls.getPortfolio).toBe(2);
    expect(runtime.reconciledEvents).toHaveLength(2);

    const health = runtime.coordinator.health().get(VENUE, accountId);
    expect(health.status).toBe('INITIALIZING');
    expect(health.failureCode).toBeUndefined();

    // Следующий запрос — новая серия, и без гонки она проходит.
    expect((await runtime.coordinator.request(VENUE, accountId, 'MANUAL')).ok).toBe(true);
    expect(runtime.coordinator.health().get(VENUE, accountId).status).toBe('READY');
  });
});

describe('устойчивость цикла', () => {
  it('дефект reconciler’а отвергает ожидающих и не оставляет аккаунт «занятым»', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    let explode = true;
    const coordinator = AccountReconciliationCoordinator.create({
      clock: runtime.clock,
      reconciler: {
        reconcile: async (venueId, account) => {
          if (explode) throw new Error('reconciler defect');
          return runtime.reconciler.reconcile(venueId, account);
        },
      },
    });

    await expect(coordinator.request(VENUE, accountId, 'STARTUP')).rejects.toThrow('reconciler defect');

    explode = false;
    await runtime.initializeAccount(accountId);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId }));
    expect((await coordinator.request(VENUE, accountId, 'MANUAL')).ok).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN])('maxConsecutiveVersionConflicts = %p отвергается', (max) => {
    const runtime = buildRuntime();
    expect(() =>
      AccountReconciliationCoordinator.create({
        reconciler: runtime.reconciler,
        clock: runtime.clock,
        maxConsecutiveVersionConflicts: max,
      }),
    ).toThrow(RangeError);
  });
});
