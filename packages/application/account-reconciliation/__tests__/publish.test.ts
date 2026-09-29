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
import { VENUE, portfolio, walletAccount } from './helpers/fixtures.js';
import { buildRuntime } from './helpers/runtime.js';

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
      context: { eventType: 'TRADING_ACCOUNT_ORDER_COMMITTED', originalError: new Error('x') },
    });
    const { accountId, reconciler } = await setup(stubBus(() => Promise.resolve(Err(foreign))));

    const pass = await reconciler.reconcile(VENUE, accountId);

    expect(!pass.ok && pass.error).toBeInstanceOf(AccountReconciliationPublishError);
  });

  it('конфликт версий распознаётся по КЛАССУ, а не по тексту', async () => {
    // Сообщение нарочно не содержит ничего похожего на «stale»/«version».
    const conflict = new AccountReconciliationVersionConflictError(VENUE, walletAccount(), 1, 2);
    Object.defineProperty(conflict, 'message', { value: 'something unrelated' });
    const critical = new CriticalHandlerError('Critical handler failed', {
      context: { eventType: 'TRADING_ACCOUNT_RECONCILED', originalError: conflict },
    });
    const { accountId, reconciler } = await setup(stubBus(() => Promise.resolve(Err(critical))));

    const pass = await reconciler.reconcile(VENUE, accountId);

    expect(!pass.ok && pass.error).toBe(conflict);
  });
});
