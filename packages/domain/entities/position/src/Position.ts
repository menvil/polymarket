/**
 * Сущность Position (Позиция)
 *
 * @remarks
 * Представляет открытую/закрытую позицию по активу.
 * Position является неизменяемой доменной сущностью (immutable entity).
 *
 * ### Архитектура:
 * - **Entity**: Position - чистая бизнес-логика
 * - **Value Objects**: PositionStatus, PositionLot, PositionSide - инварианты
 * - **Algorithms**: FIFO/LIFO для управления лотами
 * - **Utils**: P&L расчеты, статистика
 *
 * ### Жизненный цикл:
 * ```
 * OPEN → PARTIALLY_CLOSED → CLOSED
 * ```
 *
 * ### Бизнес-правила:
 * 1. Позиция должна иметь валидные id, accountId, instrumentId, asset
 * 2. Quantity должен быть валидным value object
 * 3. Lots управляются через FIFO/LIFO
 * 4. P&L рассчитывается от средней цены входа
 *
 * @example
 * ```typescript
 * import { Position } from './Position';
 * import { Quantity, Timestamp } from '@polymarket/value-objects';
 * import { asPositionId, asAccountId, asInstrumentId, asAssetId } from '@polymarket/ids';
 *
 * const result = Position.create({
 *   id: asPositionId('pos-123')!,
 *   accountId: asAccountId('account-456')!,
 *   instrumentId: asInstrumentId('market-abc-token-yes')!,
 *   asset: asAssetId('USDC')!,
 *   side: 'LONG',
 *   quantity: Quantity.of(new Decimal(100)),
 *   averageEntryPrice: Price.of(new Decimal(0.65)),
 *   timestamp: Timestamp.now(),
 *   lots: []
 * });
 *
 * if (result.ok) {
 *   const position = result.value();
 *   console.log(position.id); // 'pos-123'
 * }
 * ```
 */

import { Result, Ok, Err } from '@polymarket/result';
import { Price, Quantity, Timestamp, Fee } from '@polymarket/value-objects';
import { SignedQuantity } from '@polymarket/value-objects/signed-quantity';
import { ValidationError } from '@polymarket/errors';
import type { PositionId, AccountId, InstrumentId, AssetId } from '@polymarket/ids';
import { PositionLot } from './core/PositionLot.js';
import Decimal from 'decimal.js';

/**
 * Сторона позиции
 *
 * @remarks
 * - LONG - длинная позиция (покупка)
 * - SHORT - короткая позиция (продажа)
 */
export type PositionSide = 'LONG' | 'SHORT';

/**
 * Статус позиции
 *
 * @remarks
 * - OPEN - позиция открыта
 * - PARTIALLY_CLOSED - частично закрыта
 * - CLOSED - полностью закрыта
 */
export type PositionStatus = 'OPEN' | 'PARTIALLY_CLOSED' | 'CLOSED';

/**
 * Параметры создания Position
 */
export interface PositionParams {
  readonly id: PositionId;
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  readonly asset: AssetId;
  readonly side: PositionSide;
  readonly quantity: Quantity;
  readonly averageEntryPrice: Price;
  readonly timestamp: Timestamp;
  readonly lots: readonly PositionLot[];
  readonly realizedPnL?: SignedQuantity;
  readonly fees?: Fee;
}

/**
 * Класс Position - неизменяемая доменная сущность
 *
 * @remarks
 * Все свойства readonly для обеспечения неизменяемости.
 * Методы изменения состояния возвращают НОВЫЙ экземпляр.
 */
export class Position {
  public readonly id: PositionId;
  public readonly accountId: AccountId;
  public readonly instrumentId: InstrumentId;
  public readonly asset: AssetId;
  public readonly side: PositionSide;
  public readonly quantity: Quantity;
  public readonly averageEntryPrice: Price;
  public readonly timestamp: Timestamp;
  public readonly lots: readonly PositionLot[];
  public readonly realizedPnL: SignedQuantity;
  public readonly fees: Fee;

  /**
   * Приватный конструктор (используйте Position.create())
   */
  private constructor(params: PositionParams) {
    this.id = params.id;
    this.accountId = params.accountId;
    this.instrumentId = params.instrumentId;
    this.asset = params.asset;
    this.side = params.side;
    this.quantity = params.quantity;
    this.averageEntryPrice = params.averageEntryPrice;
    this.timestamp = params.timestamp;
    this.lots = params.lots;
    this.realizedPnL = params.realizedPnL ?? SignedQuantity.ZERO;
    this.fees = params.fees || Fee.zero(params.asset);
  }

  /**
   * Создаёт Position с валидацией
   *
   * @param params - Параметры создания позиции
   * @returns Result<Position, ValidationError>
   */
  public static create(params: PositionParams): Result<Position, ValidationError> {
    // Валидация ID
    if (!params.id) {
      return Err(
        new ValidationError('Position ID is required', {
          context: { field: 'id' },
        })
      );
    }

    if (!params.accountId) {
      return Err(
        new ValidationError('Account ID is required', {
          context: { field: 'accountId', positionId: params.id },
        })
      );
    }

    if (!params.instrumentId) {
      return Err(
        new ValidationError('Instrument ID is required', {
          context: { field: 'instrumentId', positionId: params.id },
        })
      );
    }

    if (!params.asset) {
      return Err(
        new ValidationError('Asset ID is required', {
          context: { field: 'asset', positionId: params.id },
        })
      );
    }

    // Валидация quantity
    if (!params.quantity) {
      return Err(
        new ValidationError('Quantity is required', {
          context: { field: 'quantity', positionId: params.id },
        })
      );
    }

    // Валидация price
    if (!params.averageEntryPrice) {
      return Err(
        new ValidationError('Average entry price is required', {
          context: { field: 'averageEntryPrice', positionId: params.id },
        })
      );
    }

    // Валидация timestamp
    if (!params.timestamp) {
      return Err(
        new ValidationError('Timestamp is required', {
          context: { field: 'timestamp', positionId: params.id },
        })
      );
    }

    return Ok(new Position(params));
  }

  /**
   * Возвращает статус позиции
   */
  public getStatus(): PositionStatus {
    if (this.quantity.isZero()) {
      return 'CLOSED';
    }
    if (this.lots.length > 0 && this.lots.some(lot => !lot.quantity.isZero())) {
      return this.quantity.equals(this.getTotalLotsQuantity()) ? 'OPEN' : 'PARTIALLY_CLOSED';
    }
    return 'OPEN';
  }

  /**
   * Проверяет открыта ли позиция
   */
  public isOpen(): boolean {
    return !this.quantity.isZero();
  }

  /**
   * Проверяет закрыта ли позиция
   */
  public isClosed(): boolean {
    return this.quantity.isZero();
  }

  /**
   * Возвращает общее количество в лотах
   */
  private getTotalLotsQuantity(): Quantity {
    if (this.lots.length === 0) {
      return Quantity.ZERO;
    }

    const total = this.lots.reduce(
      (sum, lot) => sum.plus(lot.quantity.value()),
      new Decimal(0)
    );

    return Quantity.of(total);
  }

  /**
   * Вычисляет unrealized P&L
   *
   * @param currentPrice - Текущая рыночная цена
   * @returns Unrealized P&L
   */
  public getUnrealizedPnL(currentPrice: Price): SignedQuantity {
    if (this.quantity.isZero()) {
      return SignedQuantity.ZERO;
    }

    const priceDiff = currentPrice.value().minus(this.averageEntryPrice.value());
    const pnl = priceDiff.times(this.quantity.value());

    return SignedQuantity.of(this.side === 'LONG' ? pnl : pnl.negated());
  }

  /**
   * Возвращает total P&L (realized + unrealized)
   *
   * @param currentPrice - Текущая рыночная цена
   * @returns Total P&L
   */
  public getTotalPnL(currentPrice: Price): SignedQuantity {
    const unrealized = this.getUnrealizedPnL(currentPrice);
    const total = this.realizedPnL.value().plus(unrealized.value());
    return SignedQuantity.of(total);
  }

  /**
   * Преобразует Position в plain object
   */
  public toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      accountId: this.accountId,
      instrumentId: this.instrumentId,
      asset: this.asset,
      side: this.side,
      quantity: this.quantity.value().toNumber(),
      averageEntryPrice: this.averageEntryPrice.value().toNumber(),
      timestamp: this.timestamp.toNumber(),
      status: this.getStatus(),
      realizedPnL: this.realizedPnL.value().toNumber(),
      fees: this.fees.quantity.amount().value().toNumber(),
      lotsCount: this.lots.length,
    };
  }

  /**
   * Строковое представление
   */
  public toString(): string {
    return `Position[${this.id}]: ${this.side} ${this.quantity.value().toNumber()} @ ${this.averageEntryPrice.value().toNumber()} (${this.getStatus()})`;
  }
}
