/**
 * Коллектор ленты трейдов (Trade Tape Collector)
 *
 * @remarks
 * **Пассивный буфер** rolling-ленты трейдов per tokenId (`TradeTape` из
 * `@polymarket/trade-tape`). Подписками владеет `MarketDataStore` — он пишет сюда
 * через `recordDirect()` (с опц. `marketId`) и чистит через `clearMarket()`.
 * У коллектора **нет** `start()/stop()` и зависимости от EventBus (#1).
 *
 * ### Принцип: только запись, стратегия считает сама.
 * Коллектор НЕ вычисляет OFI, VWAP или другие метрики.
 * Стратегия сама забирает нужный временной срез и обрабатывает данные:
 * - Напрямую (buy/sell ratio, simple OFI)
 * - Через `TradeFlowCalculator` (если нужен полный набор метрик)
 *
 * ### Согласованность с BookDepthCollector:
 * - `BookDepthCollector` хранит `OrderBookHistory` per tokenId
 * - `TradeTapeCollector` хранит `TradeTape` per tokenId
 * - Оба — пассивные буферы: создаются лениво, чистятся через `clearMarket()` за O(k)
 *
 * ### Жизненный цикл:
 * 1. `recordDirect(...)` → добавляет `TapeRecord` в `TradeTape` инструмента
 *    (marketId берётся из аргумента или из каталога для reverse index)
 * 2. `clearMarket(marketId)` → удаляет ленты инструментов закрытого рынка
 *
 * ### Удержание данных (retention):
 * Политика передаётся при создании и применяется к каждой `TradeTape`:
 * - `maxCount` — FIFO по количеству записей
 * - `maxAgeMs` — авто-вытеснение по возрасту при каждом `append()`
 *
 * ### Сложность операций:
 * - `_record()` — O(1) amortized
 * - `_cleanup()` — O(k) где k = количество инструментов рынка (обычно 2)
 *   Достигается за счёт reverse index `_byMarket: Map<marketId, Set<InstrumentId>>`
 *
 * @example
 * ```typescript
 * const collector = new TradeTapeCollector(
 *   { catalog, logger, clock },
 *   { maxCount: 1000, maxAgeMs: 300_000 },
 * );
 * // MarketDataStore пишет: collector.recordDirect(tokenId, price, size, side, ts, marketId);
 *
 * // В стратегии — взять ленту за последнюю минуту и посчитать:
 * const tape = collector.getTape(tokenId);
 * if (tape) {
 *   const trades = tape.getRecent(60_000);
 *   const metrics = TradeFlowCalculator.compute(trades);
 * }
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { IClock } from '@polymarket/time';
import type { Side } from '@polymarket/value-objects';
import type { IMarketCatalog } from '@polymarket/ports';
import { TradeTape } from '@polymarket/trade-tape';
import type { TapeRetentionPolicy } from '@polymarket/trade-tape';

/**
 * Зависимости TradeTapeCollector.
 *
 * @remarks
 * Коллектор — **пассивный буфер**: подписками владеет MarketDataStore (пишет
 * через `recordDirect()`, чистит через `clearMarket()`), поэтому `eventBus` не
 * нужен (#1). `catalog` остаётся как fallback для marketId, если MarketDataStore
 * не передал его явно.
 */
export interface TradeTapeCollectorDeps {
  /** Каталог инструментов — fallback для ассоциирования tokenId с marketId при cleanup */
  readonly catalog: IMarketCatalog;
  /** Logger */
  readonly logger: ILogger;
  /** Источник времени для детерминированной работы TradeTape */
  readonly clock: IClock;
}

/**
 * Политика хранения трейдов.
 *
 * @remarks
 * Хотя бы одно поле должно быть задано.
 * Псевдоним для `TapeRetentionPolicy` из `@polymarket/trade-tape`.
 */
export type TradeTapeCollectorConfig = TapeRetentionPolicy;

/**
 * Внутренняя структура хранения ленты per tokenId.
 */
interface InternalEntry {
  readonly tape: TradeTape;
}

/**
 * Коллектор ленты трейдов из WS-потока.
 *
 * @remarks
 * Поддерживает `Map<InstrumentId, InternalEntry>` + `_byMarket: Map<string, Set<InstrumentId>>`
 * для O(1) cleanup при `MARKET_CLOSED`.
 * Каждая лента создаётся лениво при первом трейде.
 */
export class TradeTapeCollector {
  /** Ленты per InstrumentId */
  private readonly _entries = new Map<InstrumentId, InternalEntry>();

  /**
   * Reverse index: marketId → Set<InstrumentId>.
   * Позволяет удалить все инструменты рынка за O(k), а не O(N).
   */
  private readonly _byMarket = new Map<string, Set<InstrumentId>>();

  /**
   * Прямой индекс instrumentId → marketId (string).
   * Нужен для **поздней** регистрации (#1): marketId может стать известен после
   * создания ленты (первый трейд пришёл до BOOK_DEPTH/каталога) — тогда лента
   * без этого индекса осталась бы вне `_byMarket` и не очистилась бы.
   */
  private readonly _instrumentToMarket = new Map<InstrumentId, string>();

  /**
   * @param _deps - Зависимости (catalog, logger, clock)
   * @param _config - Политика хранения (maxCount и/или maxAgeMs)
   *
   * @throws {RangeError} Если политика невалидна — пустая, `maxCount`/`maxAgeMs` вне
   *   допустимого диапазона (полная проверка через `TradeTape.create()`, не только
   *   "оба поля не заданы" — раньше невалидный конфиг тихо проходил конструктор и падал
   *   только на первом живом трейде, внутри лениво вызываемого `TradeTape.create()`
   *   в `_record()`)
   */
  constructor(
    private readonly _deps: TradeTapeCollectorDeps,
    private readonly _config: TradeTapeCollectorConfig,
  ) {
    const validation = TradeTape.create(_config, _deps.clock);
    if (!validation.ok) {
      throw new RangeError(
        `TradeTapeCollector: invalid retention policy — ${validation.error.message}`,
      );
    }
  }

  /**
   * Возвращает `TradeTape` для данного инструмента.
   *
   * @param tokenId - ID токена
   * @returns `TradeTape` или `undefined` если трейдов ещё не было
   *
   * @example
   * ```typescript
   * const tape = collector.getTape(tokenId);
   * if (tape) {
   *   const metrics = TradeFlowCalculator.compute(tape.getRecent(60_000));
   * }
   * ```
   */
  public getTape(tokenId: InstrumentId): TradeTape | undefined {
    return this._entries.get(tokenId)?.tape;
  }

  /**
   * Возвращает количество инструментов с активными лентами.
   *
   * @returns Количество tokenId с накопленными данными
   */
  public instrumentCount(): number {
    return this._entries.size;
  }

  /**
   * Записывает трейд напрямую, минуя EventBus подписку.
   *
   * @param instrumentId - ID инструмента (tokenId)
   * @param price - Цена трейда
   * @param size - Объём трейда
   * @param side - Сторона агрессора
   * @param timestamp - Timestamp трейда
   *
   * @param marketId - ID рынка (опц.). Если передан — используется для reverse
   *   index вместо каталога (#2): MarketDataStore знает marketId из BOOK_UPDATED,
   *   что надёжнее каталога и закрывает дыру утечки для инструментов, которых
   *   каталог ещё не знает.
   *
   * @remarks
   * Используется MarketDataStore для записи TRADE_RECEIVED событий
   * без дублирования EventBus подписки (MarketDataStore владеет подпиской).
   */
  public recordDirect(
    instrumentId: InstrumentId,
    price: import('@polymarket/value-objects').Price,
    size: import('@polymarket/value-objects').Quantity,
    side: Side,
    timestamp: import('@polymarket/value-objects').Timestamp,
    marketId?: MarketId,
  ): void {
    this._record(instrumentId, price, size, side, timestamp, marketId);
  }

  /**
   * Очищает ленты всех инструментов закрытого рынка.
   *
   * @param marketId - ID закрытого рынка
   *
   * @remarks
   * Пассивная точка очистки (как {@link recordDirect} — пассивная точка записи).
   * Используется `MarketDataStore`, который владеет подпиской на `MARKET_CLOSED`
   * и делегирует cleanup сюда, чтобы избежать дублирующей подписки.
   * Сложность O(k), где k = число инструментов рынка (обычно 2).
   */
  public clearMarket(marketId: MarketId): void {
    this._cleanup(marketId);
  }

  /**
   * Очищает все ленты и reverse index из памяти.
   *
   * @remarks
   * Используется при сбросе состояния (тестирование, полная остановка).
   */
  public clear(): void {
    this._entries.clear();
    this._byMarket.clear();
    this._instrumentToMarket.clear();
  }

  // ── Приватные методы ───────────────────────────────────────────────────────

  /**
   * Добавляет трейд в ленту инструмента.
   *
   * @remarks
   * Лента (`TradeTape`) создаётся лениво при первом трейде. marketId
   * регистрируется на каждом трейде (#1, поздняя регистрация). Вытеснение
   * устаревших записей обрабатывается внутри `TradeTape.append()`.
   */
  private _record(
    instrumentId: InstrumentId,
    price: import('@polymarket/value-objects').Price,
    size: import('@polymarket/value-objects').Quantity,
    side: Side,
    timestamp: import('@polymarket/value-objects').Timestamp,
    marketId?: MarketId,
  ): void {
    // #1: регистрируем marketId на КАЖДОМ трейде, а не только при создании ленты —
    // marketId может стать известен позже (первый трейд пришёл до BOOK_DEPTH/каталога).
    // #2: явный marketId (из BOOK_UPDATED/BOOK_DEPTH) надёжнее каталога.
    this._registerMarket(instrumentId, marketId ?? this._deps.catalog.get(instrumentId)?.marketId);

    let entry = this._entries.get(instrumentId);
    if (entry === undefined) {
      const tapeResult = TradeTape.create(this._config, this._deps.clock);
      if (!tapeResult.ok) {
        // Не должно происходить: _config уже прошёл ту же валидацию в конструкторе.
        // Fail-closed вместо throw в горячем пути — пропускаем трейд, логируем громко.
        this._deps.logger.error('TradeTapeCollector: unexpected invalid retention policy', {
          tokenId: String(instrumentId),
          error: tapeResult.error.message,
        });
        return;
      }
      entry = { tape: tapeResult.value };
      this._entries.set(instrumentId, entry);
      this._deps.logger.debug('TradeTapeCollector: new tape created', {
        tokenId: String(instrumentId),
        marketId: this._instrumentToMarket.get(instrumentId) ?? 'unknown',
      });
    }

    entry.tape.append({ price, size, side, timestamp });
  }

  /**
   * Регистрирует/обновляет связь instrumentId → marketId в reverse index (#1).
   *
   * @remarks
   * Идемпотентно: повторный тот же marketId — no-op. Если инструмент сменил
   * рынок (редко) — удаляем из старого множества и пишем warn.
   */
  private _registerMarket(instrumentId: InstrumentId, marketId: MarketId | undefined): void {
    if (marketId === undefined) return;
    const marketIdStr = String(marketId);
    const existing = this._instrumentToMarket.get(instrumentId);
    if (existing === marketIdStr) return;

    if (existing !== undefined) {
      this._deps.logger.warn('TradeTapeCollector: instrument moved between markets', {
        tokenId: String(instrumentId),
        previousMarketId: existing,
        newMarketId: marketIdStr,
      });
      this._byMarket.get(existing)?.delete(instrumentId);
    }

    this._instrumentToMarket.set(instrumentId, marketIdStr);
    let set = this._byMarket.get(marketIdStr);
    if (set === undefined) {
      set = new Set<InstrumentId>();
      this._byMarket.set(marketIdStr, set);
    }
    set.add(instrumentId);
  }

  /**
   * Удаляет ленты инструментов закрытого рынка.
   *
   * @remarks
   * Сложность O(k) где k = количество инструментов рынка (обычно 2 для Polymarket).
   * Использует reverse index `_byMarket` — не итерирует все записи. Поздняя
   * регистрация marketId (#1) гарантирует, что лента попадает в индекс, даже если
   * первый трейд пришёл до того, как marketId стал известен.
   *
   * @param marketId - ID закрытого рынка
   */
  private _cleanup(marketId: MarketId): void {
    const marketIdStr = String(marketId);
    const keys = this._byMarket.get(marketIdStr);
    if (keys === undefined || keys.size === 0) return;

    for (const key of keys) {
      this._entries.delete(key);
      this._instrumentToMarket.delete(key);
    }
    this._byMarket.delete(marketIdStr);

    this._deps.logger.debug('TradeTapeCollector: tapes cleaned up', {
      marketId: marketIdStr,
      removed: keys.size,
    });
  }
}
