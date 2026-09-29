/**
 * Общая подготовка тестов authoritative-коррекции.
 *
 * @remarks
 * Состояние наполняется ЖИВЫМИ событиями через настоящую шину — так же, как
 * это будет делать рантайм. Коррекция затем проверяется поверх реального
 * накопленного состояния, а не поверх пустого аккаунта, где «ничего не
 * изменилось» доказывалось бы тривиально.
 */
import type { AccountId, OrderId } from '@polymarket/ids';
import type { Fill } from '@polymarket/fill';
import type { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';
import type { AccountHotStateView, AccountRuntimeStateView } from '../../src/index.js';
import {
  VENUE,
  fill as makeFill,
  must,
  order,
  portfolio,
  walletAccount,
  withFill,
} from './fixtures.js';
import { buildRuntime, publishOk, type AccountRuntime } from './runtime.js';

/** Состояние, накопленное живыми событиями до коррекции. */
export interface SeededAccount extends AccountRuntime {
  /** Владелец всех записей */
  readonly accountId: AccountId;
  /** Заявка A после живого исполнения — `PARTIALLY_FILLED` */
  readonly orderA: Order;
  /** Заявка B — `OPEN`, без исполнений */
  readonly orderB: Order;
  /** Исполнение заявки A — `APPLIED`, venue-статус `MATCHED` */
  readonly fillA: Fill;
  /** Портфель после последнего живого события */
  readonly portfolioAfter: Portfolio;
}

/**
 * Собирает аккаунт ровно на версии 5.
 *
 * @returns Рантайм и записи, созданные живым контуром
 *
 * @remarks
 * ```text
 * t=1000  INITIALIZED                          version 1
 * t=2000  ORDER_COMMITTED   A: OPEN            version 2
 * t=3000  FILL_APPLIED      fill-a → A         version 3   (APPLIED)
 * t=3500  VENUE_STATUS      fill-a MATCHED     version 4
 * t=4000  ORDER_COMMITTED   B: OPEN            version 5
 * ```
 */
export async function seedAccount(): Promise<SeededAccount> {
  const runtime = buildRuntime();
  const { bus, events } = runtime;
  const accountId = walletAccount();

  events.observeAt(1_000);
  await publishOk(bus, events.initialized({ accountId, portfolio: portfolio({ accountId }) }));

  const openA = must(order({ id: 'order-a', accountId }).accept());
  events.observeAt(2_000);
  await publishOk(
    bus,
    events.orderCommitted({
      accountId,
      order: openA,
      portfolio: portfolio({ accountId, available: 9_350, reserved: 650 }),
    }),
  );

  const fillA = makeFill({ id: 'fill-a', orderId: 'order-a', accountId, size: 40 });
  const orderA = withFill(openA, { id: 'fill-a', size: 40 });
  events.observeAt(3_000);
  await publishOk(
    bus,
    events.fillApplied({
      fill: fillA,
      order: orderA,
      portfolio: portfolio({ accountId, available: 9_350, reserved: 390 }),
    }),
  );

  events.observeAt(3_500);
  await publishOk(bus, events.fillVenueStatus({ fill: fillA, venueStatus: 'MATCHED' }));

  const orderB = must(order({ id: 'order-b', accountId, timestampMs: 1_700_000_050_000 }).accept());
  const portfolioAfter = portfolio({ accountId, available: 9_000, reserved: 740 });
  events.observeAt(4_000);
  await publishOk(
    bus,
    events.orderCommitted({ accountId, order: orderB, portfolio: portfolioAfter }),
  );

  return { ...runtime, accountId, orderA, orderB, fillA, portfolioAfter };
}

/** Аккаунт из проекции; его отсутствие — дефект самого теста. */
export function accountOf(view: AccountHotStateView, accountId: AccountId): AccountRuntimeStateView {
  const account = view.getAccount(VENUE, accountId);
  if (account === undefined) throw new Error('fixture failed: account is not initialized');
  return account;
}

/**
 * Ссылочный отпечаток состояния: КАЖДЫЙ хранимый объект, обе версии и время.
 *
 * @remarks
 * Сравнение по ссылкам — самая строгая проверка «ничего не записано»: любая
 * запись в `Map`, даже того же содержимого, создала бы новый объект записи.
 */
export interface ReferenceFingerprint {
  readonly globalVersion: number;
  readonly accountVersion: number;
  readonly lastMutationAtMs: number;
  readonly portfolio: Portfolio;
  readonly orders: ReadonlyMap<OrderId, unknown>;
  readonly fills: ReadonlyMap<string, unknown>;
}

/**
 * Снимает ссылочный отпечаток.
 *
 * @param view - Проекция приватного состояния
 * @param accountId - Аккаунт
 * @returns Отпечаток для сравнения через {@link expectUnchanged}
 */
export function fingerprint(view: AccountHotStateView, accountId: AccountId): ReferenceFingerprint {
  const account = accountOf(view, accountId);
  return {
    globalVersion: view.getVersion(),
    accountVersion: account.version,
    lastMutationAtMs: account.lastMutationAt.toNumber(),
    portfolio: account.portfolio,
    orders: new Map(account.orders().map((record) => [record.order.id, record])),
    fills: new Map(account.fills().map((record) => [record.fill.id, record])),
  };
}

/**
 * Требует, чтобы состояние совпало с отпечатком объект в объект.
 *
 * @param view - Проекция приватного состояния
 * @param accountId - Аккаунт
 * @param before - Отпечаток, снятый до проверяемого действия
 * @throws {Error} При первом расхождении
 */
export function expectUnchanged(
  view: AccountHotStateView,
  accountId: AccountId,
  before: ReferenceFingerprint,
): void {
  const after = fingerprint(view, accountId);
  const problems: string[] = [];
  if (after.globalVersion !== before.globalVersion) problems.push('global version');
  if (after.accountVersion !== before.accountVersion) problems.push('account version');
  if (after.lastMutationAtMs !== before.lastMutationAtMs) problems.push('lastMutationAt');
  if (after.portfolio !== before.portfolio) problems.push('portfolio');
  if (after.orders.size !== before.orders.size) problems.push('order count');
  for (const [id, record] of before.orders) {
    if (after.orders.get(id) !== record) problems.push(`order ${id}`);
  }
  if (after.fills.size !== before.fills.size) problems.push('fill count');
  for (const [id, record] of before.fills) {
    if (after.fills.get(id) !== record) problems.push(`fill ${id}`);
  }
  if (problems.length > 0) {
    throw new Error(`state changed: ${problems.join(', ')}`);
  }
}
