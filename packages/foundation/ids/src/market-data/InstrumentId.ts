/**
 * InstrumentId - идентификатор инструмента на market data source
 *
 * @remarks
 * Branded type для type safety.
 *
 * Представляет ID инструмента в venue-specific формате:
 * - Polymarket: token_id (ERC1155 token ID, цифры)
 * - Kalshi: ticker (e.g., "INXD-23DEC31-T4120")
 *
 * Используется для:
 * - Subscription на маркет-данные
 * - Идентификация инструмента в котировках/трейдах
 *
 * @example
 * ```typescript
 * // Polymarket token_id
 * const polymarketInstrument = asInstrumentId('123456789')!;
 *
 * // Kalshi ticker
 * const kalshiInstrument = asInstrumentId('INXD-23DEC31-T4120')!;
 * ```
 */
export type InstrumentId = string & { readonly __brand: 'InstrumentId' };

/**
 * Максимальная длина InstrumentId
 * @internal
 */
const MAX_INSTRUMENT_ID_LENGTH = 128;

/**
 * Валидация и парсинг InstrumentId
 *
 * @param raw - Строка для парсинга
 * @returns InstrumentId или undefined если формат невалидный
 *
 * @remarks
 * Базовые ограничения (venue-agnostic):
 * - Не пустая строка
 * - Максимум 128 символов
 * - Не содержит control characters (U+0000..U+001F, U+007F..U+009F)
 * - Не содержит пробелы по краям (автоматически trim)
 *
 * Для venue-specific валидации используй separate venue parsers
 * или check формат после парсинга.
 *
 * @example
 * ```typescript
 * asInstrumentId('123456789'); // → '123456789' as InstrumentId (Polymarket token_id)
 * asInstrumentId('INXD-23DEC31-T4120'); // → 'INXD-23DEC31-T4120' as InstrumentId (Kalshi ticker)
 * asInstrumentId('  valid  '); // → 'valid' as InstrumentId (trimmed)
 * asInstrumentId(''); // → undefined (пустая строка)
 * asInstrumentId('  '); // → undefined (только пробелы)
 * asInstrumentId('a\x00b'); // → undefined (control character)
 * asInstrumentId('x'.repeat(200)); // → undefined (слишком длинная)
 * ```
 */
export function asInstrumentId(raw: string): InstrumentId | undefined {
  // Trim whitespace
  const trimmed = raw.trim();

  // Non-empty check
  if (trimmed.length === 0) {
    return undefined;
  }

  // Length check
  if (trimmed.length > MAX_INSTRUMENT_ID_LENGTH) {
    return undefined;
  }

  // Control characters check
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F-\x9F]/.test(trimmed)) {
    return undefined;
  }

  return trimmed as InstrumentId;
}

/**
 * Unsafe constructor - bypasses validation
 *
 * @internal
 * @param raw - Raw string (без валидации)
 * @returns InstrumentId
 *
 * @remarks
 * Используй только если уверен что строка валидна.
 * Для external input всегда используй asInstrumentId().
 */
export function unsafeInstrumentId(raw: string): InstrumentId {
  return raw as InstrumentId;
}
