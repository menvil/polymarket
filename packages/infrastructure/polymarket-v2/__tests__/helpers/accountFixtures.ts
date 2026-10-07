/**
 * Фикстуры и fake-зависимости account plane.
 *
 * @remarks
 * Ответы SDK собираются в ТОЙ форме, которую отдаёт официальный
 * `@polymarket/client` 0.6.0 после своей zod-валидации: camelCase,
 * `tokenId`, статусы сделки с префиксом `TRADE_STATUS_`, `matchedAt` в ISO.
 *
 * Runtime-код SDK (ESM-only) в CJS-тестах пакета не загружается — как и в его
 * исходниках. Поэтому брендированные строки SDK (`TokenId`, `DecimalString`…)
 * строятся одной функцией {@link sdkString}, а не фабриками `to*` SDK.
 *
 * Сети нет: `listOpenOrders`/`listAccountTrades` отдают fake-страницы,
 * которые считают, сколько страниц реально прочитано, и умеют упасть на
 * заданной.
 */
import type { AuthoritativeOutcomeAssetId } from '@polymarket/account-reconciliation';
import type {
  ConditionId,
  DecimalString,
  IsoDateTimeString,
  TokenId,
  TradeStatus as VendorTradeStatus,
} from '@polymarket/bindings';
import type { ClobTrade, OpenOrder } from '@polymarket/bindings/clob';
import {
  KnownVenues,
  accountIdFromWallet,
  asOrderId,
  asPolymarketCtfToken,
  assetIdToString,
  isPolymarketCtfToken,
  parseWalletAddress,
  type AccountId,
  type MarketId,
  type OrderId,
} from '@polymarket/ids';
import { Err, Ok, type Result } from '@polymarket/result';
import { MoneyService, QuantityService, type Money, type Quantity } from '@polymarket/value-objects';
import {
  PolymarketAccountStateError,
  PolymarketAccountVenueStateSource,
  type PolymarketAuthoritativeBalanceReader,
  type PolymarketSecureAccountClient,
} from '@polymarket/polymarket-v2/account';

/**
 * Брендированная строка SDK (`TokenId`, `ConditionId`, `DecimalString`, …).
 *
 * @param value - Значение
 * @returns То же значение под брендированным типом SDK
 *
 * @remarks
 * Фабрики `to*` SDK делают ровно это (`Tagged<string, …>`), но живут в
 * ESM-only runtime-коде.
 */
export function sdkString<T extends string>(value: string): T {
  return value as T;
}

/** Статусы сделки SDK — значения enum `TradeStatus` `@polymarket/bindings`. */
export const TRADE_STATUS = {
  Matched: 'TRADE_STATUS_MATCHED',
  MatchedNotBroadcasted: 'TRADE_STATUS_MATCHED_NOT_BROADCASTED',
  Mined: 'TRADE_STATUS_MINED',
  Confirmed: 'TRADE_STATUS_CONFIRMED',
  Retrying: 'TRADE_STATUS_RETRYING',
  Failed: 'TRADE_STATUS_FAILED',
} as const satisfies Record<string, `${VendorTradeStatus}`>;

/** Наш адрес maker-заявок — в СМЕШАННОМ регистре, чтобы проверять нормализацию. */
export const OUR_ADDRESS = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';

/** Адрес чужого участника сделки. */
export const OTHER_ADDRESS = '0x9999999999999999999999999999999999999999';

/** Наш API-ключ (owner) в WS-событиях. */
export const OUR_OWNER = '11111111-1111-1111-1111-111111111111';

/** Owner чужого участника сделки. */
export const OTHER_OWNER = '22222222-2222-2222-2222-222222222222';

/** Condition id тестового рынка. */
export const MARKET_A = `0x${'a1'.repeat(32)}` as MarketId;

/** Condition id второго рынка scope. */
export const MARKET_B = `0x${'b2'.repeat(32)}` as MarketId;

/** Token id исхода YES рынка A. */
export const YES_TOKEN_ID = '100000000000000000000000000000000000000000000001';

/** Token id исхода NO рынка A. */
export const NO_TOKEN_ID = '200000000000000000000000000000000000000000000002';

/** Наш аккаунт — кошелёк с нашим адресом. */
export const ACCOUNT: AccountId = (() => {
  const wallet = parseWalletAddress(OUR_ADDRESS.toLowerCase());
  if (wallet === undefined) throw new Error('fixture failed: invalid wallet');
  return accountIdFromWallet(wallet);
})();

/** Чужой аккаунт — для проверок идентичности. */
export const OTHER_ACCOUNT: AccountId = (() => {
  const wallet = parseWalletAddress(OTHER_ADDRESS);
  if (wallet === undefined) throw new Error('fixture failed: invalid wallet');
  return accountIdFromWallet(wallet);
})();

/** Площадка тестов. */
export const VENUE = KnownVenues.POLYMARKET;

/**
 * Outcome-актив по token id.
 *
 * @param tokenId - Числовой token id
 * @returns `POLYMARKET_CTF_TOKEN`
 */
export function outcomeAsset(tokenId: string): AuthoritativeOutcomeAssetId {
  const asset = asPolymarketCtfToken(tokenId);
  if (asset === undefined || !isPolymarketCtfToken(asset)) throw new Error('fixture failed: invalid token');
  return asset;
}

/** Исход YES рынка A. */
export const YES = outcomeAsset(YES_TOKEN_ID);

/** Исход NO рынка A. */
export const NO = outcomeAsset(NO_TOKEN_ID);

/** Canonical OrderId. */
export function orderId(raw: string): OrderId {
  const id = asOrderId(raw);
  if (id === undefined) throw new Error('fixture failed: invalid order id');
  return id;
}

/** Параметры заявки, которые тест меняет точечно. */
export interface OpenOrderOverrides {
  readonly id?: string;
  readonly tokenId?: string;
  readonly side?: string;
  readonly price?: string;
  readonly originalSize?: string;
  readonly sizeMatched?: string;
  readonly status?: string;
  readonly conditionId?: string;
}

/**
 * Заявка в форме ответа SDK (`listOpenOrders`/`fetchOrder`).
 *
 * @param overrides - Что отличается от живой BUY 10 @ 0.42 без исполнений
 * @returns `OpenOrder`
 */
export function openOrder(overrides: OpenOrderOverrides = {}): OpenOrder {
  return {
    id: overrides.id ?? '0xorder1',
    conditionId: sdkString<ConditionId>(overrides.conditionId ?? MARKET_A),
    tokenId: sdkString<TokenId>(overrides.tokenId ?? YES_TOKEN_ID),
    owner: OUR_OWNER,
    makerAddress: OUR_ADDRESS,
    side: overrides.side ?? 'BUY',
    price: sdkString<DecimalString>(overrides.price ?? '0.42'),
    originalSize: sdkString<DecimalString>(overrides.originalSize ?? '10'),
    sizeMatched: sdkString<DecimalString>(overrides.sizeMatched ?? '0'),
    outcome: 'Yes',
    orderType: 'GTC',
    status: overrides.status ?? 'LIVE',
    associateTrades: [],
    createdAt: sdkString<IsoDateTimeString>('2026-10-01T12:00:00.000Z'),
  };
}

/** Maker-заявка сделки в форме SDK. */
export interface MakerOrderFixture {
  readonly orderId: string;
  readonly tokenId: string;
  readonly side: string;
  readonly price: string;
  readonly matchedAmount: string;
  readonly makerAddress: string;
  readonly owner: string;
  readonly outcome?: string;
}

/** Параметры сделки, которые тест меняет точечно. */
export interface ClobTradeOverrides {
  readonly id?: string;
  readonly conditionId?: string;
  readonly tokenId?: string;
  readonly owner?: string;
  readonly takerOrderId?: string;
  readonly side?: string;
  readonly traderSide?: 'TAKER' | 'MAKER';
  readonly price?: string;
  readonly size?: string;
  readonly status?: string;
  readonly feeRateBps?: string;
  readonly makerOrders?: readonly MakerOrderFixture[];
  readonly matchedAtSeconds?: number;
}

/** Время исполнения тестовых сделок, Unix-секунды. */
export const MATCHED_AT_SECONDS = 1_790_000_000;

/**
 * Сделка аккаунта в форме ответа SDK (`listAccountTrades`).
 *
 * @param overrides - Что отличается от нашей TAKER-покупки 10 YES @ 0.57
 * @returns `ClobTrade`
 */
export function clobTrade(overrides: ClobTradeOverrides = {}): ClobTrade {
  const seconds = overrides.matchedAtSeconds ?? MATCHED_AT_SECONDS;
  const iso = sdkString<IsoDateTimeString>(new Date(seconds * 1000).toISOString());
  return {
    id: overrides.id ?? 'trade-1',
    conditionId: sdkString<ConditionId>(overrides.conditionId ?? MARKET_A),
    tokenId: sdkString<TokenId>(overrides.tokenId ?? YES_TOKEN_ID),
    owner: overrides.owner ?? OUR_OWNER,
    makerAddress: OUR_ADDRESS,
    takerOrderId: overrides.takerOrderId ?? '0xtaker-order',
    side: overrides.side ?? 'BUY',
    traderSide: overrides.traderSide ?? 'TAKER',
    price: sdkString<DecimalString>(overrides.price ?? '0.57'),
    size: sdkString<DecimalString>(overrides.size ?? '10'),
    outcome: 'Yes',
    status: overrides.status ?? TRADE_STATUS.Matched,
    feeRateBps: sdkString<DecimalString>(overrides.feeRateBps ?? '0'),
    bucketIndex: 0,
    transactionHash: '0xdeadbeef',
    makerOrders: (overrides.makerOrders ?? [
      {
        orderId: '0xother-maker',
        tokenId: YES_TOKEN_ID,
        side: 'SELL',
        price: '0.57',
        matchedAmount: '10',
        makerAddress: OTHER_ADDRESS,
        owner: OTHER_OWNER,
      },
    ]).map((makerOrder) => ({
      orderId: makerOrder.orderId,
      tokenId: sdkString<TokenId>(makerOrder.tokenId),
      feeRateBps: sdkString<DecimalString>('0'),
      makerAddress: makerOrder.makerAddress,
      matchedAmount: sdkString<DecimalString>(makerOrder.matchedAmount),
      outcome: makerOrder.outcome ?? 'Yes',
      owner: makerOrder.owner,
      price: sdkString<DecimalString>(makerOrder.price),
      side: makerOrder.side,
    })),
    matchedAt: iso,
    updatedAt: iso,
  };
}

/**
 * Fake-страницы SDK: `AsyncIterable` со счётчиком прочитанных страниц.
 *
 * @remarks
 * `failAt` — номер страницы (с нуля), на которой итерация бросает, как
 * бросил бы `Paginated` SDK при сбое запроса страницы.
 */
export class FakePages<T> implements AsyncIterable<{ readonly items: readonly T[] }> {
  /** Сколько страниц отдано потребителю */
  public consumed = 0;

  /**
   * @param _pages - Содержимое страниц
   * @param _failAt - Страница, на которой бросить ошибку
   * @param _error - Что бросить
   */
  constructor(
    private readonly _pages: readonly (readonly T[])[],
    private readonly _failAt?: number,
    private readonly _error: unknown = new Error('page request failed'),
  ) {}

  /** Отдаёт страницы по одной. */
  public async *[Symbol.asyncIterator](): AsyncIterator<{ readonly items: readonly T[] }> {
    for (const [index, items] of this._pages.entries()) {
      if (index === this._failAt) throw this._error;
      this.consumed += 1;
      yield { items };
    }
    if (this._failAt === this._pages.length) throw this._error;
  }
}

/** Fake secure-клиент: заданные страницы и обработчик `fetchOrder`, журнал вызовов. */
export class FakeAccountClient implements PolymarketSecureAccountClient {
  /** Запросы `listOpenOrders` */
  public readonly openOrderRequests: unknown[] = [];
  /** Запросы `listAccountTrades` */
  public readonly tradeRequests: unknown[] = [];
  /** Запросы `fetchOrder` */
  public readonly orderRequests: unknown[] = [];
  /** Страницы открытых заявок */
  public openOrders = new FakePages<OpenOrder>([[]]);
  /** Страницы сделок по рынку (condition id) */
  public readonly trades = new Map<string, FakePages<ClobTrade>>();
  /** Ответ `fetchOrder` */
  public fetchOrderImpl: (orderId: string) => Promise<OpenOrder> = () =>
    Promise.reject(new Error('fetchOrder not configured'));

  /** {@inheritDoc PolymarketSecureAccountClient.listOpenOrders} */
  public listOpenOrders(request?: unknown): AsyncIterable<{ readonly items: readonly OpenOrder[] }> {
    this.openOrderRequests.push(request);
    return this.openOrders;
  }

  /** {@inheritDoc PolymarketSecureAccountClient.fetchOrder} */
  public fetchOrder(request: { orderId: string }): Promise<OpenOrder> {
    this.orderRequests.push(request);
    return this.fetchOrderImpl(request.orderId);
  }

  /** {@inheritDoc PolymarketSecureAccountClient.listAccountTrades} */
  public listAccountTrades(request?: { market?: string }): AsyncIterable<{ readonly items: readonly ClobTrade[] }> {
    this.tradeRequests.push(request);
    return this.trades.get(request?.market ?? '') ?? new FakePages<ClobTrade>([[]]);
  }

  /** Сколько запросов к API сделано вообще. */
  public get requestCount(): number {
    return this.openOrderRequests.length + this.tradeRequests.length + this.orderRequests.length;
  }
}

/** Fake reader балансов: заданные значения, журнал вызовов. */
export class FakeBalanceReader implements PolymarketAuthoritativeBalanceReader {
  /** Вызовы reader-а */
  public readonly calls: string[] = [];
  /** Ответ collateral */
  public collateral: Result<Money, PolymarketAccountStateError> = Ok(money('100'));
  /** Балансы по token id; отсутствие — настоящий ноль */
  public readonly balances = new Map<string, Result<Quantity, PolymarketAccountStateError>>();

  /** {@inheritDoc PolymarketAuthoritativeBalanceReader.getCollateralBalance} */
  public async getCollateralBalance(): Promise<Result<Money, PolymarketAccountStateError>> {
    this.calls.push('collateral');
    return this.collateral;
  }

  /** {@inheritDoc PolymarketAuthoritativeBalanceReader.getOutcomeAssetBalance} */
  public async getOutcomeAssetBalance(
    asset: AuthoritativeOutcomeAssetId,
  ): Promise<Result<Quantity, PolymarketAccountStateError>> {
    this.calls.push(assetIdToString(asset));
    const key = isPolymarketCtfToken(asset) ? asset.tokenId : assetIdToString(asset);
    return this.balances.get(key) ?? Ok(quantity('0'));
  }
}

/** Количество из строки. */
export function quantity(value: string): Quantity {
  const created = QuantityService.create(value);
  if (!created.ok) throw created.error;
  return created.value;
}

/** USDC из строки. */
export function money(value: string): Money {
  const created = MoneyService.create(value, 'USDC');
  if (!created.ok) throw created.error;
  return created.value;
}

/** Отказ reader-а. */
export function readerError(message: string): Result<never, PolymarketAccountStateError> {
  return Err(new PolymarketAccountStateError(message));
}

/**
 * Адаптер на fake-зависимостях.
 *
 * @param client - Fake-клиент
 * @param reader - Fake-reader
 * @returns Готовый адаптер
 */
export function buildSource(
  client: FakeAccountClient = new FakeAccountClient(),
  reader: FakeBalanceReader = new FakeBalanceReader(),
): { source: PolymarketAccountVenueStateSource; client: FakeAccountClient; reader: FakeBalanceReader } {
  const created = PolymarketAccountVenueStateSource.create(
    { venueId: VENUE, accountId: ACCOUNT, makerAddress: OUR_ADDRESS },
    { client, balanceReader: reader },
  );
  if (!created.ok) throw created.error;
  return { source: created.value, client, reader };
}
