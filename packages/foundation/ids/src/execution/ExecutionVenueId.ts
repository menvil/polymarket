import type { VenueId } from '../core/VenueId.js';
import { KnownVenues, asVenueId } from '../core/VenueId.js';

/**
 * ExecutionVenueId - место исполнения (куда отправляются ордера)
 *
 * @remarks
 * Отвечает на вопрос: "КУДА мы ОТПРАВЛЯЕМ ордера?"
 *
 * Используется в:
 * - Order (куда отправлен ордер)
 * - Fill (где исполнился ордер)
 *
 * Разделение Live vs Simulation:
 * - Live venues: Реальное исполнение на бирже
 * - SIMULATOR: Виртуальное исполнение (backtest, paper trading)
 *
 * Branded string для extensibility: можно добавлять новые execution venues
 * без изменения foundation layer.
 *
 * Известные execution venues:
 * - POLYMARKET: Polymarket live execution
 * - KALSHI: Kalshi live execution
 * - SIMULATOR: Simulated execution (backtest, paper trading)
 *
 * @example
 * ```typescript
 * import { KnownExecutionVenues, asExecutionVenueId } from '@polymarket/ids';
 *
 * // Live trading
 * const order = {
 *   venueId: KnownExecutionVenues.POLYMARKET,
 *   side: 'BUY',
 *   price: 0.48
 * };
 *
 * // Backtest
 * const simulatedOrder = {
 *   venueId: KnownExecutionVenues.SIMULATOR,
 *   side: 'BUY',
 *   price: 0.48
 * };
 *
 * // Custom execution venue с валидацией
 * const customVenue = asExecutionVenueId('MY_CUSTOM_VENUE');
 * if (customVenue) {
 *   console.log('Valid execution venue');
 * }
 * ```
 */
export type ExecutionVenueId = string & { readonly __brand: 'ExecutionVenueId' };

/**
 * Известные execution venues
 */
export const KnownExecutionVenues = {
  POLYMARKET: 'POLYMARKET' as ExecutionVenueId,
  KALSHI: 'KALSHI' as ExecutionVenueId,
  SIMULATOR: 'SIMULATOR' as ExecutionVenueId,
} as const;

/**
 * Set известных execution venues для быстрой проверки
 * @internal
 */
const KNOWN_EXECUTION_VENUE_SET = new Set<string>(Object.values(KnownExecutionVenues));

/**
 * Type guard для проверки известных execution venues
 *
 * @param id - Строка для проверки
 * @returns true если id является известным execution venue
 *
 * @remarks
 * Проверяет только известные venues (POLYMARKET, KALSHI, SIMULATOR).
 * Для проверки формата custom venues используй asExecutionVenueId().
 *
 * @example
 * ```typescript
 * isKnownExecutionVenue('POLYMARKET'); // → true
 * isKnownExecutionVenue('SIMULATOR'); // → true
 * isKnownExecutionVenue('CUSTOM_VENUE'); // → false (неизвестный venue)
 * ```
 */
export function isKnownExecutionVenue(id: string): id is ExecutionVenueId {
  return KNOWN_EXECUTION_VENUE_SET.has(id);
}

/**
 * Валидация и парсинг ExecutionVenueId
 *
 * @param raw - Строка для парсинга
 * @returns ExecutionVenueId или undefined если формат невалидный
 *
 * @remarks
 * Валидирует формат ExecutionVenueId:
 * - Только uppercase буквы, цифры, подчеркивания
 * - Длина 1-32 символа
 * - Не может начинаться с цифры
 * - НЕ содержит ':' или '\' (гарантия для round-trip сериализации)
 *
 * Поддерживает как известные venues (POLYMARKET, KALSHI, SIMULATOR),
 * так и кастомные venues с валидным форматом.
 *
 * Для строгой проверки только известных venues используй isKnownExecutionVenue().
 *
 * @example
 * ```typescript
 * asExecutionVenueId('POLYMARKET'); // → 'POLYMARKET' as ExecutionVenueId
 * asExecutionVenueId('SIMULATOR'); // → 'SIMULATOR' as ExecutionVenueId
 * asExecutionVenueId('MY_CUSTOM_VENUE'); // → 'MY_CUSTOM_VENUE' as ExecutionVenueId
 * asExecutionVenueId('invalid-venue'); // → undefined (содержит дефис)
 * asExecutionVenueId('123VENUE'); // → undefined (начинается с цифры)
 * asExecutionVenueId(''); // → undefined (пустая строка)
 * asExecutionVenueId('has:colon'); // → undefined (содержит ':')
 * ```
 */
export function asExecutionVenueId(raw: string): ExecutionVenueId | undefined {
  // Формат: uppercase буквы, цифры, подчеркивания, 1-32 символа, не начинается с цифры
  // Regex автоматически запрещает ':' и '\' (не входят в [A-Z0-9_])
  if (!/^[A-Z_][A-Z0-9_]{0,31}$/.test(raw)) {
    return undefined;
  }

  return raw as ExecutionVenueId;
}

/**
 * Mapping: ExecutionVenueId → VenueId
 *
 * @remarks
 * SIMULATOR не мапится в VenueId (это виртуальный venue).
 *
 * Для кастомных execution venues валидирует формат через asVenueId()
 * и возвращает undefined если формат невалидный или это SIMULATOR.
 *
 * @example
 * ```typescript
 * executionToVenue(KnownExecutionVenues.POLYMARKET);  // → 'POLYMARKET' as VenueId
 * executionToVenue(KnownExecutionVenues.KALSHI);      // → 'KALSHI' as VenueId
 * executionToVenue(KnownExecutionVenues.SIMULATOR);   // → undefined (виртуальный venue)
 *
 * // Custom venue с валидацией
 * const customExec = asExecutionVenueId('MY_CUSTOM_VENUE')!;
 * executionToVenue(customExec); // → 'MY_CUSTOM_VENUE' as VenueId
 * ```
 */
export function executionToVenue(venueId: ExecutionVenueId): VenueId | undefined {
  // SIMULATOR это виртуальный venue, не мапится в VenueId
  if (venueId === KnownExecutionVenues.SIMULATOR) {
    return undefined;
  }

  // Для известных venues возвращаем соответствующий VenueId
  if (venueId === KnownExecutionVenues.POLYMARKET) {
    return KnownVenues.POLYMARKET;
  }

  if (venueId === KnownExecutionVenues.KALSHI) {
    return KnownVenues.KALSHI;
  }

  // Для кастомных venues валидируем формат через asVenueId
  // (ExecutionVenueId и VenueId имеют одинаковый формат)
  return asVenueId(venueId);
}

/**
 * Проверка что venue является симуляцией
 *
 * @param venueId - ExecutionVenueId для проверки
 * @returns true если venue является SIMULATOR
 *
 * @example
 * ```typescript
 * isSimulator(KnownExecutionVenues.SIMULATOR); // → true
 * isSimulator(KnownExecutionVenues.POLYMARKET); // → false
 * ```
 */
export function isSimulator(venueId: ExecutionVenueId): boolean {
  return venueId === KnownExecutionVenues.SIMULATOR;
}

/**
 * Проверка что venue является live (не симуляцией)
 *
 * @param venueId - ExecutionVenueId для проверки
 * @returns true если venue НЕ является SIMULATOR
 *
 * @remarks
 * Live venue означает реальное исполнение ордеров на бирже,
 * в отличие от SIMULATOR (backtest, paper trading).
 *
 * @example
 * ```typescript
 * isLiveVenue(KnownExecutionVenues.POLYMARKET); // → true
 * isLiveVenue(KnownExecutionVenues.KALSHI); // → true
 * isLiveVenue(KnownExecutionVenues.SIMULATOR); // → false
 * ```
 */
export function isLiveVenue(venueId: ExecutionVenueId): boolean {
  return !isSimulator(venueId);
}
