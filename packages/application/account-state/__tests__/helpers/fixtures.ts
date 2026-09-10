/**
 * Фикстуры canonical-событий приватного контура.
 *
 * @remarks
 * Всё строится НАСТОЯЩИМИ domain-конструкторами: `Order.create`,
 * `Fill.create`, `Portfolio.create`, `Balance.of`. Подсунуть проектору
 * структурную заглушку через `as unknown as` значило бы проверять не тот код,
 * который поедет в прод: половина инвариантов состояния опирается на
 * `equals()` реальных value objects.
 *
 * Время события задаётся ЯВНО через управляемые часы: в приватном состоянии не
 * должно остаться ни одной зависимости от `Date.now()`, и тест обязан это
 * доказывать, а не полагаться на удачу.
 */
import { PaperClock } from '@polymarket/time';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { TimestampService, type Timestamp } from '@polymarket/timestamp';
import {
  Balance,
  FeeService,
  MoneyService,
  OutcomePriceService,
  QuantityService,
  type Fee,
  type Money,
  type OutcomePrice,
  type Quantity,
  type Side,
} from '@polymarket/value-objects';
import {
  AssetIdHelpers,
  accountIdForSubaccount,
  accountIdFromVenue,
  accountIdFromWallet,
  asFillId,
  asMarketId,
  asOrderId,
  asPolymarketCtfToken,
  asStrategyId,
  asVenueId,
  parseAssetId,
  parseWalletAddress,
  type AccountId,
  type AssetId,
  type FillId,
  type InstrumentId,
  type MarketId,
  type OrderId,
  type StrategyId,
  type VenueId,
} from '@polymarket/ids';
import { Fill } from '@polymarket/fill';
import { Order } from '@polymarket/order';
import { Portfolio, SimplePosition, asPortfolioId } from '@polymarket/portfolio';
import type {
  TradingAccountFillAppliedEvent,
  TradingAccountFillConfirmedEvent,
  TradingAccountFillRevertedEvent,
  TradingAccountInitializedEvent,
  TradingAccountOrderCommittedEvent,
} from '@polymarket/application-events';

/** Разворачивает `Result` фикстуры: отказ здесь — дефект самого теста. */
export function must<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!result.ok) throw new Error(`fixture failed: ${String(result.error)}`);
  return result.value as T;
}

/** Момент времени из миллисекунд. */
export function ts(ms: number): Timestamp {
  return must(TimestampService.create(ms));
}

/** Площадка, на которой живёт основной тестовый аккаунт. */
export const VENUE: VenueId = asVenueId('POLYMARKET') as VenueId;

/** Вторая площадка — для проверки, что namespace'ы не склеиваются. */
export const OTHER_VENUE: VenueId = asVenueId('KALSHI') as VenueId;

/** Рынок, к которому относятся тестовые исполнения. */
export const MARKET: MarketId = asMarketId('market-btc-updown') as MarketId;

/**
 * Кошелёк-аккаунт: у него НЕТ встроенной площадки.
 *
 * @param address - Hex-адрес; по умолчанию основной тестовый кошелёк
 * @returns WALLET-аккаунт
 *
 * @remarks
 * Каждый вызов возвращает НОВЫЙ объект с той же canonical-идентичностью —
 * именно это нужно тесту «два эквивалентных `AccountId` находят один аккаунт».
 */
export function walletAccount(address = '0x1234567890abcdef1234567890abcdef12345678'): AccountId {
  const wallet = parseWalletAddress(address);
  if (wallet === undefined) throw new Error('fixture failed: invalid wallet address');
  return accountIdFromWallet(wallet);
}

/**
 * Venue-аккаунт: площадка встроена в сам идентификатор.
 *
 * @param venueId - Площадка
 * @param userId - Идентификатор пользователя на площадке
 * @returns VENUE-аккаунт
 */
export function venueAccount(venueId: VenueId = VENUE, userId = 'user-1'): AccountId {
  return must(accountIdFromVenue(venueId, userId));
}

/**
 * Субаккаунт над venue-аккаунтом: площадка наследуется от корня.
 *
 * @param venueId - Площадка корневого аккаунта
 * @param name - Имя субаккаунта
 * @returns SUBACCOUNT с VENUE-корнем
 */
export function venueSubaccount(venueId: VenueId = VENUE, name = 'trading'): AccountId {
  return must(accountIdForSubaccount(venueAccount(venueId), name));
}

/** CTF-токен исхода — актив заявок и исполнений. */
export function token(tokenId: string): AssetId {
  const asset = asPolymarketCtfToken(tokenId);
  if (asset === undefined) throw new Error('fixture failed: invalid CTF token');
  return asset;
}

/**
 * CTF-токен, чья canonical-строка длиннее предела `InstrumentId` (128 символов).
 *
 * @remarks
 * Собран НАСТОЯЩЕЙ фабрикой `asPolymarketCtfToken`: она принимает любую
 * непустую строку цифр и длину не ограничивает, а `asInstrumentId` — да.
 * Поэтому такой актив является валидным `AssetId`, но торговым инструментом
 * не становится. Именно этот разрыв контрактов и обязано ловить состояние.
 */
export const UNRESOLVABLE_TOKEN: AssetId = token('9'.repeat(200));

/** Токен исхода UP основного тестового рынка. */
export const UP_TOKEN: AssetId = token('100000000000000000000000000000000000000000000001');

/** Токен исхода DOWN основного тестового рынка. */
export const DOWN_TOKEN: AssetId = token('200000000000000000000000000000000000000000000002');

/**
 * Денежная величина в USDC.
 *
 * @remarks
 * Через service-фасады, а не через `new Decimal(...)`: голый `Decimal` вне
 * `value-objects`/`math` запрещён контрактом границ (ADR, Решение 1), и в
 * фикстурах это правило действует ровно так же, как в продакшн-коде.
 */
export function money(value: number): Money {
  return must(MoneyService.create(value, 'USDC'));
}

/**
 * Комиссия в заданном активе; по умолчанию — USDC.
 *
 * @param value - Величина комиссии
 * @param asset - Актив комиссии
 * @returns Валидная `Fee`
 *
 * @remarks
 * Актив вынесен параметром, потому что `Fee.equals` сравнивает ЕГО ТОЖЕ:
 * «0.07 чего-то» — не факт исполнения. Проверить это можно только парой с
 * равными величинами и разными активами.
 *
 * `Fee` принимает лишь `CURRENCY` и `OUTCOME_TOKEN`, а поддерживаемая валюта
 * в системе одна (USDC) — поэтому вторым активом может быть только
 * {@link OUTCOME_TOKEN_ASSET}, но не CTF-токен исхода.
 */
export function fee(value: number, asset: AssetId = AssetIdHelpers.USDC): Fee {
  return must(FeeService.create(asset, value));
}

/**
 * Актив вида `OUTCOME_TOKEN` — второй допустимый актив комиссии.
 *
 * @remarks
 * Отличается от `UP_TOKEN`/`DOWN_TOKEN`: те имеют тип
 * `POLYMARKET_CTF_TOKEN`, который `FeeService` отвергает.
 */
export const OUTCOME_TOKEN_ASSET: AssetId = (() => {
  const asset = parseAssetId(`OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0x${'a'.repeat(64)}:UP`);
  if (asset === undefined) throw new Error('fixture failed: invalid outcome token asset');
  return asset;
})();

/** Цена исхода. */
export function price(value: number): OutcomePrice {
  return must(OutcomePriceService.create(value));
}

/** Количество. */
export function qty(value: number): Quantity {
  return must(QuantityService.create(value));
}

/** Параметры портфеля, которые тест переопределяет точечно. */
export interface PortfolioOverrides {
  /** Владелец агрегата */
  readonly accountId?: AccountId;
  /** Владелец баланса — отдельно, чтобы проверять расхождение с агрегатом */
  readonly balanceAccountId?: AccountId;
  /** Площадка баланса — отдельно, по той же причине */
  readonly balanceVenueId?: VenueId;
  /** Свободные средства */
  readonly available?: number;
  /** Зарезервированные средства */
  readonly reserved?: number;
  /** Идентификатор портфеля */
  readonly id?: string;
}

/**
 * Портфель с явно управляемой идентичностью.
 *
 * @param overrides - Что отличается от «нормального» портфеля
 * @returns Валидный `Portfolio`
 *
 * @remarks
 * `balanceAccountId`/`balanceVenueId` вынесены отдельными полями специально:
 * состояние проверяет идентичность в ТРЁХ местах, и тест обязан уметь
 * рассогласовать каждое по отдельности.
 */
export function portfolio(overrides: PortfolioOverrides = {}): Portfolio {
  const accountId = overrides.accountId ?? walletAccount();
  const balance = Balance.of(
    money(overrides.available ?? 10_000),
    money(overrides.reserved ?? 0),
    overrides.balanceAccountId ?? accountId,
    overrides.balanceVenueId ?? VENUE,
  );
  return must(
    Portfolio.create({
      id: asPortfolioId(overrides.id ?? 'portfolio-1'),
      accountId,
      balance,
    }),
  );
}

/** Параметры заявки, которые тест переопределяет точечно. */
export interface OrderOverrides {
  readonly id?: string;
  readonly accountId?: AccountId | null;
  readonly asset?: AssetId;
  readonly side?: Side;
  readonly price?: number;
  readonly size?: number;
  readonly timestampMs?: number;
  readonly strategyId?: StrategyId;
}

/**
 * Заявка в статусе `PENDING` — то, что создаёт `Order.create`.
 *
 * @param overrides - Что отличается от «нормальной» заявки
 * @returns Валидный `Order`
 *
 * @remarks
 * `accountId: null` означает «владельца НЕТ» и нужен тесту обязательности
 * владельца; `undefined` в overrides означает «оставить по умолчанию».
 */
export function order(overrides: OrderOverrides = {}): Order {
  const owner = overrides.accountId === null ? undefined : overrides.accountId ?? walletAccount();
  return must(
    Order.create({
      id: asOrderId(overrides.id ?? 'order-1') as OrderId,
      asset: overrides.asset ?? UP_TOKEN,
      side: overrides.side ?? 'BUY',
      price: price(overrides.price ?? 0.65),
      size: qty(overrides.size ?? 100),
      timestamp: ts(overrides.timestampMs ?? 1_700_000_000_000),
      ...(owner === undefined ? {} : { accountId: owner }),
      ...(overrides.strategyId === undefined ? {} : { strategyId: overrides.strategyId }),
    }),
  );
}

/** Идентификатор стратегии для проверки поля идентичности. */
export function strategyId(raw: string): StrategyId {
  return asStrategyId(raw) as StrategyId;
}

/** Параметры исполнения, которые тест переопределяет точечно. */
export interface FillOverrides {
  readonly id?: string;
  readonly orderId?: string;
  readonly accountId?: AccountId;
  readonly venueId?: VenueId;
  readonly marketId?: MarketId;
  readonly tokenId?: AssetId;
  readonly settlementAssetId?: AssetId;
  readonly price?: number;
  readonly size?: number;
  readonly side?: Side;
  readonly timestampMs?: number;
  readonly fee?: number;
  /** Актив комиссии — отдельно от величины, см. {@link fee} */
  readonly feeAsset?: AssetId;
}

/**
 * Исполнение — canonical факт сделки.
 *
 * @param overrides - Что отличается от «нормального» исполнения
 * @returns Валидный `Fill`
 */
export function fill(overrides: FillOverrides = {}): Fill {
  return must(
    Fill.create({
      id: asFillId(overrides.id ?? 'fill-1') as FillId,
      orderId: asOrderId(overrides.orderId ?? 'order-1') as OrderId,
      accountId: overrides.accountId ?? walletAccount(),
      venueId: overrides.venueId ?? VENUE,
      marketId: overrides.marketId ?? MARKET,
      tokenId: overrides.tokenId ?? UP_TOKEN,
      settlementAssetId: overrides.settlementAssetId ?? AssetIdHelpers.USDC,
      price: price(overrides.price ?? 0.65),
      size: qty(overrides.size ?? 40),
      side: overrides.side ?? 'BUY',
      timestamp: ts(overrides.timestampMs ?? 1_700_000_100_000),
      fee: fee(overrides.fee ?? 0, overrides.feeAsset ?? AssetIdHelpers.USDC),
    }),
  );
}

/**
 * Позиция портфеля — настоящая доменная реализация `IPosition`.
 *
 * @param instrumentId - Инструмент позиции
 * @param params - Количество, цена входа и сторона
 * @returns `SimplePosition` из `@polymarket/portfolio`
 *
 * @remarks
 * Именно `SimplePosition`, а не структурная заглушка: тест доказывает, что
 * `getPosition()` читает ИЗ ПОРТФЕЛЯ, и подсовывать в портфель объект, которого
 * домен не признаёт, для такой проверки бессмысленно.
 */
export function position(
  instrumentId: InstrumentId,
  params: { quantity?: number; averageEntryPrice?: number; side?: 'LONG' | 'SHORT' } = {},
): SimplePosition {
  return new SimplePosition({
    instrumentId,
    quantity: qty(params.quantity ?? 40).value(),
    averageEntryPrice: price(params.averageEntryPrice ?? 0.65).value(),
    side: params.side ?? 'LONG',
  });
}

/**
 * Применяет исполнение к заявке — доменный путь `PENDING → … → PARTIALLY_FILLED`.
 *
 * @param source - Заявка, к которой применяется исполнение
 * @param params - Идентификатор исполнения и его объём
 * @returns Заявка после исполнения
 *
 * @remarks
 * Состояние заявки строится ДОМЕНОМ, а не собирается тестом руками: `status`,
 * `filledSize`, `averagePrice` и `fillIds` связаны инвариантами `Order`, и
 * фикстура, обходящая их, проверяла бы не тот объект.
 */
export function withFill(
  source: Order,
  params: { id?: string; size?: number; price?: number } = {},
): Order {
  return must(
    source.applyFill({
      id: asFillId(params.id ?? 'fill-1') as FillId,
      orderId: source.id,
      asset: source.asset,
      side: source.side,
      size: qty(params.size ?? 40),
      price: params.price === undefined ? source.price : price(params.price),
    }),
  );
}

/**
 * Генератор событий с управляемым временем.
 *
 * @remarks
 * `metadata.createdAt` каждого события задаётся вызывающим, поэтому одна и та
 * же последовательность воспроизводима: времена мутаций не зависят от того,
 * когда тест запущен.
 */
export class EventFactory {
  private readonly _clock = new PaperClock(new Date(0));
  private readonly _metadata = new MessageMetadataGenerator({ clock: this._clock });

  /**
   * Устанавливает время следующих событий.
   *
   * @param ms - Момент в миллисекундах эпохи
   */
  public observeAt(ms: number): void {
    this._clock.setTime(new Date(ms));
  }

  /** Canonical metadata с текущим временем. */
  private _envelope() {
    return this._metadata.nextRoot();
  }

  /**
   * `TRADING_ACCOUNT_INITIALIZED`.
   *
   * @param params - Площадка, аккаунт и портфель
   * @returns Canonical событие инициализации
   */
  public initialized(params: {
    venueId?: VenueId;
    accountId: AccountId;
    portfolio: Portfolio;
  }): TradingAccountInitializedEvent {
    return {
      type: 'TRADING_ACCOUNT_INITIALIZED',
      payload: {
        venueId: params.venueId ?? VENUE,
        accountId: params.accountId,
        portfolio: params.portfolio,
      },
      metadata: this._envelope(),
    };
  }

  /**
   * `TRADING_ACCOUNT_ORDER_COMMITTED`.
   *
   * @param params - Владелец, итоговая заявка и итоговый портфель
   * @returns Canonical событие commit'а заявки
   */
  public orderCommitted(params: {
    venueId?: VenueId;
    accountId: AccountId;
    order: Order;
    portfolio: Portfolio;
  }): TradingAccountOrderCommittedEvent {
    return {
      type: 'TRADING_ACCOUNT_ORDER_COMMITTED',
      payload: {
        venueId: params.venueId ?? VENUE,
        accountId: params.accountId,
        order: params.order,
        portfolio: params.portfolio,
      },
      metadata: this._envelope(),
    };
  }

  /**
   * `TRADING_ACCOUNT_FILL_APPLIED`.
   *
   * @param params - Исполнение, итоговый портфель и опциональная заявка
   * @returns Canonical событие применения исполнения
   */
  public fillApplied(params: {
    fill: Fill;
    portfolio: Portfolio;
    order?: Order;
  }): TradingAccountFillAppliedEvent {
    return {
      type: 'TRADING_ACCOUNT_FILL_APPLIED',
      payload: {
        fill: params.fill,
        portfolio: params.portfolio,
        ...(params.order === undefined ? {} : { order: params.order }),
      },
      metadata: this._envelope(),
    };
  }

  /**
   * `TRADING_ACCOUNT_FILL_CONFIRMED`.
   *
   * @param params - Тот же факт исполнения, что был применён
   * @returns Canonical событие подтверждения
   */
  public fillConfirmed(params: { fill: Fill }): TradingAccountFillConfirmedEvent {
    return {
      type: 'TRADING_ACCOUNT_FILL_CONFIRMED',
      payload: { fill: params.fill },
      metadata: this._envelope(),
    };
  }

  /**
   * `TRADING_ACCOUNT_FILL_REVERTED`.
   *
   * @param params - Исполнение, портфель после отката, заявка и причина
   * @returns Canonical событие отката
   */
  public fillReverted(params: {
    fill: Fill;
    portfolio: Portfolio;
    order?: Order;
    reason?: string;
  }): TradingAccountFillRevertedEvent {
    return {
      type: 'TRADING_ACCOUNT_FILL_REVERTED',
      payload: {
        fill: params.fill,
        portfolio: params.portfolio,
        ...(params.order === undefined ? {} : { order: params.order }),
        reason: params.reason ?? 'venue reported FAILED',
      },
      metadata: this._envelope(),
    };
  }
}

/**
 * Логгер-заглушка для `EventBus`.
 *
 * @remarks
 * Шина нужна настоящая — проверяется весь путь `IEventBus → projector →
 * state`, включая critical-подписки. А вот вывод шины в тестовый лог не нужен
 * никому: отвергнутые события здесь ожидаемы и проверяются по `Err`, а не по
 * строкам в консоли.
 */
export const silentLogger = (() => {
  const logger: Record<string, unknown> = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
  };
  logger['child'] = () => logger;
  return logger as never;
})();
