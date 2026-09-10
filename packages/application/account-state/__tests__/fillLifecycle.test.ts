/**
 * Жизненный цикл исполнения: `APPLIED → CONFIRMED` и `APPLIED → REVERTED`.
 *
 * @remarks
 * Метки `R`…`AG` соответствуют плану MR. Два теста здесь важнее остальных:
 * `X` (повторный APPLY со старым портфелем не откатывает деньги) и `AF`
 * (`CONFIRMED → REVERTED` запрещён — финальность на то и финальность).
 */
import { describe, expect, it } from '@jest/globals';
import type { Fill } from '@polymarket/fill';
import {
  AccountFillIdentityConflictError,
  AccountFillNotFoundError,
  AccountFillOrderLinkError,
  AccountFillTransitionError,
  AccountIdentityMismatchError,
  AccountInstrumentResolutionError,
  AccountNotInitializedError,
  AccountOrderAccountMissingError,
  AccountOrderIdentityConflictError,
  type AccountFillFactField,
} from '../src/index.js';
import {
  DOWN_TOKEN,
  OTHER_VENUE,
  UNRESOLVABLE_TOKEN,
  VENUE,
  fill as makeFill,
  must,
  order,
  portfolio,
  ts,
  walletAccount,
  withFill,
} from './helpers/fixtures.js';
import { buildRuntime, publishErr, publishOk } from './helpers/runtime.js';
import type { AccountRuntime } from './helpers/runtime.js';

/** Инструмент, в который превращается `UP_TOKEN`. */
const UP_INSTRUMENT = '100000000000000000000000000000000000000000000001' as never;

/** Чужой кошелёк для проверок владения. */
const STRANGER = '0x9999999999999999999999999999999999999999';

/** Рантайм с уже инициализированным аккаунтом. */
async function withAccount(available = 10_000): Promise<AccountRuntime & {
  accountId: ReturnType<typeof walletAccount>;
}> {
  const runtime = buildRuntime();
  const accountId = walletAccount();
  runtime.events.observeAt(1_000);
  await publishOk(
    runtime.bus,
    runtime.events.initialized({ accountId, portfolio: portfolio({ accountId, available }) }),
  );
  return { ...runtime, accountId };
}

describe('R. применение исполнения без заявки в payload', () => {
  it('сохраняет исполнение и портфель, заявку не создаёт', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const fill = makeFill({ accountId });
    const after = portfolio({ accountId, available: 9_974, reserved: 0 });

    events.observeAt(2_000);
    await publishOk(bus, events.fillApplied({ fill, portfolio: after }));

    const account = view.getAccount(VENUE, accountId);
    const record = account?.getFill(fill.id);
    expect(record?.fill).toBe(fill);
    expect(record?.status).toBe('APPLIED');
    expect(record?.appliedAt.equals(ts(2_000))).toBe(true);
    expect(record?.confirmedAt).toBeUndefined();
    expect(record?.revertedAt).toBeUndefined();
    expect(account?.portfolio).toBe(after);
    expect(account?.orders()).toHaveLength(0);
    expect(account?.fillsForOrder(fill.orderId)).toHaveLength(1);
    expect(account?.fillsForInstrument(UP_INSTRUMENT)).toHaveLength(1);
    expect(account?.version).toBe(2);
    expect(view.getVersion()).toBe(2);
  });
});

describe('S. применение исполнения вместе с заявкой', () => {
  it('исполнение, заявка, портфель и все индексы обновляются одной мутацией', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const open = must(order({ accountId }).accept());
    events.observeAt(2_000);
    await publishOk(
      bus,
      events.orderCommitted({
        accountId,
        order: open,
        portfolio: portfolio({ accountId, available: 9_350, reserved: 650 }),
      }),
    );

    const fill = makeFill({ accountId, orderId: open.id, size: 40 });
    const partially = withFill(open, { id: fill.id, size: 40 });
    const after = portfolio({ accountId, available: 9_350, reserved: 390 });

    events.observeAt(3_000);
    await publishOk(bus, events.fillApplied({ fill, portfolio: after, order: partially }));

    const account = view.getAccount(VENUE, accountId);
    expect(account?.getFill(fill.id)?.status).toBe('APPLIED');
    expect(account?.getOrder(open.id)?.order.status).toBe('PARTIALLY_FILLED');
    expect(account?.getOrder(open.id)?.updatedAt.equals(ts(3_000))).toBe(true);
    expect(account?.portfolio).toBe(after);
    expect(account?.fillsForOrder(open.id).map((r) => r.fill.id)).toEqual([fill.id]);
    expect(account?.fillsForInstrument(UP_INSTRUMENT)).toHaveLength(1);
    expect(account?.ordersForInstrument(UP_INSTRUMENT)).toHaveLength(1);
    // Одна мутация, а не четыре: считается принятое событие.
    expect(account?.version).toBe(3);
    expect(view.getVersion()).toBe(3);
  });
});

describe('T–V. связь заявки и исполнения внутри одного события', () => {
  it('T. order.id не совпадает с fill.orderId — отказ без мутации', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const fill = makeFill({ accountId, orderId: 'order-1' });
    events.observeAt(2_000);

    const error = await publishErr(
      bus,
      events.fillApplied({
        fill,
        portfolio: portfolio({ accountId, available: 1 }),
        order: order({ id: 'order-2', accountId }),
      }),
    );

    expect(error).toBeInstanceOf(AccountFillOrderLinkError);
    expect((error as AccountFillOrderLinkError).field).toBe('orderId');
    expectUntouched(view, accountId);
  });

  it('U. владелец заявки не совпадает с владельцем исполнения — отказ', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const fill = makeFill({ accountId });
    events.observeAt(2_000);

    const error = await publishErr(
      bus,
      events.fillApplied({
        fill,
        portfolio: portfolio({ accountId, available: 1 }),
        order: order({ accountId: walletAccount(STRANGER) }),
      }),
    );

    expect(error).toBeInstanceOf(AccountIdentityMismatchError);
    expect((error as AccountIdentityMismatchError).subject).toBe('FILL_ORDER_ACCOUNT');
    expectUntouched(view, accountId);
  });

  it('V. order.asset не совпадает с fill.tokenId — отказ', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const fill = makeFill({ accountId });
    events.observeAt(2_000);

    const error = await publishErr(
      bus,
      events.fillApplied({
        fill,
        portfolio: portfolio({ accountId, available: 1 }),
        order: order({ accountId, asset: DOWN_TOKEN }),
      }),
    );

    expect(error).toBeInstanceOf(AccountFillOrderLinkError);
    expect((error as AccountFillOrderLinkError).field).toBe('asset');
    expectUntouched(view, accountId);
  });

  it('заявка без владельца рядом с исполнением отвергается', async () => {
    const { bus, view, events, accountId } = await withAccount();
    events.observeAt(2_000);

    const error = await publishErr(
      bus,
      events.fillApplied({
        fill: makeFill({ accountId }),
        portfolio: portfolio({ accountId, available: 1 }),
        order: order({ accountId: null }),
      }),
    );

    expect(error).toBeInstanceOf(AccountOrderAccountMissingError);
    expectUntouched(view, accountId);
  });

  it('заявка с конфликтующей идентичностью рядом с исполнением отвергается', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const open = must(order({ accountId }).accept());
    const afterCommit = portfolio({ accountId, available: 9_350, reserved: 650 });

    events.observeAt(2_000);
    await publishOk(bus, events.orderCommitted({ accountId, order: open, portfolio: afterCommit }));

    events.observeAt(3_000);
    // Тот же OrderId, но другой объём — это ДРУГАЯ заявка, и применять
    // исполнение вместе с ней нельзя, даже если само исполнение новое.
    const error = await publishErr(
      bus,
      events.fillApplied({
        fill: makeFill({ id: 'fill-new', accountId, orderId: open.id }),
        portfolio: portfolio({ accountId, available: 1 }),
        order: must(order({ accountId, size: 250 }).accept()),
      }),
    );

    expect(error).toBeInstanceOf(AccountOrderIdentityConflictError);
    expect((error as AccountOrderIdentityConflictError).difference.field).toBe('size');
    const account = view.getAccount(VENUE, accountId);
    expect(account?.fills()).toHaveLength(0);
    expect(account?.getOrder(open.id)?.order).toBe(open);
    expect(account?.portfolio).toBe(afterCommit);
    expect(account?.version).toBe(2);
    expect(view.getVersion()).toBe(2);
  });

  it('токен исполнения, не приводимый к инструменту, отвергается', async () => {
    const { bus, view, events, accountId } = await withAccount();
    events.observeAt(2_000);

    const error = await publishErr(
      bus,
      events.fillApplied({
        fill: makeFill({ accountId, tokenId: UNRESOLVABLE_TOKEN }),
        portfolio: portfolio({ accountId, available: 1 }),
      }),
    );

    expect(error).toBeInstanceOf(AccountInstrumentResolutionError);
    expect((error as AccountInstrumentResolutionError).subject).toBe('FILL_TOKEN');
    expectUntouched(view, accountId);
  });
});

describe('W. исполнение по неизвестному аккаунту', () => {
  it('APPLY по неинициализированному аккаунту отвергается', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    events.observeAt(1_000);

    const error = await publishErr(
      bus,
      events.fillApplied({
        fill: makeFill({ accountId }),
        portfolio: portfolio({ accountId }),
      }),
    );

    expect(error).toBeInstanceOf(AccountNotInitializedError);
    expect(view.getVersion()).toBe(0);
  });

  it('исполнение чужой площадки не попадает в наш аккаунт', async () => {
    const { bus, view, events, accountId } = await withAccount();
    events.observeAt(2_000);

    // Аккаунт инициализирован на POLYMARKET; исполнение помечено KALSHI —
    // это другой торговый аккаунт, а не наш.
    const error = await publishErr(
      bus,
      events.fillApplied({
        fill: makeFill({ accountId, venueId: OTHER_VENUE }),
        portfolio: portfolio({ accountId, balanceVenueId: OTHER_VENUE }),
      }),
    );

    expect(error).toBeInstanceOf(AccountNotInitializedError);
    expectUntouched(view, accountId);
  });
});

describe('X. повторный APPLY со старым снимком не откатывает состояние', () => {
  it('дубликат — no-op: ни портфель, ни заявка из него не применяются', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const open = must(order({ accountId }).accept());
    events.observeAt(2_000);
    await publishOk(
      bus,
      events.orderCommitted({
        accountId,
        order: open,
        portfolio: portfolio({ accountId, available: 9_350, reserved: 650 }),
      }),
    );

    const fill = makeFill({ accountId, orderId: open.id, size: 40 });
    const partially = withFill(open, { id: fill.id, size: 40 });
    const afterFill = portfolio({ accountId, available: 9_350, reserved: 390 });

    events.observeAt(3_000);
    await publishOk(bus, events.fillApplied({ fill, portfolio: afterFill, order: partially }));

    events.observeAt(4_000);
    // Повторная доставка: тот же факт, но снимки в payload отстали на шаг —
    // заявка ещё OPEN, а резервация ещё полная.
    await publishOk(
      bus,
      events.fillApplied({
        fill: makeFill({ accountId, orderId: open.id, size: 40 }),
        portfolio: portfolio({ accountId, available: 9_350, reserved: 650 }),
        order: open,
      }),
    );

    const account = view.getAccount(VENUE, accountId);
    expect(account?.portfolio).toBe(afterFill);
    expect(account?.portfolio.balance.reserved().value().toNumber()).toBe(390);
    expect(account?.getOrder(open.id)?.order.status).toBe('PARTIALLY_FILLED');
    expect(account?.getFill(fill.id)?.appliedAt.equals(ts(3_000))).toBe(true);
    expect(account?.version).toBe(3);
    expect(view.getVersion()).toBe(3);
    expect(account?.lastMutationAt.equals(ts(3_000))).toBe(true);
    // Индексы не удваиваются.
    expect(account?.fillsForOrder(open.id)).toHaveLength(1);
    expect(account?.fillsForInstrument(UP_INSTRUMENT)).toHaveLength(1);
  });
});

describe('Y. тот же FillId с другим фактом — конфликт', () => {
  /** Способы подменить факт исполнения под тем же `FillId`. */
  const conflicts: ReadonlyArray<{
    field: AccountFillFactField;
    make: (accountId: ReturnType<typeof walletAccount>) => Fill;
  }> = [
    { field: 'size', make: (a) => makeFill({ accountId: a, size: 41 }) },
    { field: 'price', make: (a) => makeFill({ accountId: a, price: 0.7 }) },
    { field: 'marketId', make: (a) => makeFill({ accountId: a, marketId: 'market-other' as never }) },
    { field: 'side', make: (a) => makeFill({ accountId: a, side: 'SELL' }) },
    { field: 'orderId', make: (a) => makeFill({ accountId: a, orderId: 'order-99' }) },
    { field: 'tokenId', make: (a) => makeFill({ accountId: a, tokenId: DOWN_TOKEN }) },
    { field: 'fee', make: (a) => makeFill({ accountId: a, fee: 0.07 }) },
    { field: 'timestamp', make: (a) => makeFill({ accountId: a, timestampMs: 1_700_000_200_000 }) },
  ];

  it.each(conflicts)('$field изменился — Err без мутации', async ({ field, make }) => {
    const { bus, view, events, accountId } = await withAccount();
    const applied = makeFill({ accountId });
    const afterApply = portfolio({ accountId, available: 9_974 });

    events.observeAt(2_000);
    await publishOk(bus, events.fillApplied({ fill: applied, portfolio: afterApply }));

    events.observeAt(3_000);
    const error = await publishErr(
      bus,
      events.fillApplied({
        fill: make(accountId),
        portfolio: portfolio({ accountId, available: 1 }),
      }),
    );

    expect(error).toBeInstanceOf(AccountFillIdentityConflictError);
    expect((error as AccountFillIdentityConflictError).difference.field).toBe(field);
    expect((error as AccountFillIdentityConflictError).action).toBe('APPLY');

    const account = view.getAccount(VENUE, accountId);
    expect(account?.getFill(applied.id)?.fill).toBe(applied);
    expect(account?.portfolio).toBe(afterApply);
    expect(account?.version).toBe(2);
    expect(view.getVersion()).toBe(2);
    expect(account?.lastMutationAt.equals(ts(2_000))).toBe(true);
  });
});

describe('Z. подтверждение исполнения', () => {
  it('APPLIED → CONFIRMED меняет только статус и время', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const fill = makeFill({ accountId });
    const afterApply = portfolio({ accountId, available: 9_974 });

    events.observeAt(2_000);
    await publishOk(bus, events.fillApplied({ fill, portfolio: afterApply }));

    events.observeAt(2_800);
    await publishOk(bus, events.fillConfirmed({ fill }));

    const account = view.getAccount(VENUE, accountId);
    const record = account?.getFill(fill.id);
    expect(record?.status).toBe('CONFIRMED');
    expect(record?.confirmedAt?.equals(ts(2_800))).toBe(true);
    expect(record?.appliedAt.equals(ts(2_000))).toBe(true);
    expect(record?.fill).toBe(fill);
    // Портфель не тронут: экономика применена раньше.
    expect(account?.portfolio).toBe(afterApply);
    expect(account?.version).toBe(3);
    expect(view.getVersion()).toBe(3);
  });
});

describe('AA–AC. границы подтверждения', () => {
  it('AA. повторное подтверждение — no-op', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const fill = makeFill({ accountId });
    events.observeAt(2_000);
    await publishOk(bus, events.fillApplied({ fill, portfolio: portfolio({ accountId }) }));
    events.observeAt(2_800);
    await publishOk(bus, events.fillConfirmed({ fill }));

    events.observeAt(3_500);
    await publishOk(bus, events.fillConfirmed({ fill: makeFill({ accountId }) }));

    const account = view.getAccount(VENUE, accountId);
    expect(account?.getFill(fill.id)?.confirmedAt?.equals(ts(2_800))).toBe(true);
    expect(account?.version).toBe(3);
    expect(view.getVersion()).toBe(3);
    expect(account?.lastMutationAt.equals(ts(2_800))).toBe(true);
  });

  it('AB. подтверждение неизвестного исполнения не создаёт запись', async () => {
    const { bus, view, events, accountId } = await withAccount();
    events.observeAt(2_000);

    const error = await publishErr(bus, events.fillConfirmed({ fill: makeFill({ accountId }) }));

    expect(error).toBeInstanceOf(AccountFillNotFoundError);
    expect((error as AccountFillNotFoundError).action).toBe('CONFIRM');
    const account = view.getAccount(VENUE, accountId);
    expect(account?.fills()).toHaveLength(0);
    expect(account?.version).toBe(1);
    expect(view.getVersion()).toBe(1);
  });

  it('подтверждение по неизвестному аккаунту отвергается', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    events.observeAt(1_000);

    const error = await publishErr(bus, events.fillConfirmed({ fill: makeFill({ accountId }) }));

    expect(error).toBeInstanceOf(AccountNotInitializedError);
    expect(view.getVersion()).toBe(0);
  });

  it('AC. подтверждение с другим фактом при том же FillId — конфликт', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const fill = makeFill({ accountId });
    events.observeAt(2_000);
    await publishOk(bus, events.fillApplied({ fill, portfolio: portfolio({ accountId }) }));

    events.observeAt(3_000);
    const error = await publishErr(
      bus,
      events.fillConfirmed({ fill: makeFill({ accountId, price: 0.9 }) }),
    );

    expect(error).toBeInstanceOf(AccountFillIdentityConflictError);
    expect((error as AccountFillIdentityConflictError).action).toBe('CONFIRM');
    expect((error as AccountFillIdentityConflictError).difference.field).toBe('price');
    const account = view.getAccount(VENUE, accountId);
    expect(account?.getFill(fill.id)?.status).toBe('APPLIED');
    expect(account?.version).toBe(2);
  });
});

describe('AD–AG. откат исполнения', () => {
  it('AD. APPLIED → REVERTED применяет пост-реверсный портфель и заявку', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const open = must(order({ accountId }).accept());
    events.observeAt(2_000);
    await publishOk(
      bus,
      events.orderCommitted({
        accountId,
        order: open,
        portfolio: portfolio({ accountId, available: 9_350, reserved: 650 }),
      }),
    );

    const fill = makeFill({ accountId, orderId: open.id, size: 40 });
    const partially = withFill(open, { id: fill.id, size: 40 });
    events.observeAt(3_000);
    await publishOk(
      bus,
      events.fillApplied({
        fill,
        portfolio: portfolio({ accountId, available: 9_350, reserved: 390 }),
        order: partially,
      }),
    );

    const afterRevert = portfolio({ accountId, available: 9_350, reserved: 650 });
    events.observeAt(4_000);
    await publishOk(
      bus,
      events.fillReverted({
        fill,
        portfolio: afterRevert,
        order: open,
        reason: 'venue reported FAILED',
      }),
    );

    const account = view.getAccount(VENUE, accountId);
    const record = account?.getFill(fill.id);
    expect(record?.status).toBe('REVERTED');
    expect(record?.revertedAt?.equals(ts(4_000))).toBe(true);
    expect(record?.revertReason).toBe('venue reported FAILED');
    expect(record?.appliedAt.equals(ts(3_000))).toBe(true);
    expect(account?.portfolio).toBe(afterRevert);
    expect(account?.getOrder(open.id)?.order.status).toBe('OPEN');
    expect(account?.version).toBe(4);
    expect(view.getVersion()).toBe(4);
  });

  it('AE. повторный откат со старыми снимками ничего не откатывает', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const fill = makeFill({ accountId });
    events.observeAt(2_000);
    await publishOk(
      bus,
      events.fillApplied({ fill, portfolio: portfolio({ accountId, available: 9_974 }) }),
    );

    const afterRevert = portfolio({ accountId, available: 10_000 });
    events.observeAt(3_000);
    await publishOk(bus, events.fillReverted({ fill, portfolio: afterRevert, reason: 'first' }));

    events.observeAt(4_000);
    await publishOk(
      bus,
      events.fillReverted({
        fill: makeFill({ accountId }),
        portfolio: portfolio({ accountId, available: 9_974 }),
        reason: 'second',
      }),
    );

    const account = view.getAccount(VENUE, accountId);
    expect(account?.portfolio).toBe(afterRevert);
    // Причина проставлена ПЕРВЫМ принятым откатом и не переписывается.
    expect(account?.getFill(fill.id)?.revertReason).toBe('first');
    expect(account?.getFill(fill.id)?.revertedAt?.equals(ts(3_000))).toBe(true);
    expect(account?.version).toBe(3);
    expect(view.getVersion()).toBe(3);
    expect(account?.lastMutationAt.equals(ts(3_000))).toBe(true);
  });

  it('AF. CONFIRMED → REVERTED запрещён', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const fill = makeFill({ accountId });
    const afterApply = portfolio({ accountId, available: 9_974 });

    events.observeAt(2_000);
    await publishOk(bus, events.fillApplied({ fill, portfolio: afterApply }));
    events.observeAt(2_800);
    await publishOk(bus, events.fillConfirmed({ fill }));

    events.observeAt(3_500);
    const error = await publishErr(
      bus,
      events.fillReverted({ fill, portfolio: portfolio({ accountId, available: 10_000 }) }),
    );

    expect(error).toBeInstanceOf(AccountFillTransitionError);
    expect((error as AccountFillTransitionError).current).toBe('CONFIRMED');
    expect((error as AccountFillTransitionError).target).toBe('REVERTED');
    const account = view.getAccount(VENUE, accountId);
    expect(account?.getFill(fill.id)?.status).toBe('CONFIRMED');
    expect(account?.portfolio).toBe(afterApply);
    expect(account?.version).toBe(3);
    expect(view.getVersion()).toBe(3);
  });

  it('REVERTED → CONFIRMED тоже запрещён', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const fill = makeFill({ accountId });
    events.observeAt(2_000);
    await publishOk(bus, events.fillApplied({ fill, portfolio: portfolio({ accountId }) }));
    events.observeAt(3_000);
    await publishOk(bus, events.fillReverted({ fill, portfolio: portfolio({ accountId }) }));

    events.observeAt(4_000);
    const error = await publishErr(bus, events.fillConfirmed({ fill }));

    expect(error).toBeInstanceOf(AccountFillTransitionError);
    expect((error as AccountFillTransitionError).current).toBe('REVERTED');
    expect((error as AccountFillTransitionError).target).toBe('CONFIRMED');
    expect(view.getAccount(VENUE, accountId)?.getFill(fill.id)?.status).toBe('REVERTED');
    expect(view.getVersion()).toBe(3);
  });

  it('откат по неизвестному аккаунту отвергается', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    events.observeAt(1_000);

    const error = await publishErr(
      bus,
      events.fillReverted({
        fill: makeFill({ accountId }),
        portfolio: portfolio({ accountId }),
      }),
    );

    expect(error).toBeInstanceOf(AccountNotInitializedError);
    expect((error as AccountNotInitializedError).action).toBe('FILL_REVERTED');
    expect(view.getVersion()).toBe(0);
  });

  it('AG. откат неизвестного исполнения отвергается', async () => {
    const { bus, view, events, accountId } = await withAccount();
    events.observeAt(2_000);

    const error = await publishErr(
      bus,
      events.fillReverted({
        fill: makeFill({ accountId }),
        portfolio: portfolio({ accountId, available: 1 }),
      }),
    );

    expect(error).toBeInstanceOf(AccountFillNotFoundError);
    expect((error as AccountFillNotFoundError).action).toBe('REVERT');
    expectUntouched(view, accountId);
  });
});

/**
 * Проверяет, что аккаунт остался ровно в состоянии после инициализации.
 *
 * @param view - Проекция приватного состояния
 * @param accountId - Аккаунт
 */
function expectUntouched(
  view: ReturnType<typeof buildRuntime>['view'],
  accountId: ReturnType<typeof walletAccount>,
): void {
  const account = view.getAccount(VENUE, accountId);
  expect(account?.orders()).toHaveLength(0);
  expect(account?.fills()).toHaveLength(0);
  expect(account?.portfolio.balance.available().value().toNumber()).toBe(10_000);
  expect(account?.version).toBe(1);
  expect(view.getVersion()).toBe(1);
  expect(account?.lastMutationAt.equals(ts(1_000))).toBe(true);
}
