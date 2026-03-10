/**
 * Простая реализация IPosition для обновления Portfolio aggregate.
 *
 * @remarks
 * SimplePosition — неизменяемый объект, реализующий IPosition интерфейс
 * из @polymarket/portfolio. Используется PortfolioService для создания и
 * обновления позиций на основе Fill-событий без зависимости от
 * пакета @polymarket/position (lot-based FIFO/LIFO).
 *
 * Предназначен только для application-слоя — хранит агрегированные данные
 * позиции (quantity + averageEntryPrice), без истории лотов.
 *
 * @example
 * ```typescript
 * const position = new SimplePosition({
 *   instrumentId: instrumentId,
 *   quantity: new Decimal('50'),
 *   averageEntryPrice: new Decimal('0.65'),
 *   side: 'LONG',
 * });
 * console.log(position.isClosed()); // false
 * ```
 */

import Decimal from 'decimal.js';
import type { InstrumentId } from '@polymarket/ids';
import type { IPosition } from '@polymarket/portfolio';

/** Параметры для создания SimplePosition */
export interface SimplePositionParams {
  /** ID инструмента (токена) */
  readonly instrumentId: InstrumentId;
  /** Текущее количество токенов (>= 0) */
  readonly quantity: Decimal;
  /** Средневзвешенная цена входа */
  readonly averageEntryPrice: Decimal;
  /** Сторона позиции */
  readonly side: 'LONG' | 'SHORT';
}

/** Реализация IPosition для использования в Portfolio aggregate */
export class SimplePosition implements IPosition {
  public readonly instrumentId: InstrumentId;
  public readonly quantity: { value(): Decimal };
  public readonly averageEntryPrice: { value(): Decimal };
  public readonly side: 'LONG' | 'SHORT';

  constructor(params: SimplePositionParams) {
    this.instrumentId = params.instrumentId;
    this.side = params.side;
    this.quantity = { value: () => params.quantity };
    this.averageEntryPrice = { value: () => params.averageEntryPrice };
  }

  /**
   * Возвращает true если позиция закрыта (количество = 0).
   *
   * @returns true если quantity равно нулю
   */
  public isClosed(): boolean {
    return this.quantity.value().isZero();
  }

  /**
   * Возвращает нереализованный PnL (упрощённая реализация).
   *
   * @remarks
   * SimplePosition не хранит лоты, поэтому PnL считается по
   * средней цене входа против текущей цены.
   *
   * @param currentPrice - Текущая рыночная цена (опционально)
   * @returns Нереализованный PnL или Decimal(0) если нет цены
   */
  public getUnrealizedPnL(currentPrice?: { value(): Decimal }): { value(): Decimal } {
    if (!currentPrice) {
      return { value: () => new Decimal(0) };
    }
    const qty = this.quantity.value();
    const entryPrice = this.averageEntryPrice.value();
    // Для SHORT: прибыль при падении цены (entryPrice - currentPrice)
    // Для LONG: прибыль при росте цены (currentPrice - entryPrice)
    const priceDiff = this.side === 'SHORT'
      ? entryPrice.minus(currentPrice.value())
      : currentPrice.value().minus(entryPrice);
    const pnl = qty.times(priceDiff);
    return { value: () => pnl };
  }
}
