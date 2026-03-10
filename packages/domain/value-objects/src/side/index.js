/**
 * Side module - направление торговой операции
 *
 * @remarks
 * Представляет сторону в торговой операции (BUY или SELL).
 *
 * ## Основные экспорты:
 *
 * ### Core
 * - **Side** — type alias ('BUY' | 'SELL')
 *
 * ### Facade (публичный API)
 * - **SideService** — создание и валидация Side
 *
 * ### Adapters
 * - **SideSerializer** — JSON сериализация/десериализация
 * - **SideFormatter** — форматирование для UI
 *
 * ### Errors
 * - **SideErrorReason** — типизированные причины ошибок
 *
 * ## Использование:
 *
 * @example
 * ```typescript
 * import { SideService, SideFormatter } from '@polymarket/value-objects';
 *
 * // Создание с валидацией
 * const result = SideService.fromString('BUY');
 * if (result.ok) {
 *   const side = result.value;
 *
 *   // Форматирование
 *   console.log(SideFormatter.toDisplay(side)); // 'Buy'
 *   console.log(SideFormatter.toEmoji(side));   // '🟢'
 *
 *   // Утилиты
 *   const opposite = SideService.opposite(side); // 'SELL'
 *   const canMatch = SideService.canMatch(side, 'SELL'); // true
 * }
 * ```
 */
// Facade (публичный API)
export { SideService } from './facade/index.js';
// Adapters (serialization + formatting)
export { SideSerializer, SideFormatter } from './adapters/index.js';
// Errors (error reasons)
export { SideErrorReason } from './errors/index.js';
//# sourceMappingURL=index.js.map