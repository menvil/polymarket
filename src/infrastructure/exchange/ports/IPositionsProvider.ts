/**
 * Общий интерфейс провайдера позиций (МНОЖЕСТВЕННОЕ ЧИСЛО!)
 *
 * @remarks
 * Провайдер позиций абстрагирует доступ к данным о позициях.
 * Позиции - это исполненные сделки, НЕ открытые ордера.
 *
 * **ВАЖНО**: Это множественное число "Positions" (не единственное "Position"),
 * потому что он управляет несколькими позициями.
 *
 * **Варианты использования**:
 * - Получение текущих позиций (исполненные сделки)
 * - Расчёт нереализованного PnL
 * - Проверка лимитов позиций
 * - Отображение сводки портфеля
 *
 * @example
 * ```typescript
 * const provider = new PolymarketPositionsProvider(positionsClient, mapper, logger);
 *
 * const positions = await provider.getPositions();
 * console.log(`Total positions: ${positions.length}`);
 *
 * const state = await provider.getPositionState('0x123');
 * console.log(`Current: ${state.currentPosition}, Limit: ${state.positionLimit}`);
 * ```
 */

import type { PositionResponse, PositionState } from '../types/PositionResponse.js';

export type { PositionResponse, PositionState };

/**
 * Общий интерфейс провайдера позиций (МНОЖЕСТВЕННОЕ ЧИСЛО!)
 */
export interface IPositionsProvider {
  /**
   * Получить текущие позиции (исполненные сделки)
   *
   * @param tokenId - Опционально: фильтр по ID токена
   * @returns Массив позиций
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Возвращает исполненные сделки, НЕ открытые ордера.
   * Для открытых ордеров используйте IOrdersProvider.
   *
   * @example
   * ```typescript
   * const positions = await provider.getPositions();
   * console.log(`Total positions: ${positions.length}`);
   *
   * const btcPositions = await provider.getPositions('BTC-USD');
   * console.log(`BTC position: ${btcPositions[0].size}`);
   * ```
   */
  getPositions(tokenId?: string): Promise<PositionResponse[]>;

  /**
   * Получить состояние позиции для конкретного токена
   *
   * @param tokenId - ID токена
   * @returns Состояние позиции с лимитами
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Используется для валидации перед размещением ордеров.
   * Проверяет текущий размер позиции и лимиты.
   *
   * @example
   * ```typescript
   * const state = await provider.getPositionState('0x123');
   *
   * if (state.canIncrease) {
   *   console.log(`Can increase position up to ${state.positionLimit}`);
   * }
   * ```
   */
  getPositionState(tokenId: string): Promise<PositionState>;

  /**
   * Получить общий нереализованный PnL по всем позициям
   *
   * @returns Общий нереализованный PnL
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Опциональный метод. Вычисляет сумму нереализованного PnL для всех позиций.
   */
  getTotalUnrealizedPnl?(): Promise<number>;

  /**
   * Получить общий реализованный PnL по всем позициям
   *
   * @returns Общий реализованный PnL
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Опциональный метод. Вычисляет сумму реализованного PnL для всех закрытых позиций.
   */
  getTotalRealizedPnl?(): Promise<number>;
}