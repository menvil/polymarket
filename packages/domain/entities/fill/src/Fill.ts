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
 * ### Что хранит Fill:
 * Fill содержит только доменные данные, необходимые для расчёта экономики:
 * orderId, marketId, tokenId, settlementAssetId, price, size, side, fee, timestamp.
 * Инфраструктурные метаданные (liquidity, venueTradeId) живут в ExecutionMetadata.
 *
 * ### Реальные инварианты (cross-field):
 * 1. marketId не пустая строка (строковый тип, нет VO)
 * 2. size > 0 (Quantity допускает 0, Fill — нет)
 * 3. Если fee ненулевая → fee.asset совпадает с settlementAssetId
 *    (гарантирует корректность getNetCashFlow)
 * Все остальные инварианты гарантируются типами и VO при создании.
 *
 * ### Immutability:
 * Все свойства readonly. Fill создаётся один раз и не изменяется.
 *
 * @example
 * ```typescript
 * import { Fill } from '@polymarket/fill';
 * import { asFillId, asOrderId, parseAccountId, asVenueId, parseAssetId, AssetIdHelpers } from '@polymarket/ids';
 * import { Price, Quantity, TimestampService, Fee } from '@polymarket/value-objects';
 * import Decimal from 'decimal.js';
 *
 * const result = Fill.create({
 *   id: asFillId('fill-123')!,
 *   orderId: asOrderId('order-456')!,
 *   accountId: parseAccountId({ type: 'WALLET', address: '0xabc...' })!,
 *   venueId: asVenueId('POLYMARKET')!,
 *   marketId: 'market-abc',
 *   tokenId: parseAssetId('...'),
 *   settlementAssetId: AssetIdHelpers.USDC,
 *   price: Price.of(new Decimal('0.65')),
 *   size: Quantity.of(new Decimal('50')),
 *   side: 'BUY',
 *   timestamp: TimestampService.create(Date.now()).value,
 *   fee: Fee.zero(AssetIdHelpers.USDC),
 * });
 *
 * if (result.ok) {
 *   const fill = result.value;
 *   const cashDelta = fill.getCashFlow();
 *   console.log(cashDelta.amount.toNumber()); // -32.5 (BUY = деньги ушли)
 *   const positionDelta = fill.getSignedQuantity();
 *   console.log(positionDelta.amount.toNumber()); // +50 (позиция выросла)
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import type { FillId, OrderId, AccountId, VenueId, AssetId } from '@polymarket/ids';
import { assetIdToString } from '@polymarket/ids';
import type { Price, Side, Timestamp, Fee } from '@polymarket/value-objects';
import { Quantity } from '@polymarket/value-objects';
import { AssetQuantity } from '@polymarket/value-objects/asset-quantity';
import { SignedQuantity } from '@polymarket/value-objects/signed-quantity';
import type { AssetDelta } from './AssetDelta.js';

/**
 * Параметры создания Fill
 *
 * @remarks
 * Все ID-поля типизированы — branded types гарантируют корректность.
 * Все VO (Price, Quantity, Timestamp, Fee) валидируют себя при создании.
 * liquidity и venueTradeId вынесены в ExecutionMetadata (не доменные данные).
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
  /** ID токена (актива исполнения) */
  readonly tokenId: AssetId;
  /** Расчётный актив (USDC для Polymarket) */
  readonly settlementAssetId: AssetId;
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
}

/**
 * Fill — неизменяемая доменная запись исполнения ордера
 *
 * @remarks
 * Все свойства readonly. Factory method Fill.create() с Result pattern.
 * Содержит методы для расчёта экономического эффекта исполнения в виде AssetDelta.
 */
export class Fill {
  public readonly id: FillId;
  public readonly orderId: OrderId;
  public readonly accountId: AccountId;
  public readonly venueId: VenueId;
  public readonly marketId: string;
  public readonly tokenId: AssetId;
  public readonly settlementAssetId: AssetId;
  public readonly price: Price;
  public readonly size: Quantity;
  public readonly side: Side;
  public readonly timestamp: Timestamp;
  public readonly fee: Fee;

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
    this.settlementAssetId = params.settlementAssetId;
    this.price = params.price;
    this.size = params.size;
    this.side = params.side;
    this.timestamp = params.timestamp;
    this.fee = params.fee;
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
   * 3. Если fee ненулевая → fee.asset должен совпадать с settlementAssetId
   *    (гарантирует корректность getNetCashFlow: сложение в одной валюте)
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
   *   settlementAssetId: AssetIdHelpers.USDC,
   *   // ... остальные поля
   * });
   * if (result.ok) {
   *   const fill = result.value;
   *   console.log(fill.getCashFlow().amount.toNumber()); // -32.5 для BUY 50 @ 0.65
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

    // Инвариант 3: если fee ненулевая, fee.asset должен совпадать с settlementAssetId
    // Это гарантирует корректность getNetCashFlow (сложение в одной валюте)
    if (!params.fee.isZero()) {
      const feeAssetStr = assetIdToString(params.fee.asset);
      const settlementAssetStr = assetIdToString(params.settlementAssetId);
      if (feeAssetStr !== settlementAssetStr) {
        return Err(
          new ValidationError('Fill fee asset must match settlementAssetId when fee is non-zero', {
            context: { feeAsset: feeAssetStr, settlementAssetId: settlementAssetStr },
          })
        );
      }
    }

    return Ok(new Fill(params));
  }

  // ==================== Экономические расчёты ====================

  /**
   * Возвращает знаковый объём исполнения (position delta)
   *
   * @returns AssetDelta с asset=tokenId и amount=+size для BUY, -size для SELL
   *
   * @remarks
   * Используется для расчёта изменения позиции.
   * BUY увеличивает позицию (положительный amount), SELL уменьшает (отрицательный).
   *
   * @example
   * ```typescript
   * // BUY 50 @ 0.65
   * const delta = fill.getSignedQuantity();
   * console.log(delta.amount.toNumber()); // +50
   *
   * // SELL 50 @ 0.65
   * const delta = fill.getSignedQuantity();
   * console.log(delta.amount.toNumber()); // -50
   * ```
   */
  public getSignedQuantity(): AssetDelta {
    const raw = this.side === 'BUY' ? this.size.value() : this.size.value().negated();
    return { asset: this.tokenId, amount: SignedQuantity.of(raw) };
  }

  /**
   * Возвращает денежный поток от исполнения (без комиссии)
   *
   * @returns AssetDelta с asset=settlementAssetId и amount=-(price×size) для BUY, +(price×size) для SELL
   *
   * @remarks
   * BUY: деньги уходят (отрицательный amount)
   * SELL: деньги приходят (положительный amount)
   * Для получения чистого потока с учётом комиссии используйте getNetCashFlow().
   *
   * @example
   * ```typescript
   * // BUY 50 @ 0.65, settlementAssetId=USDC
   * const delta = fill.getCashFlow();
   * console.log(delta.asset);          // USDC AssetId
   * console.log(delta.amount.toNumber()); // -32.5
   *
   * // SELL 50 @ 0.65
   * console.log(delta.amount.toNumber()); // +32.5
   * ```
   */
  public getCashFlow(): AssetDelta {
    const notional = this.price.value().times(this.size.value());
    const raw = this.side === 'BUY' ? notional.negated() : notional;
    return { asset: this.settlementAssetId, amount: SignedQuantity.of(raw) };
  }

  /**
   * Возвращает денежный поток от комиссии
   *
   * @returns AssetDelta с asset=fee.asset и amount=-feeAmount (всегда отрицательный или 0)
   *
   * @remarks
   * Делегирует в `fee.toDebitDelta()` — Fee сам знает как преобразовать себя
   * в знаковый delta (инкапсуляция, нет прямого доступа к внутренней структуре).
   * Комиссия всегда является расходом. При нулевой комиссии amount равен 0.
   * Благодаря инварианту Fill.create(), при ненулевой комиссии fee.asset === settlementAssetId.
   *
   * @example
   * ```typescript
   * // Fee 0.02 USDC
   * const feeFlow = fill.getFeeFlow();
   * console.log(feeFlow.asset);          // USDC AssetId
   * console.log(feeFlow.amount.toNumber()); // -0.02
   *
   * // Zero fee
   * console.log(feeFlow.amount.isZero()); // true
   * ```
   */
  public getFeeFlow(): AssetDelta {
    return this.fee.toDebitDelta();
  }

  /**
   * Возвращает чистый денежный поток (с учётом комиссии)
   *
   * @returns AssetDelta с asset=settlementAssetId и amount=cashFlow + feeFlow
   *
   * @remarks
   * Это итоговое изменение расчётного баланса от исполнения.
   * Инвариант Fill.create() гарантирует, что при ненулевой комиссии
   * fee.asset === settlementAssetId, поэтому сложение корректно.
   *
   * @example
   * ```typescript
   * // BUY 50 @ 0.65, fee 0.02 USDC
   * const net = fill.getNetCashFlow();
   * console.log(net.asset);           // USDC AssetId
   * console.log(net.amount.toNumber()); // -32.52
   *
   * // SELL 50 @ 0.65, fee 0.02 USDC
   * console.log(net.amount.toNumber()); // +32.48
   * ```
   */
  public getNetCashFlow(): AssetDelta {
    const cashFlow = this.getCashFlow();
    const feeFlow = this.getFeeFlow();
    return {
      asset: this.settlementAssetId,
      amount: SignedQuantity.of(cashFlow.amount.value().plus(feeFlow.amount.value())),
    };
  }

  /**
   * Вычисляет номинальную стоимость исполнения (notional)
   *
   * @returns AssetQuantity с asset=settlementAssetId и amount=price×size (всегда положительный)
   *
   * @remarks
   * Notional — это абсолютная стоимость исполнения без учёта стороны (BUY/SELL).
   * Для знакового расчёта используйте getCashFlow().
   *
   * @example
   * ```typescript
   * // BUY или SELL 50 @ 0.65
   * const notional = fill.getNotional();
   * console.log(notional.amount().value().toNumber()); // 32.5
   * console.log(notional.asset());                     // USDC AssetId
   * ```
   */
  public getNotional(): AssetQuantity {
    const notionalAmount = Quantity.of(this.price.value().times(this.size.value()));
    return new AssetQuantity(this.settlementAssetId, notionalAmount);
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
