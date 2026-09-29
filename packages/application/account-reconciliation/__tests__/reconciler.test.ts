/**
 * Один проход сверки: что публикуется, когда НЕ публикуется ничего.
 *
 * @remarks
 * Проверяется путь целиком: fake-источник → `AccountReconciler` → настоящая
 * шина → настоящий проектор → `AccountHotState`. Число коррекций, дошедших до
 * шины, считает независимый non-critical наблюдатель.
 */
import { describe, expect, it } from '@jest/globals';
import { AccountPortfolioIdentityMismatchError } from '@polymarket/account-state';
import {
  AccountReconciliationSourceError,
  AccountReconciliationUnresolvedOrderError,
  AccountReconciliationValidationError,
  type AccountReconciliationSourceOperation,
} from '../src/index.js';
import {
  VENUE,
  fill,
  openOrder,
  pendingOrder,
  portfolio,
  walletAccount,
  withFill,
} from './helpers/fixtures.js';
import { buildRuntime, versionOf } from './helpers/runtime.js';

describe('AccountReconciler: успешный проход', () => {
  it('полный снимок → ровно одно TRADING_ACCOUNT_RECONCILED с версией, прочитанной до запросов', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    const open = openOrder('order-1', accountId);
    await runtime.commitOrder(accountId, open);
    expect(versionOf(runtime.view, accountId)).toBe(2);

    const authoritative = portfolio({ accountId, available: 9_000, reserved: 65, upQuantity: 40 });
    const venueFill = fill({ id: 'fill-1', orderId: 'order-1', accountId, size: 40 });
    runtime.source
      .account(accountId)
      .setPortfolio(authoritative)
      .setOpenOrders([withFill(open, 'fill-1', 40)])
      .setFills([venueFill]);

    runtime.clock.setTime(new Date(50_000));
    const pass = await runtime.reconciler.reconcile(VENUE, accountId);

    expect(pass.ok).toBe(true);
    expect(runtime.reconciledEvents).toHaveLength(1);
    const [event] = runtime.reconciledEvents;
    expect(pass.ok && pass.value.event).toBe(event);
    expect(event.payload.venueId).toBe(VENUE);
    expect(event.payload.accountId).toEqual(accountId);
    expect(event.payload.expectedAccountVersion).toBe(2);
    expect(event.payload.portfolio).toBe(authoritative);
    expect(event.payload.orders.map((o) => [o.id, o.status])).toEqual([['order-1', 'PARTIALLY_FILLED']]);
    expect(event.payload.fills).toEqual([venueFill]);
    expect(event.metadata.createdAt.toNumber()).toBe(50_000);

    // Коррекция применена одной мутацией.
    const account = runtime.view.getAccount(VENUE, accountId);
    expect(account?.version).toBe(3);
    expect(account?.portfolio).toBe(authoritative);
    expect(account?.getFill(venueFill.id)?.status).toBe('CONFIRMED');
    expect(account?.getOrder(open.id)?.order.status).toBe('PARTIALLY_FILLED');
  });

  it('все три обязательных чтения выполняются; getOrder не вызывается, если открытые совпали', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    const open = openOrder('order-1', accountId);
    await runtime.commitOrder(accountId, open);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId })).setOpenOrders([open]);

    await runtime.reconciler.reconcile(VENUE, accountId);

    expect(runtime.source.calls).toEqual({
      getPortfolio: 1,
      getOpenOrders: 1,
      getFills: 1,
      getOrder: 0,
    });
  });

  it('аккаунт, не принятый состоянием → ValidationError ACCOUNT_NOT_INITIALIZED, к источнику не ходим', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();

    const pass = await runtime.reconciler.reconcile(VENUE, accountId);

    expect(pass.ok).toBe(false);
    const error = !pass.ok ? pass.error : undefined;
    expect(error).toBeInstanceOf(AccountReconciliationValidationError);
    expect((error as AccountReconciliationValidationError).reason).toBe('ACCOUNT_NOT_INITIALIZED');
    expect(runtime.source.calls.getPortfolio).toBe(0);
    expect(runtime.reconciledEvents).toHaveLength(0);
  });
});

describe('AccountReconciler: обязательное чтение не удалось → события нет', () => {
  it.each<AccountReconciliationSourceOperation>(['getPortfolio', 'getOpenOrders', 'getFills'])(
    '%s → Err(SourceError), коррекция не опубликована, состояние не тронуто',
    async (method) => {
      const runtime = buildRuntime();
      const accountId = walletAccount();
      await runtime.initializeAccount(accountId);
      runtime.source.account(accountId).setPortfolio(portfolio({ accountId, available: 1 }));
      runtime.source.fail(method);
      const versionBefore = runtime.view.getVersion();

      const pass = await runtime.reconciler.reconcile(VENUE, accountId);

      expect(pass.ok).toBe(false);
      const error = !pass.ok ? pass.error : undefined;
      expect(error).toBeInstanceOf(AccountReconciliationSourceError);
      expect((error as AccountReconciliationSourceError).operation).toBe(method);
      expect(runtime.reconciledEvents).toHaveLength(0);
      expect(runtime.view.getVersion()).toBe(versionBefore);
    },
  );

  it('адаптер бросил исключение вместо Err → тот же отказ, исключение не выходит наружу', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId }));
    runtime.source.fail('getFills', 'THROW');

    const pass = await runtime.reconciler.reconcile(VENUE, accountId);

    expect(pass.ok).toBe(false);
    const error = !pass.ok ? pass.error : undefined;
    expect(error).toBeInstanceOf(AccountReconciliationSourceError);
    expect((error as AccountReconciliationSourceError).operation).toBe('getFills');
    expect((error as AccountReconciliationSourceError).originalError).toBeInstanceOf(Error);
    expect(runtime.reconciledEvents).toHaveLength(0);
  });
});

describe('AccountReconciler: локально открытая заявка отсутствует среди открытых у источника', () => {
  it('вызывается getOrder(orderId); терминальная заявка входит в коррекцию', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    const open = openOrder('order-123', accountId);
    await runtime.commitOrder(accountId, open);

    const canceled = open.cancel('venue');
    if (!canceled.ok) throw canceled.error;
    runtime.source
      .account(accountId)
      .setPortfolio(portfolio({ accountId }))
      .setOpenOrders([])
      .setOrder(canceled.value);

    const pass = await runtime.reconciler.reconcile(VENUE, accountId);

    expect(pass.ok).toBe(true);
    expect(runtime.source.getOrderCalls).toEqual(['order-123']);
    expect(runtime.reconciledEvents[0].payload.orders).toEqual([canceled.value]);
    expect(runtime.view.getAccount(VENUE, accountId)?.getOrder(open.id)?.order.status).toBe('CANCELED');
  });

  it('getOrder → undefined: статус НЕ угадывается, коррекции нет, Err(UnresolvedOrder)', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    await runtime.commitOrder(accountId, openOrder('order-123', accountId));
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId })).setOpenOrders([]);
    const versionBefore = versionOf(runtime.view, accountId);

    const pass = await runtime.reconciler.reconcile(VENUE, accountId);

    expect(pass.ok).toBe(false);
    const error = !pass.ok ? pass.error : undefined;
    expect(error).toBeInstanceOf(AccountReconciliationUnresolvedOrderError);
    expect((error as AccountReconciliationUnresolvedOrderError).orderIds).toEqual(['order-123']);
    expect(runtime.reconciledEvents).toHaveLength(0);
    expect(versionOf(runtime.view, accountId)).toBe(versionBefore);
    expect(runtime.view.getAccount(VENUE, accountId)?.getOrder('order-123' as never)?.order.status).toBe('OPEN');
  });

  it('локальная PENDING-заявка тоже считается открытой (OPEN_ORDER_STATUSES)', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    await runtime.commitOrder(accountId, pendingOrder('order-pending', accountId));
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId })).setOpenOrders([]);

    const pass = await runtime.reconciler.reconcile(VENUE, accountId);

    expect(runtime.source.getOrderCalls).toEqual(['order-pending']);
    expect(!pass.ok && pass.error).toBeInstanceOf(AccountReconciliationUnresolvedOrderError);
  });

  it('терминальные локальные заявки getOrder не запрашивают', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    const canceled = openOrder('order-done', accountId).cancel('user');
    if (!canceled.ok) throw canceled.error;
    await runtime.commitOrder(accountId, canceled.value);
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId })).setOpenOrders([]);

    const pass = await runtime.reconciler.reconcile(VENUE, accountId);

    expect(pass.ok).toBe(true);
    expect(runtime.source.calls.getOrder).toBe(0);
  });

  it('отказ getOrder → Err(SourceError) с заявкой, коррекции нет', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    await runtime.commitOrder(accountId, openOrder('order-123', accountId));
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId })).setOpenOrders([]);
    runtime.source.fail('getOrder');

    const pass = await runtime.reconciler.reconcile(VENUE, accountId);

    const error = !pass.ok ? pass.error : undefined;
    expect(error).toBeInstanceOf(AccountReconciliationSourceError);
    expect((error as AccountReconciliationSourceError).operation).toBe('getOrder');
    expect((error as AccountReconciliationSourceError).orderId).toBe('order-123');
    expect(runtime.reconciledEvents).toHaveLength(0);
  });

  it('getOrder(X) вернул заявку Y → ValidationError ORDER_ID_MISMATCH, коррекции нет', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    await runtime.commitOrder(accountId, openOrder('order-123', accountId));
    // Источник «отвечает» чужой заявкой на вопрос про order-123.
    runtime.source
      .account(accountId)
      .setPortfolio(portfolio({ accountId }))
      .setOpenOrders([])
      .answerGetOrder('order-123' as never, openOrder('order-999', accountId));

    const pass = await runtime.reconciler.reconcile(VENUE, accountId);

    const error = !pass.ok ? pass.error : undefined;
    expect(error).toBeInstanceOf(AccountReconciliationValidationError);
    expect((error as AccountReconciliationValidationError).reason).toBe('ORDER_ID_MISMATCH');
    expect(runtime.reconciledEvents).toHaveLength(0);
  });

  it('в отказе перечислены ВСЕ неизвестные источнику заявки', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    await runtime.commitOrder(accountId, openOrder('order-a', accountId));
    await runtime.commitOrder(accountId, openOrder('order-b', accountId));
    const resolvedC = openOrder('order-c', accountId);
    await runtime.commitOrder(accountId, resolvedC);
    runtime.source
      .account(accountId)
      .setPortfolio(portfolio({ accountId }))
      .setOpenOrders([])
      .setOrder(resolvedC);

    const pass = await runtime.reconciler.reconcile(VENUE, accountId);

    const error = !pass.ok ? pass.error : undefined;
    expect(error).toBeInstanceOf(AccountReconciliationUnresolvedOrderError);
    expect((error as AccountReconciliationUnresolvedOrderError).orderIds).toEqual(['order-a', 'order-b']);
  });
});

describe('AccountReconciler: отказ canonical-пути', () => {
  it('состояние отвергло снимок → ValidationError CORRECTION_REJECTED с исходной ошибкой состояния', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    await runtime.initializeAccount(accountId);
    const stranger = walletAccount('0x9999999999999999999999999999999999999999');
    runtime.source.account(accountId).setPortfolio(portfolio({ accountId: stranger }));
    const versionBefore = versionOf(runtime.view, accountId);

    const pass = await runtime.reconciler.reconcile(VENUE, accountId);

    const error = !pass.ok ? pass.error : undefined;
    expect(error).toBeInstanceOf(AccountReconciliationValidationError);
    const validation = error as AccountReconciliationValidationError;
    expect(validation.reason).toBe('CORRECTION_REJECTED');
    expect(validation.originalError).toBeInstanceOf(AccountPortfolioIdentityMismatchError);
    expect(versionOf(runtime.view, accountId)).toBe(versionBefore);
  });
});
