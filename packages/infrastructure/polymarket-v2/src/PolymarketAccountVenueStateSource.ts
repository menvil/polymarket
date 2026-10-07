/**
 * Production-адаптер `IAccountVenueStateSource` для Polymarket на официальном
 * `@polymarket/client` 0.6.x.
 *
 * @remarks
 * ```text
 * AccountVenueStateScope
 *         ↓
 * PolymarketAccountVenueStateSource
 *         ├── refreshed collateral                (весь аккаунт)
 *         ├── scoped token balances               (каждый актив scope, ноль явно)
 *         ├── account-wide open orders            (все страницы SDK)
 *         └── complete trades of scoped markets   (каждый рынок scope, все страницы)
 *         ↓
 * AuthoritativeAccountState
 * ```
 *
 * ### Что адаптер делает
 *
 * Один проход `getAccountState()` читает четыре набора, переводит их в
 * canonical-типы и отдаёт ОДНО состояние — либо `Err`, если не удался хотя бы
 * один шаг. Частичного состояния не бывает: всё собирается в локальные
 * переменные и уходит наружу только целиком.
 *
 * ### Чего адаптер НЕ делает
 *
 * ```text
 * НЕТ listPositions                (инвентарь — адресные балансы scope)
 * НЕТ сканирования всей истории    (сделки — только рынков scope)
 * НЕТ предположений о стратегии    (ручная активность аккаунта валидна)
 * НЕТ сборки Portfolio             (только факты площадки)
 * НЕТ сверки и мутаций             (это работа matcher-а)
 * НЕ публикует ExternalMessage и ApplicationEvent — это request/response-порт
 * ```
 *
 * ### Один аккаунт на экземпляр
 *
 * Secure-клиент SDK привязан к конкретным credentials и кошельку, поэтому
 * адаптер фиксирует идентичность аккаунта при создании и отвергает любой
 * запрос с другой парой `venueId + accountId` — ДО обращения к API.
 * Клиент и credentials создаёт composition root (`createSecureClient()`);
 * адаптер не читает ни `process.env`, ни ключей.
 */
import {
  AccountReconciliationSourceError,
  type AccountVenueStateScope,
  type AccountVenueStateSourceOperation,
  type AuthoritativeAccountState,
  type AuthoritativeAssetBalance,
  type AuthoritativeFillState,
  type AuthoritativeOpenOrderState,
  type AuthoritativeOrderState,
  type IAccountVenueStateSource,
} from '@polymarket/account-reconciliation';
import type { ClobTrade, OpenOrder } from '@polymarket/bindings/clob';
import type {
  FetchOrderRequest,
  ListAccountTradesRequest,
  ListOpenOrdersRequest,
} from '@polymarket/client/actions';
import {
  KnownVenues,
  accountIdEquals,
  accountIdToString,
  type AccountId,
  type MarketId,
  type OrderId,
  type VenueId,
} from '@polymarket/ids';
import { Err, Ok, type Result } from '@polymarket/result';
import type { Money } from '@polymarket/value-objects';
import type { PolymarketAuthoritativeBalanceReader } from './PolymarketClobRefreshedBalanceReader.js';
import type { PolymarketTakerFeeRateResolver } from './PolymarketTakerFeeRateResolver.js';
import {
  PolymarketAccountStateError,
  mapPolymarketClobTrade,
  mapPolymarketOpenOrder,
  mapPolymarketOrderState,
  mergeAuthoritativeFills,
  outcomeAssetKey,
} from './polymarketAccountMapping.js';

/**
 * Узкий структурный интерфейс secure-клиента SDK — ровно три чтения.
 *
 * @remarks
 * Настоящий `SecureClient` из `@polymarket/client` ему соответствует
 * (`Paginated<T>` — это `AsyncIterable<Page<T>>`), а тесты подставляют
 * fake без сети. Своего HTTP-клиента нет.
 *
 * `updateBalanceAllowance` сюда не входит: балансы читает отдельный
 * {@link PolymarketAuthoritativeBalanceReader}.
 */
export interface PolymarketSecureAccountClient {
  /** Открытые заявки аккаунта, постранично */
  listOpenOrders(request?: ListOpenOrdersRequest): AsyncIterable<{ readonly items: readonly OpenOrder[] }>;
  /** Одна заявка аккаунта; «не найдено» — `RequestRejectedError` со статусом 404 */
  fetchOrder(request: FetchOrderRequest): Promise<OpenOrder>;
  /** Сделки аккаунта, постранично */
  listAccountTrades(request?: ListAccountTradesRequest): AsyncIterable<{ readonly items: readonly ClobTrade[] }>;
}

/** Идентичность аккаунта, к которому привязан secure-клиент. */
export interface PolymarketAccountVenueStateSourceConfig {
  /** Площадка — обязана быть `POLYMARKET` */
  readonly venueId: VenueId;
  /** Аккаунт, к которому привязаны credentials клиента */
  readonly accountId: AccountId;
  /**
   * EVM-адрес, на который выставляются наши заявки (funder/proxy-кошелёк).
   *
   * @remarks
   * По нему — и только по нему — `FillMapper` находит НАШИ maker-заявки в
   * сделке. Регистр не важен.
   */
  readonly makerAddress: string;
}

/** Зависимости адаптера — готовые, созданные composition root. */
export interface PolymarketAccountVenueStateSourceDependencies {
  /** Secure-клиент SDK (или совместимый fake) */
  readonly client: PolymarketSecureAccountClient;
  /** Источник фактических балансов */
  readonly balanceReader: PolymarketAuthoritativeBalanceReader;
  /**
   * Ставка taker-комиссии по рынку.
   *
   * @remarks
   * Единственный источник комиссии TAKER-исполнений: `feeRateBps` REST-сделки
   * приходит `"0"` и на `Fill.fee` не влияет.
   */
  readonly takerFeeRates: PolymarketTakerFeeRateResolver;
}

/** EVM-адрес: `0x` + 40 hex-символов. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Condition id рынка Polymarket: `0x` + 64 hex-символа. */
const CONDITION_ID = /^0x[0-9a-fA-F]{64}$/;

/**
 * Authoritative текущее состояние одного аккаунта Polymarket.
 *
 * @remarks
 * Все ожидаемые отказы инфраструктуры — `Err(AccountReconciliationSourceError)`
 * с `operation` метода и этапом в тексте (`balances`, `open orders`,
 * `trades market X`, `order lookup`…); исходная ошибка — в `originalError`.
 *
 * @example
 * ```typescript
 * const source = PolymarketAccountVenueStateSource.create(
 *   { venueId: KnownVenues.POLYMARKET, accountId, makerAddress: funder },
 *   {
 *     client: secureClient,
 *     balanceReader: PolymarketClobRefreshedBalanceReader.fromSdk(secureClient, sdk),
 *     takerFeeRates, // PolymarketStaticTakerFeeRateResolver.create([[market, 0.07]])
 *   },
 * );
 * if (source.ok) {
 *   const state = await source.value.getAccountState(venueId, accountId, { marketIds: [market], assets: [up, down] });
 * }
 * ```
 */
export class PolymarketAccountVenueStateSource implements IAccountVenueStateSource {
  /**
   * @param _config - Идентичность аккаунта, адрес maker-заявок — в нижнем регистре
   * @param _deps - Клиент, reader балансов и ставки taker-комиссии
   */
  private constructor(
    private readonly _config: PolymarketAccountVenueStateSourceConfig,
    private readonly _deps: PolymarketAccountVenueStateSourceDependencies,
  ) {}

  /**
   * Создаёт адаптер для одного аккаунта.
   *
   * @param config - Площадка, аккаунт и адрес maker-заявок
   * @param deps - Secure-клиент, reader балансов и ставки taker-комиссии
   * @returns Адаптер либо отказ, если площадка не `POLYMARKET` или адрес не EVM
   *
   * @example
   * ```typescript
   * const source = PolymarketAccountVenueStateSource.create(config, deps);
   * ```
   */
  public static create(
    config: PolymarketAccountVenueStateSourceConfig,
    deps: PolymarketAccountVenueStateSourceDependencies,
  ): Result<PolymarketAccountVenueStateSource, PolymarketAccountStateError> {
    if (config.venueId !== KnownVenues.POLYMARKET) {
      return Err(new PolymarketAccountStateError(`venue must be ${KnownVenues.POLYMARKET}, got ${config.venueId}`));
    }
    if (!EVM_ADDRESS.test(config.makerAddress)) {
      return Err(new PolymarketAccountStateError(`maker address is not an EVM address: ${config.makerAddress}`));
    }
    return Ok(
      new PolymarketAccountVenueStateSource({ ...config, makerAddress: config.makerAddress.toLowerCase() }, deps),
    );
  }

  /**
   * Текущее состояние аккаунта в пределах scope за один проход.
   *
   * @param venueId - Площадка — обязана совпасть с настроенной
   * @param accountId - Аккаунт — обязан совпасть с настроенным
   * @param scope - Рынки (condition id) и outcome-активы текущего торгового контура
   * @returns Состояние целиком либо `Err` с этапом, на котором проход не удался
   *
   * @remarks
   * 1. Идентичность и scope (дубликаты, не-condition-id рынки) — до любых запросов.
   * 2. Collateral и баланс КАЖДОГО актива scope — параллельно, через reader.
   * 3. Все страницы `listOpenOrders()` без фильтра — весь аккаунт.
   * 4. Для каждого рынка scope — все страницы `listAccountTrades({ market })`,
   *    рынки параллельно, страницы внутри запроса последовательно. Фильтр
   *    `makerAddress` НЕ передаётся: эндпоинт уже ограничен аккаунтом, а
   *    фильтр по maker-адресу, по наблюдению legacy, может скрыть
   *    taker-сделки.
   * 5. Сделки → canonical-исполнения (`FillMapper`); комиссия TAKER — по
   *    ставке `takerFeeRates` рынка сделки, не по `feeRateBps` ответа; отказ
   *    резолвера — отказ прохода. Затем слияние повторов, проверка аккаунта,
   *    площадки и рынка каждого исполнения.
   * 6. Проверка `set(assetBalances.asset) == set(scope.assets)`.
   *
   * @example
   * ```typescript
   * const state = await source.getAccountState(venueId, accountId, scope);
   * if (!state.ok) return state; // SOURCE_FAILED, частичного состояния нет
   * ```
   */
  public async getAccountState(
    venueId: VenueId,
    accountId: AccountId,
    scope: AccountVenueStateScope,
  ): Promise<Result<AuthoritativeAccountState, AccountReconciliationSourceError>> {
    const fail = this._failure('getAccountState', venueId, accountId);
    const identity = this._checkIdentity(venueId, accountId);
    if (identity !== undefined) return fail(identity);
    const scopeProblem = checkScope(scope);
    if (scopeProblem !== undefined) return fail(scopeProblem);

    const balances = await this._readBalances(scope);
    if (!balances.ok) return fail(balances.error);

    const openOrders = await this._readOpenOrders();
    if (!openOrders.ok) return fail(openOrders.error);

    const recentFills = await this._readTrades(scope);
    if (!recentFills.ok) return fail(recentFills.error);

    return Ok({
      collateralBalance: balances.value.collateral,
      assetBalances: balances.value.assets,
      openOrders: openOrders.value,
      recentFills: recentFills.value,
    });
  }

  /**
   * Состояние одной заявки на площадке.
   *
   * @param venueId - Площадка — обязана совпасть с настроенной
   * @param accountId - Аккаунт — обязан совпасть с настроенным
   * @param orderId - Заявка
   * @returns Состояние заявки (в том числе терминальное); `undefined` — только
   *   если площадка ответила 404 «order not found»; иначе отказ
   *
   * @remarks
   * Любой другой отказ (401, 403, 429, 500, транспорт, схема ответа) — `Err`,
   * а не `undefined`: «не знаю» и «не смог спросить» — разные ответы.
   * Заявка с идентификатором, отличным от запрошенного, — противоречие
   * ответа, тоже `Err`.
   *
   * @example
   * ```typescript
   * const order = await source.getOrderState(venueId, accountId, orderId);
   * ```
   */
  public async getOrderState(
    venueId: VenueId,
    accountId: AccountId,
    orderId: OrderId,
  ): Promise<Result<AuthoritativeOrderState | undefined, AccountReconciliationSourceError>> {
    const fail = this._failure('getOrderState', venueId, accountId, orderId);
    const identity = this._checkIdentity(venueId, accountId);
    if (identity !== undefined) return fail(identity);

    let order: OpenOrder;
    try {
      order = await this._deps.client.fetchOrder({ orderId: String(orderId) });
    } catch (error) {
      if (isOrderNotFound(error)) return Ok(undefined);
      return fail(new PolymarketAccountStateError(`order lookup ${orderId}: request failed`, { cause: error }));
    }

    const mapped = mapPolymarketOrderState(order);
    if (!mapped.ok) return fail(mapped.error);
    if (mapped.value.orderId !== orderId) {
      return fail(
        new PolymarketAccountStateError(`order lookup ${orderId}: venue returned order ${mapped.value.orderId}`),
      );
    }
    return Ok(mapped.value);
  }

  /**
   * Сверяет запрос с настроенной идентичностью.
   *
   * @param venueId - Площадка запроса
   * @param accountId - Аккаунт запроса
   * @returns Описание расхождения либо `undefined`
   */
  private _checkIdentity(venueId: VenueId, accountId: AccountId): PolymarketAccountStateError | undefined {
    if (venueId !== this._config.venueId || !accountIdEquals(accountId, this._config.accountId)) {
      return new PolymarketAccountStateError(
        `identity: request ${venueId}/${accountIdToString(accountId)} does not match configured ` +
          `${this._config.venueId}/${accountIdToString(this._config.accountId)}`,
      );
    }
    return undefined;
  }

  /**
   * Collateral и балансы всех активов scope — параллельно.
   *
   * @param scope - Scope запроса
   * @returns Collateral и ровно по одному балансу на актив либо первый отказ
   */
  private async _readBalances(
    scope: AccountVenueStateScope,
  ): Promise<Result<{ collateral: Money; assets: readonly AuthoritativeAssetBalance[] }, PolymarketAccountStateError>> {
    const reader = this._deps.balanceReader;
    const [collateral, assets] = await Promise.all([
      guarded('balances', () => reader.getCollateralBalance()),
      Promise.all(scope.assets.map((asset) => guarded('balances', () => reader.getOutcomeAssetBalance(asset)))),
    ]);
    if (!collateral.ok) return Err(collateral.error);

    const balances: AuthoritativeAssetBalance[] = [];
    for (const [index, asset] of scope.assets.entries()) {
      const balance = assets[index];
      if (balance === undefined) {
        return Err(new PolymarketAccountStateError(`balances: ${outcomeAssetKey(asset)}: missing result`));
      }
      if (!balance.ok) return Err(balance.error);
      balances.push({ asset, quantity: balance.value });
    }
    return Ok({ collateral: collateral.value, assets: balances });
  }

  /**
   * Все живые заявки аккаунта — все страницы, без фильтра.
   *
   * @returns Заявки либо отказ; уже прочитанные страницы при отказе не отдаются
   */
  private async _readOpenOrders(): Promise<Result<readonly AuthoritativeOpenOrderState[], PolymarketAccountStateError>> {
    const orders: AuthoritativeOpenOrderState[] = [];
    const seen = new Set<string>();
    try {
      for await (const page of this._deps.client.listOpenOrders()) {
        for (const raw of page.items) {
          const mapped = mapPolymarketOpenOrder(raw);
          if (!mapped.ok) return Err(new PolymarketAccountStateError(`open orders: ${mapped.error.message}`, { cause: mapped.error }));
          const key = String(mapped.value.orderId);
          if (seen.has(key)) return Err(new PolymarketAccountStateError(`open orders: order ${key} returned twice`));
          seen.add(key);
          orders.push(mapped.value);
        }
      }
    } catch (error) {
      return Err(new PolymarketAccountStateError('open orders pagination failed', { cause: error }));
    }
    return Ok(orders);
  }

  /**
   * Все сделки каждого рынка scope → canonical-исполнения.
   *
   * @param scope - Scope запроса
   * @returns Слитые исполнения рынков scope либо отказ
   */
  private async _readTrades(
    scope: AccountVenueStateScope,
  ): Promise<Result<readonly AuthoritativeFillState[], PolymarketAccountStateError>> {
    const perMarket = await Promise.all(scope.marketIds.map((marketId) => this._readMarketTrades(marketId)));
    const collected: AuthoritativeFillState[] = [];
    for (const result of perMarket) {
      if (!result.ok) return Err(result.error);
      collected.push(...result.value);
    }

    const merged = mergeAuthoritativeFills(collected);
    if (!merged.ok) return Err(new PolymarketAccountStateError(`trades: ${merged.error.message}`, { cause: merged.error }));

    const scopeMarkets = new Set(scope.marketIds.map((marketId) => String(marketId).toLowerCase()));
    for (const { fill } of merged.value) {
      if (!accountIdEquals(fill.accountId, this._config.accountId)) {
        return Err(new PolymarketAccountStateError(`trades: fill ${fill.id} belongs to another account`));
      }
      if (fill.venueId !== KnownVenues.POLYMARKET) {
        return Err(new PolymarketAccountStateError(`trades: fill ${fill.id} belongs to venue ${fill.venueId}`));
      }
      if (!scopeMarkets.has(String(fill.marketId).toLowerCase())) {
        return Err(new PolymarketAccountStateError(`trades: fill ${fill.id} belongs to market ${fill.marketId} outside scope`));
      }
    }
    return Ok(merged.value);
  }

  /**
   * Все страницы сделок одного рынка.
   *
   * @param marketId - Condition id рынка
   * @returns Исполнения сделок рынка либо отказ; частичные страницы не отдаются
   */
  private async _readMarketTrades(
    marketId: MarketId,
  ): Promise<Result<readonly AuthoritativeFillState[], PolymarketAccountStateError>> {
    const stage = `trades market ${marketId}`;
    const fills: AuthoritativeFillState[] = [];
    const context = {
      accountId: this._config.accountId,
      makerAddress: this._config.makerAddress,
      takerFeeRates: this._deps.takerFeeRates,
    };
    try {
      for await (const page of this._deps.client.listAccountTrades({ market: String(marketId) })) {
        for (const trade of page.items) {
          const mapped = mapPolymarketClobTrade(trade, context);
          if (!mapped.ok) return Err(new PolymarketAccountStateError(`${stage}: ${mapped.error.message}`, { cause: mapped.error }));
          fills.push(...mapped.value);
        }
      }
    } catch (error) {
      return Err(new PolymarketAccountStateError(`${stage}: pagination failed`, { cause: error }));
    }
    return Ok(fills);
  }

  /**
   * Фабрика отказа порта для одного вызова.
   *
   * @param operation - Метод порта
   * @param venueId - Площадка запроса
   * @param accountId - Аккаунт запроса
   * @param orderId - Заявка, если это `getOrderState`
   * @returns Функция: внутренняя ошибка → `Err(AccountReconciliationSourceError)`
   */
  private _failure(
    operation: AccountVenueStateSourceOperation,
    venueId: VenueId,
    accountId: AccountId,
    orderId?: OrderId,
  ): (error: PolymarketAccountStateError) => Result<never, AccountReconciliationSourceError> {
    return (error) =>
      Err(
        new AccountReconciliationSourceError(operation, venueId, accountId, error.message, {
          originalError: error,
          ...(orderId === undefined ? {} : { orderId }),
        }),
      );
  }
}

/**
 * Проверяет scope до любых запросов.
 *
 * @param scope - Scope запроса
 * @returns Описание проблемы либо `undefined`
 *
 * @remarks
 * Scope — множество. Дубликат — почти всегда ошибка вызывающего, и молча его
 * схлопнуть значило бы её скрыть. Рынок, который не является condition id,
 * вернул бы пустую выборку сделок, неотличимую от «сделок не было».
 */
function checkScope(scope: AccountVenueStateScope): PolymarketAccountStateError | undefined {
  const assets = new Set<string>();
  for (const asset of scope.assets) {
    const key = outcomeAssetKey(asset);
    if (assets.has(key)) return new PolymarketAccountStateError(`scope: duplicate asset ${key}`);
    assets.add(key);
  }
  const markets = new Set<string>();
  for (const marketId of scope.marketIds) {
    const key = String(marketId).toLowerCase();
    if (!CONDITION_ID.test(String(marketId))) {
      return new PolymarketAccountStateError(`scope: market ${marketId} is not a Polymarket condition id`);
    }
    if (markets.has(key)) return new PolymarketAccountStateError(`scope: duplicate market ${marketId}`);
    markets.add(key);
  }
  return undefined;
}

/**
 * Ответ CLOB «заявка не найдена»: `RequestRejectedError` со статусом 404.
 *
 * @param error - Исключение `fetchOrder`
 * @returns `true` только для 404 от площадки
 *
 * @remarks
 * Проверка структурная — по `name` и `status`, которые объявляет класс
 * `RequestRejectedError` SDK (`name: "RequestRejectedError"`,
 * `readonly status: number`), — а не `instanceof`: runtime-код SDK пакет не
 * загружает. 401/403/429/500, транспорт и ошибки схемы сюда не попадают.
 */
function isOrderNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === 'RequestRejectedError' && 'status' in error && error.status === 404;
}

/**
 * Вызывает reader, превращая нарушение его контракта (исключение) в отказ.
 *
 * @param stage - Этап — для текста ошибки
 * @param read - Чтение reader-а
 * @returns Результат reader-а либо отказ с исходным исключением
 */
async function guarded<T>(
  stage: string,
  read: () => Promise<Result<T, PolymarketAccountStateError>>,
): Promise<Result<T, PolymarketAccountStateError>> {
  try {
    const result = await read();
    if (!result.ok) return Err(new PolymarketAccountStateError(`${stage}: ${result.error.message}`, { cause: result.error }));
    return result;
  } catch (error) {
    return Err(new PolymarketAccountStateError(`${stage}: reader threw instead of returning Err`, { cause: error }));
  }
}
