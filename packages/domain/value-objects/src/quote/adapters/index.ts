/**
 * Quote Adapters Layer
 *
 * @remarks
 * Экспортирует адаптеры для работы с Quote:
 * - QuoteSerializer: JSON сериализация/десериализация
 * - QuoteFormatter: форматирование для отображения
 */

export { QuoteSerializer, type QuoteJSON } from './QuoteSerializer.js';
export { QuoteFormatter, type QuoteFormatOptions } from './QuoteFormatter.js';
