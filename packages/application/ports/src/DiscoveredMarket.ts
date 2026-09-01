/**
 * LEGACY-контракт кандидата обнаружения рынков.
 *
 * @remarks
 * `DiscoveredMarket` — прежняя (до canonical `Market`) форма кандидата
 * discovery: плоский DTO, совмещающий identity инструмента, торговые
 * параметры и БЫСТРО МЕНЯЮЩИЕСЯ наблюдения (`spread`, `liquidity`, `score`).
 *
 * ### Почему он ещё здесь
 *
 * Контракт остаётся ИСКЛЮЧИТЕЛЬНО как вход `MarketFilter`/`MarketScorer`
 * (`@polymarket/market-discovery`) и legacy V1-адаптера. Новый Polymarket V2
 * Discovery его больше не производит: за vendor-границей живёт canonical
 * `Market` плюс отдельные {@link MarketDiscoveryMetrics}
 * (см. `IMarketDiscoveryService.ts`).
 *
 * Filter/Scorer мигрируют на `MarketDiscoveryEntry` в следующем Policy-MR —
 * тогда этот файл исчезнет вместе с ними.
 *
 * @deprecated Используйте `MarketDiscoveryEntry` из `IMarketDiscoveryService.ts`.
 */
import type Decimal from 'decimal.js';
import type { InstrumentInfo } from './IMarketCatalog.js';
import type { Money, Ratio } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';

/**
 * Обнаруженный рынок — legacy-кандидат для торговли.
 *
 * @remarks
 * Расширяет `InstrumentInfo` — содержит все данные, необходимые для прямой
 * регистрации в каталоге через `catalog.register(candidate)`. Поля `spread`,
 * `liquidity` и `score` используются для фильтрации и приоритизации рынков
 * в `MarketFilter` и `MarketScorer`.
 *
 * `active: true` — литеральный тип: кандидат всегда активен по определению
 * (неактивные рынки отфильтровываются в адаптере ещё до создания DiscoveredMarket).
 *
 * @deprecated См. TSDoc модуля — контракт живёт до миграции Filter/Scorer.
 */
export interface DiscoveredMarket extends InstrumentInfo {
  /** Кандидат всегда активен (narrowed from boolean → true) */
  readonly active: true;
  /** Вопрос рынка (человекочитаемое описание) */
  readonly question: string;
  /**
   * Текущий спред (bid-ask), доля от 1 (0.02 = 2%, та же конвенция, что
   * `IMarketFilterConfig.minSpread`). `undefined` если недоступен (нет данных от API).
   */
  readonly spread?: Ratio;
  /** Ликвидность (объём торгов, USDC notional). `Money.of(0, 'USDC')` если недоступна. */
  readonly liquidity: Money;
  /**
   * Скор рынка — устанавливается `MarketScorer`.
   * До скоринга = Decimal('0'). После = hoursToExpiry как Decimal.
   *
   * @remarks
   * Остаётся `Decimal` (не VO) — внутренний sort-key без чистого VO-отображения,
   * см. Этап 10c плана миграции.
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
   * Время начала СОБЫТИЯ (не рынка/записи — см. `startsAt` ниже, другое поле).
   * Парсится из `eventStartTime` в API. Используется вместе с `expiresAt`
   * для вычисления длительности рынка.
   */
  readonly eventStartMs?: Timestamp;
  /**
   * Время начала ЗАПИСИ/торговли ботом (не начало самого события — см.
   * `eventStartMs` выше, другое поле). Timestamp из `events[0].startDate`.
   * Используется для выравнивания по границе начала рынка (аналог CEX window alignment).
   */
  readonly startsAt?: Timestamp;
}
