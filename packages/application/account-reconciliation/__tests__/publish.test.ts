/**
 * Перевод исхода шины в исход прохода.
 *
 * @remarks
 * Отказы самой шины (переполнение, исключение, critical-ошибка ЧУЖОГО события
 * в том же drain) настоящим `EventBus` детерминированно не воспроизвести,
 * поэтому здесь шина — stub, а всё остальное настоящее: приватное состояние
 * наполнено живыми событиями по отдельной шине, источник — fake.
 */
import { describe, expect, it } from '@jest/globals';
import type { ApplicationEvent } from '@polymarket/application-events';
import { CriticalHandlerError, QueueOverflowError } from '@polymarket/errors/event-bus';
import type { IEventBus } from '@polymarket/event-bus';
import { Err, Ok } from '@polymarket/result';
import {
  AccountReconciler,
  AccountReconciliationCoordinator,
  AccountReconciliationPublishError,
  AccountReconciliationVersionConflictError,
} from '../src/index.js';
import { SECOND_WALLET, VENUE, openOrder, portfolio, walletAccount } from './helpers/fixtures.js';
import { buildRuntime, versionOf } from './helpers/runtime.js';

/**
 * Шина, отвечающая на `publish` заданным образом.
 *
 * @param publish - Что вернуть (или бросить) на публикацию
 * @returns `IEventBus`, у которого настоящий только `publish`
 */
function stubBus(publish: (event: ApplicationEvent) => ReturnType<IEventBus['publish']>): IEventBus {
  return {
    publish,
    publishAll: () => Promise.resolve(Ok(undefined)),
    subscribe: () => () => undefined,
  } as unknown as IEventBus;
}

/**
 * Рантайм с принятым аккаунтом и reconciler поверх stub-шины.
 *
 * @param bus - Шина для публикации коррекции
 * @returns Reconciler, координатор и аккаунт
 */
async function setup(bus: IEventBus) {
  const runtime = buildRuntime();
  const accountId = walletAccount();
  await runtime.initializeAccount(accountId);
  runtime.source.account(accountId).setPortfolio(portfolio({ accountId }));
  const reconciler = AccountReconciler.create({
    source: runtime.source,
    eventBus: bus,
    accountState: runtime.view,
    metadata: runtime.metadata,
  });
  const coordinator = AccountReconciliationCoordinator.create({ reconciler, clock: runtime.clock });
  return { runtime, accountId, reconciler, coordinator };
}

describe('исход публикации', () => {
  it('переполнение очереди → PublishError, health UNHEALTHY PUBLISH_FAILED', async () => {
    const overflow = new QueueOverflowError('EventBus queue overflow (1): cannot enqueue x');
    const { accountId, coordinator } = await setup(stubBus(() => Promise.resolve(Err(overflow))));

    const result = await coordinator.request(VENUE, accountId, 'STARTUP');

    const error = !result.ok ? result.error : undefined;
    expect(error).toBeInstanceOf(AccountReconciliationPublishError);
    expect((error as AccountReconciliationPublishError).originalError).toBe(overflow);
    const health = coordinator.health().get(VENUE, accountId);
    expect(health.status).toBe('UNHEALTHY');
    expect(health.failureCode).toBe('PUBLISH_FAILED');
  });

  it('исключение из publish не выходит наружу → PublishError', async () => {
    const boom = new Error('bus invariant violated');
    const { accountId, reconciler } = await setup(stubBus(() => Promise.reject(boom)));

    const pass = await reconciler.reconcile(VENUE, accountId);

    const error = !pass.ok ? pass.error : undefined;
    expect(error).toBeInstanceOf(AccountReconciliationPublishError);
    expect((error as AccountReconciliationPublishError).originalError).toBe(boom);
  });

  it('critical-ошибка на ДРУГОМ событии drain’а — не отказ состояния, а PublishError', async () => {
    const foreign = new CriticalHandlerError('Critical handler failed', {
      context: {
        eventType: 'TRADING_ACCOUNT_ORDER_COMMITTED',
        messageId: 'foreign-message',
        originalError: new Error('x'),
      },
    });
    const { accountId, reconciler } = await setup(stubBus(() => Promise.resolve(Err(foreign))));

    const pass = await reconciler.reconcile(VENUE, accountId);

    expect(!pass.ok && pass.error).toBeInstanceOf(AccountReconciliationPublishError);
  });

  it.each([
    ['конфликт версий', () => new AccountReconciliationVersionConflictError(VENUE, walletAccount(), 1, 2)],
    ['отказ состояния', () => new Error('order identity conflict')],
  ])(
    'чужой TRADING_ACCOUNT_RECONCILED (%s) в нашем drain’е — PublishError, а не наш диагноз',
    async (_kind, makeOriginal) => {
      // Коррекция другого аккаунта отвергнута в drain'е, которым владеет наша
      // публикация: тип тот же, identity сообщения — чужая.
      const foreign = new CriticalHandlerError('Critical handler failed', {
        context: {
          eventType: 'TRADING_ACCOUNT_RECONCILED',
          messageId: 'another-reconciliation',
          originalError: makeOriginal(),
        },
      });
      const { accountId, reconciler } = await setup(stubBus(() => Promise.resolve(Err(foreign))));

      const pass = await reconciler.reconcile(VENUE, accountId);

      expect(!pass.ok && pass.error).toBeInstanceOf(AccountReconciliationPublishError);
      expect(!pass.ok && (pass.error as AccountReconciliationPublishError).originalError).toBe(foreign);
    },
  );

  it('конфликт версий НАШЕГО события распознаётся по КЛАССУ, а не по тексту', async () => {
    // Сообщение нарочно не содержит ничего похожего на «stale»/«version».
    const conflict = new AccountReconciliationVersionConflictError(VENUE, walletAccount(), 1, 2);
    Object.defineProperty(conflict, 'message', { value: 'something unrelated' });
    const { accountId, reconciler } = await setup(
      stubBus((event) =>
        Promise.resolve(
          Err(
            new CriticalHandlerError('Critical handler failed', {
              context: {
                eventType: event.type,
                messageId: event.metadata.messageId,
                originalError: conflict,
              },
            }),
          ),
        ),
      ),
    );

    const pass = await reconciler.reconcile(VENUE, accountId);

    expect(!pass.ok && pass.error).toBe(conflict);
  });

  it('настоящая шина: коррекция A, отвергнутая в drain’е публикации B, не становится диагнозом B', async () => {
    const runtime = buildRuntime();
    const accountA = walletAccount();
    const accountB = walletAccount(SECOND_WALLET);
    await runtime.initializeAccount(accountA);
    await runtime.initializeAccount(accountB);
    runtime.source.account(accountA).setPortfolio(portfolio({ accountId: accountA }));
    runtime.source.account(accountB).setPortfolio(portfolio({ accountId: accountB, available: 7_000 }));

    // Удерживаем drain, которым владеет публикация B: non-critical наблюдатель
    // не отпускает коррекцию B, пока тест не разрешит.
    let releaseDrain!: () => void;
    const drainHeld = new Promise<void>((resolve) => { releaseDrain = resolve; });
    let markEntered!: () => void;
    const drainEntered = new Promise<void>((resolve) => { markEntered = resolve; });
    runtime.bus.subscribe('TRADING_ACCOUNT_RECONCILED', async (event) => {
      if (event.payload.accountId !== accountB) return;
      markEntered();
      await drainHeld;
    });

    const passB = runtime.reconciler.reconcile(VENUE, accountB);
    await drainEntered;

    // A читает версию 1; живое событие A и коррекция A встают в очередь ЧУЖОГО
    // drain'а — живое раньше, поэтому коррекция A окажется устаревшей.
    const passA = runtime.reconciler.reconcile(VENUE, accountA);
    await runtime.commitOrder(accountA, openOrder('order-live', accountA));
    const resultA = await passA;
    expect(resultA.ok).toBe(true); // Ok на постановку в очередь — известное ограничение

    releaseDrain();
    const resultB = await passB;

    // Отвергнута коррекция A (конфликт версий), а не B: B получает
    // PublishError, а не чужой конфликт.
    expect(!resultB.ok && resultB.error).toBeInstanceOf(AccountReconciliationPublishError);
    const critical = !resultB.ok
      ? ((resultB.error as AccountReconciliationPublishError).originalError as CriticalHandlerError)
      : undefined;
    expect(critical?.context?.['originalError']).toBeInstanceOf(AccountReconciliationVersionConflictError);
    expect(critical?.context?.['messageId']).toBe(runtime.reconciledEvents[1].metadata.messageId);
    // Коррекция B применена, устаревшая коррекция A — нет.
    expect(runtime.view.getAccount(VENUE, accountB)?.portfolio.balance.available().toNumber()).toBe(7_000);
    expect(versionOf(runtime.view, accountA)).toBe(2);
  });
});
