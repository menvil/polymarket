/**
 * Перевод исхода шины в исход прохода (stub-шина).
 *
 * @remarks
 * Здесь проверяется только классификация: что reconciler делает с каждым
 * исходом `publishConfirmed()`. Шина — stub, всё остальное настоящее:
 * приватное состояние наполнено живыми событиями по отдельной шине, источник
 * — fake. Поведение настоящей шины — в `confirmedDelivery.test.ts`.
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
 * Шина, отвечающая на `publishConfirmed` заданным образом.
 *
 * @param publishConfirmed - Что вернуть (или бросить) на подтверждённую публикацию
 * @returns `IEventBus`, у которого настоящий только `publishConfirmed`
 *
 * @remarks
 * Обычный `publish` бросает: reconciler обязан публиковать коррекцию ТОЛЬКО
 * подтверждённым путём, и тест, прошедший через `publish`, должен упасть.
 */
function stubBus(
  publishConfirmed: (event: ApplicationEvent) => ReturnType<IEventBus['publishConfirmed']>,
): IEventBus {
  return {
    publish: () => {
      throw new Error('AccountReconciler must not use plain publish()');
    },
    publishConfirmed,
    publishAll: () => Promise.resolve(Ok(undefined)),
    subscribe: () => () => undefined,
  };
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
});
