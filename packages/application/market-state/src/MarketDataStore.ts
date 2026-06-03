/**
 * MarketDataStore — фасад для рыночных данных стратегий.
 *
 * @remarks
 * ### Назначение:
 * Объединяет BookDepthCollector, TradeTapeCollector и TopOfBook tracking
 * в единый интерфейс для StrategyScheduler.
 *
 * ### Обязанности:
 * 1. Хранит последний TopOfBook per instrumentId
 * 2. Делегирует getBookHistory → BookDepthCollector
 * 3. Делегирует getTradeTape → TradeTapeCollector
 * 4. Подписывается на EventBus: BOOK_UPDATED, BOOK_DEPTH, TRADE_RECEIVED, MARKET_CLOSED
 * 5. При обновлении вызывает `_onChange(instrumentId, reason)` callback
 * 6. При закрытии рынка чистит TopOfBook и делегирует cleanup коллекторам
 *
 * ### Владение подписками (важно):
 * MarketDataStore — **единственный владелец** подписок EventBus. Коллекторы
 * (`BookDepthCollector`, `TradeTapeCollector`) используются как пассивные буферы:
 * запись через `recordDirect()`, очистка через `clearMarket()`. **Не вызывайте
 * `collector.start()`**, если коллектор передан в MarketDataStore — иначе каждое
 * событие запишется дважды (подписка коллектора + recordDirect стора).
 *
 * ### Особенности подписок:
 * - BOOK_UPDATED → сохраняет TopOfBook + reverse index + onChange('BOOK')
 * - BOOK_DEPTH → записывает в BookDepthCollector + onChange('BOOK') (#2).
 *   Depth-only изменения (стенки, ликвидность, исчезновение уровней) теперь
 *   будят стратегию. Scheduler коалесцирует dirty-флаги per tick, поэтому
 *   парный BOOK_UPDATED + BOOK_DEPTH не вызывает двойную переоценку.
 * - TRADE_RECEIVED → записывает в TradeTapeCollector + onChange('TRADE')
 * - MARKET_CLOSED → удаляет TopOfBook рынка + `bookCollector.clearMarket()`
 *   + `tapeCollector.clearMarket()` (защита от утечки по закрытым рынкам)
 *
 * @example
 * ```typescript
 * const store = new MarketDataStore(deps);
 * store.setOnChange((instrumentId, reason) => {
 *   scheduler.onStateChanged(instrumentId, reason);
 * });
 * store.start();
 *
 * // Sync reads
 * const topOfBook = store.getTopOfBook(instrumentId);
 * const history = store.getBookHistory(instrumentId);
 * const tape = store.getTradeTape(instrumentId);
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { IEventBus, TopOfBook } from '@polymarket/event-bus';
import type { OrderBookHistory } from '@polymarket/order-book';
import type { TradeTape } from '@polymarket/trade-tape';
import type { BookDepthCollector } from './BookDepthCollector.js';
import type { TradeTapeCollector } from './TradeTapeCollector.js';

// ── Публичные типы ─────────────────────────────────────────

/**
 * Причина обновления данных — передаётся в onChange callback.
 *
 * @remarks
 * Используется как TriggerReason в StrategyScheduler.
 * Совпадает по значениям с TriggerReason из strategy пакета.
 */
export type MarketDataReason = 'BOOK' | 'TRADE';

/**
 * Состояние свежести TopOfBook для инструмента.
 *
 * @remarks
 * Единый формат проверки актуальности данных — чтобы стратегии не изобретали
 * собственные stale-правила (#3). `ageMs` считается от переданного `nowMs`.
 */
export interface TopOfBookState {
  /** Последний TopOfBook. */
  readonly topOfBook: TopOfBook;
  /** Timestamp события BOOK_UPDATED (epoch ms). */
  readonly eventTsMs: number;
  /** Возраст данных = `nowMs - eventTsMs` (ms). */
  readonly ageMs: number;
  /** `true`, если `ageMs > staleMs` или `ageMs < 0`. */
  readonly stale: boolean;
}

/**
 * Зависимости MarketDataStore.
 */
export interface MarketDataStoreDeps {
  /** Event bus для подписки на рыночные события */
  readonly eventBus: IEventBus;
  /** Коллектор снапшотов стакана */
  readonly bookCollector: BookDepthCollector;
  /** Коллектор ленты трейдов */
  readonly tapeCollector: TradeTapeCollector;
  /** Logger */
  readonly logger: ILogger;
}

// ── Реализация ─────────────────────────────────────────────

export class MarketDataStore {
  private readonly _logger: ILogger;
  private readonly _topOfBooks = new Map<InstrumentId, TopOfBook>();
  private readonly _topOfBookTimestampsMs = new Map<InstrumentId, number>();
  /**
   * Reverse index: marketId → Set<InstrumentId>.
   * Строится из BOOK_UPDATED (несёт и instrumentId, и marketId) — позволяет
   * за O(k) удалить TopOfBook данные закрытого рынка при MARKET_CLOSED.
   */
  private readonly _byMarket = new Map<string, Set<InstrumentId>>();
  /**
   * Прямой индекс instrumentId → marketId (из BOOK_UPDATED).
   * Прокидывается в `tapeCollector.recordDirect`, чтобы лента надёжно
   * регистрировалась под рынком даже когда каталог ленты ещё не знает инструмент (#2).
   */
  private readonly _instrumentToMarket = new Map<InstrumentId, MarketId>();
  private _onChange?: (instrumentId: InstrumentId, reason: MarketDataReason) => void;

  private _unsubBookUpdated: (() => void) | undefined;
  private _unsubBookDepth: (() => void) | undefined;
  private _unsubTradeReceived: (() => void) | undefined;
  private _unsubMarketClosed: (() => void) | undefined;

  constructor(private readonly _deps: MarketDataStoreDeps) {
    this._logger = _deps.logger.child({ component: 'MarketDataStore' });
  }

  // ── Публичный API ──────────────────────────────────────

  /**
   * Регистрирует callback для уведомления об обновлении данных.
   *
   * @param cb - Callback: (instrumentId, reason) → void
   *
   * @remarks
   * Повторный вызов **перезаписывает** предыдущий callback — старый больше не вызывается.
   * Обычно вызывается один раз при инициализации (StrategyScheduler).
   */
  public setOnChange(cb: (instrumentId: InstrumentId, reason: MarketDataReason) => void): void {
    this._onChange = cb;
  }

  /**
   * Запускает подписки на EventBus.
   *
   * @remarks
   * Повторный вызов без stop() безопасен — отписывает предыдущие подписки.
   */
  public start(): void {
    this._unsubBookUpdated?.();
    this._unsubBookDepth?.();
    this._unsubTradeReceived?.();
    this._unsubMarketClosed?.();

    this._unsubBookUpdated = this._deps.eventBus.subscribe(
      'BOOK_UPDATED',
      (event) => {
        this._topOfBooks.set(event.instrumentId, event.topOfBook);
        this._topOfBookTimestampsMs.set(event.instrumentId, event.timestamp.toNumber());
        this._registerInstrument(event.marketId, event.instrumentId);
        this._onChange?.(event.instrumentId, 'BOOK');
      },
    );

    this._unsubBookDepth = this._deps.eventBus.subscribe(
      'BOOK_DEPTH',
      (event) => {
        this._deps.bookCollector.recordDirect(
          event.instrumentId,
          event.snapshot,
          event.timestamp.toNumber(),
        );
        // #2: уведомляем об изменении глубины. Reason 'BOOK' покрывает и
        // TopOfBook, и BookDepth; scheduler коалесцирует dirty-флаги per tick,
        // поэтому парный BOOK_UPDATED+BOOK_DEPTH даёт одну переоценку, не флудит.
        // Depth-only апдейты (стенки/ликвидность) больше не теряются.
        this._onChange?.(event.instrumentId, 'BOOK');
      },
    );

    this._unsubTradeReceived = this._deps.eventBus.subscribe(
      'TRADE_RECEIVED',
      (event) => {
        this._deps.tapeCollector.recordDirect(
          event.instrumentId,
          event.price,
          event.size,
          event.side,
          event.timestamp,
          this._instrumentToMarket.get(event.instrumentId),
        );
        this._onChange?.(event.instrumentId, 'TRADE');
      },
    );

    this._unsubMarketClosed = this._deps.eventBus.subscribe(
      'MARKET_CLOSED',
      (event) => {
        this._onMarketClosed(event.marketId);
      },
    );

    this._logger.info('MarketDataStore started');
  }

  /**
   * Останавливает подписки.
   *
   * @remarks
   * TopOfBook данные сохраняются после stop() — стратегии могут читать.
   */
  public stop(): void {
    this._unsubBookUpdated?.();
    this._unsubBookDepth?.();
    this._unsubTradeReceived?.();
    this._unsubMarketClosed?.();
    this._unsubBookUpdated = undefined;
    this._unsubBookDepth = undefined;
    this._unsubTradeReceived = undefined;
    this._unsubMarketClosed = undefined;

    this._logger.info('MarketDataStore stopped');
  }

  /**
   * Возвращает последний TopOfBook для инструмента.
   *
   * @param instrumentId - ID инструмента
   * @returns TopOfBook или undefined если данных ещё не было
   */
  public getTopOfBook(instrumentId: InstrumentId): TopOfBook | undefined {
    return this._topOfBooks.get(instrumentId);
  }

  /**
   * Возвращает timestamp последнего BOOK_UPDATED для инструмента.
   *
   * @remarks
   * Используется cross-market стратегиями для проверки, что две книги
   * достаточно синхронны перед одновременной покупкой обеих ног.
   */
  public getTopOfBookTimestampMs(instrumentId: InstrumentId): number | undefined {
    return this._topOfBookTimestampsMs.get(instrumentId);
  }

  /**
   * Возвращает состояние свежести TopOfBook для инструмента (#3).
   *
   * @param instrumentId - ID инструмента
   * @param nowMs - Текущее время (epoch ms) — обычно `snapshot.nowMs`
   * @param staleMs - Порог устаревания (ms)
   * @returns {@link TopOfBookState} или `undefined`, если данных ещё не было
   *
   * @remarks
   * Единая точка проверки актуальности — заменяет разрозненные stale-правила
   * в стратегиях. Возраст считается от `nowMs`, а не от системных часов.
   *
   * @example
   * ```typescript
   * const st = store.getTopOfBookState(id, snapshot.nowMs, 2_000);
   * if (!st || st.stale) return; // нет данных или устарели
   * ```
   */
  public getTopOfBookState(
    instrumentId: InstrumentId,
    nowMs: number,
    staleMs: number,
  ): TopOfBookState | undefined {
    const topOfBook = this._topOfBooks.get(instrumentId);
    const eventTsMs = this._topOfBookTimestampsMs.get(instrumentId);
    if (topOfBook === undefined || eventTsMs === undefined) return undefined;

    const ageMs = nowMs - eventTsMs;
    return { topOfBook, eventTsMs, ageMs, stale: ageMs < 0 || ageMs > staleMs };
  }

  /**
   * Проверяет, что две книги достаточно синхронны по времени (#3).
   *
   * @param a - Первый инструмент
   * @param b - Второй инструмент
   * @param maxSkewMs - Максимальный допустимый разрыв timestamp (ms)
   * @returns `true`, если обе книги известны и `|tsA - tsB| <= maxSkewMs`
   *
   * @remarks
   * Используется cross-market стратегиями перед одновременной покупкой обеих ног,
   * чтобы не торговать по рассинхронным данным (кейс Binance/MEXC 10мс vs 100мс).
   */
  public areBooksSynchronized(a: InstrumentId, b: InstrumentId, maxSkewMs: number): boolean {
    const tsA = this._topOfBookTimestampsMs.get(a);
    const tsB = this._topOfBookTimestampsMs.get(b);
    if (tsA === undefined || tsB === undefined) return false;
    return Math.abs(tsA - tsB) <= maxSkewMs;
  }

  /**
   * Возвращает историю снапшотов стакана.
   *
   * @param instrumentId - ID инструмента
   * @returns OrderBookHistory или undefined
   */
  public getBookHistory(instrumentId: InstrumentId): OrderBookHistory | undefined {
    return this._deps.bookCollector.getHistory(instrumentId);
  }

  /**
   * Возвращает ленту трейдов.
   *
   * @param instrumentId - ID инструмента
   * @returns TradeTape или undefined
   */
  public getTradeTape(instrumentId: InstrumentId): TradeTape | undefined {
    return this._deps.tapeCollector.getTape(instrumentId);
  }

  /**
   * Очищает все TopOfBook данные.
   *
   * @remarks
   * Используется для тестов. Не очищает коллекторы — они управляются отдельно.
   */
  public clear(): void {
    this._topOfBooks.clear();
    this._topOfBookTimestampsMs.clear();
    this._byMarket.clear();
    this._instrumentToMarket.clear();
  }

  // ── Приватные методы ───────────────────────────────────────

  /**
   * Регистрирует связь instrumentId → marketId в reverse index.
   *
   * @param marketId - ID рынка из BOOK_UPDATED
   * @param instrumentId - ID инструмента
   */
  private _registerInstrument(marketId: MarketId, instrumentId: InstrumentId): void {
    const key = String(marketId);
    let set = this._byMarket.get(key);
    if (set === undefined) {
      set = new Set<InstrumentId>();
      this._byMarket.set(key, set);
    }
    set.add(instrumentId);
    this._instrumentToMarket.set(instrumentId, marketId);
  }

  /**
   * Очистка состояния закрытого рынка.
   *
   * Алгоритм:
   * 1. Удаляем TopOfBook и timestamp всех инструментов рынка (по reverse index).
   * 2. Делегируем cleanup истории стакана и ленты трейдов коллекторам.
   *
   * @remarks
   * MarketDataStore — единственный владелец подписки на MARKET_CLOSED. Коллекторы
   * остаются пассивными (их собственный `start()` не вызывается), поэтому их
   * очистка идёт через публичный `clearMarket()`, а не через их подписку. Это
   * закрывает утечку: без этого истории закрытых рынков жили бы вечно.
   *
   * @param marketId - ID закрытого рынка
   */
  private _onMarketClosed(marketId: MarketId): void {
    const key = String(marketId);
    const instruments = this._byMarket.get(key);
    if (instruments !== undefined) {
      for (const instrumentId of instruments) {
        this._topOfBooks.delete(instrumentId);
        this._topOfBookTimestampsMs.delete(instrumentId);
        this._instrumentToMarket.delete(instrumentId);
      }
      this._byMarket.delete(key);
    }

    this._deps.bookCollector.clearMarket(key);
    this._deps.tapeCollector.clearMarket(marketId);

    this._logger.debug('MarketDataStore: cleaned up closed market', {
      marketId: key,
      instruments: instruments?.size ?? 0,
    });
  }
}
