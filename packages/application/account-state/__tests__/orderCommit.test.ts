/**
 * Атомарный commit заявки: `Order` и `Portfolio` одной мутацией.
 *
 * @remarks
 * Метки `I`…`Q` соответствуют плану MR. Ключевой здесь — тест `O`: точный
 * дубликат несёт УСТАРЕВШИЙ портфель, и применить его значило бы вернуть уже
 * потраченные деньги в available.
 */
import { describe, expect, it } from '@jest/globals';
import type { Order } from '@polymarket/order';
import {
  AccountInstrumentResolutionError,
  AccountIdentityMismatchError,
  AccountNotInitializedError,
  AccountOrderAccountMissingError,
  AccountOrderIdentityConflictError,
  type AccountOrderIdentityField,
} from '../src/index.js';
import {
  DOWN_TOKEN,
  UNRESOLVABLE_TOKEN,
  UP_TOKEN,
  VENUE,
  must,
  order,
  portfolio,
  strategyId,
  ts,
  walletAccount,
  withFill,
} from './helpers/fixtures.js';
import { buildRuntime, publishErr, publishOk } from './helpers/runtime.js';
import type { AccountRuntime } from './helpers/runtime.js';

/** Инструмент, в который превращается `UP_TOKEN`. */
const UP_INSTRUMENT = '100000000000000000000000000000000000000000000001' as never;

/** Инструмент, в который превращается `DOWN_TOKEN`. */
const DOWN_INSTRUMENT = '200000000000000000000000000000000000000000000002' as never;

/**
 * Инициализирует аккаунт и возвращает рантайм вместе с его идентичностью.
 *
 * @param available - Стартовый свободный баланс
 * @returns Рантайм и аккаунт
 */
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

describe('I. commit по неизвестному аккаунту', () => {
  it('заявка по неинициализированному аккаунту отвергается без мутации', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    events.observeAt(1_000);

    const error = await publishErr(
      bus,
      events.orderCommitted({
        accountId,
        order: order({ accountId }),
        portfolio: portfolio({ accountId }),
      }),
    );

    expect(error).toBeInstanceOf(AccountNotInitializedError);
    expect(view.getAccount(VENUE, accountId)).toBeUndefined();
    expect(view.getVersion()).toBe(0);
  });
});

describe('J. первый валидный commit', () => {
  it('сохраняет заявку, заменяет портфель и увеличивает обе версии ровно на единицу', async () => {
    const { bus, view, events, accountId } = await withAccount(10_000);
    const committed = order({ accountId });
    const after = portfolio({ accountId, available: 9_350, reserved: 650 });

    events.observeAt(2_500);
    await publishOk(bus, events.orderCommitted({ accountId, order: committed, portfolio: after }));

    const account = view.getAccount(VENUE, accountId);
    expect(account?.getOrder(committed.id)?.order).toBe(committed);
    expect(account?.getOrder(committed.id)?.updatedAt.equals(ts(2_500))).toBe(true);
    expect(account?.portfolio).toBe(after);
    expect(account?.portfolio.balance.reserved().value().toNumber()).toBe(650);
    // Навигация — производное представление: заявка видна по инструменту
    // своего актива без какой-либо хранимой записи о ней.
    expect(account?.ordersForInstrument(UP_INSTRUMENT)).toHaveLength(1);
    expect(account?.version).toBe(2);
    expect(view.getVersion()).toBe(2);
    expect(account?.lastMutationAt.equals(ts(2_500))).toBe(true);
  });
});

describe('K–M. согласованность заявки с аккаунтом', () => {
  it('K. заявка без accountId отвергается', async () => {
    const { bus, view, events, accountId } = await withAccount();
    events.observeAt(2_000);

    const error = await publishErr(
      bus,
      events.orderCommitted({
        accountId,
        order: order({ accountId: null }),
        portfolio: portfolio({ accountId, available: 1 }),
      }),
    );

    expect(error).toBeInstanceOf(AccountOrderAccountMissingError);
    const account = view.getAccount(VENUE, accountId);
    expect(account?.orders()).toHaveLength(0);
    expect(account?.portfolio.balance.available().value().toNumber()).toBe(10_000);
    expect(view.getVersion()).toBe(1);
  });

  it('L. заявка чужого владельца отвергается', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const stranger = walletAccount('0x9999999999999999999999999999999999999999');
    events.observeAt(2_000);

    const error = await publishErr(
      bus,
      events.orderCommitted({
        accountId,
        order: order({ accountId: stranger }),
        portfolio: portfolio({ accountId, available: 1 }),
      }),
    );

    expect(error).toBeInstanceOf(AccountIdentityMismatchError);
    expect((error as AccountIdentityMismatchError).subject).toBe('ORDER_ACCOUNT');
    const account = view.getAccount(VENUE, accountId);
    expect(account?.orders()).toHaveLength(0);
    expect(account?.portfolio.balance.available().value().toNumber()).toBe(10_000);
    expect(view.getVersion()).toBe(1);
  });

  it('M. актив, не приводимый к InstrumentId, отвергается до мутации', async () => {
    const { bus, view, events, accountId } = await withAccount();
    events.observeAt(2_000);

    // `AssetId` и `InstrumentId` — контракты с РАЗНЫМИ ограничениями:
    // CTF-токен из 200 цифр валиден как актив, но в инструмент не помещается.
    // Связать такую заявку с рыночным контекстом нечем.
    const error = await publishErr(
      bus,
      events.orderCommitted({
        accountId,
        order: order({ accountId, asset: UNRESOLVABLE_TOKEN }),
        portfolio: portfolio({ accountId, available: 1 }),
      }),
    );

    expect(error).toBeInstanceOf(AccountInstrumentResolutionError);
    expect((error as AccountInstrumentResolutionError).subject).toBe('ORDER_ASSET');
    const account = view.getAccount(VENUE, accountId);
    expect(account?.orders()).toHaveLength(0);
    expect(account?.portfolio.balance.available().value().toNumber()).toBe(10_000);
    expect(view.getVersion()).toBe(1);
  });
});

describe('N. конфликт неизменяемой идентичности заявки', () => {
  /** Способы подменить заявку под тем же `OrderId`. */
  const conflicts: ReadonlyArray<{
    field: AccountOrderIdentityField;
    make: (accountId: ReturnType<typeof walletAccount>) => Order;
  }> = [
    { field: 'asset', make: (a) => order({ accountId: a, asset: DOWN_TOKEN }) },
    { field: 'side', make: (a) => order({ accountId: a, side: 'SELL' }) },
    { field: 'size', make: (a) => order({ accountId: a, size: 250 }) },
    { field: 'price', make: (a) => order({ accountId: a, price: 0.42 }) },
    { field: 'timestamp', make: (a) => order({ accountId: a, timestampMs: 1_700_000_050_000 }) },
    {
      field: 'strategyId',
      make: (a) => order({ accountId: a, strategyId: strategyId('other-strategy') }),
    },
    {
      field: 'accountId',
      make: () => order({ accountId: walletAccount('0x9999999999999999999999999999999999999999') }),
    },
  ];

  it.each(conflicts)('$field изменился — конфликт без мутации', async ({ field, make }) => {
    const { bus, view, events, accountId } = await withAccount();
    const stored = order({ accountId });
    const afterCommit = portfolio({ accountId, available: 9_350, reserved: 650 });

    events.observeAt(2_000);
    await publishOk(bus, events.orderCommitted({ accountId, order: stored, portfolio: afterCommit }));

    events.observeAt(3_000);
    const error = await publishErr(
      bus,
      events.orderCommitted({
        accountId,
        order: make(accountId),
        portfolio: portfolio({ accountId, available: 1 }),
      }),
    );

    // Владельца проверяет отдельная, более ранняя проверка: подменённый
    // accountId — это «чужая заявка», а не «изменённая идентичность своей».
    if (field === 'accountId') {
      expect(error).toBeInstanceOf(AccountIdentityMismatchError);
    } else {
      expect(error).toBeInstanceOf(AccountOrderIdentityConflictError);
      expect((error as AccountOrderIdentityConflictError).difference.field).toBe(field);
    }

    const account = view.getAccount(VENUE, accountId);
    expect(account?.getOrder(stored.id)?.order).toBe(stored);
    expect(account?.portfolio).toBe(afterCommit);
    expect(account?.version).toBe(2);
    expect(view.getVersion()).toBe(2);
    expect(account?.lastMutationAt.equals(ts(2_000))).toBe(true);
  });
});

describe('O. точный дубликат не откатывает состояние', () => {
  it('повтор с УСТАРЕВШИМ портфелем — no-op, деньги не возвращаются', async () => {
    const { bus, view, events, accountId } = await withAccount(10_000);
    const committed = order({ accountId });
    const afterReserve = portfolio({ accountId, available: 9_350, reserved: 650 });
    const beforeReserve = portfolio({ accountId, available: 10_000, reserved: 0 });

    events.observeAt(2_000);
    await publishOk(
      bus,
      events.orderCommitted({ accountId, order: committed, portfolio: afterReserve }),
    );

    events.observeAt(3_000);
    // Повторная доставка ТОГО ЖЕ commit'а: заявка та же, а портфель в событии
    // отстал на одну операцию. Применить его — значит вернуть в available
    // 650 USDC, которые уже зарезервированы под живую заявку.
    await publishOk(
      bus,
      events.orderCommitted({ accountId, order: committed, portfolio: beforeReserve }),
    );

    const account = view.getAccount(VENUE, accountId);
    expect(account?.portfolio).toBe(afterReserve);
    expect(account?.portfolio.balance.available().value().toNumber()).toBe(9_350);
    expect(account?.portfolio.balance.reserved().value().toNumber()).toBe(650);
    expect(account?.version).toBe(2);
    expect(view.getVersion()).toBe(2);
    expect(account?.lastMutationAt.equals(ts(2_000))).toBe(true);
    expect(account?.ordersForInstrument(UP_INSTRUMENT)).toHaveLength(1);
  });

  it('эквивалентная, но пересобранная заявка тоже распознаётся как дубликат', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const first = order({ accountId });
    // Другой JS-объект с теми же значениями: сравнение идёт по value objects,
    // а не по ссылке.
    const rebuilt = order({ accountId: walletAccount() });
    expect(rebuilt).not.toBe(first);

    const afterReserve = portfolio({ accountId, available: 9_350, reserved: 650 });
    events.observeAt(2_000);
    await publishOk(bus, events.orderCommitted({ accountId, order: first, portfolio: afterReserve }));

    events.observeAt(3_000);
    await publishOk(
      bus,
      events.orderCommitted({ accountId, order: rebuilt, portfolio: portfolio({ accountId }) }),
    );

    expect(view.getAccount(VENUE, accountId)?.getOrder(first.id)?.order).toBe(first);
    expect(view.getVersion()).toBe(2);
  });
});

describe('P. законная эволюция заявки', () => {
  it('OPEN → PARTIALLY_FILLED применяется вместе с новым портфелем', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const pending = order({ accountId });
    const open = must(pending.accept());

    events.observeAt(2_000);
    await publishOk(
      bus,
      events.orderCommitted({
        accountId,
        order: open,
        portfolio: portfolio({ accountId, available: 9_350, reserved: 650 }),
      }),
    );

    const partially = withFill(open, { size: 40 });
    const afterFill = portfolio({ accountId, available: 9_350, reserved: 390 });

    events.observeAt(3_000);
    await publishOk(
      bus,
      events.orderCommitted({ accountId, order: partially, portfolio: afterFill }),
    );

    const account = view.getAccount(VENUE, accountId);
    expect(account?.getOrder(open.id)?.order.status).toBe('PARTIALLY_FILLED');
    expect(account?.getOrder(open.id)?.updatedAt.equals(ts(3_000))).toBe(true);
    expect(account?.portfolio).toBe(afterFill);
    expect(account?.version).toBe(3);
    expect(view.getVersion()).toBe(3);
    // Заявка одна, сколько бы commit'ов её ни обновляло: коллекция ключуется
    // OrderId, а навигация читает её же.
    expect(account?.ordersForInstrument(UP_INSTRUMENT)).toHaveLength(1);
  });

  it('OPEN → CANCELED применяется и освобождает резервацию', async () => {
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

    const canceled = must(open.cancel('strategy exit'));
    events.observeAt(3_000);
    await publishOk(
      bus,
      events.orderCommitted({
        accountId,
        order: canceled,
        portfolio: portfolio({ accountId, available: 10_000, reserved: 0 }),
      }),
    );

    const account = view.getAccount(VENUE, accountId);
    expect(account?.getOrder(open.id)?.order.status).toBe('CANCELED');
    expect(account?.portfolio.balance.reserved().value().toNumber()).toBe(0);
    expect(account?.openOrders()).toHaveLength(0);
    expect(account?.version).toBe(3);
  });
});

describe('Q. навигация по заявкам инструмента', () => {
  it('возвращает заявки своего инструмента и не возвращает чужие', async () => {
    const { bus, view, events, accountId } = await withAccount();
    const up = order({ id: 'order-up', accountId, asset: UP_TOKEN });
    const down = order({ id: 'order-down', accountId, asset: DOWN_TOKEN });

    events.observeAt(2_000);
    await publishOk(
      bus,
      events.orderCommitted({ accountId, order: up, portfolio: portfolio({ accountId }) }),
    );
    events.observeAt(2_500);
    await publishOk(
      bus,
      events.orderCommitted({ accountId, order: down, portfolio: portfolio({ accountId }) }),
    );

    const account = view.getAccount(VENUE, accountId);
    expect(account?.ordersForInstrument(UP_INSTRUMENT).map((r) => r.order.id)).toEqual([up.id]);
    expect(account?.ordersForInstrument(DOWN_INSTRUMENT).map((r) => r.order.id)).toEqual([down.id]);
    expect(account?.ordersForInstrument('unknown-instrument' as never)).toEqual([]);
    expect(account?.orders()).toHaveLength(2);
  });
});
