/**
 * Построитель инфраструктуры рыночных данных.
 *
 * @remarks
 * Создаёт стек обработки рыночных данных:
 * - `BookDepthCollector` — собирает обновления стакана из EventBus, хранит историю
 * - `TradeTapeCollector` — собирает сделки из EventBus, хранит ленту
 * - `TradeIndexCollector` — индексирует построенные Trade по VenueTradeId (для
 *   будущего ExecutionLinker, Этап 7 плана миграции)
 * - `MarketDataStore` — агрегирует данные от коллекторов, предоставляет
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

import { BookDepthCollector, TradeTapeCollector, TradeIndexCollector, MarketDataStore } from '@polymarket/market-state';
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
 * @throws {RangeError} Если политика хранения bookCollector/tapeCollector невалидна
 *   (fail-fast на старте приложения — composition root, см. BookDepthCollector/
 *   TradeTapeCollector)
 * @throws {Error} Если политика хранения TradeIndexCollector невалидна (тот же
 *   fail-fast принцип; `TradeIndexCollector.create()` сам по себе Result-based —
 *   Result конвертируется в throw именно здесь, на границе composition root, чтобы
 *   не менять сигнатуру `buildMarketData()` под один Result-возврат)
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

  // Коллекторы — пассивные буферы; подписками владеет MarketDataStore (#1).
  const bookCollector = new BookDepthCollector(
    { logger, clock },
    { maxCount: bookMaxCount },
  );

  const tapeCollector = new TradeTapeCollector(
    { catalog: marketCatalog, logger, clock },
    { maxCount: tapeMaxCount },
  );

  const tradeIndexResult = TradeIndexCollector.create({ maxCount: tapeMaxCount }, clock);
  if (!tradeIndexResult.ok) {
    throw new Error(
      `buildMarketData: invalid TradeIndexCollector retention policy — ${tradeIndexResult.error.message}`,
    );
  }

  const marketDataStore = new MarketDataStore({
    eventBus,
    bookCollector,
    tapeCollector,
    tradeIndex: tradeIndexResult.value,
    logger,
  });

  return { marketDataStore, marketCatalog };
}
