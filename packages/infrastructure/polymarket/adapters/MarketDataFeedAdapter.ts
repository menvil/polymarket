/**
 * MarketDataFeedAdapter — маршрутизация рыночных данных из WS в BookUpdateHandler.
 *
 * @remarks
 * Одна ответственность: market channel (orderbook snapshots + публичные трейды).
 * User channel (fills, order updates) → UserEventFeedAdapter.
 *
 * ### Поток данных:
 * ```
 * IPolymarketWsEmitter.onOrderbookSnapshot(dto)
 *   → recorder?.recordEvent(tokenId, dto)   (опционально, сначала пишем raw)
 *   → WsRawLevel[] → PriceLevel[]           (конвертация на границе инфраструктуры)
 *   → bookHandler?.handleSnapshot()         (application layer, опционально)
 *
 * IPolymarketWsEmitter.onReconnect()
 *   → bookHandler?.onReconnect()            (инвалидирует кэш стаканов, опционально)
 * ```
 *
 * ### Режим только записи (data collection):
 * Если `bookHandler = null`, адаптер работает только как recorder — пишет события
 * на диск без какой-либо доменной обработки. Используется в скрипте collect-data.
 *
 * ### Запись сырых данных (опционально):
 * Если передан `recorder`, каждый входящий WS-снапшот записывается на диск
 * до доменной обработки. Это позволяет воспроизвести исторические данные в бектесте.
 * `recordEvent` синхронен и никогда не бросает — не влияет на trading path.
 *
 * ### Gap recovery (при reconnect):
 * `onReconnect()` инвалидирует все стаканы.
 * Следующий WS snapshot (`onOrderbookSnapshot`) восстановит свежее состояние.
 * При необходимости принудительного восстановления используй `forceSnapshotRefresh()`.
 *
 * @example
 * ```typescript
 * // Торговый режим (с BookUpdateHandler):
 * const adapter = new MarketDataFeedAdapter(wsEmitter, bookHandler, logger, recorder);
 * adapter.start();
 *
 * // Режим только записи (без BookUpdateHandler):
 * const adapter = new MarketDataFeedAdapter(wsEmitter, null, logger, recorder);
 * adapter.start();
 *
 * // При завершении:
 * adapter.stop();
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- внутренняя Decimal-арифметика/парсинг границы после VO-типизированного публичного API, см. docs/architecture/boundary-contract.md, Решение 1
import Decimal from 'decimal.js';
import type { ILogger } from '@polymarket/logger';
import { asInstrumentId } from '@polymarket/ids';
import { OutcomePrice, Quantity } from '@polymarket/value-objects';
import { TimestampService } from '@polymarket/timestamp';
import { OrderbookLevel } from '@polymarket/orderbook';
import type { IMarketDataRecorder } from '@polymarket/ports';
import type { IPolymarketWsEmitter } from '../ws/IPolymarketWsEmitter.js';
import type { BookUpdateHandler } from '@polymarket/handlers';

/**
 * Адаптер маркет-данных: мост между WS-эмиттером и BookUpdateHandler.
 *
 * @remarks
 * Подписывается на WS-события при `start()`.
 * Снимает все подписки при `stop()`.
 * Опционально записывает raw WS-события через `IMarketDataRecorder` (fire-and-forget).
 *
 * `bookHandler` может быть `null` — тогда адаптер работает только как recorder
 * (режим сбора данных без торговой логики).
 */
export class MarketDataFeedAdapter {
  private readonly _logger: ILogger;
  /** Список активных unsubscribe-функций */
  private readonly _unsubscribes: Array<() => void> = [];
  /**
   * Последний хэш снапшота per asset_id — для дедупликации reconnect-дублей.
   * Хэш специфичен для конкретного asset_id (не market), что подтверждено
   * реальными данными: YES/NO токены одного рынка имеют разные хэши.
   */
  private readonly _lastHashes = new Map<string, string>();

  /**
   * @param _wsEmitter - WS-эмиттер raw событий Polymarket
   * @param _bookHandler - Application handler обновлений стакана, или `null` в режиме только записи
   * @param _logger - Logger
   * @param _recorder - Опциональный рекордер для сохранения сырых WS-событий на диск
   */
  constructor(
    private readonly _wsEmitter: IPolymarketWsEmitter,
    private readonly _bookHandler: BookUpdateHandler | null,
    logger: ILogger,
    private readonly _recorder?: IMarketDataRecorder,
  ) {
    this._logger = logger.child({ component: 'MarketDataFeedAdapter' });
  }

  /**
   * Запускает маршрутизацию: подписывается на WS-события.
   *
   * @remarks
   * Идемпотентен: повторный вызов добавит дублирующие подписки —
   * вызывай `stop()` перед повторным `start()`.
   *
   * @example
   * ```typescript
   * adapter.start();
   * ```
   */
  public start(): void {
    const unsubSnapshot = this._wsEmitter.onOrderbookSnapshot(async (dto) => {
      const tokenId = asInstrumentId(dto.asset_id);
      if (!tokenId) {
        this._logger.warn('Invalid asset_id in orderbook snapshot, skipping', {
          asset_id: dto.asset_id,
        });
        return;
      }

      // Записываем raw событие до доменной обработки (fire-and-forget, синхронно)
      this._recorder?.recordEvent(tokenId, dto);

      // В режиме только записи (bookHandler = null) конвертация уровней не нужна:
      // raw данные уже сохранены выше, а доменная обработка отсутствует.
      if (!this._bookHandler) return;

      // Дедупликация по хэшу: пропускаем снапшот если состояние книги не изменилось.
      // Эффективно при reconnect — Polymarket переотправляет снапшоты, большинство
      // из которых идентичны уже обработанным (те же хэши → skip).
      if (dto.hash) {
        if (this._lastHashes.get(dto.asset_id) === dto.hash) {
          this._logger.debug('Skipping duplicate orderbook snapshot', { asset_id: dto.asset_id });
          return;
        }
        this._lastHashes.set(dto.asset_id, dto.hash);
      }

      const bids = this._convertLevels(dto.bids);
      const asks = this._convertLevels(dto.asks);
      const tsResult = TimestampService.create(Number(dto.timestamp));
      if (!tsResult.ok) {
        this._logger.warn('Invalid timestamp in WS orderbook snapshot, skipping', {
          asset_id: dto.asset_id,
          timestamp: dto.timestamp,
        });
        return;
      }

      await this._bookHandler.handleSnapshot(tokenId, bids, asks, tsResult.value);
    });

    const unsubReconnect = this._wsEmitter.onReconnect(() => {
      if (this._bookHandler) {
        this._logger.info('Market WS reconnected, invalidating order books');
        this._bookHandler.onReconnect();
      } else {
        this._logger.info('Market WS reconnected (recorder-only mode, no order books to invalidate)');
      }
    });

    this._unsubscribes.push(unsubSnapshot, unsubReconnect);
    this._logger.info('MarketDataFeedAdapter started');
  }

  /**
   * Останавливает маршрутизацию: снимает все WS-подписки.
   *
   * @remarks
   * Идемпотентен: повторный вызов безопасен.
   */
  public stop(): void {
    for (const unsub of this._unsubscribes) {
      unsub();
    }
    this._unsubscribes.length = 0;
    this._logger.info('MarketDataFeedAdapter stopped');
  }

  /**
   * Конвертирует WS raw levels в OrderbookLevel[] (Value Objects).
   *
   * @param levels - Raw уровни из WS (цена и размер как строки)
   * @returns Массив OrderbookLevel с типизированными VOs
   *
   * @remarks
   * Невалидные уровни пропускаются с предупреждением в лог.
   * Конвертация выполняется на границе инфраструктуры (до передачи в application layer).
   */
  private _convertLevels(levels: Array<{ price: string; size: string }>): OrderbookLevel[] {
    const result: OrderbookLevel[] = [];

    for (const level of levels) {
      try {
        const price = OutcomePrice.of(new Decimal(level.price));
        const quantity = Quantity.of(new Decimal(level.size));
        result.push(OrderbookLevel.create(price, quantity));
      } catch {
        // price="1" или price="0" — ожидаемо для рынков у разрешения (losing-токен).
        // Уровень пропускается корректно — DEBUG, не WARN.
        this._logger.debug('Skipping out-of-range price level in WS snapshot', {
          price: level.price,
          size: level.size,
        });
      }
    }

    return result;
  }
}
