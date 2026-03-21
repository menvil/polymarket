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
 * 4. Подписывается на EventBus: BOOK_UPDATED, BOOK_DEPTH, TRADE_RECEIVED
 * 5. При обновлении вызывает `_onChange(instrumentId, reason)` callback
 *
 * ### Особенности подписок:
 * - BOOK_UPDATED → сохраняет TopOfBook + onChange('BOOK')
 * - BOOK_DEPTH → записывает в BookDepthCollector; onChange **не вызывается** —
 *   архитектурное допущение: каждый BOOK_DEPTH сопровождается BOOK_UPDATED,
 *   который уже уведомил стратегию. Если upstream начнёт слать depth без
 *   paired top-of-book update, стратегия это изменение не увидит.
 * - TRADE_RECEIVED → записывает в TradeTapeCollector + onChange('TRADE')
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
import type { InstrumentId } from '@polymarket/ids';
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
  private _onChange?: (instrumentId: InstrumentId, reason: MarketDataReason) => void;

  private _unsubBookUpdated: (() => void) | undefined;
  private _unsubBookDepth: (() => void) | undefined;
  private _unsubTradeReceived: (() => void) | undefined;

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

    this._unsubBookUpdated = this._deps.eventBus.subscribe(
      'BOOK_UPDATED',
      (event) => {
        this._topOfBooks.set(event.instrumentId, event.topOfBook);
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
        // Не вызываем onChange — BOOK_UPDATED уже вызвал
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
        );
        this._onChange?.(event.instrumentId, 'TRADE');
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
    this._unsubBookUpdated = undefined;
    this._unsubBookDepth = undefined;
    this._unsubTradeReceived = undefined;

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
  }
}
