/**
 * Сущность Fill (исполнение ордера)
 *
 * @remarks
 * Представляет исполнение нашего конкретного ордера на торговой площадке.
 * Fill — это неизменяемая запись о том, что наш ордер был (частично) исполнен:
 * по какой цене, в каком объёме, с какой комиссией, с каким типом ликвидности.
 *
 * ### Что такое Fill (execution record):
 * Fill — это "наше исполнение": факт того, что конкретный наш ордер
 * был исполнен. Используется для:
 * - Расчёта позиций (position tracking)
 * - Расчёта PnL
 * - Учёта комиссий
 * - Аллокации по стратегиям
 *
 * ### Чем Fill НЕ является:
 * Fill НЕ является рыночным принтом (market tape).
 * Для аналитики рынка используется Trade entity (packages/domain/entities/trade/).
 *
 * ### Связь с Trade:
 * Fill.venueTradeId?: VenueTradeId — опциональная сшивка в application layer
 * через ExecutionLinker.
 *
 * ### Инварианты:
 * 1. id не пустой (FillId)
 * 2. orderId обязателен — нет orderId, нет Fill
 * 3. accountId не пустой
 * 4. venueId не пустой
 * 5. marketId не пустая строка
 * 6. tokenId присутствует
 * 7. size > 0
 * 8. price > 0
 * 9. timestamp валидный
 * 10. fee.amount >= 0 (гарантируется Fee VO инвариантом)
 *
 * ### Immutability:
 * Все свойства readonly. Fill создаётся один раз и не изменяется.
 *
 * @example
 * ```typescript
 * import { Fill } from '@polymarket/fill';
 * import { asFillId, asOrderId, parseAccountId, asVenueId, parseAssetId } from '@polymarket/ids';
 * import { Price, Quantity, Timestamp, Fee } from '@polymarket/value-objects';
 * import { AssetQuantity } from '@polymarket/value-objects/asset-quantity';
 * import Decimal from 'decimal.js';
 *
 * const result = Fill.create({
 *   id: asFillId('fill-123')!,
 *   orderId: asOrderId('order-456')!,
 *   accountId: parseAccountId({ type: 'WALLET', address: '0xabc...' })!,
 *   venueId: asVenueId('POLYMARKET')!,
 *   marketId: 'market-abc',
 *   tokenId: parseAssetId('...'),
 *   price: Price.of(new Decimal('0.65')),
 *   size: Quantity.of(new Decimal('50')),
 *   side: 'BUY',
 *   timestamp: Timestamp.now(),
 *   fee: Fee.zero(usdcAsset),
 *   liquidity: 'MAKER',
 * });
 *
 * if (result.ok) {
 *   const fill = result.value;
 *   console.log(fill.getNotional().toNumber()); // 32.5
 *   console.log(fill.isMaker()); // true
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import type { FillId, OrderId, AccountId, VenueId, AssetId, VenueTradeId } from '@polymarket/ids';
import { accountIdToString } from '@polymarket/ids';
import type { Price, Quantity, Side, Timestamp, Fee } from '@polymarket/value-objects';
import Decimal from 'decimal.js';
import type { Liquidity } from './value-objects/Liquidity.js';
import type { FillSnapshot } from './FillSnapshot.js';

/**
 * Параметры создания Fill
 *
 * @remarks
 * orderId обязателен — нет orderId, нет Fill.
 * Все остальные ID-поля тоже обязательны.
 * liquidity и venueTradeId опциональны.
 */
export interface FillParams {
  /** Уникальный ID исполнения */
  readonly id: FillId;
  /** ID ордера — ОБЯЗАТЕЛЕН */
  readonly orderId: OrderId;
  /** ID аккаунта */
  readonly accountId: AccountId;
  /** ID торговой площадки */
  readonly venueId: VenueId;
  /** ID рынка */
  readonly marketId: string;
  /** ID токена (актива) */
  readonly tokenId: AssetId;
  /** Цена исполнения */
  readonly price: Price;
  /** Размер исполнения */
  readonly size: Quantity;
  /** Сторона (BUY/SELL) */
  readonly side: Side;
  /** Время исполнения */
  readonly timestamp: Timestamp;
  /** Комиссия за исполнение (>= 0) */
  readonly fee: Fee;
  /** Тип ликвидности — опционально */
  readonly liquidity?: Liquidity;
  /** ID трейда на venue — опциональная сшивка с Trade entity */
  readonly venueTradeId?: VenueTradeId;
}

/**
 * Класс Fill - исполнение ордера
 *
 * @remarks
 * Неизменяемая доменная сущность.
 * Все свойства readonly. Factory method Fill.create() с Result pattern.
 */
export class Fill {
  public readonly id: FillId;
  public readonly orderId: OrderId;
  public readonly accountId: AccountId;
  public readonly venueId: VenueId;
  public readonly marketId: string;
  public readonly tokenId: AssetId;
  public readonly price: Price;
  public readonly size: Quantity;
  public readonly side: Side;
  public readonly timestamp: Timestamp;
  public readonly fee: Fee;
  public readonly liquidity: Liquidity | undefined;
  public readonly venueTradeId: VenueTradeId | undefined;

  /**
   * Приватный конструктор (используйте Fill.create())
   */
  private constructor(params: FillParams) {
    this.id = params.id;
    this.orderId = params.orderId;
    this.accountId = params.accountId;
    this.venueId = params.venueId;
    this.marketId = params.marketId;
    this.tokenId = params.tokenId;
    this.price = params.price;
    this.size = params.size;
    this.side = params.side;
    this.timestamp = params.timestamp;
    this.fee = params.fee;
    this.liquidity = params.liquidity;
    this.venueTradeId = params.venueTradeId;
  }

  /**
   * Создаёт Fill с валидацией инвариантов
   *
   * @param params - Параметры создания исполнения
   * @returns Result<Fill, ValidationError>
   *
   * @remarks
   * ### Валидации:
   * 1. id не пустой (FillId)
   * 2. orderId обязателен и не пустой
   * 3. accountId не пустой
   * 4. venueId не пустой
   * 5. marketId не пустая строка
   * 6. tokenId присутствует
   * 7. size > 0
   * 8. price > 0
   * 9. timestamp присутствует
   * 10. fee присутствует (fee.amount >= 0 гарантируется Fee VO)
   *
   * @example
   * ```typescript
   * const result = Fill.create({
   *   id: asFillId('fill-123')!,
   *   orderId: asOrderId('order-456')!,
   *   // ... остальные поля
   * });
   * if (result.ok) {
   *   const fill = result.value;
   * }
   * ```
   */
  public static create(params: FillParams): Result<Fill, ValidationError> {
    // Инвариант 1: id не пустой
    if (!params.id) {
      return Err(
        new ValidationError('Fill ID is required', {
          context: { field: 'id', value: params.id },
        })
      );
    }

    // Инвариант 2: orderId обязателен
    if (!params.orderId) {
      return Err(
        new ValidationError('Order ID is required for Fill', {
          context: { field: 'orderId', fillId: params.id },
        })
      );
    }

    // Инвариант 3: accountId не пустой
    if (!params.accountId) {
      return Err(
        new ValidationError('Account ID is required', {
          context: { field: 'accountId', fillId: params.id },
        })
      );
    }

    // Инвариант 4: venueId не пустой
    if (!params.venueId) {
      return Err(
        new ValidationError('Venue ID is required', {
          context: { field: 'venueId', fillId: params.id },
        })
      );
    }

    // Инвариант 5: marketId не пустая строка
    if (!params.marketId || params.marketId.trim().length === 0) {
      return Err(
        new ValidationError('Market ID is required and must be non-empty', {
          context: { field: 'marketId', fillId: params.id, value: params.marketId },
        })
      );
    }

    // Инвариант 6: tokenId присутствует
    if (!params.tokenId) {
      return Err(
        new ValidationError('Token ID is required', {
          context: { field: 'tokenId', fillId: params.id },
        })
      );
    }

    // Инвариант 7: size > 0
    if (!params.size) {
      return Err(
        new ValidationError('Size is required', {
          context: { field: 'size', fillId: params.id },
        })
      );
    }

    if (!params.size.isPositive()) {
      return Err(
        new ValidationError('Fill size must be positive', {
          context: { field: 'size', fillId: params.id, value: params.size.value().toNumber() },
        })
      );
    }

    // Инвариант 8: price > 0
    if (!params.price) {
      return Err(
        new ValidationError('Price is required', {
          context: { field: 'price', fillId: params.id },
        })
      );
    }

    if (!params.price.value().gt(new Decimal(0))) {
      return Err(
        new ValidationError('Fill price must be positive', {
          context: { field: 'price', fillId: params.id, value: params.price.value().toNumber() },
        })
      );
    }

    // Инвариант 9: timestamp присутствует
    if (!params.timestamp) {
      return Err(
        new ValidationError('Timestamp is required', {
          context: { field: 'timestamp', fillId: params.id },
        })
      );
    }

    // Инвариант 10: fee присутствует
    if (!params.fee) {
      return Err(
        new ValidationError('Fee is required', {
          context: { field: 'fee', fillId: params.id },
        })
      );
    }

    return Ok(new Fill(params));
  }

  // ==================== Calculations ====================

  /**
   * Вычисляет номинальную стоимость исполнения (notional)
   *
   * @returns Notional (price × size) как Decimal
   *
   * @remarks
   * Формула: notional = price.value() × size.value()
   *
   * @example
   * ```typescript
   * const fill = Fill.create({ price: Price.of(0.65), size: Quantity.of(50), ... });
   * console.log(fill.getNotional().toNumber()); // 32.5
   * ```
   */
  public getNotional(): Decimal {
    return this.price.value().times(this.size.value());
  }

  // ==================== Predicates ====================

  /**
   * Проверяет, является ли исполнение покупкой
   *
   * @returns True если side === 'BUY'
   */
  public isBuy(): boolean {
    return this.side === 'BUY';
  }

  /**
   * Проверяет, является ли исполнение продажей
   *
   * @returns True если side === 'SELL'
   */
  public isSell(): boolean {
    return this.side === 'SELL';
  }

  /**
   * Проверяет, является ли исполнение maker-ом
   *
   * @returns True если liquidity === 'MAKER'
   */
  public isMaker(): boolean {
    return this.liquidity === 'MAKER';
  }

  /**
   * Проверяет, является ли исполнение taker-ом
   *
   * @returns True если liquidity === 'TAKER'
   */
  public isTaker(): boolean {
    return this.liquidity === 'TAKER';
  }

  /**
   * Проверяет, есть ли ненулевая комиссия
   *
   * @returns True если fee.amount > 0
   *
   * @remarks
   * Используется для условного применения fee logic.
   *
   * @example
   * ```typescript
   * if (fill.hasFee()) {
   *   deductFeeFromBalance(fill.fee);
   * }
   * ```
   */
  public hasFee(): boolean {
    return !this.fee.isZero();
  }

  // ==================== Serialization ====================

  /**
   * Преобразует Fill в плоский снапшот (примитивы)
   *
   * @returns FillSnapshot — сериализованное представление
   *
   * @remarks
   * Все value objects конвертируются в примитивы.
   * AccountId сериализуется как строка через JSON.stringify.
   *
   * @example
   * ```typescript
   * const snapshot = fill.toSnapshot();
   * await db.save(snapshot);
   * ```
   */
  public toSnapshot(): FillSnapshot {
    return {
      id: this.id,
      orderId: this.orderId,
      accountId: accountIdToString(this.accountId),
      venueId: this.venueId,
      marketId: this.marketId,
      tokenId: JSON.stringify(this.tokenId),
      price: this.price.value().toNumber(),
      size: this.size.value().toNumber(),
      side: this.side,
      timestampMs: this.timestamp.value,
      feeAmount: this.fee.quantity.amount().value().toNumber(),
      feeAsset: JSON.stringify(this.fee.asset),
      liquidity: this.liquidity,
      venueTradeId: this.venueTradeId,
    };
  }

  /**
   * Строковое представление для отладки
   *
   * @returns Строка с ключевыми полями исполнения
   *
   * @example
   * ```typescript
   * console.log(fill.toString());
   * // "Fill[fill-123]: BUY 50 @ 0.65 (order-456)"
   * ```
   */
  public toString(): string {
    return `Fill[${this.id}]: ${this.side} ${this.size.value().toString()} @ ${this.price.value().toString()} (order: ${this.orderId})`;
  }
}
