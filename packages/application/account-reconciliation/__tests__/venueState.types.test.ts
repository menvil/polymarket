/**
 * Контракт authoritative текущего состояния площадки: что в нём ЕСТЬ и чего в
 * нём быть НЕ может.
 *
 * @remarks
 * Главные проверки — на этапе компиляции: `tsc --noEmit` включает
 * `__tests__`, а ts-jest компилирует файл перед запуском. Если из контракта
 * исчезнет запрет (`PENDING` станет допустимым, `tradeStatus` —
 * необязательным, у баланса актива появятся лоты, у заявки — `strategyId`, у
 * исполнения — origin, в `openOrders` пройдёт терминальная заявка, в
 * outcome-актив — `CURRENCY`, а состояние снова обрастёт `positions`/`fills`),
 * то неиспользованный `@ts-expect-error` или неверное `Equal<…>` сломают
 * компиляцию, а не runtime-ассерт.
 *
 * Отсутствие поля проверяется через `keyof`, а не рефлексией: интерфейс —
 * контракт для адаптера, и вопрос «может ли адаптер передать `strategyId`»
 * решает компилятор, а не содержимое конкретного объекта.
 *
 * Все импорты контракта — из корня пакета: заодно фиксируется публичный
 * экспорт.
 */
import { describe, expect, it } from '@jest/globals';
import type { ExecutionMetadata, TradeStatus } from '@polymarket/fill';
import { Ok, type Result } from '@polymarket/result';
import {
  AssetIdHelpers,
  BinaryOutcome,
  KnownOnChainProtocols,
  asMarketId,
  asOrderId,
  asPolymarketCtfToken,
  assetIdToString,
  isOutcomeTokenAsset,
  isPolymarketCtfToken,
  type AccountId,
  type AssetId,
  type ChainId,
  type ConditionId,
  type MarketId,
  type OrderId,
  type VenueId,
} from '@polymarket/ids';
import {
  MoneyService,
  OutcomePriceService,
  QuantityService,
  type Money,
  type Quantity,
  type Side,
} from '@polymarket/value-objects';
import {
  AccountReconciliationSourceError,
  type AccountVenueStateScope,
  type AccountVenueStateSourceOperation,
  type AuthoritativeAccountState,
  type AuthoritativeAssetBalance,
  type AuthoritativeFillMetadata,
  type AuthoritativeFillState,
  type AuthoritativeOpenOrderState,
  type AuthoritativeOpenOrderStatus,
  type AuthoritativeOrderState,
  type AuthoritativeOrderStatus,
  type AuthoritativeOutcomeAssetId,
  type IAccountVenueStateSource,
} from '../src/index.js';
import { UP_TOKEN, VENUE, fill, must, portfolio, walletAccount } from './helpers/fixtures.js';

/**
 * Точное равенство типов.
 *
 * @remarks
 * Взаимная присваиваемость (`A extends B` и `B extends A`) здесь не годится:
 * она не отличает `readonly`/необязательность и схлопывает `any`. Сравнение
 * через отложенные условные типы требует ИДЕНТИЧНОСТИ.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const ORDER_ID = asOrderId('order-1') as OrderId;

/** Рынок фикстур — тот же, на котором `fill()` создаёт исполнения. */
const MARKET = asMarketId('market-btc-updown') as MarketId;

/**
 * Сырой CTF-токен, суженный до outcome-актива.
 *
 * @remarks
 * `asPolymarketCtfToken` отдаёт широкий `AssetId`; сужение — canonical-guard,
 * ровно так, как это будет делать адаптер.
 *
 * @param asset - Широкий `AssetId` CTF-токена
 * @returns Тот же актив как `AuthoritativeOutcomeAssetId`
 */
function ctfToken(asset: AssetId | undefined): AuthoritativeOutcomeAssetId {
  if (asset === undefined || !isPolymarketCtfToken(asset)) throw new Error('fixture failed: not a CTF token');
  return asset;
}

/** Исход YES рынка фикстур. */
const YES_TOKEN = ctfToken(UP_TOKEN);
/** Исход NO рынка фикстур. */
const NO_TOKEN = ctfToken(asPolymarketCtfToken('100000000000000000000000000000000000000000000002'));
/** Токен рынка вне scope. */
const OUT_OF_SCOPE_TOKEN = ctfToken(asPolymarketCtfToken('100000000000000000000000000000000000000000000099'));

/** On-chain outcome-токен (`OUTCOME_TOKEN`) — второй допустимый вариант outcome-актива. */
const ONCHAIN_UP: AuthoritativeOutcomeAssetId = (() => {
  const asset = must<AssetId>(
    AssetIdHelpers.fromOutcomeToken(
      {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: 137 as ChainId,
        conditionId: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd' as ConditionId,
      },
      BinaryOutcome.UP,
    ),
  );
  if (!isOutcomeTokenAsset(asset)) throw new Error('fixture failed: not an OUTCOME_TOKEN');
  return asset;
})();

/** Количество из числа. */
function qty(value: number): Quantity {
  return must(QuantityService.create(value));
}

/** USDC из числа. */
function usdc(value: number): Money {
  return must(MoneyService.create(value, 'USDC'));
}

/**
 * Состояние заявки площадки с согласованным исполнением.
 *
 * @remarks
 * Объём 10; исполнено — 0 у `OPEN` и терминальных без исполнения, 4 у
 * `PARTIALLY_FILLED`, 10 у `FILLED` — документированные инварианты
 * `AuthoritativeOrderState`. Статус выводится литералом, поэтому
 * `venueOrder('OPEN')` годится в `openOrders`, а `venueOrder('FILLED')` — нет.
 */
function venueOrder<S extends AuthoritativeOrderStatus>(
  status: S,
  side: Side = 'BUY',
): AuthoritativeOrderState & { readonly status: S } {
  const filled = status === 'FILLED' ? 10 : status === 'PARTIALLY_FILLED' ? 4 : 0;
  return {
    orderId: ORDER_ID,
    asset: YES_TOKEN,
    side,
    price: must(OutcomePriceService.create(0.42)),
    size: qty(10),
    filledSize: qty(filled),
    status,
  };
}

/** Что «знает площадка» в fake-источнике. */
interface VenueFacts {
  readonly collateral: Money;
  /** Балансы по `assetIdToString`; актива нет — аккаунт его не держит */
  readonly balances: ReadonlyMap<string, Quantity>;
  readonly openOrders: readonly AuthoritativeOpenOrderState[];
  /** Терминальные заявки, которые знает адресный `getOrderState` */
  readonly closedOrders: readonly AuthoritativeOrderState[];
  /** Свежие сделки аккаунта на всех рынках */
  readonly trades: readonly AuthoritativeFillState[];
}

/** Факты площадки с пустыми наборами по умолчанию. */
function venueFacts(overrides: Partial<VenueFacts> = {}): VenueFacts {
  return {
    collateral: usdc(1_000),
    balances: new Map(),
    openOrders: [],
    closedOrders: [],
    trades: [],
    ...overrides,
  };
}

/**
 * Минимальная реализация порта — модель семантики scope.
 *
 * @remarks
 * Её существование — тоже проверка: порт реализуем одними canonical-типами,
 * без `Portfolio`, `Position`, canonical `Order` и без какого-либо знания о
 * локальном состоянии.
 *
 * Семантика scope, которую обязан соблюдать настоящий адаптер:
 * - `assetBalances` — ровно по одному на каждый `scope.assets`, ноль явно,
 *   активов вне scope нет;
 * - `recentFills` — только сделки на `scope.marketIds`;
 * - `collateralBalance` и `openOrders` — на весь аккаунт, от scope не зависят.
 */
class InMemoryVenueStateSource implements IAccountVenueStateSource {
  /** Scope каждого вызова `getAccountState`, по порядку */
  public readonly scopes: AccountVenueStateScope[] = [];

  constructor(private readonly _facts: VenueFacts) {}

  async getAccountState(
    _venueId: VenueId,
    _accountId: AccountId,
    scope: AccountVenueStateScope,
  ): Promise<Result<AuthoritativeAccountState, AccountReconciliationSourceError>> {
    this.scopes.push(scope);
    return Ok({
      collateralBalance: this._facts.collateral,
      assetBalances: scope.assets.map((asset) => ({
        asset,
        quantity: this._facts.balances.get(assetIdToString(asset)) ?? qty(0),
      })),
      openOrders: this._facts.openOrders,
      recentFills: this._facts.trades.filter((trade) => scope.marketIds.includes(trade.fill.marketId)),
    });
  }

  async getOrderState(
    _venueId: VenueId,
    _accountId: AccountId,
    orderId: OrderId,
  ): Promise<Result<AuthoritativeOrderState | undefined, AccountReconciliationSourceError>> {
    const known: readonly AuthoritativeOrderState[] = [...this._facts.openOrders, ...this._facts.closedOrders];
    return Ok(known.find((order) => order.orderId === orderId));
  }
}

/** Множество активов в каноническом строковом виде. */
function assetKeys(assets: readonly AuthoritativeOutcomeAssetId[]): string[] {
  return assets.map((asset) => assetIdToString(asset)).sort();
}

describe('AuthoritativeAccountState: факты текущего торгового контура, а не Portfolio', () => {
  it('состоит ровно из collateralBalance, assetBalances, openOrders, recentFills — без positions/fills/available', () => {
    const keys: Equal<
      keyof AuthoritativeAccountState,
      'collateralBalance' | 'assetBalances' | 'openOrders' | 'recentFills'
    > = true;
    void keys;

    const withPositions: AuthoritativeAccountState = {
      collateralBalance: usdc(1_000),
      assetBalances: [],
      openOrders: [],
      recentFills: [],
      // @ts-expect-error — account-wide листинга позиций в контракте нет: балансы — адресно по scope
      positions: [],
    };
    void withPositions;

    const withFills: AuthoritativeAccountState = {
      collateralBalance: usdc(1_000),
      assetBalances: [],
      openOrders: [],
      recentFills: [],
      // @ts-expect-error — полной истории исполнений нет: только recentFills
      fills: [],
    };
    void withFills;

    const withAvailable: AuthoritativeAccountState = {
      collateralBalance: usdc(1_000),
      assetBalances: [],
      openOrders: [],
      recentFills: [],
      // @ts-expect-error — резервация — наша форма представления; площадка её не сообщает
      availableCollateral: usdc(750),
    };
    void withAvailable;

    // @ts-expect-error — локальный Portfolio не является состоянием площадки
    const fromPortfolio: AuthoritativeAccountState = portfolio({ accountId: walletAccount() });
    void fromPortfolio;
    expect(true).toBe(true);
  });
});

describe('AccountVenueStateScope: пределы задаёт вызывающий', () => {
  it('состоит ровно из marketIds и assets; лимита числа исполнений нет', () => {
    const keys: Equal<keyof AccountVenueStateScope, 'marketIds' | 'assets'> = true;
    void keys;

    const withLimit: AccountVenueStateScope = {
      marketIds: [MARKET],
      assets: [YES_TOKEN, NO_TOKEN],
      // @ts-expect-error — глубина recentFills — деталь адаптера, а не application-контракта
      recentFillLimit: 1000,
    };
    void withLimit;
    expect(true).toBe(true);
  });

  it('CURRENCY в scope.assets — ошибка компиляции', () => {
    const scope: AccountVenueStateScope = {
      marketIds: [MARKET],
      // @ts-expect-error — collateral не outcome-актив: он account-wide в collateralBalance
      assets: [{ type: 'CURRENCY', currency: 'USDC' }],
    };
    void scope;
    expect(true).toBe(true);
  });

  it('getAccountState принимает scope третьим аргументом', () => {
    const parameters: Equal<
      Parameters<IAccountVenueStateSource['getAccountState']>,
      [venueId: VenueId, accountId: AccountId, scope: AccountVenueStateScope]
    > = true;
    void parameters;
    expect(true).toBe(true);
  });
});

describe('assetBalances: ровно активы scope, ноль — явно', () => {
  it('scope [YES, NO] → [{ YES, 5 }, { NO, 0 }]: ноль представлен записью, актив вне scope не возвращается', async () => {
    const accountId = walletAccount();
    const source = new InMemoryVenueStateSource(
      venueFacts({
        balances: new Map([
          [assetIdToString(YES_TOKEN), qty(5)],
          // Аккаунт держит токен другого рынка — scope его не просит.
          [assetIdToString(OUT_OF_SCOPE_TOKEN), qty(3)],
        ]),
      }),
    );
    const scope: AccountVenueStateScope = { marketIds: [MARKET], assets: [YES_TOKEN, NO_TOKEN] };

    const state = await source.getAccountState(VENUE, accountId, scope);
    if (!state.ok) throw state.error;
    const balances = state.value.assetBalances;

    expect(balances.map((balance) => [assetIdToString(balance.asset), balance.quantity.value().toString()])).toEqual([
      [assetIdToString(YES_TOKEN), '5'],
      [assetIdToString(NO_TOKEN), '0'],
    ]);
    // set(assetBalances.asset) == set(scope.assets), без дубликатов и лишних.
    expect(assetKeys(balances.map((balance) => balance.asset))).toEqual(assetKeys(scope.assets));
    expect(new Set(assetKeys(balances.map((balance) => balance.asset))).size).toBe(balances.length);
    expect(source.scopes).toEqual([scope]);
  });

  it('collateralBalance и openOrders — на весь аккаунт и от scope не зависят', async () => {
    const accountId = walletAccount();
    const source = new InMemoryVenueStateSource(
      venueFacts({ collateral: usdc(1_000), openOrders: [venueOrder('OPEN')] }),
    );

    const empty = await source.getAccountState(VENUE, accountId, { marketIds: [], assets: [] });
    if (!empty.ok) throw empty.error;
    expect(empty.value.collateralBalance.value().toString()).toBe('1000');
    expect(empty.value.openOrders).toHaveLength(1);
    expect(empty.value.assetBalances).toEqual([]);
  });

  it('поля баланса — ровно asset и quantity; CURRENCY и лоты запрещены', () => {
    const keys: Equal<keyof AuthoritativeAssetBalance, 'asset' | 'quantity'> = true;
    void keys;

    // @ts-expect-error — collateral не баланс outcome-актива
    const currency: AuthoritativeAssetBalance = { asset: { type: 'CURRENCY', currency: 'USDC' }, quantity: qty(1) };
    void currency;

    const withLots: AuthoritativeAssetBalance = {
      asset: YES_TOKEN,
      quantity: qty(10),
      // @ts-expect-error — площадка лотов не знает; лоты — локальная provenance
      lots: [],
    };
    void withLots;
    expect(true).toBe(true);
  });
});

describe('recentFills: ограниченное свежее свидетельство на рынках scope', () => {
  it('содержит только сделки рынков scope.marketIds', async () => {
    const accountId = walletAccount();
    const trade: AuthoritativeFillState = {
      fill: fill({ id: 'fill-1', orderId: 'order-1', accountId, size: 4 }),
      metadata: { tradeStatus: 'MATCHED', liquidity: 'MAKER' },
    };
    const source = new InMemoryVenueStateSource(venueFacts({ trades: [trade] }));

    const inScope = await source.getAccountState(VENUE, accountId, { marketIds: [MARKET], assets: [] });
    const outOfScope = await source.getAccountState(VENUE, accountId, { marketIds: [], assets: [] });

    expect(inScope.ok && inScope.value.recentFills).toEqual([trade]);
    expect(outOfScope.ok && outOfScope.value.recentFills).toEqual([]);
  });
});

describe('AuthoritativeOutcomeAssetId: только outcome-активы', () => {
  it('OUTCOME_TOKEN и POLYMARKET_CTF_TOKEN допустимы, CURRENCY — ошибка компиляции', () => {
    const ctf: AuthoritativeOutcomeAssetId = YES_TOKEN;
    const onChain: AuthoritativeOutcomeAssetId = ONCHAIN_UP;
    expect([ctf.type, onChain.type]).toEqual(['POLYMARKET_CTF_TOKEN', 'OUTCOME_TOKEN']);

    // @ts-expect-error — collateral не outcome-актив: он живёт в collateralBalance: Money
    const currency: AuthoritativeOutcomeAssetId = { type: 'CURRENCY', currency: 'USDC' };
    void currency;

    // @ts-expect-error — широкий AssetId (может быть CURRENCY) без сужения не принимается
    const unchecked: AuthoritativeOutcomeAssetId = AssetIdHelpers.USDC;
    void unchecked;
  });

  it('состав закреплён: новый вариант AssetId не станет outcome-активом молча', () => {
    const exact: Equal<
      AuthoritativeOutcomeAssetId,
      Extract<AssetId, { readonly type: 'OUTCOME_TOKEN' | 'POLYMARKET_CTF_TOKEN' }>
    > = true;
    void exact;
    expect(true).toBe(true);
  });

  it('CURRENCY запрещён и в активе заявки', () => {
    // @ts-expect-error — актив заявки — outcome-токен
    const order: AuthoritativeOrderState = { ...venueOrder('OPEN'), asset: { type: 'CURRENCY', currency: 'USDC' } };
    void order;
    expect(true).toBe(true);
  });
});

describe('AuthoritativeOrderState: только факты, которыми владеет площадка', () => {
  it('поля — ровно venue-owned; локальные strategyId/decisionId/intentId/timestamp/reason/fillIds не нужны', () => {
    const keys: Equal<
      keyof AuthoritativeOrderState,
      'orderId' | 'asset' | 'side' | 'price' | 'size' | 'filledSize' | 'status'
    > = true;
    void keys;

    // Валидно без каких-либо локальных полей.
    const minimal: AuthoritativeOrderState = venueOrder('OPEN');
    expect(minimal.status).toBe('OPEN');

    const withStrategy: AuthoritativeOrderState = {
      ...minimal,
      // @ts-expect-error — автор заявки — локальное знание; площадка его не сообщает
      strategyId: 'strategy-123',
    };
    void withStrategy;
  });

  it('PENDING не может быть authoritative-статусом', () => {
    // @ts-expect-error — PENDING — локальный жизненный цикл до приёма площадкой
    const pending: AuthoritativeOrderStatus = 'PENDING';
    void pending;

    // @ts-expect-error — и внутри состояния заявки тоже
    const pendingOrder: AuthoritativeOrderState = { ...venueOrder('OPEN'), status: 'PENDING' };
    void pendingOrder;
    expect(true).toBe(true);
  });

  it('состав статусов закреплён: новый OrderStatus не станет authoritative молча', () => {
    // Сломается, если в OrderStatus появится статус: решить, локальный он
    // (добавить в Exclude) или подтверждаемый площадкой (добавить сюда).
    const exact: Equal<
      AuthoritativeOrderStatus,
      'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED'
    > = true;
    void exact;

    const statuses: readonly AuthoritativeOrderStatus[] = [
      'OPEN',
      'PARTIALLY_FILLED',
      'FILLED',
      'CANCELED',
      'REJECTED',
      'EXPIRED',
    ];
    expect(statuses.map((status) => venueOrder(status).status)).toEqual(statuses);
  });

  it('фикстура согласована с инвариантами: FILLED исполнена целиком, OPEN — ничего', () => {
    const filled = venueOrder('FILLED');
    expect(filled.filledSize.equals(filled.size)).toBe(true);
    expect(venueOrder('OPEN').filledSize.isZero()).toBe(true);
    const partial = venueOrder('PARTIALLY_FILLED');
    expect(partial.filledSize.isZero() || partial.filledSize.equals(partial.size)).toBe(false);
  });
});

describe('AuthoritativeOpenOrderState: в openOrders только живые заявки', () => {
  it('OPEN и PARTIALLY_FILLED допустимы в openOrders', () => {
    const open: AuthoritativeAccountState['openOrders'] = [
      venueOrder('OPEN'),
      venueOrder('PARTIALLY_FILLED'),
    ];
    expect(open.map((order) => order.status)).toEqual(['OPEN', 'PARTIALLY_FILLED']);
  });

  it('терминальные FILLED / CANCELED / REJECTED / EXPIRED в openOrders — ошибка компиляции', () => {
    // @ts-expect-error — исполненная заявка ничего не резервирует
    const filled: AuthoritativeAccountState['openOrders'] = [venueOrder('FILLED')];
    void filled;
    // @ts-expect-error — отменённая заявка не живая
    const canceled: AuthoritativeAccountState['openOrders'] = [venueOrder('CANCELED')];
    void canceled;
    // @ts-expect-error — отвергнутая заявка не живая
    const rejected: AuthoritativeAccountState['openOrders'] = [venueOrder('REJECTED')];
    void rejected;
    // @ts-expect-error — истёкшая заявка не живая
    const expired: AuthoritativeAccountState['openOrders'] = [venueOrder('EXPIRED')];
    void expired;

    // Широкий AuthoritativeOrderState без сужения статуса тоже не проходит.
    const wide: AuthoritativeOrderState = venueOrder('OPEN');
    // @ts-expect-error — статус AuthoritativeOrderState может быть терминальным
    const unchecked: AuthoritativeOpenOrderState = wide;
    void unchecked;
    expect(true).toBe(true);
  });

  it('состав статусов живой заявки закреплён; поля те же, что у состояния заявки', () => {
    const exact: Equal<AuthoritativeOpenOrderStatus, 'OPEN' | 'PARTIALLY_FILLED'> = true;
    const sameKeys: Equal<keyof AuthoritativeOpenOrderState, keyof AuthoritativeOrderState> = true;
    void exact;
    void sameKeys;

    // Живая заявка — частный случай состояния заявки.
    const live: AuthoritativeOpenOrderState = venueOrder('OPEN');
    const general: AuthoritativeOrderState = live;
    expect(general.status).toBe('OPEN');
  });

  it('getOrderState по-прежнему отдаёт полный AuthoritativeOrderState — включая терминальный', async () => {
    const returns: Equal<
      Awaited<ReturnType<IAccountVenueStateSource['getOrderState']>>,
      Result<AuthoritativeOrderState | undefined, AccountReconciliationSourceError>
    > = true;
    void returns;

    const accountId = walletAccount();
    const filledId = asOrderId('order-filled') as OrderId;
    const source = new InMemoryVenueStateSource(
      venueFacts({
        openOrders: [venueOrder('PARTIALLY_FILLED')],
        closedOrders: [{ ...venueOrder('FILLED'), orderId: filledId }],
      }),
    );

    const filled = await source.getOrderState(VENUE, accountId, filledId);
    expect(filled.ok && filled.value?.status).toBe('FILLED');
    const live = await source.getOrderState(VENUE, accountId, ORDER_ID);
    expect(live.ok && live.value?.status).toBe('PARTIALLY_FILLED');
    // undefined — «источник не может доказать», а не терминальный статус
    const unknown = await source.getOrderState(VENUE, accountId, asOrderId('order-404') as OrderId);
    expect(unknown).toEqual(Ok(undefined));
  });
});

describe('AuthoritativeFillState: статус сделки на площадке обязателен', () => {
  it('без tradeStatus состояние не компилируется', () => {
    const venueFill = fill({ id: 'fill-1', orderId: 'order-1' });

    // @ts-expect-error — tradeStatus обязателен: сделка в ответе площадки ≠ финальная
    const withoutStatus: AuthoritativeFillState = { fill: venueFill, metadata: { liquidity: 'TAKER' } };
    void withoutStatus;

    // @ts-expect-error — metadata обязательна целиком
    const withoutMetadata: AuthoritativeFillState = { fill: venueFill };
    void withoutMetadata;

    // @ts-expect-error — голый Fill не является authoritative-состоянием исполнения
    const bareFill: AuthoritativeFillState = venueFill;
    void bareFill;

    // @ts-expect-error — Fill[] без venue status нельзя отдать как recentFills
    const bareFills: AuthoritativeAccountState['recentFills'] = [venueFill];
    void bareFills;
    expect(true).toBe(true);
  });

  it('canonical ExecutionMetadata (tradeStatus необязателен) не сужается в authoritative молча', () => {
    const live: ExecutionMetadata = { liquidity: 'MAKER' };
    // @ts-expect-error — у живого потока tradeStatus может не быть; authoritative его требует
    const authoritative: AuthoritativeFillMetadata = live;
    void authoritative;

    // Обратное направление разрешено: authoritative-метаданные — частный случай canonical.
    const widened: ExecutionMetadata = { tradeStatus: 'CONFIRMED' } satisfies AuthoritativeFillMetadata;
    expect(widened.tradeStatus).toBe('CONFIRMED');
  });

  it('метаданные не добавляют своих полей к canonical ExecutionMetadata', () => {
    const sameKeys: Equal<keyof AuthoritativeFillMetadata, keyof ExecutionMetadata> = true;
    void sameKeys;
    expect(true).toBe(true);
  });

  it('принимается любой статус площадки без потери — включая нефинальные и FAILED', () => {
    const venueFill = fill({ id: 'fill-1', orderId: 'order-1' });
    const statuses: readonly TradeStatus[] = ['MATCHED', 'MINED', 'RETRYING', 'CONFIRMED', 'FAILED'];
    const venueFills: AuthoritativeFillState[] = statuses.map((tradeStatus) => ({
      fill: venueFill,
      metadata: { tradeStatus },
    }));
    expect(venueFills.map((venue) => venue.metadata.tradeStatus)).toEqual(statuses);
  });
});

describe('неизвестный инициатор допустим', () => {
  it('ни заявка, ни исполнение, ни их метаданные не несут оси происхождения или локального владения', () => {
    type StateKeys = keyof AuthoritativeOrderState | keyof AuthoritativeFillState | keyof AuthoritativeFillMetadata;
    const noOrigin: Equal<
      Extract<StateKeys, 'origin' | 'initiator' | 'strategyId' | 'decisionId' | 'intentId'>,
      never
    > = true;
    void noOrigin;
    expect(true).toBe(true);
  });

  it('заявка и исполнение, которых рантайм не создавал, — валидное состояние аккаунта', async () => {
    // Заявку создали вне рантайма (UI площадки, другой процесс): локально её
    // нет нигде, и ни одно поле не требует это доказать.
    const accountId = walletAccount();
    const externalOrderId = asOrderId('external-ui-order') as OrderId;
    const externalSell: AuthoritativeOpenOrderState = {
      ...venueOrder('OPEN', 'SELL'),
      orderId: externalOrderId,
      size: qty(5),
    };
    const externalFill: AuthoritativeFillState = {
      fill: fill({ id: 'external-fill', orderId: 'external-ui-buy', accountId, size: 10 }),
      metadata: { tradeStatus: 'CONFIRMED' },
    };
    const source = new InMemoryVenueStateSource(
      venueFacts({
        balances: new Map([[assetIdToString(YES_TOKEN), qty(10)]]),
        openOrders: [externalSell],
        trades: [externalFill],
      }),
    );

    const state = await source.getAccountState(VENUE, accountId, { marketIds: [MARKET], assets: [YES_TOKEN] });
    expect(state.ok && state.value.openOrders.map((order) => order.orderId)).toEqual([externalOrderId]);
    expect(state.ok && state.value.recentFills[0].fill.orderId).toBe('external-ui-buy');

    const order = await source.getOrderState(VENUE, accountId, externalOrderId);
    expect(order.ok && order.value?.side).toBe('SELL');
  });
});

describe('порт состояния площадки', () => {
  it('ровно две операции: getAccountState и getOrderState — отдельного getAssetBalance нет', () => {
    const methods: Equal<keyof IAccountVenueStateSource, 'getAccountState' | 'getOrderState'> = true;
    const operations: Equal<AccountVenueStateSourceOperation, 'getAccountState' | 'getOrderState'> = true;
    const sameAsPort: Equal<AccountVenueStateSourceOperation, keyof IAccountVenueStateSource> = true;
    void methods;
    void operations;
    void sameAsPort;
    expect(true).toBe(true);
  });

  it.each<AccountVenueStateSourceOperation>(['getAccountState', 'getOrderState'])(
    '%s → тот же AccountReconciliationSourceError с SOURCE_FAILED',
    (operation) => {
      const error = new AccountReconciliationSourceError(operation, VENUE, walletAccount(), 'HTTP 503');

      expect(error.failureCode).toBe('SOURCE_FAILED');
      expect(error.operation).toBe(operation);
      expect(error.message).toContain(operation);
    },
  );
});
