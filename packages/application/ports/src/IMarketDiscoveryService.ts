/**
 * Порт: сервис обнаружения рынков.
 *
 * @remarks
 * `IMarketDiscoveryService` — application-layer порт (Dependency Inversion).
 * Инфраструктурная реализация `PolymarketMarketDiscoveryAdapter` обращается
 * к Gamma REST API, фильтрует и скорит рынки, затем возвращает готовых кандидатов.
 *
 * Используется:
 * - `MarketDiscoveryPublisher._discover()` — получить список кандидатов и наполнить каталог
 *
 * ### Жизненный цикл:
 * ```
 * MarketDiscoveryPublisher._discover()
 *   → discoveryService.findCandidates()
 *   → (внутри: TTL cache check → при необходимости refresh())
 *   → возвращает DiscoveredMarket[]
 *   → publisher регистрирует каждого кандидата через catalog.register(candidate)
 * ```
 */
import type Decimal from 'decimal.js';
import type { InstrumentInfo } from './IMarketCatalog.js';
import type { Timestamp } from '@polymarket/value-objects';

/**
 * Обнаруженный рынок — кандидат для торговли.
 *
 * @remarks
 * Расширяет `InstrumentInfo` — содержит все данные, необходимые для прямой
 * регистрации в каталоге через `catalog.register(candidate)`. Поля `spread`,
 * `liquidity` и `score` используются для фильтрации и приоритизации рынков
 * в `MarketFilter` и `MarketScorer`.
 *
 * `active: true` — литеральный тип: кандидат всегда активен по определению
 * (неактивные рынки отфильтровываются в адаптере ещё до создания DiscoveredMarket).
 */
export interface DiscoveredMarket extends InstrumentInfo {
  /** Кандидат всегда активен (narrowed from boolean → true) */
  readonly active: true;
  /** Вопрос рынка (человекочитаемое описание) */
  readonly question: string;
  /** Текущий спред (bid-ask). `undefined` если недоступен (нет данных от API). */
  readonly spread?: Decimal;
  /** Ликвидность (объём торгов). Decimal('0') если недоступен */
  readonly liquidity: Decimal;
  /**
   * Скор рынка — устанавливается `MarketScorer`.
   * До скоринга = Decimal('0'). После = hoursToExpiry как Decimal.
   */
  readonly score: Decimal;
  /**
   * Все token ID рынка (UP + DOWN) из `clobTokenIds`.
   * Используется для подписки и маршрутизации событий обоих исходов.
   * Если не задан — только `instrumentId` (UP token).
   */
  readonly allTokenIds?: readonly string[];
  /**
   * Полные сырые данные рынка из REST API (опционально).
   * Устанавливается адаптером и передаётся в `MarketMeta.rawMarket`
   * для записи в meta-строку снапшота.
   */
  readonly rawMarket?: Record<string, unknown>;
  /**
   * Время начала события (epoch ms). Парсится из `eventStartTime` в API.
   * Используется вместе с `expiresAt` для вычисления длительности рынка.
   */
  readonly eventStartMs?: number;
  /**
   * Время начала рынка (когда начинается запись данных). Timestamp из `events[0].startDate`.
   * Используется для выравнивания по границе начала рынка (аналог CEX window alignment).
   */
  readonly startsAt?: Timestamp;
}

// TODO(discovery): prefer catalog.registerMarket() when all outcome tokens for
// a market are available, to avoid temporarily exposing partial markets.
/**
 * Порт: сервис обнаружения рынков.
 *
 * @example
 * ```typescript
 * const candidates = await discoveryService.findCandidates();
 * for (const candidate of candidates) {
 *   // DiscoveredMarket extends InstrumentInfo — регистрируем напрямую
 *   catalog.register(candidate);
 * }
 * ```
 */
export interface IMarketDiscoveryService {
  /**
   * Возвращает список отфильтрованных и проскоренных кандидатов.
   *
   * @returns Readonly массив DiscoveredMarket, отсортированных по приоритету
   *
   * @remarks
   * Реализация кэширует результаты на `cacheTtlMs` миллисекунд.
   * При устаревшем кэше автоматически вызывает `refresh()`.
   * Количество возвращаемых рынков ограничено `IMarketFilterConfig.maxMarketsToReturn`.
   *
   * @example
   * ```typescript
   * const candidates = await discoveryService.findCandidates();
   * console.log(`Found ${candidates.length} tradeable markets`);
   * ```
   */
  findCandidates(): Promise<readonly DiscoveredMarket[]>;

  /**
   * Принудительно обновляет кэш кандидатов из источника данных.
   *
   * @remarks
   * Вызывается внутри `findCandidates()` при устаревшем TTL.
   * Можно вызвать явно для немедленного обновления данных.
   *
   * @example
   * ```typescript
   * await discoveryService.refresh();
   * const freshCandidates = await discoveryService.findCandidates();
   * ```
   */
  refresh(): Promise<void>;
}
