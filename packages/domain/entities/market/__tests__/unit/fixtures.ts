/**
 * Общие фикстуры тестов канонического Market
 *
 * @remarks
 * Модельный рынок во всех тестах один и тот же — 5-минутный BTC Up/Down
 * 12:00–12:05, ровно тот пример, который описан в контракте пакета.
 * Единая фикстура делает временные ассерты читаемыми: `at('11:59:59')`
 * вместо магических epoch-чисел.
 */

import { TimestampService, type Timestamp } from '@polymarket/timestamp';
import {
  Market,
  MarketState,
  asMarketDuration,
  parseMarketSlug,
  unsafeMarketId,
  unsafeInstrumentId,
  unsafeCryptoAssetId,
  KnownVenues,
  type MarketProps,
} from '../../src/index.js';

/** Дата модельного торгового дня — все временные метки внутри неё */
const TEST_DAY = '2026-09-01';

/**
 * Строит Timestamp из времени суток модельного торгового дня
 *
 * @param time - Время в формате `HH:MM:SS` или `HH:MM:SS.mmm`
 * @returns Timestamp соответствующего момента в UTC
 * @throws {Error} Если строка не парсится в валидный Timestamp
 *
 * @example
 * ```typescript
 * at('11:59:59'); // → Timestamp 2026-09-01T11:59:59.000Z
 * ```
 */
export function at(time: string): Timestamp {
  const iso = `${TEST_DAY}T${time.includes('.') ? time : `${time}.000`}Z`;
  const result = TimestampService.fromISO(iso);
  if (!result.ok) throw new Error(`Invalid test timestamp: ${iso}`);
  return result.value;
}

/** Запланированное начало модельного рынка — 12:00:00 */
export const STARTS_AT = at('12:00:00');
/** Запланированное окончание модельного рынка — 12:05:00 */
export const EXPIRES_AT = at('12:05:00');

/** InstrumentId исхода UP модельного рынка */
export const UP_INSTRUMENT = unsafeInstrumentId('71476031705491');
/** InstrumentId исхода DOWN модельного рынка */
export const DOWN_INSTRUMENT = unsafeInstrumentId('22993088410122');

/** Номинальная длительность 5-минутной серии */
export const FIVE_MINUTES = asMarketDuration(5 * 60_000)!;

/** Пара исходов модельного рынка */
export const TEST_OUTCOMES: MarketProps['outcomes'] = [
  { index: 0, label: 'Up', instrumentId: UP_INSTRUMENT },
  { index: 1, label: 'Down', instrumentId: DOWN_INSTRUMENT },
];

/**
 * Возвращает базовые параметры модельного рынка
 *
 * @returns {@link MarketProps} для BTC Up/Down 12:00–12:05 в состоянии ACTIVE
 *
 * @example
 * ```typescript
 * const props = baseProps();
 * ```
 */
export function baseProps(): MarketProps {
  return {
    id: unsafeMarketId('btc-up-down-1200'),
    venueId: KnownVenues.POLYMARKET,
    slug: parseMarketSlug('bitcoin-up-or-down-september-1-12pm-et')!,
    question: 'Bitcoin Up or Down — September 1, 12:00–12:05 ET?',
    startsAt: STARTS_AT,
    expiresAt: EXPIRES_AT,
    state: MarketState.active(),
    outcomes: TEST_OUTCOMES,
    family: 'CRYPTO_UP_DOWN',
    crypto: { asset: unsafeCryptoAssetId('btc'), duration: FIVE_MINUTES },
  };
}

/**
 * Создаёт модельный Market с точечными переопределениями
 *
 * @param overrides - Поля, которые нужно заменить
 * @returns `Result` из `Market.create()` — тесты сами решают, ожидают Ok или Err
 *
 * @example
 * ```typescript
 * const result = makeMarketResult({ question: '' }); // → Err
 * ```
 */
export function makeMarketResult(
  overrides: Partial<MarketProps> = {},
): ReturnType<typeof Market.create> {
  return Market.create({ ...baseProps(), ...overrides });
}

/**
 * Создаёт модельный Market и разворачивает Ok
 *
 * @param overrides - Поля, которые нужно заменить
 * @returns Market
 * @throws {Error} Если создание вернуло Err — значит, сломана фикстура теста
 *
 * @example
 * ```typescript
 * const market = makeMarket({ state: MarketState.closed() });
 * ```
 */
export function makeMarket(overrides: Partial<MarketProps> = {}): Market {
  const result = makeMarketResult(overrides);
  if (!result.ok) throw new Error(`Test fixture is invalid: ${result.error.message}`);
  return result.value;
}

/**
 * Разворачивает Ok-результат в тестах
 *
 * @param result - Result из доменного вызова
 * @param context - Пояснение для сообщения об ошибке
 * @returns Значение из Ok
 * @throws {Error} Если result — Err
 *
 * @example
 * ```typescript
 * const closed = unwrap(market.markClosed());
 * ```
 */
export function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
  context = '',
): T {
  if (!result.ok) throw new Error(`Expected Ok result${context ? `: ${context}` : ''}`);
  return result.value;
}
