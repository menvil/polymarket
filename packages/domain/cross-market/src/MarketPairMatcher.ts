/**
 * Матчер пар рынков для кросс-маркетного арбитража
 *
 * @remarks
 * Находит пары рынков с одинаковым `(asset, endDate)` но разной `recurrence`.
 * Работает в двух режимах:
 * 1. **Из снапшотов (backtest)**: парсит meta-строки NDJSON файлов
 * 2. **Из Gamma API (live)**: парсит ticker поле из DiscoveredMarket
 *
 * ### Алгоритм:
 * 1. Для каждого рынка парсим ticker: `btc-updown-15m-1774231200`
 *    → asset='BTC', recurrence='15m', endEpoch=1774231200
 * 2. Группируем по ключу `(asset, endDate)`
 * 3. В каждой группе ≥2 рынков → создаём все пары
 * 4. В каждой паре определяем easy (длинная duration) vs hard (короткая)
 *
 * ### Точки пересечения:
 * - :00 — 5m + 15m + hourly → до 3 пар
 * - :15, :30, :45 — 5m + 15m → 1 пара
 *
 * @example
 * ```typescript
 * const matcher = new MarketPairMatcher();
 * const infos = await matcher.parseSnapshotDir('/snapshots/2026-03-23');
 * const pairs = matcher.findPairs(infos);
 * console.log(`Found ${pairs.length} pairs`);
 * ```
 */

import { asInstrumentId } from '@polymarket/ids';
import type { MarketInfo, MarketPair, Recurrence } from './types.js';
import { RECURRENCE_RANK, OVERLAP_DURATION_MS } from './types.js';

/**
 * Длительность рынка в секундах по типу recurrence.
 *
 * @remarks
 * Epoch в тикере Polymarket (`btc-updown-5m-1774382700`) — это **startTime** рынка.
 * Для вычисления endTime: `endEpoch = startEpoch + RECURRENCE_DURATION_SEC[recurrence]`.
 */
const RECURRENCE_DURATION_SEC: Record<Recurrence, number> = {
  '5m': 5 * 60,
  '15m': 15 * 60,
  hourly: 60 * 60,
  daily: 24 * 60 * 60,
};

/**
 * Результат парсинга ticker строки.
 * @internal
 */
interface TickerParseResult {
  readonly asset: string;
  readonly recurrence: Recurrence;
  readonly startEpoch: number;
  readonly endEpoch: number;
}

/**
 * Сырая мета-строка снапшота (первая строка NDJSON файла).
 */
export interface RawSnapshotMeta {
  readonly t: 'meta';
  readonly tokenIds: string[];
  readonly m?: {
    readonly endDate?: string;
    readonly eventStartTime?: string;
    readonly events?: ReadonlyArray<{
      readonly ticker?: string;
      readonly startTime?: string;
      readonly eventMetadata?: {
        readonly priceToBeat?: number | string;
        readonly finalPrice?: number | string;
      };
    }>;
  };
}

/**
 * Матчер пар рынков.
 */
export class MarketPairMatcher {
  /**
   * Парсит ticker строку формата `btc-updown-15m-1774231200`.
   *
   * @param ticker - Строка ticker из Gamma API
   * @returns Распарсенные данные или undefined при невалидном формате
   *
   * @example
   * ```typescript
   * const result = MarketPairMatcher.parseTicker('btc-updown-15m-1774231200');
   * // { asset: 'BTC', recurrence: '15m', startEpoch: 1774231200, endEpoch: 1774232100 }
   * ```
   */
  static parseTicker(ticker: string): TickerParseResult | undefined {
    const match = ticker.match(/^(\w+)-updown-(\w+)-(\d+)$/);
    if (!match) return undefined;

    const asset = match[1].toUpperCase();
    const rec = match[2];
    const startEpoch = parseInt(match[3], 10);

    if (!isValidRecurrence(rec)) return undefined;

    // Epoch в тикере — это startTime рынка, не endTime.
    // endEpoch = startEpoch + duration (5m→300s, 15m→900s, hourly→3600s, daily→86400s).
    const durationSec = RECURRENCE_DURATION_SEC[rec];
    const endEpoch = startEpoch + durationSec;

    return { asset, recurrence: rec, startEpoch, endEpoch };
  }

  /**
   * Извлекает MarketInfo из мета-строки снапшота.
   *
   * @param meta - Первая строка NDJSON файла (t='meta')
   * @param filePath - Путь к файлу (для привязки)
   * @returns MarketInfo или undefined при невалидных данных
   */
  static parseSnapshotMeta(meta: RawSnapshotMeta, filePath: string): MarketInfo | undefined {
    const m = meta.m;
    if (!m) return undefined;

    const events = m.events;
    const ticker = events?.[0]?.ticker;
    if (!ticker) return undefined;

    const parsed = MarketPairMatcher.parseTicker(ticker);
    if (!parsed) return undefined;

    const endDate = m.endDate;
    if (!endDate) return undefined;
    const endEpochMs = Date.parse(endDate);
    if (!Number.isFinite(endEpochMs)) return undefined;

    const rawTokenId = meta.tokenIds[0];
    if (!rawTokenId) return undefined;

    const instrumentId = asInstrumentId(rawTokenId);
    if (!instrumentId) return undefined;

    const rawDownTokenId = meta.tokenIds[1];
    const downInstrumentId = rawDownTokenId ? asInstrumentId(rawDownTokenId) : undefined;
    const event = events?.[0];
    const startDate = event?.startTime ?? m.eventStartTime;
    const parsedStartMs = startDate ? Date.parse(startDate) : NaN;
    const startEpochMs = Number.isFinite(parsedStartMs) ? parsedStartMs : parsed.startEpoch * 1000;
    const priceToBeat = toOptionalNumber(event?.eventMetadata?.priceToBeat);
    const finalPrice = toOptionalNumber(event?.eventMetadata?.finalPrice);

    return {
      asset: parsed.asset,
      recurrence: parsed.recurrence,
      endDate,
      startDate: Number.isFinite(parsedStartMs) ? startDate : new Date(startEpochMs).toISOString(),
      startEpochMs,
      endEpochMs,
      instrumentId,
      downInstrumentId,
      filePath,
      ticker,
      priceToBeat,
      finalPrice,
    };
  }

  /**
   * Находит все пары рынков из списка MarketInfo.
   *
   * @param markets - Список рынков (из parseSnapshotMeta или Gamma API)
   * @returns Массив MarketPair, отсортированный по endDate
   *
   * @remarks
   * Алгоритм:
   * 1. Группируем по `(asset, endDate)` ← ключ идентичности
   * 2. В каждой группе ≥2 рынков → генерируем все пары
   * 3. Easy = рынок с меньшим RECURRENCE_RANK (длиннее duration)
   * 4. Тип пары формируется из отсортированных recurrence: `5m-15m`, `5m-hourly`, etc.
   *
   * @example
   * ```typescript
   * const pairs = matcher.findPairs(marketInfos);
   * for (const pair of pairs) {
   *   console.log(`${pair.easy.asset} ${pair.easy.endDate}: ${pair.pairType}`);
   * }
   * ```
   */
  findPairs(markets: readonly MarketInfo[]): MarketPair[] {
    // Группировка по (asset, endDate)
    const groups = new Map<string, MarketInfo[]>();

    for (const m of markets) {
      const key = `${m.asset}:${m.endDate}`;
      const group = groups.get(key);
      if (group) {
        group.push(m);
      } else {
        groups.set(key, [m]);
      }
    }

    // Генерация пар
    const pairs: MarketPair[] = [];

    for (const group of groups.values()) {
      if (group.length < 2) continue;

      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];

          // Определяем easy (длиннее) vs hard (короче)
          const rankA = RECURRENCE_RANK[a.recurrence];
          const rankB = RECURRENCE_RANK[b.recurrence];

          let easy: MarketInfo;
          let hard: MarketInfo;

          if (rankA < rankB) {
            easy = a;
            hard = b;
          } else if (rankA > rankB) {
            easy = b;
            hard = a;
          } else {
            // Одинаковая duration — не пара
            continue;
          }

          // Тип пары (отсортированные recurrence)
          const recs = [easy.recurrence, hard.recurrence].sort(
            (a, b) => RECURRENCE_RANK[a] - RECURRENCE_RANK[b],
          );
          const pairType = `${recs[1]}-${recs[0]}`;
          const overlapMs = OVERLAP_DURATION_MS[pairType] ?? 5 * 60 * 1000;

          pairs.push({ easy, hard, pairType, overlapMs });
        }
      }
    }

    // Сортировка по endDate
    pairs.sort((a, b) => a.easy.endEpochMs - b.easy.endEpochMs);

    return pairs;
  }
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Проверяет, является ли строка валидной Recurrence.
 * @internal
 */
function isValidRecurrence(rec: string): rec is Recurrence {
  return rec in RECURRENCE_RANK;
}
