/**
 * Коллектор ленты трейдов (Trade Tape Collector)
 *
 * @remarks
 * Подписывается на `TRADE_RECEIVED` события и накапливает rolling-ленту
 * трейдов per tokenId в виде простых `TapeRecord` записей.
 *
 * ### Принцип: только запись, стратегия считает сама.
 * Коллектор НЕ вычисляет OFI, VWAP или другие метрики.
 * Стратегия сама забирает нужный временной срез и обрабатывает данные:
 * - Напрямую (buy/sell ratio, simple OFI)
 * - Через `TradeFlowCalculator` (если нужен полный набор метрик)
 *
 * ### Почему не используется `TradeTape` из `@polymarket/trade-tape`:
 * `TradeTape.append()` требует полный `Trade` entity с `VenueTradeId`, `VenueId`
 * и `AssetId` — данные которых нет в `TRADE_RECEIVED`.
 * `TapeRecord` хранит только то, что реально приходит из WS-ленты:
 * цену, объём, сторону и временную метку.
 *
 * ### Жизненный цикл:
 * 1. `start()` — подписывается на `TRADE_RECEIVED` и `MARKET_CLOSED`
 * 2. `TRADE_RECEIVED` → добавляет `TapeRecord` в ленту инструмента
 * 3. `MARKET_CLOSED` → удаляет ленты инструментов закрытого рынка
 * 4. `stop()` — отписывается от всех событий
 *
 * ### Удержание данных (retention):
 * Поддерживает оба ограничения как `BookDepthCollector`:
 * - `maxCount` — FIFO по количеству записей
 * - `maxAgeMs` — авто-вытеснение по возрасту при каждом `record()`
 *
 * @example
 * ```typescript
 * const collector = new TradeTapeCollector(deps, {
 *   maxCount: 1000,    // последние 1000 трейдов
 *   maxAgeMs: 300_000, // или не старше 5 минут
 * });
 * collector.start();
 *
 * // В стратегии — взять ленту за последнюю минуту и посчитать самостоятельно:
 * const trades = collector.getRecent(tokenId, 60_000);
 * const buy  = trades.filter(t => t.side === 'BUY').reduce((s, t) => s + t.size.value().toNumber(), 0);
 * const sell = trades.filter(t => t.side === 'SELL').reduce((s, t) => s + t.size.value().toNumber(), 0);
 * const ofi  = (buy - sell) / (buy + sell || 1);
 *
 * // VWAP:
 * const notional = trades.reduce((s, t) => s + t.price.value().mul(t.size.value()).toNumber(), 0);
 * const volume   = trades.reduce((s, t) => s + t.size.value().toNumber(), 0);
 * const vwap     = volume > 0 ? notional / volume : undefined;
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { Price, Quantity, Timestamp } from '@polymarket/value-objects';
import type { IEventBus } from '@polymarket/event-bus';
import type { IMarketCatalog } from '@polymarket/ports';

/**
 * Минимальная запись трейда из WS-ленты.
 *
 * @remarks
 * Содержит только поля доступные в `TRADE_RECEIVED` событии.
 * Не является полным `Trade` entity — не содержит `VenueTradeId`, `VenueId`, `AssetId`.
 */
export interface TapeRecord {
  /** Цена исполнения (Price VO) */
  readonly price: Price;
  /** Объём трейда (Quantity VO) */
  readonly size: Quantity;
  /** Сторона агрессора */
  readonly side: 'BUY' | 'SELL';
  /** Временная метка трейда */
  readonly timestamp: Timestamp;
}

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
 */
export interface TradeTapeCollectorConfig {
  /**
   * Максимальное количество трейдов per tokenId.
   * При превышении самый старый вытесняется (FIFO).
   */
  readonly maxCount?: number;
  /**
   * Максимальный возраст трейда в мс.
   * Устаревшие вытесняются при каждом новом трейде.
   */
  readonly maxAgeMs?: number;
}

/**
 * Внутренняя лента per tokenId
 */
interface InternalTape {
  records: TapeRecord[];
  /** marketId сохраняется при создании для cleanup на MARKET_CLOSED */
  marketId: string | undefined;
}

/**
 * Коллектор ленты трейдов из WS-потока.
 *
 * @remarks
 * Поддерживает `Map<tokenId, InternalTape>`.
 * Каждая лента создаётся лениво при первом трейде.
 */
export class TradeTapeCollector {
  private readonly _tapes = new Map<string, InternalTape>();

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
   * Возвращает трейды за последние `durationMs` мс.
   *
   * @param tokenId - ID токена
   * @param durationMs - Длительность окна в мс
   * @param nowMs - Текущее время (по умолчанию Date.now())
   * @returns Трейды в хронологическом порядке или пустой массив
   *
   * @example
   * ```typescript
   * const lastMinute = collector.getRecent(tokenId, 60_000);
   * ```
   */
  public getRecent(
    tokenId: InstrumentId,
    durationMs: number,
    nowMs?: number,
  ): readonly TapeRecord[] {
    const now = nowMs ?? Date.now();
    return this.getWindow(tokenId, now - durationMs, now);
  }

  /**
   * Возвращает трейды в заданном временном окне (включительно).
   *
   * @param tokenId - ID токена
   * @param fromMs - Начало окна в мс
   * @param toMs - Конец окна в мс
   * @returns Трейды в хронологическом порядке или пустой массив
   *
   * @example
   * ```typescript
   * const window = collector.getWindow(tokenId, T0, T0 + 60_000);
   * ```
   */
  public getWindow(
    tokenId: InstrumentId,
    fromMs: number,
    toMs: number,
  ): readonly TapeRecord[] {
    const tape = this._tapes.get(String(tokenId));
    if (!tape) return [];
    return tape.records.filter(
      (r) => r.timestamp.toNumber() >= fromMs && r.timestamp.toNumber() <= toMs,
    );
  }

  /**
   * Возвращает все трейды в ленте инструмента.
   *
   * @param tokenId - ID токена
   * @returns Все трейды в хронологическом порядке или пустой массив
   */
  public getAll(tokenId: InstrumentId): readonly TapeRecord[] {
    return this._tapes.get(String(tokenId))?.records ?? [];
  }

  /**
   * Возвращает количество трейдов в ленте инструмента.
   *
   * @param tokenId - ID токена
   * @returns Количество записей или 0 если лента не существует
   */
  public size(tokenId: InstrumentId): number {
    return this._tapes.get(String(tokenId))?.records.length ?? 0;
  }

  /**
   * Возвращает количество инструментов с активными лентами.
   *
   * @returns Количество tokenId с накопленными данными
   */
  public instrumentCount(): number {
    return this._tapes.size;
  }

  /**
   * Очищает все ленты из памяти.
   *
   * @remarks
   * Используется при сбросе состояния (тестирование, полная остановка).
   */
  public clear(): void {
    this._tapes.clear();
  }

  // ── Приватные методы ───────────────────────────────────────────────────────

  /**
   * Добавляет трейд в ленту инструмента.
   *
   * @remarks
   * Лента создаётся лениво при первом трейде.
   * marketId берётся из каталога один раз при создании ленты — для cleanup.
   * Порядок: 1) вытеснить старые, 2) добавить, 3) FIFO по maxCount.
   */
  private _record(
    instrumentId: InstrumentId,
    price: Price,
    size: Quantity,
    side: 'BUY' | 'SELL',
    timestamp: Timestamp,
  ): void {
    const key = String(instrumentId);
    let tape = this._tapes.get(key);

    if (tape === undefined) {
      const marketId = this._deps.catalog.get(instrumentId)?.marketId;
      tape = { records: [], marketId: marketId !== undefined ? String(marketId) : undefined };
      this._tapes.set(key, tape);

      this._deps.logger.debug('TradeTapeCollector: new tape created', {
        tokenId: key,
        marketId: tape.marketId ?? 'unknown',
      });
    }

    const record: TapeRecord = { price, size, side, timestamp };
    const nowMs = timestamp.toNumber();

    // Шаг 1: вытеснить устаревшие по возрасту
    if (this._config.maxAgeMs !== undefined) {
      const cutoff = nowMs - this._config.maxAgeMs;
      let i = 0;
      while (i < tape.records.length && tape.records[i].timestamp.toNumber() < cutoff) {
        i++;
      }
      if (i > 0) tape.records.splice(0, i);
    }

    // Шаг 2: добавить новый трейд
    tape.records.push(record);

    // Шаг 3: FIFO по maxCount
    if (this._config.maxCount !== undefined && tape.records.length > this._config.maxCount) {
      tape.records.shift();
    }
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

    for (const [key, tape] of this._tapes) {
      if (tape.marketId === marketIdStr) {
        this._tapes.delete(key);
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
