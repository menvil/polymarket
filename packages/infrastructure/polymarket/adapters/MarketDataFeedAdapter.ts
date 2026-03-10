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
 *   → WsRawLevel[] → PriceLevel[]           (конвертация на границе инфраструктуры)
 *   → BookUpdateHandler.handleSnapshot()    (application layer)
 *
 * IPolymarketWsEmitter.onReconnect()
 *   → BookUpdateHandler.onReconnect()       (инвалидирует кэш стаканов)
 * ```
 *
 * ### Gap recovery (при reconnect):
 * `onReconnect()` инвалидирует все стаканы.
 * Следующий WS snapshot (`onOrderbookSnapshot`) восстановит свежее состояние.
 * При необходимости принудительного восстановления используй `forceSnapshotRefresh()`.
 *
 * @example
 * ```typescript
 * const adapter = new MarketDataFeedAdapter(wsEmitter, bookHandler, logger);
 * adapter.start();
 * // При завершении:
 * adapter.stop();
 * ```
 */
import Decimal from 'decimal.js';
import type { ILogger } from '@polymarket/logger';
import { asInstrumentId } from '@polymarket/ids';
import { Price, Quantity } from '@polymarket/value-objects';
import type { PriceLevel } from '@polymarket/order-book';
import type { IPolymarketWsEmitter } from '../ws/IPolymarketWsEmitter.js';
import type { BookUpdateHandler } from '@polymarket/handlers';

/**
 * Адаптер маркет-данных: мост между WS-эмиттером и BookUpdateHandler.
 *
 * @remarks
 * Подписывается на WS-события при `start()`.
 * Снимает все подписки при `stop()`.
 */
export class MarketDataFeedAdapter {
  private readonly _logger: ILogger;
  /** Список активных unsubscribe-функций */
  private readonly _unsubscribes: Array<() => void> = [];

  /**
   * @param _wsEmitter - WS-эмиттер raw событий Polymarket
   * @param _bookHandler - Application handler обновлений стакана
   * @param _logger - Logger
   */
  constructor(
    private readonly _wsEmitter: IPolymarketWsEmitter,
    private readonly _bookHandler: BookUpdateHandler,
    logger: ILogger,
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

      const bids = this._convertLevels(dto.bids);
      const asks = this._convertLevels(dto.asks);
      const timestamp = Number(dto.timestamp);

      await this._bookHandler.handleSnapshot(tokenId, bids, asks, timestamp);
    });

    const unsubReconnect = this._wsEmitter.onReconnect(() => {
      this._logger.info('Market WS reconnected, invalidating order books');
      this._bookHandler.onReconnect();
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
   * Конвертирует WS raw levels в PriceLevel[] (Value Objects).
   *
   * @param levels - Raw уровни из WS (цена и размер как строки)
   * @returns Массив PriceLevel с типизированными VOs
   *
   * @remarks
   * Невалидные уровни пропускаются с предупреждением в лог.
   * Конвертация выполняется на границе инфраструктуры (до передачи в application layer).
   */
  private _convertLevels(levels: Array<{ price: string; size: string }>): PriceLevel[] {
    const result: PriceLevel[] = [];

    for (const level of levels) {
      try {
        const price = Price.of(new Decimal(level.price));
        const size = Quantity.of(new Decimal(level.size));
        result.push({ price, size });
      } catch {
        this._logger.warn('Invalid price level in WS snapshot, skipping', {
          price: level.price,
          size: level.size,
        });
      }
    }

    return result;
  }
}
