/**
 * Сущность Trade (рыночный принт / market print)
 *
 * @remarks
 * Представляет рыночную сделку (trade) зафиксированную на торговой площадке.
 * Trade — это неизменяемая запись о том, что произошло на рынке:
 * по какой цене, в каком объёме, с какой стороны агрессора.
 *
 * ### Что такое Trade (market tape):
 * Trade — это "рыночный принт" (market print): факт исполнения сделки
 * на рынке предсказаний. Используется для:
 * - Аналитики рынка (VWAP, pressure, volume)
 * - Построения сигналов
 * - Ведения рыночной ленты (market tape)
 *
 * ### Чем Trade НЕ является:
 * Trade НЕ содержит информацию об исполнении конкретного нашего ордера.
 * Для этого используется Fill entity (packages/domain/entities/fill/).
 *
 * ### Связь с Fill:
 * Fill.venueTradeId?: VenueTradeId — опциональная сшивка в application layer
 * через ExecutionLinker.
 *
 * ### Immutability:
 * Все свойства readonly. Trade создаётся один раз и не изменяется.
 *
 * @example
 * ```typescript
 * import { Trade } from '@polymarket/trade';
 * import { asVenueTradeId, asVenueId, parseAssetId } from '@polymarket/ids';
 * import { Price, Quantity, Timestamp } from '@polymarket/value-objects';
 * import Decimal from 'decimal.js';
 *
 * const result = Trade.create({
 *   id: asVenueTradeId('0xabc_1700000000000')!,
 *   venueId: asVenueId('POLYMARKET')!,
 *   marketId: '0xb9ed6ed97ce9146ef1a01278d5fc0f8bd04050a69f0a5568a66075b3c0c6b2c3',
 *   tokenId: parseAssetId('62305814799875783974460176688386847666394972778903073967664089920408777315323')!,
 *   price: Price.of(new Decimal('0.65')),
 *   size: Quantity.of(new Decimal('100')),
 *   aggressorSide: 'BUY',
 *   timestamp: Timestamp.now(),
 * });
 *
 * if (result.ok) {
 *   const trade = result.value;
 *   console.log(trade.getNotional().toNumber()); // 65 (0.65 × 100)
 *   console.log(trade.isBuy()); // true
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import type { VenueTradeId, VenueId, AssetId, TxHash } from '@polymarket/ids';
import { assetIdToString } from '@polymarket/ids';
import type { Price, Quantity, Side, Timestamp } from '@polymarket/value-objects';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import type { TradeSnapshot } from './TradeSnapshot.js';

/**
 * Параметры создания Trade
 *
 * @remarks
 * Все поля readonly. aggressorSide и txHash опциональны.
 */
export interface TradeParams {
  /** Уникальный ID трейда на venue */
  readonly id: VenueTradeId;
  /** ID торговой площадки */
  readonly venueId: VenueId;
  /** ID рынка (string, пока без MarketId VO) */
  readonly marketId: string;
  /** ID токена (актива) */
  readonly tokenId: AssetId;
  /** Цена трейда */
  readonly price: Price;
  /** Размер трейда */
  readonly size: Quantity;
  /** Сторона агрессора — опционально, не всегда известно */
  readonly aggressorSide?: Side;
  /** Время трейда */
  readonly timestamp: Timestamp;
  /** Хэш блокчейн-транзакции — опционально */
  readonly txHash?: TxHash;
}

/**
 * Класс Trade - рыночный принт (market print)
 *
 * @remarks
 * Неизменяемая доменная сущность.
 * Все свойства readonly. Factory method Trade.create() с Result pattern.
 *
 * ### Инварианты:
 * 1. id не пустой (гарантируется VenueTradeId)
 * 2. venueId не пустой (гарантируется VenueId)
 * 3. marketId не пустой (строка)
 * 4. tokenId не пустой (гарантируется AssetId)
 * 5. price > 0
 * 6. size > 0
 * 7. timestamp присутствует (числовая валидация делегирована Timestamp VO / TimestampService)
 */
export class Trade {
  public readonly id: VenueTradeId;
  public readonly venueId: VenueId;
  public readonly marketId: string;
  public readonly tokenId: AssetId;
  public readonly price: Price;
  public readonly size: Quantity;
  public readonly aggressorSide: Side | undefined;
  public readonly timestamp: Timestamp;
  public readonly txHash: TxHash | undefined;

  /**
   * Приватный конструктор (используйте Trade.create())
   */
  private constructor(params: TradeParams) {
    this.id = params.id;
    this.venueId = params.venueId;
    this.marketId = params.marketId;
    this.tokenId = params.tokenId;
    this.price = params.price;
    this.size = params.size;
    this.aggressorSide = params.aggressorSide;
    this.timestamp = params.timestamp;
    this.txHash = params.txHash;
  }

  /**
   * Создаёт Trade с валидацией инвариантов
   *
   * @param params - Параметры создания трейда
   * @returns Result<Trade, ValidationError>
   *
   * @remarks
   * Валидирует все обязательные поля:
   * 1. id не пустой (VenueTradeId уже валидирован на создании)
   * 2. venueId не пустой
   * 3. marketId не пустая строка
   * 4. tokenId не пустой
   * 5. price > 0
   * 6. size > 0
   * 7. timestamp присутствует
   *
   * @example
   * ```typescript
   * const result = Trade.create({
   *   id: asVenueTradeId('0xabc_1700000000000')!,
   *   venueId: asVenueId('POLYMARKET')!,
   *   marketId: 'market-abc',
   *   tokenId: parseAssetId('...'),
   *   price: Price.of(new Decimal('0.65')),
   *   size: Quantity.of(new Decimal('100')),
   *   timestamp: Timestamp.now(),
   * });
   * ```
   */
  public static create(params: TradeParams): Result<Trade, ValidationError> {
    // Инвариант 1: id не пустой
    if (!params.id) {
      return Err(
        new ValidationError('Trade ID is required', {
          context: { field: 'id', value: params.id },
        })
      );
    }

    // Инвариант 2: venueId не пустой
    if (!params.venueId) {
      return Err(
        new ValidationError('Venue ID is required', {
          context: { field: 'venueId', tradeId: params.id },
        })
      );
    }

    // Инвариант 3: marketId не пустая строка
    if (typeof params.marketId !== 'string' || params.marketId.trim().length === 0) {
      return Err(
        new ValidationError('Market ID is required and must be non-empty', {
          context: { field: 'marketId', tradeId: params.id, value: params.marketId },
        })
      );
    }

    // Инвариант 4: tokenId не пустой
    if (!params.tokenId) {
      return Err(
        new ValidationError('Token ID is required', {
          context: { field: 'tokenId', tradeId: params.id },
        })
      );
    }

    // Инвариант 5: price > 0
    if (!params.price) {
      return Err(
        new ValidationError('Price is required', {
          context: { field: 'price', tradeId: params.id },
        })
      );
    }

    if (!params.price.value().gt(new Decimal(0))) {
      return Err(
        new ValidationError('Trade price must be positive', {
          context: { field: 'price', tradeId: params.id, value: params.price.value().toNumber() },
        })
      );
    }

    // Инвариант 6: size > 0
    if (!params.size) {
      return Err(
        new ValidationError('Size is required', {
          context: { field: 'size', tradeId: params.id },
        })
      );
    }

    if (!params.size.isPositive()) {
      return Err(
        new ValidationError('Trade size must be positive', {
          context: { field: 'size', tradeId: params.id, value: params.size.value().toNumber() },
        })
      );
    }

    // Инвариант 7: timestamp присутствует
    if (!params.timestamp) {
      return Err(
        new ValidationError('Timestamp is required', {
          context: { field: 'timestamp', tradeId: params.id },
        })
      );
    }

    return Ok(new Trade(params));
  }

  // ==================== Calculations ====================

  /**
   * Вычисляет номинальную стоимость трейда (notional)
   *
   * @returns Notional (price × size) как Decimal
   *
   * @remarks
   * Формула: notional = price.value() × size.value()
   *
   * @example
   * ```typescript
   * const trade = Trade.create({ price: Price.of(0.65), size: Quantity.of(100), ... });
   * console.log(trade.getNotional().toNumber()); // 65
   * ```
   */
  public getNotional(): Decimal {
    return this.price.value().times(this.size.value());
  }

  // ==================== Predicates ====================

  /**
   * Проверяет, был ли агрессор на стороне покупки
   *
   * @returns True если aggressorSide === 'BUY'
   *
   * @example
   * ```typescript
   * const trade = Trade.create({ aggressorSide: 'BUY', ... });
   * console.log(trade.isBuy()); // true
   * ```
   */
  public isBuy(): boolean {
    return this.aggressorSide === 'BUY';
  }

  /**
   * Проверяет, был ли агрессор на стороне продажи
   *
   * @returns True если aggressorSide === 'SELL'
   *
   * @example
   * ```typescript
   * const trade = Trade.create({ aggressorSide: 'SELL', ... });
   * console.log(trade.isSell()); // true
   * ```
   */
  public isSell(): boolean {
    return this.aggressorSide === 'SELL';
  }

  // ==================== Comparison ====================

  /**
   * Сравнивает трейд с другим по времени
   *
   * @param other - Другой Trade для сравнения
   * @returns Отрицательное если this раньше, положительное если позже, 0 если одновременно
   *
   * @remarks
   * Используется для сортировки trades по времени.
   * Делегирует сравнение в Timestamp.diffMs().
   *
   * @example
   * ```typescript
   * const trades = [trade3, trade1, trade2];
   * trades.sort((a, b) => a.compareByTime(b));
   * // [trade1, trade2, trade3] — хронологический порядок
   * ```
   */
  public compareByTime(other: Trade): number {
    return this.timestamp.diffMs(other.timestamp).toNumber();
  }

  // ==================== Serialization ====================

  /**
   * Преобразует Trade в плоский снапшот (примитивы)
   *
   * @returns TradeSnapshot — сериализованное представление
   *
   * @remarks
   * Используется для сохранения в хранилище или логирования.
   * Все value objects конвертируются в примитивы.
   *
   * @example
   * ```typescript
   * const snapshot = trade.toSnapshot();
   * const json = JSON.stringify(snapshot);
   * // { "id": "...", "price": "0.65", "size": "100", "timestampMs": 1700000000000 }
   * ```
   */
  public toSnapshot(): TradeSnapshot {
    return {
      id: this.id,
      venueId: this.venueId,
      marketId: this.marketId,
      tokenId: assetIdToString(this.tokenId),
      price: this.price.value().toString(),
      size: this.size.value().toString(),
      aggressorSide: this.aggressorSide,
      timestampMs: this.timestamp.toNumber(),
      txHash: this.txHash,
    };
  }

  /**
   * Строковое представление для отладки
   *
   * @returns Строка с ключевыми полями трейда
   *
   * @example
   * ```typescript
   * console.log(trade.toString());
   * // "Trade[0xabc_1700000000000]: BUY 100 @ 0.65 on POLYMARKET"
   * ```
   */
  public toString(): string {
    const side = this.aggressorSide ?? 'UNKNOWN';
    return `Trade[${this.id}]: ${side} ${this.size.value().toString()} @ ${this.price.value().toString()} on ${this.venueId}`;
  }
}
