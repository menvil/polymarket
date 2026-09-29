/**
 * Семантика заявок в `TRADING_ACCOUNT_RECONCILED`: upsert, а не replace.
 *
 * @remarks
 * Коррекция — граница исправления: переход заявки она не проверяет и живой
 * FSM не повторяет. Проверяется только согласованность — владелец,
 * инструмент, неизменяемая идентичность.
 */
import { describe, expect, it } from '@jest/globals';
import {
  AccountIdentityMismatchError,
  AccountInstrumentResolutionError,
  AccountOrderAccountMissingError,
  AccountOrderIdentityConflictError,
} from '../src/index.js';
import {
  DOWN_TOKEN,
  UNRESOLVABLE_TOKEN,
  must,
  order,
  portfolio,
  strategyId,
  walletAccount,
  withFill,
  type OrderOverrides,
} from './helpers/fixtures.js';
import { publishErr, publishOk } from './helpers/runtime.js';
import { accountOf, expectUnchanged, fingerprint, seedAccount } from './helpers/reconciliation.js';

describe('заявки коррекции', () => {
  it('неизвестная authoritative-заявка вставляется', async () => {
    const { bus, view, events, accountId, portfolioAfter } = await seedAccount();
    const unknown = must(order({ id: 'order-venue', accountId, timestampMs: 1_700_000_070_000 }).accept());

    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: 5, portfolio: portfolioAfter, orders: [unknown] }),
    );

    const account = accountOf(view, accountId);
    const record = account.getOrder(unknown.id);
    expect(record?.order).toBe(unknown);
    expect(record?.updatedAt.toNumber()).toBe(10_000);
    expect(account.openOrders().map((r) => r.order.id)).toContain(unknown.id);
    expect(account.version).toBe(6);
  });

  it('та же идентичность и то же состояние → no-op', async () => {
    const { bus, view, events, accountId, orderA, orderB, portfolioAfter } = await seedAccount();
    const before = fingerprint(view, accountId);

    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolioAfter,
        orders: [orderA, orderB],
      }),
    );

    expectUnchanged(view, accountId, before);
  });

  it('та же идентичность, другое состояние (OPEN → CANCELED) → authoritative-заявка заменяет сохранённую', async () => {
    const { bus, view, events, accountId, orderB, portfolioAfter } = await seedAccount();
    const canceled = must(orderB.cancel('venue'));

    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: 5, portfolio: portfolioAfter, orders: [canceled] }),
    );

    const record = accountOf(view, accountId).getOrder(orderB.id);
    expect(record?.order).toBe(canceled);
    expect(record?.updatedAt.toNumber()).toBe(10_000);
  });

  it('та же идентичность, другое состояние (OPEN → PARTIALLY_FILLED) → заменяет', async () => {
    const { bus, view, events, accountId, orderB, portfolioAfter } = await seedAccount();
    const partial = withFill(orderB, { id: 'fill-b', size: 10 });
    expect(partial.status).toBe('PARTIALLY_FILLED');

    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: 5, portfolio: portfolioAfter, orders: [partial] }),
    );

    expect(accountOf(view, accountId).getOrder(orderB.id)?.order).toBe(partial);
  });

  it('PARTIALLY_FILLED → FILLED заменяет заявку, даже если исполнения в снимке нет', async () => {
    const { bus, view, events, accountId, orderA, portfolioAfter } = await seedAccount();
    const filled = withFill(orderA, { id: 'fill-a2', size: 60 });
    expect(filled.status).toBe('FILLED');

    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: 5, portfolio: portfolioAfter, orders: [filled] }),
    );

    const account = accountOf(view, accountId);
    expect(account.getOrder(orderA.id)?.order.status).toBe('FILLED');
    expect(account.openOrders().map((r) => r.order.id)).not.toContain(orderA.id);
  });

  it.each<[string, OrderOverrides]>([
    ['asset', { asset: DOWN_TOKEN }],
    ['size', { size: 150 }],
    ['price', { price: 0.66 }],
    ['side', { side: 'SELL' }],
    ['timestamp', { timestampMs: 1_700_000_000_001 }],
    ['strategyId', { strategyId: strategyId('other-strategy') }],
  ])('тот же OrderId с другим %s → конфликт идентичности, ничего не записано', async (field, overrides) => {
    const { bus, view, events, accountId, orderA } = await seedAccount();
    const before = fingerprint(view, accountId);
    const impostor = must(order({ id: orderA.id, accountId, ...overrides }).accept());

    // Портфель в снимке ИЗМЕНЁН: отказ обязан отменить и его.
    const error = await publishErr(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolio({ accountId, available: 1 }),
        orders: [impostor],
      }),
    );

    expect(error).toBeInstanceOf(AccountOrderIdentityConflictError);
    expect((error as AccountOrderIdentityConflictError).difference.field).toBe(field);
    expectUnchanged(view, accountId, before);
  });

  it('заявка другого аккаунта → Err', async () => {
    const { bus, view, events, accountId, portfolioAfter } = await seedAccount();
    const before = fingerprint(view, accountId);
    const foreign = must(
      order({ id: 'order-foreign', accountId: walletAccount('0x9999999999999999999999999999999999999999') }).accept(),
    );

    const error = await publishErr(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: 5, portfolio: portfolioAfter, orders: [foreign] }),
    );

    expect(error).toBeInstanceOf(AccountIdentityMismatchError);
    expect((error as AccountIdentityMismatchError).subject).toBe('ORDER_ACCOUNT');
    expectUnchanged(view, accountId, before);
  });

  it('заявка без владельца → Err', async () => {
    const { bus, view, events, accountId, portfolioAfter } = await seedAccount();
    const before = fingerprint(view, accountId);
    const ownerless = must(order({ id: 'order-ownerless', accountId: null }).accept());

    const error = await publishErr(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: 5, portfolio: portfolioAfter, orders: [ownerless] }),
    );

    expect(error).toBeInstanceOf(AccountOrderAccountMissingError);
    expectUnchanged(view, accountId, before);
  });

  it('неразрешимый актив заявки → Err', async () => {
    const { bus, view, events, accountId, portfolioAfter } = await seedAccount();
    const before = fingerprint(view, accountId);
    const unresolvable = must(order({ id: 'order-x', accountId, asset: UNRESOLVABLE_TOKEN }).accept());

    const error = await publishErr(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: 5, portfolio: portfolioAfter, orders: [unresolvable] }),
    );

    expect(error).toBeInstanceOf(AccountInstrumentResolutionError);
    expect((error as AccountInstrumentResolutionError).subject).toBe('ORDER_ASSET');
    expectUnchanged(view, accountId, before);
  });

  it('заявки, не упомянутые в коррекции, остаются историей', async () => {
    const { bus, view, events, accountId, orderA, orderB, portfolioAfter } = await seedAccount();
    const storedA = accountOf(view, accountId).getOrder(orderA.id);

    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolioAfter,
        orders: [must(orderB.cancel('venue'))],
      }),
    );

    const account = accountOf(view, accountId);
    expect(account.getOrder(orderA.id)).toBe(storedA);
    expect(account.orders().map((r) => r.order.id)).toEqual([orderA.id, orderB.id]);
  });
});
