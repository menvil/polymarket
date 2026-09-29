/**
 * Семантика исполнений в `TRADING_ACCOUNT_RECONCILED`.
 *
 * @remarks
 * Коррекция работает с осью РАНТАЙМА (`APPLIED → CONFIRMED | REVERTED`), а не
 * с venue-осью (`TradeStatus`): присутствие исполнения у authoritative-
 * источника подтверждает его существование на площадке.
 */
import { describe, expect, it } from '@jest/globals';
import {
  AccountFillIdentityConflictError,
  AccountFillTransitionError,
  AccountIdentityMismatchError,
  AccountInstrumentResolutionError,
} from '../src/index.js';
import {
  OTHER_VENUE,
  UNRESOLVABLE_TOKEN,
  fill as makeFill,
  portfolio,
  walletAccount,
  type FillOverrides,
} from './helpers/fixtures.js';
import { publishErr, publishOk } from './helpers/runtime.js';
import { accountOf, expectUnchanged, fingerprint, seedAccount } from './helpers/reconciliation.js';

describe('исполнения коррекции', () => {
  it('новое authoritative-исполнение записывается сразу CONFIRMED, appliedAt = confirmedAt = время коррекции', async () => {
    const { bus, view, events, accountId, portfolioAfter } = await seedAccount();
    const missed = makeFill({ id: 'fill-missed', orderId: 'order-b', accountId, size: 10 });

    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: 5, portfolio: portfolioAfter, fills: [missed] }),
    );

    const record = accountOf(view, accountId).getFill(missed.id);
    expect(record?.fill).toBe(missed);
    expect(record?.status).toBe('CONFIRMED');
    expect(record?.appliedAt.toNumber()).toBe(10_000);
    expect(record?.confirmedAt?.toNumber()).toBe(10_000);
    // Venue-ось коррекция не придумывает.
    expect(record?.venueStatus).toBeUndefined();
    expect(record?.venueStatusAt).toBeUndefined();
    expect(record?.revertedAt).toBeUndefined();
  });

  it('APPLIED + тот же факт → CONFIRMED, исходный appliedAt сохранён, confirmedAt = время коррекции', async () => {
    const { bus, view, events, accountId, fillA, portfolioAfter } = await seedAccount();
    expect(accountOf(view, accountId).getFill(fillA.id)?.status).toBe('APPLIED');

    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolioAfter,
        // Тот же факт, собранный заново — новый объект.
        fills: [makeFill({ id: 'fill-a', orderId: 'order-a', accountId, size: 40 })],
      }),
    );

    const record = accountOf(view, accountId).getFill(fillA.id);
    expect(record?.status).toBe('CONFIRMED');
    expect(record?.appliedAt.toNumber()).toBe(3_000);
    expect(record?.confirmedAt?.toNumber()).toBe(10_000);
    expect(record?.fill).toBe(fillA);
  });

  it('venue-ось (venueStatus, venueStatusAt) переносится как есть', async () => {
    const { bus, view, events, accountId, fillA, portfolioAfter } = await seedAccount();
    const before = accountOf(view, accountId).getFill(fillA.id);
    expect(before?.venueStatus).toBe('MATCHED');
    expect(before?.venueStatusAt?.toNumber()).toBe(3_500);

    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: 5, portfolio: portfolioAfter, fills: [fillA] }),
    );

    const after = accountOf(view, accountId).getFill(fillA.id);
    expect(after?.status).toBe('CONFIRMED');
    expect(after?.venueStatus).toBe('MATCHED');
    expect(after?.venueStatusAt?.toNumber()).toBe(3_500);
  });

  it('CONFIRMED + тот же факт → no-op', async () => {
    const { bus, view, events, accountId, fillA, portfolioAfter } = await seedAccount();
    events.observeAt(6_000);
    await publishOk(bus, events.fillConfirmed({ fill: fillA }));
    expect(accountOf(view, accountId).version).toBe(6);
    const before = fingerprint(view, accountId);

    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: 6, portfolio: portfolioAfter, fills: [fillA] }),
    );

    expectUnchanged(view, accountId, before);
    expect(accountOf(view, accountId).getFill(fillA.id)?.confirmedAt?.toNumber()).toBe(6_000);
  });

  it('REVERTED, но источник говорит, что исполнение существует → Err, ничего не записано', async () => {
    const { bus, view, events, accountId, fillA } = await seedAccount();
    events.observeAt(6_000);
    await publishOk(
      bus,
      events.fillReverted({ fill: fillA, portfolio: portfolio({ accountId, available: 9_000, reserved: 1_000 }) }),
    );
    const before = fingerprint(view, accountId);

    const error = await publishErr(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 6,
        portfolio: portfolio({ accountId, available: 5 }),
        fills: [fillA],
      }),
    );

    expect(error).toBeInstanceOf(AccountFillTransitionError);
    const transition = error as AccountFillTransitionError;
    expect(transition.current).toBe('REVERTED');
    expect(transition.target).toBe('CONFIRMED');
    expectUnchanged(view, accountId, before);
    expect(accountOf(view, accountId).getFill(fillA.id)?.status).toBe('REVERTED');
  });

  it.each<[string, FillOverrides]>([
    ['price', { price: 0.66 }],
    ['size', { size: 41 }],
    ['side', { side: 'SELL' }],
    ['timestamp', { timestampMs: 1_700_000_100_001 }],
    ['fee', { fee: 0.07 }],
    ['orderId', { orderId: 'order-b' }],
  ])('тот же FillId с другим %s → конфликт факта, ничего не записано', async (field, overrides) => {
    const { bus, view, events, accountId } = await seedAccount();
    const before = fingerprint(view, accountId);
    const impostor = makeFill({ id: 'fill-a', orderId: 'order-a', accountId, size: 40, ...overrides });

    const error = await publishErr(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolio({ accountId, available: 5 }),
        fills: [impostor],
      }),
    );

    expect(error).toBeInstanceOf(AccountFillIdentityConflictError);
    const conflict = error as AccountFillIdentityConflictError;
    expect(conflict.difference.field).toBe(field);
    expect(conflict.action).toBe('RECONCILE');
    expectUnchanged(view, accountId, before);
  });

  it('исполнение другого аккаунта → Err FILL_ACCOUNT', async () => {
    const { bus, view, events, accountId, portfolioAfter } = await seedAccount();
    const before = fingerprint(view, accountId);
    const foreign = makeFill({
      id: 'fill-foreign',
      accountId: walletAccount('0x9999999999999999999999999999999999999999'),
    });

    const error = await publishErr(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: 5, portfolio: portfolioAfter, fills: [foreign] }),
    );

    expect(error).toBeInstanceOf(AccountIdentityMismatchError);
    expect((error as AccountIdentityMismatchError).subject).toBe('FILL_ACCOUNT');
    expectUnchanged(view, accountId, before);
  });

  it('исполнение другой площадки → Err FILL_VENUE', async () => {
    const { bus, view, events, accountId, portfolioAfter } = await seedAccount();
    const before = fingerprint(view, accountId);
    const foreign = makeFill({ id: 'fill-kalshi', accountId, venueId: OTHER_VENUE });

    const error = await publishErr(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: 5, portfolio: portfolioAfter, fills: [foreign] }),
    );

    expect(error).toBeInstanceOf(AccountIdentityMismatchError);
    expect((error as AccountIdentityMismatchError).subject).toBe('FILL_VENUE');
    expectUnchanged(view, accountId, before);
  });

  it('неразрешимый токен исполнения → Err', async () => {
    const { bus, view, events, accountId, portfolioAfter } = await seedAccount();
    const before = fingerprint(view, accountId);

    const error = await publishErr(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolioAfter,
        fills: [makeFill({ id: 'fill-x', accountId, tokenId: UNRESOLVABLE_TOKEN })],
      }),
    );

    expect(error).toBeInstanceOf(AccountInstrumentResolutionError);
    expect((error as AccountInstrumentResolutionError).subject).toBe('FILL_TOKEN');
    expectUnchanged(view, accountId, before);
  });

  it('исполнения, не упомянутые в коррекции, остаются как были', async () => {
    const { bus, view, events, accountId, fillA, portfolioAfter } = await seedAccount();
    const storedA = accountOf(view, accountId).getFill(fillA.id);

    events.observeAt(10_000);
    await publishOk(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: 5,
        portfolio: portfolioAfter,
        fills: [makeFill({ id: 'fill-other', orderId: 'order-b', accountId, size: 5 })],
      }),
    );

    const account = accountOf(view, accountId);
    expect(account.getFill(fillA.id)).toBe(storedA);
    expect(account.fillsForOrder('order-b' as never).map((r) => r.fill.id)).toEqual(['fill-other']);
  });
});
