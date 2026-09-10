/**
 * Отвергнутое событие не оставляет за собой НИЧЕГО.
 *
 * @remarks
 * Метки `AL` и `AQ` соответствуют плану MR.
 *
 * Тест снимает ПОЛНЫЙ отпечаток состояния до серии невалидных событий и
 * сверяет его после каждого — не отдельные поля, а всё сразу: портфель,
 * заявки, исполнения, содержимое индексов, обе версии и `lastMutationAt`.
 * Частичная мутация — уже пойманный в этом проекте класс дефекта, и ловить её
 * выборочной проверкой одного-двух полей ненадёжно.
 */
import { describe, expect, it } from '@jest/globals';
import type { AccountHotStateView, AccountRuntimeStateView } from '../src/index.js';
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

/** Инструмент исхода UP. */
const UP_INSTRUMENT = '100000000000000000000000000000000000000000000001' as never;

/** Инструмент исхода DOWN. */
const DOWN_INSTRUMENT = '200000000000000000000000000000000000000000000002' as never;

/** Полный машинно-сравнимый отпечаток состояния. */
interface StateSnapshot {
  readonly globalVersion: number;
  readonly accountVersion: number;
  readonly lastMutationAtMs: number;
  readonly balance: readonly [string, string];
  readonly orders: readonly string[];
  readonly fills: readonly string[];
  readonly ordersByInstrument: readonly string[];
  readonly fillsByInstrument: readonly string[];
  readonly fillsByOrder: readonly string[];
}

/**
 * Снимает отпечаток состояния аккаунта.
 *
 * @param view - Проекция приватного состояния
 * @param account - Состояние аккаунта
 * @returns Полностью сериализуемый отпечаток
 */
function snapshot(view: AccountHotStateView, account: AccountRuntimeStateView): StateSnapshot {
  const describeOrder = (id: string): string => {
    const record = account.getOrder(id as never);
    return record === undefined
      ? `${id}:<absent>`
      : `${id}:${record.order.status}:${record.updatedAt.toISO()}`;
  };
  const describeFill = (id: string): string => {
    const record = account.getFill(id as never);
    return record === undefined
      ? `${id}:<absent>`
      : `${id}:${record.status}:${record.appliedAt.toISO()}:${record.revertReason ?? '-'}`;
  };

  return {
    globalVersion: view.getVersion(),
    accountVersion: account.version,
    lastMutationAtMs: account.lastMutationAt.toNumber(),
    balance: [
      account.portfolio.balance.available().value().toString(),
      account.portfolio.balance.reserved().value().toString(),
    ],
    orders: account.orders().map((r) => describeOrder(r.order.id)).sort(),
    fills: account.fills().map((r) => describeFill(r.fill.id)).sort(),
    ordersByInstrument: [UP_INSTRUMENT, DOWN_INSTRUMENT]
      .flatMap((instrumentId) =>
        account.ordersForInstrument(instrumentId).map((r) => `${instrumentId}:${r.order.id}`),
      )
      .sort(),
    fillsByInstrument: [UP_INSTRUMENT, DOWN_INSTRUMENT]
      .flatMap((instrumentId) =>
        account.fillsForInstrument(instrumentId).map((r) => `${instrumentId}:${r.fill.id}`),
      )
      .sort(),
    fillsByOrder: account
      .orders()
      .flatMap((o) => account.fillsForOrder(o.order.id).map((r) => `${o.order.id}:${r.fill.id}`))
      .sort(),
  };
}

describe('AL. отвергнутое событие не меняет состояние', () => {
  it('после каждой невалидной мутации отпечаток совпадает с исходным', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    const stranger = walletAccount('0x9999999999999999999999999999999999999999');

    // ── Наполняем состояние: аккаунт, заявка, исполнение ──────────────
    events.observeAt(1_000);
    await publishOk(bus, events.initialized({ accountId, portfolio: portfolio({ accountId }) }));

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

    const applied = makeFill({ accountId, orderId: open.id, size: 40 });
    events.observeAt(3_000);
    await publishOk(
      bus,
      events.fillApplied({
        fill: applied,
        portfolio: portfolio({ accountId, available: 9_350, reserved: 390 }),
        order: withFill(open, { id: applied.id, size: 40 }),
      }),
    );

    const account = view.getAccount(VENUE, accountId);
    if (account === undefined) throw new Error('test setup failed: account is missing');
    const before = snapshot(view, account);

    // Портфель, который сдвинул бы баланс, если бы отказ был не атомарным.
    const poison = portfolio({ accountId, available: 1, reserved: 1 });

    /** Невалидные события: каждое обязано оставить состояние нетронутым. */
    const invalid = [
      {
        name: 'повторная инициализация',
        event: () => events.initialized({ accountId, portfolio: poison }),
      },
      {
        name: 'заявка без владельца',
        event: () =>
          events.orderCommitted({ accountId, order: order({ accountId: null }), portfolio: poison }),
      },
      {
        name: 'заявка чужого владельца',
        event: () =>
          events.orderCommitted({
            accountId,
            order: order({ accountId: stranger }),
            portfolio: poison,
          }),
      },
      {
        name: 'портфель чужого аккаунта',
        event: () =>
          events.orderCommitted({
            accountId,
            order: order({ id: 'order-new', accountId }),
            portfolio: portfolio({ accountId: stranger }),
          }),
      },
      {
        name: 'портфель чужой площадки',
        event: () =>
          events.orderCommitted({
            accountId,
            order: order({ id: 'order-new', accountId }),
            portfolio: portfolio({ accountId, balanceVenueId: OTHER_VENUE }),
          }),
      },
      {
        name: 'неразрешимый актив заявки',
        event: () =>
          events.orderCommitted({
            accountId,
            order: order({ id: 'order-new', accountId, asset: UNRESOLVABLE_TOKEN }),
            portfolio: poison,
          }),
      },
      {
        name: 'конфликт идентичности заявки',
        event: () =>
          events.orderCommitted({
            accountId,
            order: order({ accountId, size: 999 }),
            portfolio: poison,
          }),
      },
      {
        name: 'разорванная связь заявки и исполнения',
        event: () =>
          events.fillApplied({
            fill: makeFill({ id: 'fill-new', accountId, orderId: 'order-x' }),
            portfolio: poison,
            order: order({ id: 'order-y', accountId }),
          }),
      },
      {
        name: 'исполнение с чужим токеном в заявке',
        event: () =>
          events.fillApplied({
            fill: makeFill({ id: 'fill-new', accountId }),
            portfolio: poison,
            order: order({ accountId, asset: DOWN_TOKEN }),
          }),
      },
      {
        name: 'конфликт факта исполнения',
        event: () =>
          events.fillApplied({ fill: makeFill({ accountId, price: 0.9 }), portfolio: poison }),
      },
      {
        name: 'подтверждение неизвестного исполнения',
        event: () => events.fillConfirmed({ fill: makeFill({ id: 'fill-unknown', accountId }) }),
      },
      {
        name: 'откат неизвестного исполнения',
        event: () =>
          events.fillReverted({
            fill: makeFill({ id: 'fill-unknown', accountId }),
            portfolio: poison,
          }),
      },
      {
        name: 'подтверждение с другим фактом',
        event: () => events.fillConfirmed({ fill: makeFill({ accountId, size: 41 }) }),
      },
    ] as const;

    for (const { name, event } of invalid) {
      events.observeAt(9_000);
      const error = await publishErr(bus, event());
      expect(error).toBeInstanceOf(Error);
      expect({ name, ...snapshot(view, account) }).toEqual({ name, ...before });
    }
  });
});

describe('AQ. отказ инварианта виден публикующей стороне', () => {
  it('critical-подписка возвращает Err из publish(), а bus остаётся рабочим', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    events.observeAt(1_000);
    await publishOk(bus, events.initialized({ accountId, portfolio: portfolio({ accountId }) }));

    events.observeAt(2_000);
    const rejected = await bus.publish(
      events.orderCommitted({
        accountId,
        order: order({ accountId: null }),
        portfolio: portfolio({ accountId }),
      }),
    );
    expect(rejected.ok).toBe(false);

    // Шина работоспособна: следующая валидная мутация проходит.
    events.observeAt(3_000);
    await publishOk(
      bus,
      events.orderCommitted({
        accountId,
        order: order({ accountId }),
        portfolio: portfolio({ accountId, available: 9_350, reserved: 650 }),
      }),
    );
    expect(view.getAccount(VENUE, accountId)?.version).toBe(2);
    expect(view.getAccount(VENUE, accountId)?.lastMutationAt.equals(ts(3_000))).toBe(true);
  });

  it('проектор после stop() состояние больше не меняет', async () => {
    const { bus, view, events, projector } = buildRuntime();
    const accountId = walletAccount();
    events.observeAt(1_000);
    await publishOk(bus, events.initialized({ accountId, portfolio: portfolio({ accountId }) }));

    projector.stop();
    expect(projector.isRunning()).toBe(false);

    events.observeAt(2_000);
    // Без подписчиков даже невалидное событие проходит: отвергать его некому.
    await publishOk(
      bus,
      events.orderCommitted({
        accountId,
        order: order({ accountId }),
        portfolio: portfolio({ accountId }),
      }),
    );
    expect(view.getAccount(VENUE, accountId)?.version).toBe(1);
    expect(view.getVersion()).toBe(1);
  });

  it('повторный start() не удваивает обработку', async () => {
    const { bus, view, events, projector } = buildRuntime();
    projector.start();
    projector.start();

    const accountId = walletAccount();
    events.observeAt(1_000);
    await publishOk(bus, events.initialized({ accountId, portfolio: portfolio({ accountId }) }));

    // Вторая подписка дала бы повторную инициализацию — то есть Err.
    expect(view.getVersion()).toBe(1);
    expect(view.getAccount(VENUE, accountId)?.version).toBe(1);
  });
});
