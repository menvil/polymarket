/**
 * Математика исполнений — приватный модуль пакета
 *
 * @remarks
 * Не экспортируется из index.ts.
 * Содержит всю арифметику fill-состояния:
 * - addFill: добавить исполнение с валидацией
 * - isFull: заявка полностью исполнена
 * - emptyFill: начальное состояние
 * - VWAP: взвешенная средняя цена
 */
import { Result } from '@polymarket/result';
import { Quantity } from '@polymarket/value-objects';
import type { FillState, FillData } from './OrderState.js';
import { TradingError } from '@polymarket/errors';
/**
 * Создаёт пустое fill-состояние для новой заявки
 */
export declare function emptyFill(): FillState;
/**
 * Добавляет исполнение к текущему fill-состоянию
 *
 * @param state - Текущее fill-состояние
 * @param fill - Данные нового исполнения
 * @param orderSize - Полный размер заявки (для проверки превышения)
 * @returns Новое fill-состояние или ошибка
 *
 * @remarks
 * Алгоритм:
 * 1. Проверяет что fillSize > 0
 * 2. Проверяет отсутствие дубликата fillId
 * 3. Проверяет что fillSize <= remainingSize
 * 4. Вычисляет новый filledSize
 * 5. Вычисляет VWAP
 */
export declare function addFill(state: FillState, fill: FillData, orderSize: Quantity): Result<FillState, TradingError>;
/**
 * Проверяет что заявка полностью исполнена
 */
export declare function isFull(state: FillState, orderSize: Quantity): boolean;
//# sourceMappingURL=_fill.d.ts.map