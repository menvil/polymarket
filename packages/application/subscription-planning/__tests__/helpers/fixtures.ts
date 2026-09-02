/**
 * Общие фикстуры тестов планировщика подписок.
 *
 * @remarks
 * Записи собираются НАСТОЯЩИМИ `Market.create()` и настоящими value objects,
 * без моков сущности: половина проверяемых правил (строгая граница старта,
 * состояние рынка, точное начало торгов) — инварианты самих доменных типов,
 * и на моках они проверялись бы против выдуманной структуры, а не против
 * той, которую планировщик увидит в рантайме.
 *
 * Терминальные состояния собираются ШТАТНЫМИ переходами `markClosed()` /
 * `markResolved()`, а не подстановкой состояния в конструктор: инварианты
 * домена ради удобства фикстуры не обходятся.
 */
import { Market, MarketState, asMarketDuration } from '@polymarket/market';
import type { MarketDuration } from '@polymarket/market';
import {
  KnownVenues,
  unsafeCryptoAssetId,
  unsafeInstrumentId,
  unsafeMarketId,
} from '@polymarket/ids';
import type { VenueId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { MoneyService } from '@polymarket/value-objects';
import type { Money } from '@polymarket/value-objects';
import type { MarketDiscoveryEntry, MarketDiscoverySnapshot } from '@polymarket/ports';

/** Пять минут в миллисекундах. */
export const FIVE_MIN_MS = 5 * 60_000;
/** Пятнадцать минут в миллисекундах. */
export const FIFTEEN_MIN_MS = 15 * 60_000;
/** Минимальный запас по умолчанию (2 минуты) в миллисекундах. */
export const TWO_MIN_MS = 2 * 60_000;

/** Опорные моменты сценария смены policy. */
export const AT_1750_MS = Date.parse('2026-09-01T17:50:00.000Z');
export const AT_1755_MS = Date.parse('2026-09-01T17:55:00.000Z');
export const AT_1757_MS = Date.parse('2026-09-01T17:57:00.000Z');
export const AT_1758_MS = Date.parse('2026-09-01T17:58:00.000Z');
export const AT_1800_MS = Date.parse('2026-09-01T18:00:00.000Z');
export const AT_1805_MS = Date.parse('2026-09-01T18:05:00.000Z');
export const AT_1810_MS = Date.parse('2026-09-01T18:10:00.000Z');

/**
 * Собирает `Timestamp` из миллисекунд.
 *
 * @param ms - Момент в миллисекундах epoch
 * @returns Canonical `Timestamp`
 * @throws {Error} Если фикстура задаёт невалидный момент
 *
 * @example
 * ```typescript
 * const now = ts(AT_1757_MS);
 * ```
 */
export function ts(ms: number): Timestamp {
  const result = TimestampService.create(ms);
  if (!result.ok) throw new Error(`bad timestamp fixture: ${result.error.message}`);
  return result.value;
}

/**
 * Сумма в USDC.
 *
 * @param amount - Величина
 * @returns `Money` в USDC
 * @throws {Error} Если фикстура задаёт невалидную сумму
 *
 * @example
 * ```typescript
 * const liquidity = usdc(1000);
 * ```
 */
export function usdc(amount: number): Money {
  const result = MoneyService.create(amount, 'USDC');
  if (!result.ok) throw new Error(`bad money fixture: ${result.error.message}`);
  return result.value;
}

/**
 * Собирает НОМИНАЛ серии из миллисекунд.
 *
 * @param ms - Номинальная длительность серии
 * @returns `MarketDuration`
 * @throws {Error} Если фикстура задаёт невалидный номинал
 *
 * @example
 * ```typescript
 * const fiveMin = nominal(FIVE_MIN_MS);
 * ```
 */
export function nominal(ms: number): MarketDuration {
  const duration = asMarketDuration(ms);
  if (duration === undefined) throw new Error(`bad duration fixture: ${ms}`);
  return duration;
}

/** Подтверждённое состояние рынка в фикстуре. */
export type FixtureState = 'ACTIVE' | 'CLOSED' | 'RESOLVED';

/** Параметры фикстуры записи universe. */
export interface EntryOverrides {
  /** Идентификатор рынка (влияет и на инструменты исходов). */
  readonly id?: string;
  /** Вопрос рынка. */
  readonly question?: string;
  /** Базовый криптоактив. */
  readonly asset?: string;
  /** НОМИНАЛ серии. */
  readonly nominalMs?: number;
  /** Начало торгов. */
  readonly startsAtMs?: number;
  /** ФАКТИЧЕСКОЕ окно рынка (по умолчанию совпадает с номиналом). */
  readonly windowMs?: number;
  /** Площадка рынка. */
  readonly venueId?: VenueId;
  /** Подтверждённое состояние рынка. */
  readonly state?: FixtureState;
  /** Наблюдаемая ликвидность. */
  readonly liquidity?: number;
}

/**
 * Собирает запись universe: canonical рынок + наблюдения по нему.
 *
 * @param overrides - Отклонения от базовой фикстуры
 * @returns `MarketDiscoveryEntry` с настоящим `Market`
 * @throws {Error} Если параметры фикстуры нарушают инварианты `Market`
 *
 * @example
 * ```typescript
 * const entry = makeEntry({ id: 'xrp-1800', asset: 'xrp', startsAtMs: AT_1800_MS });
 * ```
 */
export function makeEntry(overrides: EntryOverrides = {}): MarketDiscoveryEntry {
  const {
    id = 'market-01',
    asset = 'btc',
    nominalMs = FIVE_MIN_MS,
    startsAtMs = AT_1800_MS,
    windowMs = nominalMs,
    venueId = KnownVenues.POLYMARKET,
    state = 'ACTIVE',
    liquidity = 1000,
    question = `${asset.toUpperCase()} Up or Down — ${new Date(startsAtMs).toISOString()}?`,
  } = overrides;

  const created = Market.create({
    id: unsafeMarketId(id),
    venueId,
    question,
    startsAt: ts(startsAtMs),
    expiresAt: ts(startsAtMs + windowMs),
    state: MarketState.active(),
    outcomes: [
      { index: 0, label: 'Up', instrumentId: unsafeInstrumentId(`${id}-up`) },
      { index: 1, label: 'Down', instrumentId: unsafeInstrumentId(`${id}-down`) },
    ],
    family: 'CRYPTO_UP_DOWN',
    crypto: { asset: unsafeCryptoAssetId(asset), duration: nominal(nominalMs) },
  });
  if (!created.ok) throw new Error(`bad market fixture: ${created.error.message}`);

  return {
    market: applyState(created.value, state),
    metrics: { liquidity: usdc(liquidity) },
  };
}

/**
 * Переводит рынок в требуемое подтверждённое состояние штатными переходами.
 *
 * @param market - Рынок в состоянии ACTIVE
 * @param state - Требуемое состояние фикстуры
 * @returns Рынок в этом состоянии
 * @throws {Error} Если домен отверг переход
 *
 * @example
 * ```typescript
 * const resolved = applyState(active, 'RESOLVED');
 * ```
 */
function applyState(market: Market, state: FixtureState): Market {
  if (state === 'ACTIVE') return market;

  const closed = market.markClosed();
  if (!closed.ok) throw new Error(`bad state fixture: ${closed.error.message}`);
  if (state === 'CLOSED') return closed.value;

  const resolved = closed.value.markResolved(0);
  if (!resolved.ok) throw new Error(`bad state fixture: ${resolved.error.message}`);
  return resolved.value;
}

/**
 * Снимок discovery из готовых записей.
 *
 * @param entries - Записи universe
 * @param observedAtMs - Момент обхода
 * @returns `MarketDiscoverySnapshot` с согласованной диагностикой
 *
 * @example
 * ```typescript
 * universe.replace(makeSnapshot([entryA, entryB], AT_1757_MS));
 * ```
 */
export function makeSnapshot(
  entries: readonly MarketDiscoveryEntry[],
  observedAtMs: number,
): MarketDiscoverySnapshot {
  return {
    observedAt: ts(observedAtMs),
    entries,
    diagnostics: {
      pagesFetched: 1,
      marketsScanned: entries.length,
      tradeableMarkets: entries.length,
      unsupportedMarkets: 0,
      supportedCryptoUpDown: entries.length,
      invalidMarkets: {
        total: 0,
        classification: 0,
        eventUnavailable: 0,
        schedule: 0,
        seriesDuration: 0,
        canonicalMapping: 0,
      },
      duplicateMarkets: 0,
      eventFetches: entries.length,
      eventFetchFailures: 0,
      eventCacheHits: 0,
    },
  };
}
