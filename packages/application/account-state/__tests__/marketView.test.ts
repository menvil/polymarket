/**
 * Market-centric read model: `buildMarketAccountView(account, market)`.
 *
 * @remarks
 * Состояние наполняется через НАСТОЯЩУЮ шину и проектор, а рынок — настоящим
 * `Market.create()`: представление обязано выбирать данные ровно так, как их
 * хранит нормализованное состояние, и проверять это на заглушке значило бы
 * проверять заглушку.
 *
 * Группировка по исходу идёт строго через `outcome.instrumentId`; инструменты
 * исходов совпадают с инструментами CTF-токенов фикстур.
 */
import { describe, expect, it } from '@jest/globals';
import { asInstrumentId, type AccountId, type InstrumentId, type VenueId } from '@polymarket/ids';
import { Market, MarketState } from '@polymarket/market';
import type { Order } from '@polymarket/order';
import { Portfolio, asPortfolioId } from '@polymarket/portfolio';
import type { Position } from '@polymarket/position';
import { Balance } from '@polymarket/value-objects';
import { TokenBalance } from '@polymarket/value-objects/token-balance';
import {
  AccountIdentityMismatchError,
  buildMarketAccountView,
  type AccountRuntimeStateView,
  type MarketAccountOutcomeView,
  type MarketAccountView,
} from '../src/index.js';
import {
  DOWN_TOKEN,
  MARKET,
  OTHER_VENUE,
  UP_TOKEN,
  VENUE,
  fill as makeFill,
  money,
  must,
  order,
  portfolio,
  position,
  qty,
  token,
  ts,
  walletAccount,
  withFill,
} from './helpers/fixtures.js';
import { accountOf, expectUnchanged, fingerprint } from './helpers/reconciliation.js';
import { buildRuntime, publishOk, type AccountRuntime } from './helpers/runtime.js';

/** Инструмент первого исхода — совпадает с инструментом `UP_TOKEN`. */
const UP_INSTRUMENT = asInstrumentId('100000000000000000000000000000000000000000000001') as InstrumentId;

/** Инструмент второго исхода — совпадает с инструментом `DOWN_TOKEN`. */
const DOWN_INSTRUMENT = asInstrumentId('200000000000000000000000000000000000000000000002') as InstrumentId;

/** Токен ДРУГОГО рынка — его инструмента нет среди исходов тестового рынка. */
const OTHER_MARKET_TOKEN = token('300000000000000000000000000000000000000000000003');

/**
 * Бинарный рынок с исходами UP/DOWN тестовых токенов.
 *
 * @param venueId - Площадка рынка
 * @returns Настоящий `Market`
 */
function binaryMarket(venueId: VenueId = VENUE): Market {
  return must(
    Market.create({
      id: MARKET,
      venueId,
      question: 'Will the test market resolve Up?',
      startsAt: ts(1_700_000_000_000),
      expiresAt: ts(1_700_000_300_000),
      state: MarketState.active(),
      outcomes: [
        { index: 0, label: 'Up', instrumentId: UP_INSTRUMENT },
        { index: 1, label: 'Down', instrumentId: DOWN_INSTRUMENT },
      ],
      family: 'BINARY_OUTCOME',
    }),
  );
}

/** Позиция и её токены: количество и сколько из него зарезервировано под SELL. */
interface Holding {
  readonly quantity: number;
  readonly reserved: number;
}

/**
 * Портфель с позициями по обоим исходам.
 *
 * @param accountId - Владелец
 * @param holdings - Позиция по каждому инструменту; токены собираются так,
 *   чтобы `quantity == available + reserved`
 * @returns Валидный `Portfolio`
 */
function portfolioWith(accountId: AccountId, holdings: ReadonlyMap<InstrumentId, Holding>): Portfolio {
  const positions = new Map<InstrumentId, Position>();
  const tokenBalances = new Map<InstrumentId, TokenBalance>();
  for (const [instrumentId, holding] of holdings) {
    positions.set(instrumentId, position(instrumentId, { quantity: holding.quantity, accountId }));
    tokenBalances.set(
      instrumentId,
      TokenBalance.of(
        instrumentId,
        qty(holding.quantity - holding.reserved),
        qty(holding.reserved),
        accountId,
        VENUE,
      ),
    );
  }
  return must(
    Portfolio.create({
      id: asPortfolioId('portfolio-1'),
      accountId,
      balance: Balance.of(money(9_000), money(1_000), accountId, VENUE),
      positions,
      tokenBalances,
    }),
  );
}

/** Рантайм с одним инициализированным аккаунтом. */
interface Seeded extends AccountRuntime {
  readonly accountId: AccountId;
  /** Портфель, который получают все события сценария */
  readonly book: Portfolio;
}

/**
 * Инициализирует аккаунт.
 *
 * @param book - Портфель аккаунта; по умолчанию — пустой
 * @returns Рантайм и аккаунт
 */
async function seed(book?: (accountId: AccountId) => Portfolio): Promise<Seeded> {
  const runtime = buildRuntime();
  const accountId = walletAccount();
  const initial = book === undefined ? portfolio({ accountId }) : book(accountId);
  runtime.events.observeAt(1_000);
  await publishOk(runtime.bus, runtime.events.initialized({ accountId, portfolio: initial }));
  return { ...runtime, accountId, book: initial };
}

/**
 * Публикует commit заявки с портфелем сценария.
 *
 * @param seeded - Рантайм сценария
 * @param committed - Заявка в нужном статусе
 * @param atMs - Время события
 */
async function commit(seeded: Seeded, committed: Order, atMs: number): Promise<void> {
  seeded.events.observeAt(atMs);
  await publishOk(
    seeded.bus,
    seeded.events.orderCommitted({ accountId: seeded.accountId, order: committed, portfolio: seeded.book }),
  );
}

/**
 * Строит представление и требует успеха.
 *
 * @param account - Состояние аккаунта
 * @param market - Рынок
 * @returns Представление
 */
function viewOf(account: AccountRuntimeStateView, market: Market): MarketAccountView {
  const built = buildMarketAccountView(account, market);
  if (!built.ok) throw built.error;
  return built.value;
}

/** Идентификаторы заявок исхода. */
function orderIds(records: MarketAccountOutcomeView['orders']): string[] {
  return records.map((record) => record.order.id);
}

describe('A. пустой аккаунт по рынку', () => {
  it('оба исхода пусты, токены — ноль, Balance — общий аккаунта', async () => {
    const seeded = await seed();
    const account = accountOf(seeded.view, seeded.accountId);

    const view = viewOf(account, binaryMarket());

    for (const outcome of view.outcomes) {
      expect(outcome.position).toBeUndefined();
      expect(outcome.availableTokens.isZero()).toBe(true);
      expect(outcome.reservedTokens.isZero()).toBe(true);
      expect(outcome.orders).toEqual([]);
      expect(outcome.openOrders).toEqual([]);
      expect(outcome.fills).toEqual([]);
    }
    // Тот же объект, что в портфеле: представление не строит своего баланса.
    expect(view.balance).toBe(account.portfolio.balance);
    expect(view.accountOpenOrders).toEqual([]);
  });
});

describe('B. данные разложены по исходам строго через instrumentId', () => {
  it('позиции, токены, заявки и исполнения каждого исхода не перепутаны', async () => {
    const seeded = await seed((accountId) =>
      portfolioWith(
        accountId,
        new Map([
          [UP_INSTRUMENT, { quantity: 40, reserved: 15 }],
          [DOWN_INSTRUMENT, { quantity: 25, reserved: 0 }],
        ]),
      ),
    );
    const { accountId } = seeded;

    const upBuy = must(order({ id: 'order-up-buy', accountId, asset: UP_TOKEN }).accept());
    const upSell = must(order({ id: 'order-up-sell', accountId, asset: UP_TOKEN, side: 'SELL', size: 15 }).accept());
    const downBuy = must(order({ id: 'order-down-buy', accountId, asset: DOWN_TOKEN }).accept());
    await commit(seeded, upBuy, 2_000);
    await commit(seeded, upSell, 2_100);
    await commit(seeded, downBuy, 2_200);

    const fills = [
      makeFill({ id: 'fill-up-a', accountId, orderId: 'order-up-buy', tokenId: UP_TOKEN, size: 25 }),
      makeFill({ id: 'fill-up-b', accountId, orderId: 'order-up-buy', tokenId: UP_TOKEN, size: 15 }),
      makeFill({ id: 'fill-down', accountId, orderId: 'order-down-buy', tokenId: DOWN_TOKEN, size: 25 }),
    ];
    let atMs = 3_000;
    for (const applied of fills) {
      seeded.events.observeAt(atMs);
      atMs += 100;
      await publishOk(seeded.bus, seeded.events.fillApplied({ fill: applied, portfolio: seeded.book }));
    }

    const account = accountOf(seeded.view, accountId);
    const [up, down] = viewOf(account, binaryMarket()).outcomes;

    expect(up.outcome.instrumentId).toBe(UP_INSTRUMENT);
    expect(up.position?.quantity.value().toString()).toBe('40');
    expect(up.availableTokens.value().toString()).toBe('25');
    expect(up.reservedTokens.value().toString()).toBe('15');
    expect(orderIds(up.orders).sort()).toEqual(['order-up-buy', 'order-up-sell']);
    expect(up.fills.map((record) => record.fill.id)).toEqual(['fill-up-a', 'fill-up-b']);

    expect(down.outcome.instrumentId).toBe(DOWN_INSTRUMENT);
    expect(down.position?.quantity.value().toString()).toBe('25');
    expect(down.availableTokens.value().toString()).toBe('25');
    expect(down.reservedTokens.isZero()).toBe(true);
    expect(orderIds(down.orders)).toEqual(['order-down-buy']);
    expect(down.fills.map((record) => record.fill.id)).toEqual(['fill-down']);

    // Позиция — тот же объект, что в портфеле: выборка, а не копия.
    expect(up.position).toBe(account.portfolio.getPosition(UP_INSTRUMENT));
    expect(down.position).toBe(account.portfolio.getPosition(DOWN_INSTRUMENT));
  });
});

describe('C. терминальные заявки остаются в orders, но не в openOrders', () => {
  it('PENDING / OPEN / PARTIALLY_FILLED — живые; FILLED / CANCELED — только история', async () => {
    const seeded = await seed();
    const { accountId } = seeded;

    const pending = order({ id: 'order-pending', accountId });
    const open = must(order({ id: 'order-open', accountId }).accept());
    const partial = must(order({ id: 'order-partial', accountId }).accept());
    const filled = must(order({ id: 'order-filled', accountId }).accept());
    const canceled = must(must(order({ id: 'order-canceled', accountId }).accept()).cancel('risk'));

    await commit(seeded, pending, 2_000);
    await commit(seeded, open, 2_100);
    await commit(seeded, partial, 2_200);
    await commit(seeded, filled, 2_300);
    await commit(seeded, canceled, 2_400);

    // Частичное и полное исполнение — доменным путём, вместе с заявкой.
    const partialFill = makeFill({ id: 'fill-partial', accountId, orderId: 'order-partial', size: 40 });
    const fullFill = makeFill({ id: 'fill-full', accountId, orderId: 'order-filled', size: 100 });
    seeded.events.observeAt(3_000);
    await publishOk(
      seeded.bus,
      seeded.events.fillApplied({
        fill: partialFill,
        portfolio: seeded.book,
        order: withFill(partial, { id: partialFill.id, size: 40 }),
      }),
    );
    seeded.events.observeAt(3_100);
    await publishOk(
      seeded.bus,
      seeded.events.fillApplied({
        fill: fullFill,
        portfolio: seeded.book,
        order: withFill(filled, { id: fullFill.id, size: 100 }),
      }),
    );

    const [up] = viewOf(accountOf(seeded.view, accountId), binaryMarket()).outcomes;

    expect(up.orders).toHaveLength(5);
    expect(Object.fromEntries(up.orders.map((record) => [record.order.id, record.order.status]))).toEqual({
      'order-pending': 'PENDING',
      'order-open': 'OPEN',
      'order-partial': 'PARTIALLY_FILLED',
      'order-filled': 'FILLED',
      'order-canceled': 'CANCELED',
    });
    expect(up.openOrders.map((record) => record.order.status).sort()).toEqual([
      'OPEN',
      'PARTIALLY_FILLED',
      'PENDING',
    ]);
  });
});

describe('D. заявки другого рынка не протекают в исходы', () => {
  it('чужой инструмент не попадает в outcome.orders/openOrders, но живой — есть в accountOpenOrders', async () => {
    const seeded = await seed();
    const { accountId } = seeded;

    const upLive = must(order({ id: 'order-up-live', accountId, asset: UP_TOKEN }).accept());
    const otherLive = must(order({ id: 'order-other-live', accountId, asset: OTHER_MARKET_TOKEN }).accept());
    const otherDead = must(
      must(order({ id: 'order-other-dead', accountId, asset: OTHER_MARKET_TOKEN }).accept()).cancel('manual'),
    );
    await commit(seeded, upLive, 2_000);
    await commit(seeded, otherLive, 2_100);
    await commit(seeded, otherDead, 2_200);

    const view = viewOf(accountOf(seeded.view, accountId), binaryMarket());
    const [up, down] = view.outcomes;

    expect(orderIds(up.orders)).toEqual(['order-up-live']);
    expect(orderIds(up.openOrders)).toEqual(['order-up-live']);
    expect(down.orders).toEqual([]);
    expect(down.openOrders).toEqual([]);

    // Общий collateral занимают и заявки других рынков — их видно здесь.
    expect(orderIds(view.accountOpenOrders).sort()).toEqual(['order-other-live', 'order-up-live']);
  });
});

describe('E. исполнения сохраняют полную AccountFillRecord', () => {
  it('APPLIED+MATCHED, CONFIRMED+CONFIRMED, REVERTED+FAILED — обе оси видны', async () => {
    const seeded = await seed();
    const { accountId, bus, events } = seeded;
    await commit(seeded, must(order({ id: 'order-1', accountId }).accept()), 2_000);

    const matched = makeFill({ id: 'fill-matched', accountId, size: 10 });
    const confirmed = makeFill({ id: 'fill-confirmed', accountId, size: 10 });
    const failed = makeFill({ id: 'fill-failed', accountId, size: 10 });

    events.observeAt(3_000);
    await publishOk(bus, events.fillApplied({ fill: matched, portfolio: seeded.book }));
    events.observeAt(3_100);
    await publishOk(bus, events.fillVenueStatus({ fill: matched, venueStatus: 'MATCHED' }));

    events.observeAt(4_000);
    await publishOk(bus, events.fillApplied({ fill: confirmed, portfolio: seeded.book }));
    events.observeAt(4_100);
    await publishOk(bus, events.fillVenueStatus({ fill: confirmed, venueStatus: 'CONFIRMED' }));
    events.observeAt(4_200);
    await publishOk(bus, events.fillConfirmed({ fill: confirmed }));

    events.observeAt(5_000);
    await publishOk(bus, events.fillApplied({ fill: failed, portfolio: seeded.book }));
    events.observeAt(5_100);
    await publishOk(bus, events.fillVenueStatus({ fill: failed, venueStatus: 'FAILED' }));
    events.observeAt(5_200);
    await publishOk(bus, events.fillReverted({ fill: failed, portfolio: seeded.book }));

    const account = accountOf(seeded.view, accountId);
    const [up] = viewOf(account, binaryMarket()).outcomes;

    expect(up.fills.map((record) => [record.fill.id, record.status, record.venueStatus])).toEqual([
      ['fill-matched', 'APPLIED', 'MATCHED'],
      ['fill-confirmed', 'CONFIRMED', 'CONFIRMED'],
      ['fill-failed', 'REVERTED', 'FAILED'],
    ]);
    // Записи — те же объекты, что в состоянии: ничего не пересобрано и не отфильтровано.
    for (const record of up.fills) expect(record).toBe(account.getFill(record.fill.id));
  });
});

describe('F. рынок другой площадки', () => {
  it('Err(AccountIdentityMismatchError) с subject MARKET_VENUE и без частичного результата', async () => {
    const seeded = await seed();
    const account = accountOf(seeded.view, seeded.accountId);

    const built = buildMarketAccountView(account, binaryMarket(OTHER_VENUE));

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect('value' in built).toBe(false);
    const error = built.error;
    expect(error).toBeInstanceOf(AccountIdentityMismatchError);
    expect(error.subject).toBe('MARKET_VENUE');
    expect(error.expected).toBe(VENUE);
    expect(error.actual).toBe(OTHER_VENUE);
    expect(error.venueId).toBe(VENUE);
    expect(error.accountId).toBe(account.accountId);
  });
});

describe('G. метаданные аккаунта и порядок исходов сохранены', () => {
  it('версия, время, идентичность, тот же рынок и canonical порядок Market.outcomes', async () => {
    const seeded = await seed();
    await commit(seeded, must(order({ id: 'order-1', accountId: seeded.accountId }).accept()), 2_500);
    const account = accountOf(seeded.view, seeded.accountId);
    const market = binaryMarket();

    const view = viewOf(account, market);

    expect(view.accountVersion).toBe(account.version);
    expect(view.accountVersion).toBe(2);
    expect(view.lastMutationAt).toBe(account.lastMutationAt);
    expect(view.lastMutationAt.toNumber()).toBe(2_500);
    expect(view.accountId).toBe(account.accountId);
    expect(view.venueId).toBe(account.venueId);
    expect(view.market).toBe(market);
    expect(view.outcomes).toHaveLength(2);
    expect(view.outcomes[0].outcome).toBe(market.outcomes[0]);
    expect(view.outcomes[1].outcome).toBe(market.outcomes[1]);
    expect(view.outcomes.map((outcome) => [outcome.outcome.index, outcome.outcome.label])).toEqual([
      [0, 'Up'],
      [1, 'Down'],
    ]);
  });
});

describe('H. только чтение', () => {
  it('состояние не меняется, а builder трогает лишь читающий API аккаунта и портфеля', async () => {
    const seeded = await seed((accountId) =>
      portfolioWith(accountId, new Map([[UP_INSTRUMENT, { quantity: 40, reserved: 10 }]])),
    );
    const { accountId } = seeded;
    await commit(seeded, must(order({ id: 'order-1', accountId }).accept()), 2_000);
    seeded.events.observeAt(3_000);
    await publishOk(
      seeded.bus,
      seeded.events.fillApplied({ fill: makeFill({ accountId }), portfolio: seeded.book }),
    );

    const account = accountOf(seeded.view, accountId);
    const before = fingerprint(seeded.view, accountId);

    // Прокси записывают КАЖДОЕ обращение к аккаунту и портфелю.
    const touchedAccount = new Set<string>();
    const touchedPortfolio = new Set<string>();
    const recordingPortfolio = new Proxy(account.portfolio, {
      get(target, property) {
        touchedPortfolio.add(String(property));
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const recordingAccount = new Proxy(account, {
      get(target, property) {
        touchedAccount.add(String(property));
        if (property === 'portfolio') return recordingPortfolio;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    viewOf(recordingAccount, binaryMarket());
    viewOf(recordingAccount, binaryMarket());

    expectUnchanged(seeded.view, accountId, before);
    const readAccountApi = new Set([
      'venueId',
      'accountId',
      'version',
      'lastMutationAt',
      'portfolio',
      'openOrders',
      'ordersForInstrument',
      'fillsForInstrument',
      'getPosition',
    ]);
    const readPortfolioApi = new Set(['balance', 'availableTokens', 'reservedTokens']);
    expect([...touchedAccount].filter((name) => !readAccountApi.has(name))).toEqual([]);
    expect([...touchedPortfolio].filter((name) => !readPortfolioApi.has(name))).toEqual([]);
  });
});
