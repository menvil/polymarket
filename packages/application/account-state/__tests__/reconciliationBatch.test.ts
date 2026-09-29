/**
 * `TRADING_ACCOUNT_RECONCILED` как batch-мутация: CAS, атомарность, одна
 * версия на событие, no-op.
 *
 * @remarks
 * Коррекция проверяется через НАСТОЯЩУЮ шину и critical-подписку проектора:
 * ошибка, которую увидит сверка, — это ровно то, что вернёт
 * `IEventBus.publish()`, а не прямой вызов состояния в обход контура.
 */
import { describe, expect, it } from '@jest/globals';
import {
  AccountIdentityMismatchError,
  AccountInstrumentResolutionError,
  AccountNotInitializedError,
  AccountPortfolioIdentityMismatchError,
  AccountReconciliationDuplicateEntryError,
  AccountReconciliationVersionConflictError,
  type AccountPortfolioIdentityField,
} from '../src/index.js';
import {
  UNRESOLVABLE_TOKEN,
  fill as makeFill,
  must,
  order,
  portfolio,
  walletAccount,
  withFill,
  type PortfolioOverrides,
} from './helpers/fixtures.js';
import { publishErr, publishOk } from './helpers/runtime.js';
import { accountOf, expectUnchanged, fingerprint, seedAccount } from './helpers/reconciliation.js';

describe('CAS: коррекция применяется только к той версии, на которой основан снимок', () => {
  it('current = 5, expected = 5 → коррекция применяется', async () => {
    const { bus, view, events, accountId } = await seedAccount();
    expect(accountOf(view, accountId).version).toBe(5);

    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolio({ accountId, available: 8_000, reserved: 740 }),
      }),
    );

    const account = accountOf(view, accountId);
    expect(account.version).toBe(6);
    expect(account.portfolio.balance.available().value().toNumber()).toBe(8_000);
  });

  it('current = 6, expected = 5 → конфликт версий и НОЛЬ мутаций', async () => {
    const { bus, view, events, accountId } = await seedAccount();

    // Живое событие продвигает аккаунт на 6, пока «снимок» основан на 5.
    const openC = must(order({ id: 'order-c', accountId, timestampMs: 1_700_000_060_000 }).accept());
    events.observeAt(5_000);
    await publishOk(
      bus,
      events.orderCommitted({
        accountId,
        order: openC,
        portfolio: portfolio({ accountId, available: 8_900, reserved: 840 }),
      }),
    );
    expect(accountOf(view, accountId).version).toBe(6);
    const before = fingerprint(view, accountId);

    events.observeAt(10_000);
    const error = await publishErr(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolio({ accountId, available: 1 }),
        orders: [must(order({ id: 'order-new', accountId }).accept())],
        fills: [makeFill({ id: 'fill-new', orderId: 'order-new', accountId })],
      }),
    );

    expect(error).toBeInstanceOf(AccountReconciliationVersionConflictError);
    const conflict = error as AccountReconciliationVersionConflictError;
    expect(conflict.expectedVersion).toBe(5);
    expect(conflict.actualVersion).toBe(6);
    expect(conflict.venueId).toBe('POLYMARKET');
    expect(conflict.accountId).toEqual(accountId);
    expect(conflict.severity).toBe('low');
    expectUnchanged(view, accountId, before);
  });

  it('CAS проверяется ДО содержимого: устаревший и вдобавок невалидный снимок — это конфликт', async () => {
    const { bus, view, events, accountId } = await seedAccount();
    const stranger = walletAccount('0x9999999999999999999999999999999999999999');
    const before = fingerprint(view, accountId);

    const error = await publishErr(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 4,
        portfolio: portfolio({ accountId: stranger }),
      }),
    );

    expect(error).toBeInstanceOf(AccountReconciliationVersionConflictError);
    expectUnchanged(view, accountId, before);
  });
});

describe('атомарность: весь снимок или ничего', () => {
  it('валидный портфель + валидная заявка A + невалидная заявка B + валидное исполнение → Err, ничего не записано', async () => {
    const { bus, view, events, accountId } = await seedAccount();
    const stranger = walletAccount('0x9999999999999999999999999999999999999999');
    const before = fingerprint(view, accountId);

    events.observeAt(10_000);
    const error = await publishErr(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolio({ accountId, available: 1_234 }),
        orders: [
          must(order({ id: 'order-valid', accountId }).accept()),
          must(order({ id: 'order-foreign', accountId: stranger }).accept()),
        ],
        fills: [makeFill({ id: 'fill-valid', orderId: 'order-valid', accountId })],
      }),
    );

    expect(error).toBeInstanceOf(AccountIdentityMismatchError);
    expect((error as AccountIdentityMismatchError).subject).toBe('ORDER_ACCOUNT');
    expectUnchanged(view, accountId, before);

    const account = accountOf(view, accountId);
    expect(account.getOrder('order-valid' as never)).toBeUndefined();
    expect(account.getFill('fill-valid' as never)).toBeUndefined();
    expect(account.portfolio.balance.available().value().toNumber()).toBe(9_000);
  });

  it('невалидное исполнение в хвосте снимка отвергает и уже проверенные заявки', async () => {
    const { bus, view, events, accountId, orderB } = await seedAccount();
    const before = fingerprint(view, accountId);

    const error = await publishErr(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolio({ accountId, available: 1_234 }),
        orders: [must(orderB.cancel('venue'))],
        fills: [makeFill({ id: 'fill-bad', accountId, tokenId: UNRESOLVABLE_TOKEN })],
      }),
    );

    expect(error).toBeInstanceOf(AccountInstrumentResolutionError);
    expect((error as AccountInstrumentResolutionError).subject).toBe('FILL_TOKEN');
    expectUnchanged(view, accountId, before);
    expect(accountOf(view, accountId).getOrder(orderB.id)?.order.status).toBe('OPEN');
  });

  it('коррекция неизвестного аккаунта отвергается', async () => {
    const { bus, view, events } = await seedAccount();
    const unknown = walletAccount('0x7777777777777777777777777777777777777777');
    const globalBefore = view.getVersion();

    const error = await publishErr(
      bus,
      events.reconciled({
        accountId: unknown,
        expectedAccountVersion: 1,
        portfolio: portfolio({ accountId: unknown }),
      }),
    );

    expect(error).toBeInstanceOf(AccountNotInitializedError);
    expect(view.getAccount('POLYMARKET' as never, unknown)).toBeUndefined();
    expect(view.getVersion()).toBe(globalBefore);
  });

  it('коррекция чужой площадки не находит аккаунт', async () => {
    const { bus, view, events, accountId } = await seedAccount();
    const before = fingerprint(view, accountId);

    const error = await publishErr(
      bus,
      events.reconciled({
        venueId: 'KALSHI' as never,
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolio({ accountId }),
      }),
    );

    expect(error).toBeInstanceOf(AccountNotInitializedError);
    expectUnchanged(view, accountId, before);
  });

  it.each<[AccountPortfolioIdentityField, PortfolioOverrides]>([
    ['accountId', { accountId: walletAccount('0x9999999999999999999999999999999999999999') }],
    ['balanceVenueId', { accountId: walletAccount(), balanceVenueId: 'KALSHI' as never }],
  ])('портфель с чужим %s отвергается целиком', async (field, overrides) => {
    // `balanceAccountId` отдельно не проверяется: `Portfolio.create` сам
    // отвергает баланс чужого владельца, и такой портфель до события не доходит.
    const { bus, view, events, accountId } = await seedAccount();
    const before = fingerprint(view, accountId);

    const error = await publishErr(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: 5, portfolio: portfolio(overrides) }),
    );

    expect(error).toBeInstanceOf(AccountPortfolioIdentityMismatchError);
    expect((error as AccountPortfolioIdentityMismatchError).field).toBe(field);
    expectUnchanged(view, accountId, before);
  });

  it.each(['ORDER', 'FILL'] as const)(
    'повтор %s под одним идентификатором отвергает снимок',
    async (kind) => {
      const { bus, view, events, accountId, orderB, fillA } = await seedAccount();
      const before = fingerprint(view, accountId);

      const error = await publishErr(
        bus,
        events.reconciled({
          accountId,
          expectedAccountVersion: 5,
          portfolio: portfolio({ accountId }),
          ...(kind === 'ORDER' ? { orders: [orderB, orderB] } : { fills: [fillA, fillA] }),
        }),
      );

      expect(error).toBeInstanceOf(AccountReconciliationDuplicateEntryError);
      expect((error as AccountReconciliationDuplicateEntryError).kind).toBe(kind);
      expectUnchanged(view, accountId, before);
    },
  );
});

describe('одна коррекция — одна мутация', () => {
  it('портфель + 2 заявки + 3 исполнения → account.version +1 и global version +1 ровно', async () => {
    const { bus, view, events, accountId, orderA, orderB, fillA } = await seedAccount();
    const globalBefore = view.getVersion();
    const accountBefore = accountOf(view, accountId).version;

    const filledA = withFill(orderA, { id: 'fill-a2', size: 60 });
    const canceledB = must(orderB.cancel('venue'));
    const fillA2 = makeFill({ id: 'fill-a2', orderId: 'order-a', accountId, size: 60 });
    const fillX = makeFill({ id: 'fill-x', orderId: 'order-x', accountId, size: 5 });

    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolio({ accountId, available: 9_100, reserved: 0 }),
        orders: [filledA, canceledB],
        fills: [fillA, fillA2, fillX],
      }),
    );

    const account = accountOf(view, accountId);
    expect(account.version).toBe(accountBefore + 1);
    expect(view.getVersion()).toBe(globalBefore + 1);
    expect(account.lastMutationAt.toNumber()).toBe(10_000);

    expect(account.portfolio.balance.available().value().toNumber()).toBe(9_100);
    expect(account.getOrder(orderA.id)?.order.status).toBe('FILLED');
    expect(account.getOrder(orderB.id)?.order.status).toBe('CANCELED');
    expect(account.getOrder(orderA.id)?.updatedAt.toNumber()).toBe(10_000);
    expect(account.getOrder(orderB.id)?.updatedAt.toNumber()).toBe(10_000);
    expect(account.fills().map((record) => [record.fill.id, record.status])).toEqual([
      ['fill-a', 'CONFIRMED'],
      ['fill-a2', 'CONFIRMED'],
      ['fill-x', 'CONFIRMED'],
    ]);
  });
});

describe('no-op: коррекция, ничего не изменившая, не является мутацией', () => {
  it('тот же портфель (новым объектом), те же заявки, то же подтверждённое исполнение → версии и время не меняются', async () => {
    const { bus, view, events, accountId, orderA, orderB, fillA } = await seedAccount();

    // Первая коррекция подтверждает исполнение — это настоящее изменение.
    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolio({ accountId, available: 9_000, reserved: 740 }),
        orders: [orderA, orderB],
        fills: [fillA],
      }),
    );
    expect(accountOf(view, accountId).version).toBe(6);
    const before = fingerprint(view, accountId);

    // Вторая — тот же снимок, собранный заново: равен по содержимому, но не
    // по ссылкам.
    events.observeAt(20_000);
    await publishOk(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 6,
        portfolio: portfolio({ accountId, available: 9_000, reserved: 740 }),
        orders: [orderA, orderB],
        fills: [makeFill({ id: 'fill-a', orderId: 'order-a', accountId, size: 40 })],
      }),
    );

    expectUnchanged(view, accountId, before);
    expect(accountOf(view, accountId).lastMutationAt.toNumber()).toBe(10_000);
  });

  it('пустой снимок с тем же портфелем → no-op', async () => {
    const { bus, view, events, accountId } = await seedAccount();
    const before = fingerprint(view, accountId);

    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolio({ accountId, available: 9_000, reserved: 740 }),
      }),
    );

    expectUnchanged(view, accountId, before);
  });

  it('изменился только портфель → одна мутация, записи заявок и исполнений не переписаны', async () => {
    const { bus, view, events, accountId } = await seedAccount();
    const before = fingerprint(view, accountId);

    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolio({ accountId, available: 9_001, reserved: 740 }),
      }),
    );

    const account = accountOf(view, accountId);
    expect(account.version).toBe(6);
    expect(account.portfolio).not.toBe(before.portfolio);
    for (const record of account.orders()) {
      expect(before.orders.get(record.order.id)).toBe(record);
    }
    for (const record of account.fills()) {
      expect(before.fills.get(record.fill.id)).toBe(record);
    }
  });
});
