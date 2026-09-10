/**
 * Одна и та же лента событий даёт одно и то же состояние.
 *
 * @remarks
 * Метка `AM` соответствует плану MR.
 *
 * Отдельного replay-движка здесь нет и не нужно: детерминизм обеспечивается
 * тем, что состояние НЕ читает часы. Все времена берутся из
 * `metadata.createdAt`, поэтому «прогнать ленту заново» — это буквально
 * опубликовать те же события на свежей шине.
 *
 * Проверяется полный машинно-сравнимый отпечаток обоих рантаймов, а не пара
 * выборочных полей: расхождение из-за скрытой зависимости от времени запуска
 * проявилось бы именно в тех местах, которые выборочная проверка пропускает.
 * В отпечаток входят и ответы навигационных представлений — они производные,
 * но именно их читает потребитель.
 */
import { describe, expect, it } from '@jest/globals';
import type { AccountHotStateView } from '../src/index.js';
import {
  DOWN_TOKEN,
  UP_TOKEN,
  VENUE,
  fill as makeFill,
  must,
  order,
  portfolio,
  walletAccount,
  withFill,
} from './helpers/fixtures.js';
import { buildRuntime, publishOk } from './helpers/runtime.js';

/** Инструмент исхода UP. */
const UP_INSTRUMENT = '100000000000000000000000000000000000000000000001' as never;

/** Инструмент исхода DOWN. */
const DOWN_INSTRUMENT = '200000000000000000000000000000000000000000000002' as never;

/**
 * Прогоняет фиксированную ленту событий на свежем рантайме.
 *
 * @returns Проекция приватного состояния после ленты
 *
 * @remarks
 * Лента покрывает все пять типов событий контура и оба аккаунта, чтобы
 * детерминизм проверялся не на вырожденном случае.
 */
async function replay(): Promise<AccountHotStateView> {
  const { bus, view, events } = buildRuntime();
  const primary = walletAccount('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const secondary = walletAccount('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

  events.observeAt(1_000);
  await publishOk(
    bus,
    events.initialized({ accountId: primary, portfolio: portfolio({ accountId: primary }) }),
  );
  events.observeAt(1_100);
  await publishOk(
    bus,
    events.initialized({ accountId: secondary, portfolio: portfolio({ accountId: secondary }) }),
  );

  const open = must(order({ id: 'order-up', accountId: primary, asset: UP_TOKEN }).accept());
  events.observeAt(2_000);
  await publishOk(
    bus,
    events.orderCommitted({
      accountId: primary,
      order: open,
      portfolio: portfolio({ accountId: primary, available: 9_350, reserved: 650 }),
    }),
  );

  const firstFill = makeFill({ id: 'fill-1', accountId: primary, orderId: open.id, size: 40 });
  const partially = withFill(open, { id: firstFill.id, size: 40 });
  events.observeAt(3_000);
  await publishOk(
    bus,
    events.fillApplied({
      fill: firstFill,
      portfolio: portfolio({ accountId: primary, available: 9_350, reserved: 390 }),
      order: partially,
    }),
  );

  // Заявка меняется отдельным commit'ом — законная эволюция без исполнения.
  const canceled = must(partially.cancel('strategy exit'));
  events.observeAt(3_500);
  await publishOk(
    bus,
    events.orderCommitted({
      accountId: primary,
      order: canceled,
      portfolio: portfolio({ accountId: primary, available: 9_740, reserved: 0 }),
    }),
  );

  events.observeAt(4_000);
  await publishOk(bus, events.fillConfirmed({ fill: firstFill }));

  const secondOrder = must(
    order({ id: 'order-down', accountId: primary, asset: DOWN_TOKEN }).accept(),
  );
  events.observeAt(5_000);
  await publishOk(
    bus,
    events.orderCommitted({
      accountId: primary,
      order: secondOrder,
      portfolio: portfolio({ accountId: primary, available: 9_100, reserved: 640 }),
    }),
  );

  const secondFill = makeFill({
    id: 'fill-2',
    accountId: primary,
    orderId: secondOrder.id,
    tokenId: DOWN_TOKEN,
    size: 20,
  });
  events.observeAt(6_000);
  await publishOk(
    bus,
    events.fillApplied({
      fill: secondFill,
      portfolio: portfolio({ accountId: primary, available: 9_100, reserved: 512 }),
    }),
  );

  // И один откат — чтобы в ленте были все пять типов событий контура.
  events.observeAt(7_000);
  await publishOk(
    bus,
    events.fillReverted({
      fill: secondFill,
      portfolio: portfolio({ accountId: primary, available: 9_100, reserved: 640 }),
      reason: 'venue reported FAILED',
    }),
  );

  return view;
}

/**
 * Полный отпечаток состояния, пригодный к точному сравнению.
 *
 * @param view - Проекция приватного состояния
 * @returns Машинно-сравнимая структура без ссылок на объекты
 */
function fingerprint(view: AccountHotStateView): unknown {
  return {
    version: view.getVersion(),
    accounts: view
      .accountIdentities()
      .map(({ venueId, accountId }) => {
        const account = view.getAccount(venueId, accountId);
        if (account === undefined) throw new Error('fingerprint failed: account is missing');
        return {
          venueId,
          version: account.version,
          lastMutationAt: account.lastMutationAt.toISO(),
          available: account.portfolio.balance.available().value().toString(),
          reserved: account.portfolio.balance.reserved().value().toString(),
          orders: account
            .orders()
            .map((r) => ({
              id: r.order.id,
              status: r.order.status,
              filledSize: r.order.filledSize.value().toString(),
              fillIds: [...r.order.fillIds],
              updatedAt: r.updatedAt.toISO(),
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
          openOrders: account.openOrders().map((r) => r.order.id).sort(),
          fills: account
            .fills()
            .map((r) => ({
              id: r.fill.id,
              status: r.status,
              appliedAt: r.appliedAt.toISO(),
              confirmedAt: r.confirmedAt?.toISO() ?? null,
              revertedAt: r.revertedAt?.toISO() ?? null,
              revertReason: r.revertReason ?? null,
              price: r.fill.price.value().toString(),
              size: r.fill.size.value().toString(),
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
          ordersForInstrument: [UP_INSTRUMENT, DOWN_INSTRUMENT].map((instrumentId) => [
            instrumentId,
            account.ordersForInstrument(instrumentId).map((r) => r.order.id).sort(),
          ]),
          fillsForInstrument: [UP_INSTRUMENT, DOWN_INSTRUMENT].map((instrumentId) => [
            instrumentId,
            account.fillsForInstrument(instrumentId).map((r) => r.fill.id).sort(),
          ]),
          fillsForOrder: account
            .orders()
            .map((o) => [o.order.id, account.fillsForOrder(o.order.id).map((r) => r.fill.id).sort()])
            .sort(),
        };
      })
      .sort(),
  };
}

describe('AM. детерминизм повтора ленты', () => {
  it('два независимых рантайма на одинаковой ленте дают эквивалентное состояние', async () => {
    const first = await replay();
    const second = await replay();

    expect(fingerprint(second)).toEqual(fingerprint(first));
  });

  it('лента действительно наполнила состояние, а не совпала пустотой', async () => {
    const view = await replay();
    const primary = walletAccount('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const account = view.getAccount(VENUE, primary);

    expect(view.accountIdentities()).toHaveLength(2);
    expect(account?.orders()).toHaveLength(2);
    expect(account?.fills()).toHaveLength(2);
    expect(account?.getFill('fill-1' as never)?.status).toBe('CONFIRMED');
    expect(account?.getFill('fill-2' as never)?.status).toBe('REVERTED');
    // 2 инициализации + 3 commit'а заявок + 2 apply + confirm + revert.
    expect(view.getVersion()).toBe(9);
    expect(account?.version).toBe(8);
  });
});
