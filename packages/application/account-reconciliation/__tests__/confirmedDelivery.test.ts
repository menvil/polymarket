/**
 * Граница подтверждения доставки: исход прохода относится к СВОЕЙ коррекции.
 *
 * @remarks
 * Всё настоящее — `EventBus`, critical-проектор, reconciler, координатор; fake
 * только источник. Drain удерживается non-critical наблюдателем, который не
 * отпускает выбранное событие, пока тест не разрешит: handlers одного события
 * выполняются параллельно, и следующее событие диспетчеризуется только после
 * завершения всех.
 *
 * ```text
 * 1. A держит drain, B публикуется параллельно → B не резолвится и не READY,
 *    пока его коррекция реально не обработана
 * 2. коррекция A падает VersionConflict, B ждёт рядом → B не получает конфликт A
 * 3. в очереди чужая коррекция, которая упадёт → B не попадает в очередь вовсе
 * 4. B применилась, после неё в том же drain упало другое → исход B — успех
 * ```
 */
import { describe, expect, it } from '@jest/globals';
import type { TradingAccountReconciledEvent } from '@polymarket/application-events';
import { CriticalHandlerError } from '@polymarket/errors/event-bus';
import type { AccountId } from '@polymarket/ids';
import {
  AccountReconciliationPublishError,
  AccountReconciliationVersionConflictError,
} from '../src/index.js';
import { SECOND_WALLET, VENUE, openOrder, portfolio, walletAccount } from './helpers/fixtures.js';
import { buildRuntime, flushMicrotasks, versionOf, type ReconciliationRuntime } from './helpers/runtime.js';

/** Удержание drain на событии, выбранном предикатом. */
interface DrainHold {
  /** Выбранное событие дошло до наблюдателя, drain занят */
  readonly entered: Promise<void>;
  /** Отпустить drain */
  release(): void;
}

/**
 * Подписывает non-critical наблюдателя, удерживающего drain на ПЕРВОМ
 * событии, подходящем под предикат.
 *
 * @param runtime - Рантайм
 * @param type - Тип события
 * @param match - Какое событие удерживать
 * @returns Удержание
 */
function holdDrainOn<T extends 'TRADING_ACCOUNT_RECONCILED' | 'TRADING_ACCOUNT_ORDER_COMMITTED'>(
  runtime: ReconciliationRuntime,
  type: T,
  match: (event: { payload: { accountId: AccountId } }) => boolean,
): DrainHold {
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let used = false;
  runtime.bus.subscribe(type, async (event) => {
    if (used || !match(event)) return;
    used = true;
    markEntered();
    await gate;
  });
  return { entered, release };
}

/**
 * Устаревшая коррекция чужого аккаунта — упадёт VersionConflict в проекторе.
 *
 * @param runtime - Рантайм
 * @param accountId - Аккаунт коррекции
 * @param expectedAccountVersion - Заведомо неверная версия
 * @returns Canonical событие коррекции
 */
function staleCorrection(
  runtime: ReconciliationRuntime,
  accountId: AccountId,
  expectedAccountVersion: number,
): TradingAccountReconciledEvent {
  return {
    type: 'TRADING_ACCOUNT_RECONCILED',
    payload: {
      venueId: VENUE,
      accountId,
      expectedAccountVersion,
      portfolio: portfolio({ accountId, available: 1 }),
      orders: [],
      fills: [],
    },
    metadata: runtime.metadata.nextRoot(),
  };
}

/** Два принятых аккаунта; источник для B исправляет портфель на 7 000. */
async function twoAccounts() {
  const runtime = buildRuntime();
  const accountA = walletAccount();
  const accountB = walletAccount(SECOND_WALLET);
  await runtime.initializeAccount(accountA);
  await runtime.initializeAccount(accountB);
  runtime.source.account(accountA).setPortfolio(portfolio({ accountId: accountA, available: 5_000 }));
  runtime.source.account(accountB).setPortfolio(portfolio({ accountId: accountB, available: 7_000 }));
  return { runtime, accountA, accountB };
}

/** Свободные средства аккаунта в приватном состоянии. */
function availableOf(runtime: ReconciliationRuntime, accountId: AccountId): number | undefined {
  return runtime.view.getAccount(VENUE, accountId)?.portfolio.balance.available().toNumber();
}

describe('подтверждённая доставка коррекции', () => {
  it('1. A держит drain: B не резолвится и не READY, пока его коррекция не обработана', async () => {
    const { runtime, accountA, accountB } = await twoAccounts();
    const hold = holdDrainOn(runtime, 'TRADING_ACCOUNT_RECONCILED', (e) => e.payload.accountId === accountA);

    const requestA = runtime.coordinator.request(VENUE, accountA, 'STARTUP');
    await hold.entered;

    let settledB = false;
    let availableWhenSettled: number | undefined;
    const requestB = runtime.coordinator.request(VENUE, accountB, 'STARTUP').then((result) => {
      settledB = true;
      availableWhenSettled = availableOf(runtime, accountB);
      return result;
    });
    await flushMicrotasks();

    // Снимок B собран, но его коррекция ещё не обработана — и даже не в очереди.
    expect(runtime.source.calls.getPortfolio).toBe(2);
    expect(settledB).toBe(false);
    expect(runtime.coordinator.health().get(VENUE, accountB).status).toBe('INITIALIZING');
    expect(availableOf(runtime, accountB)).toBe(10_000);
    expect(runtime.reconciledEvents.map((e) => e.payload.accountId)).toEqual([accountA]);
    expect(runtime.bus.getStats().queueSize).toBe(0);

    hold.release();
    const [resultA, resultB] = await Promise.all([requestA, requestB]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    // К моменту резолва коррекция B уже применена проектором.
    expect(availableWhenSettled).toBe(7_000);
    expect(runtime.coordinator.health().get(VENUE, accountB).status).toBe('READY');
    expect(runtime.reconciledEvents.map((e) => e.payload.accountId)).toEqual([accountA, accountB]);
  });

  it('2. коррекция A падает VersionConflict, B ждёт рядом → B НЕ получает конфликт A', async () => {
    const { runtime, accountA, accountB } = await twoAccounts();

    // A читает версию 1; пока источник держит A, живое событие делает A v2.
    const sourceHold = runtime.source.holdNext('getPortfolio', accountA);
    const passA = runtime.reconciler.reconcile(VENUE, accountA);
    await sourceHold.entered;
    await runtime.commitOrder(accountA, openOrder('order-live', accountA));
    expect(versionOf(runtime.view, accountA)).toBe(2);

    // Устаревшая коррекция A займёт drain; B встанет ждать рядом.
    const drainHold = holdDrainOn(runtime, 'TRADING_ACCOUNT_RECONCILED', (e) => e.payload.accountId === accountA);
    sourceHold.release();
    await drainHold.entered;

    let settledB = false;
    const requestB = runtime.coordinator.request(VENUE, accountB, 'STARTUP').then((result) => {
      settledB = true;
      return result;
    });
    await flushMicrotasks();
    expect(settledB).toBe(false);

    drainHold.release();
    const resultA = await passA;
    const resultB = await requestB;

    // Конфликт — у A, и это конфликт ЕГО события.
    expect(!resultA.ok && resultA.error).toBeInstanceOf(AccountReconciliationVersionConflictError);
    const eventA = runtime.reconciledEvents[0];
    expect(eventA.payload.accountId).toBe(accountA);

    // B получил не конфликт A, а «моё событие не подтверждено»: identity отказа
    // — messageId события A, не B.
    expect(resultB.ok).toBe(false);
    const errorB = !resultB.ok ? resultB.error : undefined;
    expect(errorB).not.toBeInstanceOf(AccountReconciliationVersionConflictError);
    expect(errorB).toBeInstanceOf(AccountReconciliationPublishError);
    const critical = (errorB as AccountReconciliationPublishError).originalError as CriticalHandlerError;
    expect(critical).toBeInstanceOf(CriticalHandlerError);
    expect(critical.context?.['messageId']).toBe(eventA.metadata.messageId);
    expect(critical.context?.['originalError']).toBeInstanceOf(AccountReconciliationVersionConflictError);
    expect(runtime.coordinator.health().get(VENUE, accountB).failureCode).toBe('PUBLISH_FAILED');

    // Коррекция B не публиковалась и не применится позже.
    expect(runtime.reconciledEvents).toHaveLength(1);
    await runtime.commitOrder(accountA, openOrder('order-after', accountA));
    expect(runtime.reconciledEvents).toHaveLength(1);
    expect(availableOf(runtime, accountB)).toBe(10_000);
    expect(versionOf(runtime.view, accountB)).toBe(1);

    // Следующий запрос B — свежий проход, и он проходит.
    expect((await runtime.coordinator.request(VENUE, accountB, 'MANUAL')).ok).toBe(true);
    expect(availableOf(runtime, accountB)).toBe(7_000);
  });

  it('3. в очереди чужая коррекция, которая упадёт → коррекция B в очередь не попадает и не применяется позже', async () => {
    const { runtime, accountA, accountB } = await twoAccounts();

    // Живое событие A держит drain; за ним в очереди — устаревшая коррекция A.
    const hold = holdDrainOn(runtime, 'TRADING_ACCOUNT_ORDER_COMMITTED', (e) => e.payload.accountId === accountA);
    const live = runtime.commitOrder(accountA, openOrder('order-live', accountA)).catch((error: unknown) => error);
    await hold.entered;
    const foreign = staleCorrection(runtime, accountA, 1);
    expect((await runtime.bus.publish(foreign)).ok).toBe(true);
    expect(runtime.bus.getStats().queueSize).toBe(1);

    const requestB = runtime.coordinator.request(VENUE, accountB, 'STARTUP');
    await flushMicrotasks();
    // B ждёт backlog и в очередь не встал.
    expect(runtime.bus.getStats().queueSize).toBe(1);

    hold.release();
    await live;
    const resultB = await requestB;

    expect(resultB.ok).toBe(false);
    const errorB = !resultB.ok ? resultB.error : undefined;
    expect(errorB).toBeInstanceOf(AccountReconciliationPublishError);
    const critical = (errorB as AccountReconciliationPublishError).originalError as CriticalHandlerError;
    expect(critical.context?.['messageId']).toBe(foreign.metadata.messageId);

    // Коррекции B не было ни в очереди, ни в шине — и позже она не появится.
    expect(runtime.bus.getStats().queueSize).toBe(0);
    await runtime.commitOrder(accountA, openOrder('order-after', accountA));
    await flushMicrotasks();
    expect(runtime.reconciledEvents.map((e) => e.metadata.messageId)).toEqual([foreign.metadata.messageId]);
    expect(availableOf(runtime, accountB)).toBe(10_000);
    expect(versionOf(runtime.view, accountB)).toBe(1);
  });

  it('4. коррекция B применилась, после неё в том же drain упало другое событие → исход B — успех', async () => {
    const { runtime, accountA, accountB } = await twoAccounts();

    // Пока обрабатывается коррекция B, в хвост ЕЁ drain встаёт устаревшая
    // коррекция A — она упадёт VersionConflict уже после B.
    const foreign = staleCorrection(runtime, accountA, 99);
    let reentrantPublished = false;
    runtime.bus.subscribe('TRADING_ACCOUNT_RECONCILED', async (event) => {
      if (event.payload.accountId !== accountB || reentrantPublished) return;
      reentrantPublished = true;
      await runtime.bus.publish(foreign);
    });

    const resultB = await runtime.coordinator.request(VENUE, accountB, 'STARTUP');

    expect(reentrantPublished).toBe(true);
    expect(resultB.ok).toBe(true);
    expect(availableOf(runtime, accountB)).toBe(7_000);
    expect(runtime.coordinator.health().get(VENUE, accountB).status).toBe('READY');
    // Чужая коррекция действительно упала и ничего не изменила.
    expect(runtime.reconciledEvents.map((e) => e.metadata.messageId)).toContain(foreign.metadata.messageId);
    expect(availableOf(runtime, accountA)).toBe(10_000);
    expect(versionOf(runtime.view, accountA)).toBe(1);
  });
});
