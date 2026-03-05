/**
 * Fill — доменная запись исполнения ордера (Execution Domain Record)
 *
 * @remarks
 * Fill — это **неизменяемая доменная запись** факта исполнения нашего ордера
 * на торговой площадке. По архитектурной природе это Domain Record / Immutable
 * Execution Fact, а не Entity в классическом DDD-смысле (нет lifecycle, нет
 * мутаций состояния, нет истории).
 *
 * ### Что такое Fill:
 * Fill — "наше исполнение": факт того, что конкретный ордер был (частично)
 * исполнен. Используется как входная запись для:
 * - Ledger layer (разворачивается в LedgerEntry[])
 * - Расчёта позиций (position tracking)
 * - Расчёта PnL
 * - Учёта комиссий
 *
 * ### Чем Fill НЕ является:
 * Fill НЕ является рыночным принтом (market tape).
 * Для аналитики рынка используется Trade entity (packages/domain/entities/trade/).
 *
 * ### Aggregate boundary:
 * Fill — независимая запись. Он не принадлежит Order aggregate,
 * потому что fills могут приходить вне порядка (out-of-order events),
 * а lifecycle fill > lifecycle order.
 *
 * ### Связь с Trade:
 * Fill.venueTradeId?: VenueTradeId — опциональная сшивка в application layer
 * через ExecutionLinker.
 *
 * ### Реальные инварианты (cross-field):
 * 1. marketId не пустая строка (строковый тип, нет VO)
 * 2. size > 0 (Quantity допускает 0, Fill — нет)
 * Все остальные инварианты гарантируются типами и VO при создании.
 *
 * ### Immutability:
 * Все свойства readonly. Fill создаётся один раз и не изменяется.
 *
 * @example
 * ```typescript
 * import { Fill } from '@polymarket/fill';
 * import { asFillId, asOrderId, parseAccountId, asVenueId, parseAssetId } from '@polymarket/ids';
 * import { Price, Quantity, Timestamp, Fee } from '@polymarket/value-objects';
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
 * });
 *
 * if (result.ok) {
 *   const fill = result.value;
 *   console.log(fill.getCashFlow().toNumber());   // -32.5 (BUY = деньги ушли)
 *   console.log(fill.getSignedQuantity().toNumber()); // +50 (позиция выросла)
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import type { FillId, OrderId, AccountId, VenueId, AssetId, VenueTradeId } from '@polymarket/ids';
import type { Price, Quantity, Side, Timestamp, Fee } from '@polymarket/value-objects';
import Decimal from 'decimal.js';
import type { Liquidity } from './value-objects/Liquidity.js';

/**
 * Параметры создания Fill
 *
 * @remarks
 * Все ID-поля типизированы — branded types гарантируют корректность.
 * Все VO (Price, Quantity, Timestamp, Fee) валидируют себя при создании.
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
  /** ID рынка (строка, нет MarketId VO) */
  readonly marketId: string;
  /** ID токена (актива) */
  readonly tokenId: AssetId;
  /** Цена исполнения (Price VO гарантирует > 0) */
  readonly price: Price;
  /** Размер исполнения (должен быть > 0) */
  readonly size: Quantity;
  /** Сторона (BUY/SELL) */
  readonly side: Side;
  /** Время исполнения */
  readonly timestamp: Timestamp;
  /** Комиссия за исполнение (>= 0, гарантируется Fee VO) */
  readonly fee: Fee;
  /** Тип ликвидности — опционально */
  readonly liquidity?: Liquidity;
  /** ID трейда на venue — опциональная сшивка с Trade entity */
  readonly venueTradeId?: VenueTradeId;
}

/**
 * Fill — неизменяемая доменная запись исполнения ордера
 *
 * @remarks
 * Все свойства readonly. Factory method Fill.create() с Result pattern.
 * Содержит методы для расчёта экономического эффекта исполнения.
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
   * Создаёт Fill с валидацией cross-field инвариантов
   *
   * @param params - Параметры создания исполнения
   * @returns Result<Fill, ValidationError>
   *
   * @remarks
   * ### Что валидируется здесь (cross-field инварианты):
   * 1. marketId не пустая строка — строковый тип, нет VO
   * 2. size > 0 — Quantity VO допускает 0, Fill — нет
   *
   * ### Что НЕ валидируется здесь (гарантируется типами и VO):
   * - id, orderId, accountId, venueId, tokenId — branded types
   * - price > 0 — гарантируется Price VO при создании (бросает исключение)
   * - fee.amount >= 0 — гарантируется Fee VO
   * - timestamp корректный — гарантируется Timestamp VO
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
   *   console.log(fill.getCashFlow().toNumber()); // -32.5 для BUY 50 @ 0.65
   * }
   * ```
   */
  public static create(params: FillParams): Result<Fill, ValidationError> {
    // Инвариант 1: marketId не пустая строка (нет MarketId VO)
    if (!params.marketId || params.marketId.trim().length === 0) {
      return Err(
        new ValidationError('Market ID is required and must be non-empty', {
          context: { field: 'marketId', value: params.marketId },
        })
      );
    }

    // Инвариант 2: size > 0 — Quantity VO допускает 0, Fill требует положительный размер
    if (!params.size.isPositive()) {
      return Err(
        new ValidationError('Fill size must be positive', {
          context: { field: 'size', value: params.size.value().toNumber() },
        })
      );
    }

    return Ok(new Fill(params));
  }

  // ==================== Экономические расчёты ====================

  /**
   * Возвращает знаковый объём исполнения (position delta)
   *
   * @returns +size для BUY, -size для SELL
   *
   * @remarks
   * Используется для расчёта изменения позиции.
   * BUY увеличивает позицию, SELL уменьшает.
   *
   * @example
   * ```typescript
   * // BUY 50 @ 0.65
   * fill.getSignedQuantity().toNumber() // +50
   *
   * // SELL 50 @ 0.65
   * fill.getSignedQuantity().toNumber() // -50
   * ```
   */
  public getSignedQuantity(): Decimal {
    return this.side === 'BUY' ? this.size.value() : this.size.value().negated();
  }

  /**
   * Возвращает денежный поток от исполнения (без комиссии)
   *
   * @returns -(price × size) для BUY, +(price × size) для SELL
   *
   * @remarks
   * BUY: деньги уходят (отрицательный cash flow)
   * SELL: деньги приходят (положительный cash flow)
   * Для получения чистого потока с учётом комиссии используйте getNetCashFlow().
   *
   * @example
   * ```typescript
   * // BUY 50 @ 0.65
   * fill.getCashFlow().toNumber() // -32.5
   *
   * // SELL 50 @ 0.65
   * fill.getCashFlow().toNumber() // +32.5
   * ```
   */
  public getCashFlow(): Decimal {
    const notional = this.price.value().times(this.size.value());
    return this.side === 'BUY' ? notional.negated() : notional;
  }

  /**
   * Возвращает денежный поток от комиссии
   *
   * @returns -fee.amount (всегда отрицательный или 0)
   *
   * @remarks
   * Комиссия всегда является расходом. При нулевой комиссии возвращает 0.
   *
   * @example
   * ```typescript
   * // Fee 0.02 USDC
   * fill.getFeeFlow().toNumber() // -0.02
   *
   * // Zero fee
   * fill.getFeeFlow().toNumber() // 0
   * ```
   */
  public getFeeFlow(): Decimal {
    return this.fee.quantity.amount().value().negated();
  }

  /**
   * Возвращает чистый денежный поток (с учётом комиссии)
   *
   * @returns getCashFlow() + getFeeFlow()
   *
   * @remarks
   * Это итоговое изменение денежного баланса от исполнения.
   *
   * @example
   * ```typescript
   * // BUY 50 @ 0.65, fee 0.02 USDC
   * fill.getNetCashFlow().toNumber() // -32.52
   *
   * // SELL 50 @ 0.65, fee 0.02 USDC
   * fill.getNetCashFlow().toNumber() // +32.48
   * ```
   */
  public getNetCashFlow(): Decimal {
    return this.getCashFlow().plus(this.getFeeFlow());
  }

  /**
   * Вычисляет номинальную стоимость исполнения (notional)
   *
   * @returns price × size как Decimal (всегда положительный)
   *
   * @remarks
   * Для знакового расчёта используйте getCashFlow().
   *
   * @example
   * ```typescript
   * // BUY или SELL 50 @ 0.65
   * fill.getNotional().toNumber() // 32.5
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

  // ==================== Debug ====================

  /**
   * Строковое представление для отладки
   *
   * @returns Строка с ключевыми полями исполнения
   *
   * @example
   * ```typescript
   * console.log(fill.toString());
   * // "Fill[fill-123]: BUY 50 @ 0.65 (order: order-456)"
   * ```
   */
  public toString(): string {
    return `Fill[${this.id}]: ${this.side} ${this.size.value().toString()} @ ${this.price.value().toString()} (order: ${this.orderId})`;
  }
}
