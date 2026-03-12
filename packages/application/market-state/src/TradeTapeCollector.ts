/**
 * Коллектор ленты трейдов (Trade Tape Collector)
 *
 * @remarks
 * Подписывается на `TRADE_RECEIVED` события и накапливает rolling-ленту
 * трейдов per tokenId в виде `TradeTape` из `@polymarket/trade-tape`.
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
 * - Оба создают хранилище лениво при первом событии
 * - Оба очищают данные при `MARKET_CLOSED`
 *
 * ### Жизненный цикл:
 * 1. `start()` — подписывается на `TRADE_RECEIVED` и `MARKET_CLOSED`
 * 2. `TRADE_RECEIVED` → добавляет `TapeRecord` в `TradeTape` инструмента
 * 3. `MARKET_CLOSED` → удаляет ленты инструментов закрытого рынка
 * 4. `stop()` — отписывается от всех событий
 *
 * ### Удержание данных (retention):
 * Политика передаётся при создании и применяется к каждой `TradeTape`:
 * - `maxCount` — FIFO по количеству записей
 * - `maxAgeMs` — авто-вытеснение по возрасту при каждом `append()`
 *
 * @example
 * ```typescript
 * const collector = new TradeTapeCollector(deps, {
 *   maxCount: 1000,    // последние 1000 трейдов
 *   maxAgeMs: 300_000, // или не старше 5 минут
 * });
 * collector.start();
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
import type { Side } from '@polymarket/value-objects';
import type { IEventBus } from '@polymarket/event-bus';
import type { IMarketCatalog } from '@polymarket/ports';
import { TradeTape } from '@polymarket/trade-tape';
import type { TapeRetentionPolicy } from '@polymarket/trade-tape';

/**
 * Зависимости TradeTapeCollector.
 */
export interface TradeTapeCollectorDeps {
  /** Event bus для подписки на TRADE_RECEIVED / MARKET_CLOSED */
  readonly eventBus: IEventBus;
  /** Каталог инструментов — для ассоциирования tokenId с marketId при cleanup */
  readonly catalog: IMarketCatalog;
  /** Logger */
  readonly logger: ILogger;
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
 * Внутренняя структура хранения ленты per tokenId
 */
interface InternalEntry {
  tape: TradeTape;
  /** marketId сохраняется при создании для cleanup на MARKET_CLOSED */
  marketId: string | undefined;
}

/**
 * Коллектор ленты трейдов из WS-потока.
 *
 * @remarks
 * Поддерживает `Map<tokenId, InternalEntry>`.
 * Каждая лента создаётся лениво при первом трейде.
 * Использует `TradeTape` из `@polymarket/trade-tape` — согласованно с
 * `BookDepthCollector`, который использует `OrderBookHistory`.
 */
export class TradeTapeCollector {
  private readonly _entries = new Map<string, InternalEntry>();

  private _unsubTrade: (() => void) | undefined;
  private _unsubMarketClosed: (() => void) | undefined;

  /**
   * @param _deps - Зависимости (eventBus, catalog, logger)
   * @param _config - Политика хранения (maxCount и/или maxAgeMs)
   *
   * @throws {RangeError} Если конфиг пустой (ни maxCount ни maxAgeMs не заданы)
   */
  constructor(
    private readonly _deps: TradeTapeCollectorDeps,
    private readonly _config: TradeTapeCollectorConfig,
  ) {
    if (_config.maxCount === undefined && _config.maxAgeMs === undefined) {
      throw new RangeError(
        'TradeTapeCollector: config must specify maxCount and/or maxAgeMs',
      );
    }
  }

  /**
   * Запускает коллектор — подписывается на события.
   *
   * @remarks
   * Повторный вызов без `stop()` отписывает предыдущие подписки (идемпотентен).
   *
   * @example
   * ```typescript
   * collector.start();
   * ```
   */
  public start(): void {
    this._unsubTrade?.();
    this._unsubMarketClosed?.();

    this._unsubTrade = this._deps.eventBus.subscribe(
      'TRADE_RECEIVED',
      async (event) => {
        this._record(event.instrumentId, event.price, event.size, event.side, event.timestamp);
      },
    );

    this._unsubMarketClosed = this._deps.eventBus.subscribe(
      'MARKET_CLOSED',
      async (event) => {
        this._cleanup(event.marketId);
      },
    );

    this._deps.logger.info('TradeTapeCollector started', {
      maxCount: this._config.maxCount ?? null,
      maxAgeMs: this._config.maxAgeMs ?? null,
    });
  }

  /**
   * Останавливает коллектор — отписывается от событий.
   *
   * @remarks
   * Накопленные ленты сохраняются после stop().
   * Для полного сброса вызовите `clear()`.
   */
  public stop(): void {
    this._unsubTrade?.();
    this._unsubMarketClosed?.();
    this._unsubTrade = undefined;
    this._unsubMarketClosed = undefined;

    this._deps.logger.info('TradeTapeCollector stopped', {});
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
    return this._entries.get(String(tokenId))?.tape;
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
   * Очищает все ленты из памяти.
   *
   * @remarks
   * Используется при сбросе состояния (тестирование, полная остановка).
   */
  public clear(): void {
    this._entries.clear();
  }

  // ── Приватные методы ───────────────────────────────────────────────────────

  /**
   * Добавляет трейд в ленту инструмента.
   *
   * @remarks
   * Лента (`TradeTape`) создаётся лениво при первом трейде.
   * marketId берётся из каталога один раз при создании ленты — для cleanup.
   * Вытеснение устаревших записей обрабатывается внутри `TradeTape.append()`.
   */
  private _record(
    instrumentId: InstrumentId,
    price: import('@polymarket/value-objects').Price,
    size: import('@polymarket/value-objects').Quantity,
    side: Side,
    timestamp: import('@polymarket/value-objects').Timestamp,
  ): void {
    const key = String(instrumentId);
    let entry = this._entries.get(key);

    if (entry === undefined) {
      const marketId = this._deps.catalog.get(instrumentId)?.marketId;
      const tape = TradeTape.create(this._config);
      entry = { tape, marketId: marketId !== undefined ? String(marketId) : undefined };
      this._entries.set(key, entry);

      this._deps.logger.debug('TradeTapeCollector: new tape created', {
        tokenId: key,
        marketId: entry.marketId ?? 'unknown',
      });
    }

    entry.tape.append({ price, size, side, timestamp });
  }

  /**
   * Удаляет ленты инструментов закрытого рынка.
   *
   * @remarks
   * Ищет ленты у которых сохранённый marketId совпадает с закрытым.
   * Если marketId при создании ленты был неизвестен (нет в каталоге) — лента не удаляется.
   *
   * @param marketId - ID закрытого рынка
   */
  private _cleanup(marketId: MarketId): void {
    const marketIdStr = String(marketId);
    let removed = 0;

    for (const [key, entry] of this._entries) {
      if (entry.marketId === marketIdStr) {
        this._entries.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      this._deps.logger.debug('TradeTapeCollector: tapes cleaned up', {
        marketId: marketIdStr,
        removed,
      });
    }
  }
}
