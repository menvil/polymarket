/**
 * `PolymarketAccountVenueStateSource` на fake secure-клиенте и fake reader-е.
 *
 * @remarks
 * Сети нет. Проверяется семантика порта `IAccountVenueStateSource`:
 *
 * - полнота scope (`set(assetBalances.asset) == set(scope.assets)`, ноль явно);
 * - привязка к аккаунту клиента при создании (`client.account.wallet`,
 *   `balanceReader.boundWallet`, `makerAddress`, `accountId`);
 * - fail closed ДО запросов (идентичность, дубликаты scope, не-condition-id);
 * - все страницы `listOpenOrders` и `listAccountTrades({ market })`, отказ
 *   любой страницы — `Err` без частичного состояния;
 * - комиссия TAKER — по ставке резолвера рынка, отказ резолвера — `Err`;
 * - `getOrderState`: `undefined` только на 404, всё остальное — `Err`.
 */
import { describe, expect, it } from '@jest/globals';
import { AccountReconciliationSourceError, type IAccountVenueStateSource } from '@polymarket/account-reconciliation';
import type { SecureClient } from '@polymarket/client';
import { KnownVenues, accountIdFromVenue, assetIdToString, unsafeMarketId } from '@polymarket/ids';
import {
  PolymarketAccountVenueStateSource,
  type PolymarketSecureAccountClient,
} from '@polymarket/polymarket-v2/account';
import {
  ACCOUNT,
  FakeAccountClient,
  FakeBalanceReader,
  FakePages,
  FakeTakerFeeRates,
  MARKET_A,
  MARKET_B,
  NO,
  OTHER_ACCOUNT,
  OTHER_ADDRESS,
  OUR_ADDRESS,
  OUR_OWNER,
  TRADE_STATUS,
  VENUE,
  YES,
  YES_TOKEN_ID,
  buildSource,
  clobTrade,
  money,
  openOrder,
  orderId,
  quantity,
  readerError,
} from './helpers/accountFixtures.js';

/**
 * Ошибка в форме `RequestRejectedError` SDK: тот же `name` и `status`.
 *
 * @remarks
 * Класс SDK живёт в ESM-only runtime-коде; адаптер распознаёт отказ
 * структурно — по `name` и `status`, — поэтому форма здесь та же.
 */
class RequestRejectedError extends Error {
  public override readonly name = 'RequestRejectedError';
  constructor(message: string, options: { readonly status: number }) {
    super(message);
    this.status = options.status;
  }
  public readonly status: number;
}

/** Ошибка в форме `TransportError` SDK. */
class TransportError extends Error {
  public override readonly name = 'TransportError';
}

/** Scope одного рынка с обоими исходами. */
const SCOPE = { marketIds: [MARKET_A], assets: [YES, NO] };

/** Разворачивает успешный результат или роняет тест с причиной. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Ожидает отказ порта и возвращает его. */
function failure(result: { ok: boolean; error?: unknown }): AccountReconciliationSourceError {
  expect(result.ok).toBe(false);
  expect(result.error).toBeInstanceOf(AccountReconciliationSourceError);
  return result.error as AccountReconciliationSourceError;
}

describe('контракт и создание', () => {
  it('настоящий SDK SecureClient подходит под узкий интерфейс (compile-time)', () => {
    const accepts = (client: SecureClient): PolymarketSecureAccountClient => client;
    const asPort = (source: PolymarketAccountVenueStateSource): IAccountVenueStateSource => source;
    expect(typeof accepts).toBe('function');
    expect(typeof asPort).toBe('function');
  });

  it('площадка не POLYMARKET или адрес не EVM → отказ создания', () => {
    const deps = {
      client: new FakeAccountClient(),
      balanceReader: new FakeBalanceReader(),
      takerFeeRates: new FakeTakerFeeRates(),
    };
    expect(
      PolymarketAccountVenueStateSource.create({ venueId: 'KALSHI' as never, accountId: ACCOUNT, makerAddress: OUR_ADDRESS }, deps).ok,
    ).toBe(false);
    expect(
      PolymarketAccountVenueStateSource.create({ venueId: VENUE, accountId: ACCOUNT, makerAddress: 'not-an-address' }, deps).ok,
    ).toBe(false);
  });
});

describe('создание: конфигурация обязана описывать аккаунт, к которому привязан клиент', () => {
  /** Зависимости с настраиваемыми кошельками клиента и reader-а. */
  function deps(clientWallet: string = OUR_ADDRESS, readerWallet: string = OUR_ADDRESS) {
    const client = new FakeAccountClient();
    client.account = { wallet: clientWallet };
    const balanceReader = new FakeBalanceReader();
    balanceReader.boundWallet = readerWallet;
    return { client, balanceReader, takerFeeRates: new FakeTakerFeeRates() };
  }

  /** Создание с нашей конфигурацией по умолчанию. */
  function create(
    overrides: Partial<{ accountId: typeof ACCOUNT; makerAddress: string }> = {},
    dependencies = deps(),
  ) {
    return PolymarketAccountVenueStateSource.create(
      { venueId: VENUE, accountId: overrides.accountId ?? ACCOUNT, makerAddress: overrides.makerAddress ?? OUR_ADDRESS },
      dependencies,
    );
  }

  /** Ожидает отказ создания с заданным фрагментом текста и без единого запроса. */
  function expectRejected(result: ReturnType<typeof create>, dependencies: ReturnType<typeof deps>, fragment: string): void {
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(fragment);
    expect(dependencies.client.requestCount).toBe(0);
    expect(dependencies.balanceReader.calls).toEqual([]);
  }

  it('кошельки клиента, reader-а, makerAddress и accountId совпадают (регистр не важен) → адаптер', () => {
    const dependencies = deps(OUR_ADDRESS.toLowerCase(), OUR_ADDRESS.toUpperCase().replace('0X', '0x'));
    expect(create({}, dependencies).ok).toBe(true);
  });

  it('accountId другого кошелька, чем у клиента → отказ', () => {
    const dependencies = deps();
    expectRejected(
      create({ accountId: OTHER_ACCOUNT, makerAddress: OUR_ADDRESS }, dependencies),
      dependencies,
      'is not the secure client account',
    );
  });

  it('клиент привязан к другому кошельку, чем конфигурация (reader — тоже) → отказ', () => {
    const dependencies = deps(OTHER_ADDRESS, OTHER_ADDRESS);
    expectRejected(create({}, dependencies), dependencies, 'is not the secure client wallet');
  });

  it('reader балансов привязан к чужому кошельку → отказ', () => {
    const dependencies = deps(OUR_ADDRESS, OTHER_ADDRESS);
    expectRejected(create({}, dependencies), dependencies, 'balance reader is bound to');
  });

  it('makerAddress — не кошелёк клиента, хотя accountId совпадает → отказ', () => {
    const dependencies = deps();
    expectRejected(create({ makerAddress: OTHER_ADDRESS }, dependencies), dependencies, 'is not the secure client wallet');
  });

  it('accountId не WALLET-вида (VENUE) сверить с кошельком нельзя → отказ', () => {
    const venueAccount = accountIdFromVenue(KnownVenues.POLYMARKET, 'user-1');
    if (!venueAccount.ok) throw venueAccount.error;
    const dependencies = deps();
    expectRejected(create({ accountId: venueAccount.value }, dependencies), dependencies, 'is not the secure client account');
  });

  it('клиент не сообщил кошелёк (не EVM-адрес или геттер бросил) → отказ, а не падение', () => {
    const invalid = deps('not-a-wallet');
    expectRejected(create({}, invalid), invalid, 'secure client wallet is not an EVM address');

    const throwing = deps();
    Object.defineProperty(throwing.client, 'account', {
      get: () => {
        throw new Error('authentication ended');
      },
    });
    expectRejected(create({}, throwing), throwing, 'dependency did not report its wallet');
  });
});

describe('getAccountState: балансы', () => {
  it('collateral — точные Money; scope [YES, NO] → ровно YES и NO, ноль явно', async () => {
    const { source, reader } = buildSource();
    reader.collateral = { ok: true, value: money('1000.5') };
    reader.balances.set(YES_TOKEN_ID, { ok: true, value: quantity('5') });

    const state = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE));

    expect(state.collateralBalance.value().toString()).toBe('1000.5');
    expect(state.assetBalances.map((balance) => [assetIdToString(balance.asset), balance.quantity.value().toString()])).toEqual([
      [assetIdToString(YES), '5'],
      [assetIdToString(NO), '0'],
    ]);
    expect(reader.calls.sort()).toEqual(['collateral', assetIdToString(NO), assetIdToString(YES)].sort());
  });

  it('отказ collateral или баланса актива → Err всего прохода с этапом', async () => {
    const collateralDown = buildSource();
    collateralDown.reader.collateral = readerError('HTTP 503');
    const collateralError = failure(await collateralDown.source.getAccountState(VENUE, ACCOUNT, SCOPE));
    expect(collateralError.operation).toBe('getAccountState');
    expect(collateralError.message).toContain('balances: HTTP 503');

    const assetDown = buildSource();
    assetDown.reader.balances.set(YES_TOKEN_ID, readerError('balance: expected non-negative integer base units'));
    expect(failure(await assetDown.source.getAccountState(VENUE, ACCOUNT, SCOPE)).message).toContain('balances');
  });

  it('reader, бросивший исключение вместо Err, — тоже Err', async () => {
    const { source, reader } = buildSource();
    reader.getCollateralBalance = () => Promise.reject(new Error('bug'));
    expect(failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE)).message).toContain('reader threw');
  });
});

describe('getAccountState: отказ до любых запросов', () => {
  it.each<[string, () => Parameters<PolymarketAccountVenueStateSource['getAccountState']>]>([
    ['чужой аккаунт', () => [VENUE, OTHER_ACCOUNT, SCOPE]],
    ['чужая площадка', () => ['KALSHI' as never, ACCOUNT, SCOPE]],
    ['дубликат актива', () => [VENUE, ACCOUNT, { marketIds: [MARKET_A], assets: [YES, YES] }]],
    ['дубликат рынка', () => [VENUE, ACCOUNT, { marketIds: [MARKET_A, MARKET_A], assets: [YES] }]],
    ['рынок не condition id', () => [VENUE, ACCOUNT, { marketIds: [unsafeMarketId('btc-up-down')], assets: [] }]],
  ])('%s → Err без запросов к API и reader-у', async (_label, args) => {
    const { source, client, reader } = buildSource();
    failure(await source.getAccountState(...args()));
    expect(client.requestCount).toBe(0);
    expect(reader.calls).toEqual([]);
  });
});

describe('getAccountState: открытые заявки всего аккаунта', () => {
  it('все страницы без фильтра; ручная заявка без стратегии — валидна', async () => {
    const { source, client } = buildSource();
    client.openOrders = new FakePages([
      [openOrder({ id: '0xa', sizeMatched: '0' })],
      [openOrder({ id: '0xb', sizeMatched: '4' }), openOrder({ id: '0xmanual', side: 'SELL', tokenId: '300000000000000000000000000000000000000000000003' })],
    ]);

    const state = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE));

    expect(client.openOrderRequests).toEqual([undefined]);
    expect(client.openOrders.consumed).toBe(2);
    expect(state.openOrders.map((order) => [String(order.orderId), order.status])).toEqual([
      ['0xa', 'OPEN'],
      ['0xb', 'PARTIALLY_FILLED'],
      ['0xmanual', 'OPEN'],
    ]);
  });

  it('сбой страницы N → Err, уже прочитанные страницы не отдаются', async () => {
    const { source, client } = buildSource();
    client.openOrders = new FakePages([[openOrder({ id: '0xa' })], [openOrder({ id: '0xb' })]], 1);
    const error = failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE));
    expect(error.message).toContain('open orders');
    expect(client.openOrders.consumed).toBe(1);
  });

  it.each<[string, Parameters<typeof openOrder>[0]]>([
    ['терминальный статус', { status: 'CANCELED' }],
    ['незнакомый статус', { status: 'PAUSED' }],
    ['исполнено больше объёма', { sizeMatched: '11' }],
  ])('%s в списке открытых → Err', async (_label, overrides) => {
    const { source, client } = buildSource();
    client.openOrders = new FakePages([[openOrder(overrides)]]);
    failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE));
  });

  it('одна заявка дважды → Err', async () => {
    const { source, client } = buildSource();
    client.openOrders = new FakePages([[openOrder({ id: '0xa' })], [openOrder({ id: '0xa' })]]);
    failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE));
  });
});

describe('getAccountState: сделки рынков scope', () => {
  it('для каждого рынка — все страницы listAccountTrades({ market }) без makerAddress', async () => {
    const { source, client } = buildSource();
    client.trades.set(MARKET_A, new FakePages([[clobTrade({ id: 'trade-a1' })], [clobTrade({ id: 'trade-a2' })]]));
    client.trades.set(
      MARKET_B,
      new FakePages([[clobTrade({ id: 'trade-b1', conditionId: MARKET_B, status: TRADE_STATUS.Failed })]]),
    );

    const state = unwrap(
      await source.getAccountState(VENUE, ACCOUNT, { marketIds: [MARKET_A, MARKET_B], assets: [YES] }),
    );

    expect(client.tradeRequests).toEqual([{ market: MARKET_A }, { market: MARKET_B }]);
    expect(client.trades.get(MARKET_A)?.consumed).toBe(2);
    expect(state.recentFills.map((fill) => [String(fill.fill.id), fill.metadata.tradeStatus])).toEqual([
      ['trade-a1', 'MATCHED'],
      ['trade-a2', 'MATCHED'],
      ['trade-b1', 'FAILED'],
    ]);
  });

  it('сбой страницы N одного рынка → Err всего прохода, без частичного состояния', async () => {
    const { source, client } = buildSource();
    client.trades.set(MARKET_A, new FakePages([[clobTrade({ id: 'trade-a1' })]]));
    client.trades.set(MARKET_B, new FakePages([[clobTrade({ id: 'trade-b1', conditionId: MARKET_B })]], 1));

    const error = failure(
      await source.getAccountState(VENUE, ACCOUNT, { marketIds: [MARKET_A, MARKET_B], assets: [] }),
    );

    expect(error.message).toContain(`trades market ${MARKET_B}`);
  });

  it('непереводимая сделка (статус без canonical смысла) → Err, а не пропуск', async () => {
    const { source, client } = buildSource();
    client.trades.set(MARKET_A, new FakePages([[clobTrade({ status: TRADE_STATUS.MatchedNotBroadcasted })]]));
    failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE));
  });

  it('исполнение рынка вне scope → Err', async () => {
    const { source, client } = buildSource();
    client.trades.set(MARKET_A, new FakePages([[clobTrade({ conditionId: MARKET_B })]]));
    expect(failure(await source.getAccountState(VENUE, ACCOUNT, SCOPE)).message).toContain('outside scope');
  });

  it('повтор той же сделки на соседних страницах — одна запись', async () => {
    const { source, client } = buildSource();
    client.trades.set(MARKET_A, new FakePages([[clobTrade({ id: 'trade-1' })], [clobTrade({ id: 'trade-1' })]]));
    const state = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE));
    expect(state.recentFills).toHaveLength(1);
  });
});

describe('getAccountState: комиссия TAKER — по ставке резолвера', () => {
  /** Наша MAKER-сделка рынка B: мейкер комиссию не платит. */
  const makerTradeB = clobTrade({
    id: 'trade-maker-b',
    conditionId: MARKET_B,
    traderSide: 'MAKER',
    side: 'SELL',
    makerOrders: [
      {
        orderId: '0xour-maker',
        tokenId: YES_TOKEN_ID,
        side: 'BUY',
        price: '0.57',
        matchedAmount: '10',
        makerAddress: OUR_ADDRESS,
        owner: OUR_OWNER,
      },
    ],
  });

  it('ставка запрашивается для каждой TAKER-сделки по её рынку и не запрашивается для MAKER', async () => {
    const { source, client, takerFeeRates } = buildSource();
    client.trades.set(MARKET_A, new FakePages([[clobTrade({ id: 'trade-a1' })], [clobTrade({ id: 'trade-a2' })]]));
    client.trades.set(MARKET_B, new FakePages([[makerTradeB]]));

    const state = unwrap(
      await source.getAccountState(VENUE, ACCOUNT, { marketIds: [MARKET_A, MARKET_B], assets: [] }),
    );

    expect(takerFeeRates.calls).toEqual([MARKET_A, MARKET_A]);
    const fees = state.recentFills.map(({ fill, metadata }) => [String(fill.id), metadata.liquidity, fill.fee.isZero()]);
    expect(fees).toEqual([
      ['trade-a1', 'TAKER', false],
      ['trade-a2', 'TAKER', false],
      ['trade-maker-b', 'MAKER', true],
    ]);
  });

  it('REST feeRateBps "0" не обнуляет комиссию тейкера', async () => {
    const { source, client } = buildSource();
    client.trades.set(MARKET_A, new FakePages([[clobTrade({ feeRateBps: '0' })]]));
    const state = unwrap(await source.getAccountState(VENUE, ACCOUNT, SCOPE));
    // 10 × 0.07 × 0.57 × 0.43 = 0.17157
    expect(state.recentFills[0]!.fill.fee.quantity.amount().value().toNumber()).toBeCloseTo(0.17157, 8);
  });

  it('отказ резолвера → Err всего прохода, без частичного состояния', async () => {
    const rates = new FakeTakerFeeRates();
    rates.rates.set(String(MARKET_B).toLowerCase(), readerError('fee schedule unavailable'));
    const { source, client } = buildSource(new FakeAccountClient(), new FakeBalanceReader(), rates);
    client.trades.set(MARKET_A, new FakePages([[clobTrade({ id: 'trade-a1' })]]));
    client.trades.set(MARKET_B, new FakePages([[clobTrade({ id: 'trade-b1', conditionId: MARKET_B })]]));

    const error = failure(
      await source.getAccountState(VENUE, ACCOUNT, { marketIds: [MARKET_A, MARKET_B], assets: [] }),
    );

    expect(error.message).toContain(`trades market ${MARKET_B}`);
    expect(error.message).toContain('fee schedule unavailable');
  });
});

describe('getOrderState', () => {
  it.each<[string, Parameters<typeof openOrder>[0], string]>([
    ['OPEN', { status: 'LIVE', sizeMatched: '0' }, 'OPEN'],
    ['PARTIALLY_FILLED', { status: 'LIVE', sizeMatched: '4' }, 'PARTIALLY_FILLED'],
    ['FILLED', { status: 'MATCHED', sizeMatched: '10' }, 'FILLED'],
    ['CANCELED', { status: 'CANCELED', sizeMatched: '4' }, 'CANCELED'],
  ])('%s', async (_label, overrides, expected) => {
    const { source, client } = buildSource();
    client.fetchOrderImpl = (id) => Promise.resolve(openOrder({ ...overrides, id }));

    const state = unwrap(await source.getOrderState(VENUE, ACCOUNT, orderId('0xorder1')));

    expect(client.orderRequests).toEqual([{ orderId: '0xorder1' }]);
    expect(state?.status).toBe(expected);
  });

  it('404 «order not found» → Ok(undefined)', async () => {
    const { source, client } = buildSource();
    client.fetchOrderImpl = () => Promise.reject(new RequestRejectedError('Order not found', { status: 404 }));
    expect(await source.getOrderState(VENUE, ACCOUNT, orderId('0xmissing'))).toEqual({ ok: true, value: undefined });
  });

  it.each<[string, unknown]>([
    ['500', new RequestRejectedError('Internal server error', { status: 500 })],
    ['401', new RequestRejectedError('Unauthorized', { status: 401 })],
    ['транспорт', new TransportError('socket hang up')],
    ['произвольное исключение', new Error('boom')],
  ])('%s → Err, а не undefined', async (_label, rejection) => {
    const { source, client } = buildSource();
    client.fetchOrderImpl = () => Promise.reject(rejection);
    const error = failure(await source.getOrderState(VENUE, ACCOUNT, orderId('0xorder1')));
    expect(error.operation).toBe('getOrderState');
    expect(error.orderId).toBe('0xorder1');
  });

  it('площадка вернула другую заявку → Err', async () => {
    const { source, client } = buildSource();
    client.fetchOrderImpl = () => Promise.resolve(openOrder({ id: '0xsomething-else' }));
    failure(await source.getOrderState(VENUE, ACCOUNT, orderId('0xorder1')));
  });

  it('статус без canonical смысла → Err, а не угаданный', async () => {
    const { source, client } = buildSource();
    client.fetchOrderImpl = (id) => Promise.resolve(openOrder({ id, status: 'INVALID' }));
    failure(await source.getOrderState(VENUE, ACCOUNT, orderId('0xorder1')));
  });

  it('чужая идентичность → Err без запроса', async () => {
    const { source, client } = buildSource();
    failure(await source.getOrderState(VENUE, OTHER_ACCOUNT, orderId('0xorder1')));
    expect(client.requestCount).toBe(0);
  });
});
