/**
 * Построитель инфраструктуры рыночных данных.
 *
 * @remarks
 * Создаёт стек обработки рыночных данных:
 * - `BookDepthCollector` — собирает обновления стакана из EventBus, хранит историю
 * - `TradeTapeCollector` — собирает сделки из EventBus, хранит ленту
 * - `MarketDataStore` — агрегирует данные от обоих коллекторов, предоставляет
 *   единое API для стратегий через `StrategyScheduler`
 * - `InMemoryMarketCatalog` — маппинг instrumentId → marketId для TradeTapeCollector
 *
 * ### Жизненный цикл:
 * - `marketDataStore.start()` — начинает слушать EventBus
 * - `marketDataStore.stop()` — останавливает прослушивание
 *
 * @example
 * ```typescript
 * const { marketDataStore } = buildMarketData({ infra });
 * marketDataStore.start();
 * ```
 */

import { BookDepthCollector, TradeTapeCollector, MarketDataStore } from '@polymarket/market-state';
import { InMemoryMarketCatalog } from '../InMemoryMarketCatalog.js';
import type { CoreInfra } from './buildCoreInfra.js';

/** Параметры для построения рыночных данных */
export interface BuildMarketDataParams {
  readonly infra: CoreInfra;
  /** Максимальное количество записей в истории стакана (по умолчанию 100) */
  readonly bookMaxCount?: number;
  /** Максимальное количество сделок в ленте (по умолчанию 500) */
  readonly tapeMaxCount?: number;
}

/** Результат построения инфраструктуры рыночных данных */
export interface MarketDataInfra {
  readonly marketDataStore: MarketDataStore;
  readonly marketCatalog: InMemoryMarketCatalog;
}

/**
 * Создаёт инфраструктуру рыночных данных: коллекторы и store.
 *
 * @param params - Зависимости и настройки
 * @returns Объект с marketDataStore и marketCatalog
 *
 * @example
 * ```typescript
 * const { marketDataStore, marketCatalog } = buildMarketData({ infra });
 * marketDataStore.start();
 * // Используем marketCatalog для регистрации инструментов
 * ```
 */
export function buildMarketData(params: BuildMarketDataParams): MarketDataInfra {
  const { infra, bookMaxCount = 100, tapeMaxCount = 500 } = params;
  const { eventBus, logger, clock } = infra;

  const marketCatalog = new InMemoryMarketCatalog();

  const bookCollector = new BookDepthCollector(
    { eventBus, logger, clock },
    { maxCount: bookMaxCount },
  );

  const tapeCollector = new TradeTapeCollector(
    { eventBus, catalog: marketCatalog, logger, clock },
    { maxCount: tapeMaxCount },
  );

  const marketDataStore = new MarketDataStore({
    eventBus,
    bookCollector,
    tapeCollector,
    logger,
  });

  return { marketDataStore, marketCatalog };
}
