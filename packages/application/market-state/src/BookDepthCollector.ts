/**
 * Коллектор полных снапшотов стакана (Book Depth Collector)
 *
 * @remarks
 * Подписывается на `BOOK_DEPTH` события и накапливает rolling-историю
 * снапшотов per tokenId в `OrderBookHistory`.
 *
 * ### Принцип: только запись, стратегия считает сама.
 * Коллектор НЕ вычисляет имбаланс, метрики или сигналы.
 * Он просто ведёт буфер снапшотов заданной глубины.
 * Стратегия сама забирает нужный кусок истории и применяет
 * `ImbalanceCalculator` с нужным ей режимом.
 *
 * ### Жизненный цикл:
 * 1. `start()` — подписывается на `BOOK_DEPTH` и `MARKET_CLOSED`
 * 2. `BOOK_DEPTH` → `history.record(snapshot, nowMs)` для данного tokenId
 * 3. `MARKET_CLOSED` → история инструмента удаляется (cleanup памяти)
 * 4. `stop()` — отписывается от всех событий
 *
 * ### Изоляция по инструментам:
 * У каждого tokenId своя `OrderBookHistory` с единой политикой из конфига.
 * Создаётся лениво при первом снапшоте.
 *
 * ### Сложность операций:
 * - `_record()` — O(1) amortized (lazy creation + reverse index update)
 * - `_cleanup()` — O(k) где k = количество инструментов рынка (обычно 2)
 *   Достигается за счёт reverse index `_byMarket: Map<marketId, Set<InstrumentId>>`
 *
 * @example
 * ```typescript
 * const collector = new BookDepthCollector(
 *   { eventBus, logger, clock },
 *   { maxCount: 500, maxAgeMs: 300_000 },
 * );
 * collector.start();
 *
 * // В стратегии — забрать данные и посчитать самостоятельно:
 * const history = collector.getHistory(tokenId);
 * if (history) {
 *   const snapshots = history.getRecent(60_000);
 *   const latest = history.getLatest();
 *   if (latest) {
 *     const imbalance = ImbalanceCalculator.calculate(
 *       latest.bids, latest.asks,
 *       { type: 'TOP_N', levels: 5 },
 *     );
 *   }
 * }
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { InstrumentId } from '@polymarket/ids';
import type { IClock } from '@polymarket/time';
import { OrderBookHistory } from '@polymarket/order-book';
import type { OrderBookRetentionPolicy, OrderBookSnapshot } from '@polymarket/order-book';
import type { IEventBus } from '@polymarket/event-bus';

/**
 * Зависимости BookDepthCollector.
 */
export interface BookDepthCollectorDeps {
  /** Event bus для подписки на BOOK_DEPTH / MARKET_CLOSED */
  readonly eventBus: IEventBus;
  /** Logger */
  readonly logger: ILogger;
  /** Источник времени для детерминированной работы OrderBookHistory */
  readonly clock: IClock;
}

/**
 * Создаёт `BookDepthCollector` с заданной политикой хранения снапшотов.
 *
 * @remarks
 * Политика применяется одинаково ко всем инструментам.
 * Хотя бы одно поле должно быть задано (иначе конструктор `BookDepthCollector` бросит `RangeError`).
 *
 * @example
 * ```typescript
 * // Последние 5 минут или 1000 снапшотов (что наступит раньше):
 * const collector = new BookDepthCollector(deps, { maxCount: 1000, maxAgeMs: 300_000 });
 *
 * // Только последние 200 снапшотов:
 * const collector = new BookDepthCollector(deps, { maxCount: 200 });
 * ```
 */
export type BookDepthCollectorConfig = OrderBookRetentionPolicy;

/**
 * Внутренняя запись: история снапшотов per tokenId.
 */
interface InternalEntry {
  readonly history: OrderBookHistory;
}

/**
 * Коллектор полных снапшотов стакана.
 *
 * @remarks
 * Поддерживает `Map<InstrumentId, InternalEntry>` + `_byMarket: Map<string, Set<InstrumentId>>`
 * для O(1) cleanup при `MARKET_CLOSED`.
 * Каждая история создаётся лениво при первом снапшоте.
 */
export class BookDepthCollector {
  /** Истории per InstrumentId */
  private readonly _entries = new Map<InstrumentId, InternalEntry>();

  /**
   * Reverse index: marketId → Set<InstrumentId>.
   * Позволяет удалить все инструменты рынка за O(k), а не O(N).
   */
  private readonly _byMarket = new Map<string, Set<InstrumentId>>();

  /** Unsubscribe-функции для cleanup */
  private _unsubBookDepth: (() => void) | undefined;
  private _unsubMarketClosed: (() => void) | undefined;

  /**
   * @param _deps - Зависимости (eventBus, logger, clock)
   * @param _config - Политика хранения снапшотов (maxCount и/или maxAgeMs)
   *
   * @throws {RangeError} Если конфиг пустой (ни maxCount ни maxAgeMs не заданы)
   */
  constructor(
    private readonly _deps: BookDepthCollectorDeps,
    private readonly _config: BookDepthCollectorConfig,
  ) {
    if (_config.maxCount === undefined && _config.maxAgeMs === undefined) {
      throw new RangeError(
        'BookDepthCollector: retention policy must specify maxCount and/or maxAgeMs',
      );
    }
  }

  /**
   * Запускает коллектор — подписывается на события.
   *
   * @remarks
   * Повторный вызов без предварительного `stop()` не создаёт дублирующих подписок
   * (предыдущие отписываются автоматически).
   *
   * @example
   * ```typescript
   * collector.start();
   * ```
   */
  public start(): void {
    // Защита от двойного запуска
    this._unsubBookDepth?.();
    this._unsubMarketClosed?.();

    this._unsubBookDepth = this._deps.eventBus.subscribe(
      'BOOK_DEPTH',
      (event) => {
        try {
          this._record(event.instrumentId, event.snapshot, event.timestamp.toNumber());
        } catch (err) {
          this._deps.logger.error('BookDepthCollector: failed to record snapshot', {
            instrumentId: String(event.instrumentId),
            err: err instanceof Error ? err : new Error(String(err)),
          });
        }
      },
    );

    this._unsubMarketClosed = this._deps.eventBus.subscribe(
      'MARKET_CLOSED',
      (event) => {
        this._cleanup(String(event.marketId));
      },
    );

    this._deps.logger.info('BookDepthCollector started', {
      maxCount: this._config.maxCount ?? null,
      maxAgeMs: this._config.maxAgeMs ?? null,
    });
  }

  /**
   * Останавливает коллектор — отписывается от событий.
   *
   * @remarks
   * Накопленные истории сохраняются — стратегии могут читать их после stop().
   * Для полного сброса вызовите `clear()`.
   *
   * @example
   * ```typescript
   * collector.stop();
   * ```
   */
  public stop(): void {
    this._unsubBookDepth?.();
    this._unsubMarketClosed?.();
    this._unsubBookDepth = undefined;
    this._unsubMarketClosed = undefined;

    this._deps.logger.info('BookDepthCollector stopped', {});
  }

  /**
   * Возвращает историю снапшотов для данного инструмента.
   *
   * @param tokenId - ID токена (UP/DOWN outcome token)
   * @returns `OrderBookHistory` или `undefined` если снапшотов ещё не было
   *
   * @example
   * ```typescript
   * const history = collector.getHistory(tokenId);
   * if (!history || history.isEmpty()) return;
   *
   * const latest = history.getLatest();
   * const imbalance = ImbalanceCalculator.calculate(
   *   latest.bids, latest.asks, { type: 'WEIGHTED' }
   * );
   * ```
   */
  public getHistory(tokenId: InstrumentId): OrderBookHistory | undefined {
    return this._entries.get(tokenId)?.history;
  }

  /**
   * Возвращает количество инструментов с активной историей.
   *
   * @returns Количество tokenId в коллекторе
   */
  public instrumentCount(): number {
    return this._entries.size;
  }

  /**
   * Записывает снапшот напрямую, минуя EventBus подписку.
   *
   * @param instrumentId - ID инструмента (tokenId)
   * @param snapshot - Полный снапшот стакана
   * @param nowMs - Текущее время в epoch ms
   *
   * @remarks
   * Используется MarketDataStore для записи BOOK_DEPTH событий
   * без дублирования EventBus подписки (MarketDataStore уже подписан).
   */
  public recordDirect(
    instrumentId: InstrumentId,
    snapshot: OrderBookSnapshot,
    nowMs: number,
  ): void {
    this._record(instrumentId, snapshot, nowMs);
  }

  /**
   * Очищает все истории и reverse index из памяти.
   *
   * @remarks
   * Используется для сброса состояния (например, при тестировании).
   */
  public clear(): void {
    this._entries.clear();
    this._byMarket.clear();
  }

  // ── Приватные методы ───────────────────────────────────────────────────────

  /**
   * Записывает снапшот в историю инструмента.
   *
   * @remarks
   * История создаётся лениво при первом снапшоте.
   * При создании сохраняет `marketId` из снапшота и регистрирует в reverse index.
   *
   * @param tokenId - ID токена
   * @param snapshot - Полный снапшот стакана (содержит `snapshot.marketId`)
   * @param nowMs - Текущее время (из timestamp события)
   */
  private _record(
    tokenId: InstrumentId,
    snapshot: OrderBookSnapshot,
    nowMs: number,
  ): void {
    let entry = this._entries.get(tokenId);

    if (entry === undefined) {
      const history = OrderBookHistory.create(this._config, this._deps.clock);
      entry = { history };
      this._entries.set(tokenId, entry);

      // Регистрируем в reverse index: marketId → tokenId
      let set = this._byMarket.get(snapshot.marketId);
      if (set === undefined) {
        set = new Set<InstrumentId>();
        this._byMarket.set(snapshot.marketId, set);
      }
      set.add(tokenId);

      this._deps.logger.debug('BookDepthCollector: new history created', {
        tokenId: String(tokenId),
        marketId: snapshot.marketId,
      });
    }

    entry.history.record(snapshot, nowMs);
  }

  /**
   * Удаляет все истории рынка при его закрытии.
   *
   * @remarks
   * Сложность O(k) где k = количество инструментов рынка (обычно 2 для Polymarket).
   * Использует reverse index `_byMarket` — не итерирует все записи.
   * Корректно работает даже если retention eviction очистил историю полностью.
   *
   * @param marketId - String(marketId) закрытого рынка
   */
  private _cleanup(marketId: string): void {
    const keys = this._byMarket.get(marketId);
    if (keys === undefined || keys.size === 0) return;

    for (const key of keys) {
      this._entries.delete(key);
    }
    this._byMarket.delete(marketId);

    this._deps.logger.debug('BookDepthCollector: histories cleaned up', {
      marketId,
      removed: keys.size,
    });
  }
}
