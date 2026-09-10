/**
 * Навигация по приватному состоянию и инварианты вторичных индексов.
 *
 * @remarks
 * Метки `AH`…`AJ` соответствуют плану MR, плюс инвариант-проверки индексов:
 * ни одного висячего идентификатора, ни одного дубля.
 *
 * Индексы — навигационные. Источник истины остаётся за `orders`, `fills` и
 * `portfolio`, поэтому каждый тест сверяет ответ индекса с владеющей
 * коллекцией, а не только с ожидаемой длиной.
 */
import { describe, expect, it } from '@jest/globals';
import { TERMINAL_STATUSES, type OrderStatus } from '@polymarket/order';
import { OPEN_ORDER_STATUSES, type AccountRuntimeStateView } from '../src/index.js';
import {
  DOWN_TOKEN,
  UP_TOKEN,
  VENUE,
  fill as makeFill,
  must,
  order,
  portfolio,
  position,
  walletAccount,
  withFill,
} from './helpers/fixtures.js';
import { buildRuntime, publishOk } from './helpers/runtime.js';

/** Инструмент исхода UP. */
const UP_INSTRUMENT = '100000000000000000000000000000000000000000000001' as never;

/** Инструмент исхода DOWN. */
const DOWN_INSTRUMENT = '200000000000000000000000000000000000000000000002' as never;

/**
 * Классификация КАЖДОГО статуса доменного контракта.
 *
 * @remarks
 * `Record<OrderStatus, …>`, а не массив, — и это принципиально. Массив,
 * типизированный `readonly OrderStatus[]`, остаётся валидным, если в
 * `@polymarket/order` добавят восьмой статус: он просто устареет молча, и
 * тест полноты ниже продолжит проходить, не заметив новичка. `Record` в той
 * же ситуации перестаёт компилироваться — ровно то, что обещает докблок
 * `OPEN_ORDER_STATUSES`.
 */
const ORDER_STATUS_KIND: Record<OrderStatus, 'open' | 'terminal'> = {
  PENDING: 'open',
  OPEN: 'open',
  PARTIALLY_FILLED: 'open',
  FILLED: 'terminal',
  CANCELED: 'terminal',
  REJECTED: 'terminal',
  EXPIRED: 'terminal',
};

/** Все статусы доменного контракта — выводятся из классификации. */
const ALL_ORDER_STATUSES = Object.keys(ORDER_STATUS_KIND) as readonly OrderStatus[];

/** Статусы, которые тест ожидает увидеть живыми. */
const EXPECTED_OPEN_STATUSES: readonly OrderStatus[] = ALL_ORDER_STATUSES.filter(
  (status) => ORDER_STATUS_KIND[status] === 'open',
);

/** Статусы, которые тест ожидает увидеть терминальными. */
const EXPECTED_TERMINAL_STATUSES: readonly OrderStatus[] = ALL_ORDER_STATUSES.filter(
  (status) => ORDER_STATUS_KIND[status] === 'terminal',
);

/**
 * Строит аккаунт с двумя инструментами, тремя заявками и тремя исполнениями.
 *
 * @returns Проекция аккаунта, заполненная через настоящую шину
 */
async function populated(): Promise<AccountRuntimeStateView> {
  const { bus, view, events } = buildRuntime();
  const accountId = walletAccount();

  events.observeAt(1_000);
  await publishOk(bus, events.initialized({ accountId, portfolio: portfolio({ accountId }) }));

  const upOpen = must(order({ id: 'order-up', accountId, asset: UP_TOKEN }).accept());
  const downOpen = must(order({ id: 'order-down', accountId, asset: DOWN_TOKEN }).accept());
  const canceled = must(
    must(order({ id: 'order-dead', accountId, asset: UP_TOKEN }).accept()).cancel('risk'),
  );

  events.observeAt(2_000);
  await publishOk(
    bus,
    events.orderCommitted({ accountId, order: upOpen, portfolio: portfolio({ accountId }) }),
  );
  events.observeAt(2_100);
  await publishOk(
    bus,
    events.orderCommitted({ accountId, order: downOpen, portfolio: portfolio({ accountId }) }),
  );
  events.observeAt(2_200);
  await publishOk(
    bus,
    events.orderCommitted({ accountId, order: canceled, portfolio: portfolio({ accountId }) }),
  );

  // Два исполнения по UP-заявке и одно по DOWN-заявке.
  const upFillA = makeFill({ id: 'fill-up-a', accountId, orderId: 'order-up', size: 40 });
  const upFillB = makeFill({ id: 'fill-up-b', accountId, orderId: 'order-up', size: 25 });
  const downFill = makeFill({
    id: 'fill-down',
    accountId,
    orderId: 'order-down',
    tokenId: DOWN_TOKEN,
    size: 10,
  });

  events.observeAt(3_000);
  await publishOk(
    bus,
    events.fillApplied({
      fill: upFillA,
      portfolio: portfolio({ accountId }),
      order: withFill(upOpen, { id: upFillA.id, size: 40 }),
    }),
  );
  events.observeAt(3_100);
  await publishOk(bus, events.fillApplied({ fill: upFillB, portfolio: portfolio({ accountId }) }));
  events.observeAt(3_200);
  await publishOk(bus, events.fillApplied({ fill: downFill, portfolio: portfolio({ accountId }) }));

  const account = view.getAccount(VENUE, accountId);
  if (account === undefined) throw new Error('test setup failed: account is missing');
  return account;
}

describe('AH. навигационные API', () => {
  it('fillsForOrder возвращает исполнения своей заявки', async () => {
    const account = await populated();
    expect(account.fillsForOrder('order-up' as never).map((r) => r.fill.id)).toEqual([
      'fill-up-a',
      'fill-up-b',
    ]);
    expect(account.fillsForOrder('order-down' as never).map((r) => r.fill.id)).toEqual([
      'fill-down',
    ]);
    expect(account.fillsForOrder('order-dead' as never)).toEqual([]);
  });

  it('fillsForInstrument разделяет исходы', async () => {
    const account = await populated();
    expect(account.fillsForInstrument(UP_INSTRUMENT).map((r) => r.fill.id)).toEqual([
      'fill-up-a',
      'fill-up-b',
    ]);
    expect(account.fillsForInstrument(DOWN_INSTRUMENT).map((r) => r.fill.id)).toEqual([
      'fill-down',
    ]);
  });

  it('ordersForInstrument разделяет исходы', async () => {
    const account = await populated();
    expect(account.ordersForInstrument(UP_INSTRUMENT).map((r) => r.order.id).sort()).toEqual([
      'order-dead',
      'order-up',
    ]);
    expect(account.ordersForInstrument(DOWN_INSTRUMENT).map((r) => r.order.id)).toEqual([
      'order-down',
    ]);
  });

  it('openOrders исключает терминальные заявки', async () => {
    const account = await populated();
    expect(account.openOrders().map((r) => r.order.id).sort()).toEqual(['order-down', 'order-up']);
    expect(account.orders()).toHaveLength(3);
  });
});

describe('AI. позиции читаются из портфеля', () => {
  it('getPosition возвращает объект из portfolio.positions', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    const held = position(UP_INSTRUMENT);
    const withPosition = portfolio({ accountId }).upsertPosition(held);

    events.observeAt(1_000);
    await publishOk(bus, events.initialized({ accountId, portfolio: withPosition }));

    const account = view.getAccount(VENUE, accountId);
    // Тот же экземпляр, что лежит в портфеле: параллельной коллекции позиций
    // в состоянии аккаунта нет.
    expect(account?.getPosition(UP_INSTRUMENT)).toBe(account?.portfolio.getPosition(UP_INSTRUMENT));
    expect(account?.getPosition(UP_INSTRUMENT)).toBe(held);
    expect(account?.getPosition(DOWN_INSTRUMENT)).toBeUndefined();
  });

  it('замена портфеля меняет и ответ getPosition', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    events.observeAt(1_000);
    await publishOk(bus, events.initialized({ accountId, portfolio: portfolio({ accountId }) }));

    expect(view.getAccount(VENUE, accountId)?.getPosition(UP_INSTRUMENT)).toBeUndefined();

    const held = position(UP_INSTRUMENT);
    events.observeAt(2_000);
    await publishOk(
      bus,
      events.fillApplied({
        fill: makeFill({ accountId }),
        portfolio: portfolio({ accountId }).upsertPosition(held),
      }),
    );

    expect(view.getAccount(VENUE, accountId)?.getPosition(UP_INSTRUMENT)).toBe(held);
  });
});

describe('AJ. семантика openOrders', () => {
  it('живые статусы — PENDING, OPEN, PARTIALLY_FILLED', () => {
    expect([...OPEN_ORDER_STATUSES].sort()).toEqual([...EXPECTED_OPEN_STATUSES].sort());
  });

  it('терминальные статусы в живые не входят', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual([...EXPECTED_TERMINAL_STATUSES].sort());
    for (const status of TERMINAL_STATUSES) {
      expect(OPEN_ORDER_STATUSES.has(status)).toBe(false);
    }
  });

  it('живые и терминальные вместе покрывают весь контракт OrderStatus', () => {
    // Тест полноты. Новый статус в `@polymarket/order` ломает его ДВАЖДЫ:
    // сначала на компиляции `ORDER_STATUS_KIND` (Record обязан быть полным),
    // затем на этих проверках. Решение «живой он или нет» придётся принять
    // осознанно, а не получить молча из отрицания терминальности.
    for (const status of ALL_ORDER_STATUSES) {
      expect(OPEN_ORDER_STATUSES.has(status) || TERMINAL_STATUSES.has(status)).toBe(true);
    }
    expect(OPEN_ORDER_STATUSES.size + TERMINAL_STATUSES.size).toBe(ALL_ORDER_STATUSES.length);
  });

  it('заявка в каждом живом статусе попадает в openOrders', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    events.observeAt(1_000);
    await publishOk(bus, events.initialized({ accountId, portfolio: portfolio({ accountId }) }));

    const pending = order({ id: 'order-pending', accountId });
    const open = must(order({ id: 'order-open', accountId }).accept());
    const partial = withFill(must(order({ id: 'order-partial', accountId }).accept()), {
      id: 'fill-partial',
      size: 40,
    });
    const filled = withFill(must(order({ id: 'order-filled', accountId }).accept()), {
      id: 'fill-filled',
      size: 100,
    });
    // Отклонить площадка может только ещё не принятую заявку (PENDING),
    // а истечь — только живую на бирже (OPEN/PARTIALLY_FILLED).
    const rejected = must(order({ id: 'order-rejected', accountId }).reject('venue'));
    const expired = must(must(order({ id: 'order-expired', accountId }).accept()).expire());

    let at = 2_000;
    for (const committed of [pending, open, partial, filled, rejected, expired]) {
      events.observeAt(at);
      at += 100;
      await publishOk(
        bus,
        events.orderCommitted({ accountId, order: committed, portfolio: portfolio({ accountId }) }),
      );
    }

    const account = view.getAccount(VENUE, accountId);
    expect(account?.openOrders().map((r) => r.order.id).sort()).toEqual([
      'order-open',
      'order-partial',
      'order-pending',
    ]);
    expect(filled.status).toBe('FILLED');
    expect(rejected.status).toBe('REJECTED');
    expect(expired.status).toBe('EXPIRED');
  });
});

describe('инварианты вторичных индексов', () => {
  it('ни один индекс не содержит висячих идентификаторов', async () => {
    const account = await populated();
    const orderIds = new Set(account.orders().map((r) => r.order.id));
    const fillIds = new Set(account.fills().map((r) => r.fill.id));

    for (const instrumentId of [UP_INSTRUMENT, DOWN_INSTRUMENT]) {
      for (const record of account.ordersForInstrument(instrumentId)) {
        expect(orderIds.has(record.order.id)).toBe(true);
      }
      for (const record of account.fillsForInstrument(instrumentId)) {
        expect(fillIds.has(record.fill.id)).toBe(true);
      }
    }
    for (const orderId of orderIds) {
      for (const record of account.fillsForOrder(orderId)) {
        expect(fillIds.has(record.fill.id)).toBe(true);
      }
    }
  });

  it('каждая запись встречается в своём индексе ровно один раз', async () => {
    const account = await populated();
    const indexedOrders = [
      ...account.ordersForInstrument(UP_INSTRUMENT),
      ...account.ordersForInstrument(DOWN_INSTRUMENT),
    ].map((r) => r.order.id);
    const indexedFills = [
      ...account.fillsForInstrument(UP_INSTRUMENT),
      ...account.fillsForInstrument(DOWN_INSTRUMENT),
    ].map((r) => r.fill.id);

    expect(new Set(indexedOrders).size).toBe(indexedOrders.length);
    expect(new Set(indexedFills).size).toBe(indexedFills.length);
    expect(indexedOrders.length).toBe(account.orders().length);
    expect(indexedFills.length).toBe(account.fills().length);
  });

  it('повторные события не удваивают записи индексов', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    events.observeAt(1_000);
    await publishOk(bus, events.initialized({ accountId, portfolio: portfolio({ accountId }) }));

    const open = must(order({ accountId }).accept());
    const fill = makeFill({ accountId, orderId: open.id });

    for (const at of [2_000, 2_500, 3_000]) {
      events.observeAt(at);
      await publishOk(
        bus,
        events.orderCommitted({ accountId, order: open, portfolio: portfolio({ accountId }) }),
      );
    }
    for (const at of [4_000, 4_500]) {
      events.observeAt(at);
      await publishOk(bus, events.fillApplied({ fill, portfolio: portfolio({ accountId }) }));
    }

    const account = view.getAccount(VENUE, accountId);
    expect(account?.ordersForInstrument(UP_INSTRUMENT)).toHaveLength(1);
    expect(account?.fillsForInstrument(UP_INSTRUMENT)).toHaveLength(1);
    expect(account?.fillsForOrder(open.id)).toHaveLength(1);
    // Первый commit и первый apply — две мутации, остальное дубликаты.
    expect(account?.version).toBe(3);
  });
});
