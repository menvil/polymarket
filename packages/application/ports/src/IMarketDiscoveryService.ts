/**
 * Порт: сервис обнаружения рынков.
 *
 * @remarks
 * `IMarketDiscoveryService` — application-layer порт (Dependency Inversion).
 * Инфраструктурная реализация `PolymarketMarketDiscoveryAdapter` обращается
 * к Gamma REST API, фильтрует и скорит рынки, затем возвращает готовых кандидатов.
 *
 * Используется:
 * - `StrategyCoordinator._discover()` — получить список кандидатов и наполнить каталог
 *
 * ### Жизненный цикл:
 * ```
 * StrategyCoordinator._discover()
 *   → discoveryService.findCandidates()
 *   → (внутри: TTL cache check → при необходимости refresh())
 *   → возвращает DiscoveredMarket[]
 *   → coordinator.register() в IMarketCatalog
 * ```
 */
import type { MarketId, InstrumentId } from '@polymarket/ids';
import type { Price, Quantity, Timestamp } from '@polymarket/value-objects';

/**
 * Обнаруженный рынок — кандидат для торговли.
 *
 * @remarks
 * Содержит все данные, необходимые для регистрации в каталоге и принятия
 * торгового решения. Поля `spread`, `liquidity` и `score` используются
 * для фильтрации и приоритизации рынков в `MarketFilter` и `MarketScorer`.
 */
export interface DiscoveredMarket {
  /** ID рынка (condition_id в Polymarket API) */
  readonly marketId: MarketId;
  /** ID токена YES исхода (clobTokenIds[0]) */
  readonly instrumentId: InstrumentId;
  /** Вопрос рынка (человекочитаемое описание) */
  readonly question: string;
  /** Время истечения рынка */
  readonly expiresAt: Timestamp;
  /** Минимальный шаг цены ордера */
  readonly tickSize: Price;
  /** Минимальный размер ордера */
  readonly minOrderSize: Quantity;
  /** Текущий спред (bid-ask). 0 если недоступен */
  readonly spread: number;
  /** Ликвидность (объём торгов). 0 если недоступен */
  readonly liquidity: number;
  /**
   * Скор рынка — устанавливается `MarketScorer`.
   * До скоринга = 0. После = hoursToExpiry (ближайшее истечение → меньше скор → приоритет).
   */
  readonly score: number;
}

/**
 * Порт: сервис обнаружения рынков.
 *
 * @example
 * ```typescript
 * const candidates = await discoveryService.findCandidates();
 * for (const candidate of candidates) {
 *   catalog.register({
 *     instrumentId: candidate.instrumentId,
 *     marketId: candidate.marketId,
 *     tickSize: candidate.tickSize,
 *     minOrderSize: candidate.minOrderSize,
 *     active: true,
 *   });
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
