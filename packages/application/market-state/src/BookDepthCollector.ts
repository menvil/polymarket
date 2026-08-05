/**
 * Коллектор полных снапшотов стакана (Book Depth Collector)
 *
 * @remarks
 * **Пассивный буфер** rolling-истории снапшотов per tokenId в `OrderBookHistory`.
 * Подписками на EventBus владеет `MarketDataStore` — он пишет сюда через
 * `recordDirect()` и чистит через `clearMarket()`. У коллектора **нет**
 * `start()/stop()` и зависимости от EventBus (#1 — двойная запись невозможна).
 *
 * ### Принцип: только запись, стратегия считает сама.
 * Коллектор НЕ вычисляет имбаланс, метрики или сигналы.
 * Он просто ведёт буфер снапшотов заданной глубины.
 * Стратегия сама забирает нужный кусок истории и применяет
 * `ImbalanceCalculator` с нужным ей режимом.
 *
 * ### Жизненный цикл:
 * 1. `recordDirect(tokenId, snapshot, nowMs)` → `history.record(...)` для tokenId
 * 2. `clearMarket(marketId)` → истории инструментов рынка удаляются (cleanup памяти)
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
 *   { logger, clock },
 *   { maxCount: 500, maxAgeMs: 300_000 },
 * );
 * // MarketDataStore пишет: collector.recordDirect(tokenId, snapshot, nowMs);
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

/**
 * Зависимости BookDepthCollector.
 *
 * @remarks
 * Коллектор — **пассивный буфер**: подписками на EventBus владеет MarketDataStore,
 * который пишет через `recordDirect()` и чистит через `clearMarket()`. Поэтому
 * `eventBus` здесь не нужен (#1 — исключает двойную запись на уровне типов).
 */
export interface BookDepthCollectorDeps {
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

  /**
   * Прямой индекс tokenId → marketId — для консистентности с TradeTapeCollector
   * и обработки смены рынка инструментом (#U4; на Polymarket tokenId иммутабелен
   * per condition, поэтому это defensive).
   */
  private readonly _instrumentToMarket = new Map<InstrumentId, string>();

  /**
   * @param _deps - Зависимости (logger, clock)
   * @param _config - Политика хранения снапшотов (maxCount и/или maxAgeMs)
   *
   * @throws {RangeError} Если политика невалидна — пустая, `maxCount`/`maxAgeMs` вне
   *   допустимого диапазона (полная проверка через `OrderBookHistory.create()`, не только
   *   "оба поля не заданы" — раньше невалидный конфиг тихо проходил конструктор и падал
   *   только на первом живом `BOOK_DEPTH`-событии, внутри лениво вызываемого
   *   `OrderBookHistory.create()` в `_record()`)
   */
  constructor(
    private readonly _deps: BookDepthCollectorDeps,
    private readonly _config: BookDepthCollectorConfig,
  ) {
    const validation = OrderBookHistory.create(_config, _deps.clock);
    if (!validation.ok) {
      throw new RangeError(
        `BookDepthCollector: invalid retention policy — ${validation.error.message}`,
      );
    }
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
   * Очищает историю снапшотов всех инструментов закрытого рынка.
   *
   * @param marketId - ID закрытого рынка
   *
   * @remarks
   * Пассивная точка очистки (как {@link recordDirect} — пассивная точка записи).
   * Используется `MarketDataStore`, который владеет подпиской на `MARKET_CLOSED`
   * и делегирует cleanup сюда, чтобы избежать дублирующей подписки.
   * Сложность O(k), где k = число инструментов рынка (обычно 2).
   */
  public clearMarket(marketId: string): void {
    this._cleanup(marketId);
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
    this._instrumentToMarket.clear();
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
    // #U4: регистрируем marketId на каждом снапшоте (snapshot всегда несёт marketId);
    // обрабатывает смену рынка инструментом и держит индекс консистентным.
    this._registerMarket(tokenId, snapshot.marketId);

    let entry = this._entries.get(tokenId);
    if (entry === undefined) {
      const historyResult = OrderBookHistory.create(this._config, this._deps.clock);
      if (!historyResult.ok) {
        // Не должно происходить: _config уже прошёл ту же валидацию в конструкторе.
        // Fail-closed вместо throw в горячем пути — пропускаем снапшот, логируем громко.
        this._deps.logger.error('BookDepthCollector: unexpected invalid retention policy', {
          tokenId: String(tokenId),
          error: historyResult.error.message,
        });
        return;
      }
      entry = { history: historyResult.value };
      this._entries.set(tokenId, entry);
      this._deps.logger.debug('BookDepthCollector: new history created', {
        tokenId: String(tokenId),
        marketId: snapshot.marketId,
      });
    }

    entry.history.record(snapshot, nowMs);
  }

  /**
   * Регистрирует/обновляет связь tokenId → marketId в reverse index (#U4).
   * При смене рынка инструментом удаляет из старого множества и пишет warn.
   */
  private _registerMarket(tokenId: InstrumentId, marketId: string): void {
    const existing = this._instrumentToMarket.get(tokenId);
    if (existing === marketId) return;

    if (existing !== undefined) {
      this._deps.logger.warn('BookDepthCollector: instrument moved between markets', {
        tokenId: String(tokenId),
        previousMarketId: existing,
        newMarketId: marketId,
      });
      this._byMarket.get(existing)?.delete(tokenId);
    }

    this._instrumentToMarket.set(tokenId, marketId);
    let set = this._byMarket.get(marketId);
    if (set === undefined) {
      set = new Set<InstrumentId>();
      this._byMarket.set(marketId, set);
    }
    set.add(tokenId);
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
      this._instrumentToMarket.delete(key);
    }
    this._byMarket.delete(marketId);

    this._deps.logger.debug('BookDepthCollector: histories cleaned up', {
      marketId,
      removed: keys.size,
    });
  }
}
