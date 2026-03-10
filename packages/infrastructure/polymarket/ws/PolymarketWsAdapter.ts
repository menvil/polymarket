/**
 * PolymarketWsAdapter — raw event emitter для Polymarket WebSocket.
 *
 * @remarks
 * Реализует `IPolymarketWsEmitter` — передаёт типизированные DTO
 * без доменной логики. Bridge-адаптеры (Phase 8) подписываются
 * через этот интерфейс и делегируют в Handlers (Phase 3).
 *
 * ### Архитектура:
 * ```
 * PolymarketWsClient (транспорт)
 *   → WsMessageMapper.parseWsMessage() (raw bytes → DTO)
 *   → PolymarketWsAdapter (dispatch DTO → callbacks)
 *   → IPolymarketWsEmitter subscribers (bridge-адаптеры)
 * ```
 *
 * ### Принципы:
 * - Raw event emitter: никакой доменной логики
 * - Каждый тип события → отдельный `Set<callback>`
 * - Unsubscribe через функцию-замыкание (Set.delete)
 * - Callbacks await-ятся последовательно (ошибки изолированы через try/catch)
 * - onReconnect() вызывается из события 'connected' клиента
 *
 * @example
 * ```typescript
 * const adapter = new PolymarketWsAdapter(wsManager, logger);
 * await adapter.connect();
 *
 * const unsub = adapter.onOrderbookSnapshot(async (dto) => {
 *   await bookHandler.handleFullState(dto.market, dto.asset_id, dto.bids, dto.asks);
 * });
 *
 * // При cleanup:
 * unsub();
 * await adapter.disconnect();
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { IPolymarketWsEmitter } from './IPolymarketWsEmitter.js';
import type { WsOrderbookSnapshotDto } from './dto/WsOrderbookDto.js';
import type { WsTradeDto } from './dto/WsTradeDto.js';
import type { WsUserFillDto, WsOrderUpdateDto } from './dto/WsUserEventDto.js';
import type { PolymarketWebSocketManager, SubscriptionParams } from './PolymarketWebSocketManager.js';
import { PolymarketWsClient } from './PolymarketWsClient.js';
import { PolymarketMessageRouter } from './PolymarketMessageRouter.js';
import { parseWsMessage } from './mapping/WsMessageMapper.js';

/**
 * PolymarketWsAdapter — реализация IPolymarketWsEmitter.
 *
 * @remarks
 * Связывает транспортный слой (WsClient + MessageRouter) с callback-подписчиками.
 * Не содержит доменной логики — только парсинг и dispatch.
 */
export class PolymarketWsAdapter implements IPolymarketWsEmitter {
  private readonly _client: PolymarketWsClient;
  private readonly _router: PolymarketMessageRouter;
  private readonly _logger: ILogger;

  /** Подписчики на orderbook снапшоты */
  private readonly _onSnapshot = new Set<(dto: WsOrderbookSnapshotDto) => Promise<void>>();
  /** Подписчики на публичные трейды */
  private readonly _onTrade = new Set<(dto: WsTradeDto) => Promise<void>>();
  /** Подписчики на fill-события из user channel */
  private readonly _onFill = new Set<(dto: WsUserFillDto) => Promise<void>>();
  /** Подписчики на обновления статуса ордера */
  private readonly _onOrderUpdate = new Set<(dto: WsOrderUpdateDto) => Promise<void>>();
  /** Подписчики на reconnect */
  private readonly _onReconnect = new Set<() => void>();

  /** Отслеживает подписанные tokens для переподписки после reconnect */
  private readonly _subscribedTokens = new Set<string>();

  private _isConnected = false;
  private _isDestroyed = false;

  /**
   * Создаёт PolymarketWsAdapter.
   *
   * @param wsManager - Менеджер WebSocket соединений
   * @param logger - Logger для операций адаптера
   *
   * @throws {Error} Если wsManager или logger равны null
   *
   * @example
   * ```typescript
   * const adapter = new PolymarketWsAdapter(wsManager, logger);
   * ```
   */
  constructor(wsManager: PolymarketWebSocketManager, logger: ILogger) {
    if (!wsManager) throw new Error('wsManager is required');
    if (!logger) throw new Error('logger is required');

    this._logger = logger.child ? logger.child({ component: 'PolymarketWsAdapter' }) : logger;
    this._client = new PolymarketWsClient(wsManager, this._logger);
    this._router = new PolymarketMessageRouter(this._logger);

    this._setupIntegration();
  }

  // ─────────────────────────── IPolymarketWsEmitter ────────────────────────────

  /**
   * Подписывается на полный снапшот стакана.
   *
   * @param cb - Callback (async) вызываемый при каждом 'book' событии
   * @returns Функция отписки
   */
  onOrderbookSnapshot(cb: (dto: WsOrderbookSnapshotDto) => Promise<void>): () => void {
    this._onSnapshot.add(cb);
    return () => this._onSnapshot.delete(cb);
  }

  /**
   * Подписывается на публичный трейд.
   *
   * @param cb - Callback (async) вызываемый при каждом 'trade' событии
   * @returns Функция отписки
   */
  onTradeEvent(cb: (dto: WsTradeDto) => Promise<void>): () => void {
    this._onTrade.add(cb);
    return () => this._onTrade.delete(cb);
  }

  /**
   * Подписывается на fill из user-channel.
   *
   * @param cb - Callback (async) вызываемый при каждом user-channel 'trade' событии (fill)
   * @returns Функция отписки
   *
   * @remarks
   * Polymarket user channel использует event_type: "trade" для fills.
   * Отличается от market-channel 'trade' наличием поля taker_order_id.
   */
  onUserFill(cb: (dto: WsUserFillDto) => Promise<void>): () => void {
    this._onFill.add(cb);
    return () => this._onFill.delete(cb);
  }

  /**
   * Подписывается на lifecycle событие ордера из user-channel.
   *
   * @param cb - Callback (async) вызываемый при каждом 'order' событии (event_type: "order")
   * @returns Функция отписки
   *
   * @remarks
   * Polymarket user channel использует event_type: "order" для lifecycle событий.
   * WsOrderUpdateDto.orderEventType содержит тип события (например, "PLACEMENT").
   */
  onOrderUpdate(cb: (dto: WsOrderUpdateDto) => Promise<void>): () => void {
    this._onOrderUpdate.add(cb);
    return () => this._onOrderUpdate.delete(cb);
  }

  /**
   * Подписывается на событие reconnect.
   *
   * @param cb - Callback без аргументов
   * @returns Функция отписки
   *
   * @remarks
   * BookUpdateHandler использует это для инвалидации кэша стаканов.
   */
  onReconnect(cb: () => void): () => void {
    this._onReconnect.add(cb);
    return () => this._onReconnect.delete(cb);
  }

  // ─────────────────────────── Управление подключением ─────────────────────────

  /**
   * Подключается к Polymarket WebSocket.
   *
   * @throws {Error} Если адаптер уничтожен
   */
  async connect(): Promise<void> {
    this._checkDestroyed();
    await this._client.connect();
  }

  /**
   * Отключается от WebSocket.
   */
  async disconnect(): Promise<void> {
    await this._client.destroy();
  }

  /**
   * Подписывается на WebSocket channel для tokenId.
   *
   * @param tokenId - Token ID для подписки
   *
   * @remarks
   * Добавляет tokenId в набор отслеживаемых.
   * Если уже подключены — отправляет WS подписку немедленно.
   */
  async subscribeToToken(tokenId: string): Promise<void> {
    this._checkDestroyed();
    const wasNew = !this._subscribedTokens.has(tokenId);
    this._subscribedTokens.add(tokenId);
    if (wasNew && this._isConnected) {
      await this._sendAllSubscriptions();
    }
  }

  /**
   * Отписывается от WebSocket channel для tokenId.
   *
   * @param tokenId - Token ID для отписки
   */
  async unsubscribeFromToken(tokenId: string): Promise<void> {
    this._checkDestroyed();
    this._subscribedTokens.delete(tokenId);
    if (this._isConnected) {
      await this._sendAllSubscriptions();
    }
  }

  /**
   * Проверяет подключён ли адаптер.
   */
  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Уничтожает адаптер и освобождает ресурсы.
   *
   * @remarks
   * После destroy() адаптер не может быть переиспользован.
   * Идемпотентен — безопасно вызывать несколько раз.
   */
  async destroy(): Promise<void> {
    if (this._isDestroyed) return;
    this._isDestroyed = true;

    this._logger.info('[PolymarketWsAdapter] Destroying adapter');

    try {
      await this._client.destroy();
    } catch (err) {
      this._logger.warn('[PolymarketWsAdapter] Error during client destroy', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }

    this._subscribedTokens.clear();
    this._onSnapshot.clear();
    this._onTrade.clear();
    this._onFill.clear();
    this._onOrderUpdate.clear();
    this._onReconnect.clear();
    this._router.removeAllListeners();
    this._isConnected = false;

    this._logger.info('[PolymarketWsAdapter] Destroyed');
  }

  // ─────────────────────────── Внутренняя логика ───────────────────────────────

  /**
   * Настраивает интеграцию между транспортным слоем и диспетчером.
   *
   * @remarks
   * Client → Router (raw bytes → распарсенные сообщения)
   * Router → Adapter (распарсенные сообщения → диспетчеризация DTO)
   * События жизненного цикла Client → флаг isConnected + callbacks reconnect
   */
  private _setupIntegration(): void {
    // Пересылаем raw данные из Client в Router
    this._client.on('message', (rawData: Buffer) => {
      this._router.processRawData(rawData);
    });

    // Router эмитирует 'orderbook' и 'trade', мы парсим через WsMessageMapper
    this._router.on('orderbook', (message: unknown) => {
      void this._dispatchParsed(message);
    });

    this._router.on('trade', (message: unknown) => {
      void this._dispatchParsed(message);
    });

    // User channel: order lifecycle события (event_type: "order")
    // Router эмитирует 'order' если поддерживает user channel
    this._router.on('order', (message: unknown) => {
      void this._dispatchParsed({ ...(message as object), type: 'order' });
    });

    this._router.on('error', (error: Error) => {
      this._logger.error('[PolymarketWsAdapter] Router error', {
        err: error,
      });
    });

    // События жизненного цикла
    this._client.on('connected', async () => {
      const wasConnected = this._isConnected;
      this._isConnected = true;

      if (wasConnected) {
        // Reconnect — инвалидируем кэши стаканов у подписчиков
        this._logger.info('[PolymarketWsAdapter] Reconnected — dispatching onReconnect');
        this._dispatchReconnect();
      } else {
        this._logger.info('[PolymarketWsAdapter] Connected');
      }

      // Переподписываемся на все tokens
      try {
        await this._resubscribeAll();
      } catch (err) {
        this._logger.error('[PolymarketWsAdapter] Failed to resubscribe after connect', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    });

    this._client.on('disconnected', () => {
      this._isConnected = false;
      this._logger.info('[PolymarketWsAdapter] Disconnected');
    });

    this._client.on('error', (error: Error) => {
      this._logger.error('[PolymarketWsAdapter] WebSocket error', {
        err: error,
      });
    });
  }

  /**
   * Парсит raw сообщение через WsMessageMapper и dispatch в нужный callback-set.
   *
   * @param message - Raw сообщение от Router (уже JSON-объект)
   */
  private async _dispatchParsed(message: unknown): Promise<void> {
    const dto = parseWsMessage(message);
    if (!dto) return;

    if (dto.type === 'book') {
      await this._dispatchTo(this._onSnapshot, dto as WsOrderbookSnapshotDto);
    } else if (dto.type === 'trade') {
      await this._dispatchTo(this._onTrade, dto as WsTradeDto);
    } else if ('taker_order_id' in dto) {
      // User channel fill: event_type "trade" с taker_order_id → WsUserFillDto
      await this._dispatchTo(this._onFill, dto as WsUserFillDto);
    } else if (dto.type === 'order') {
      // User channel order lifecycle: event_type "order" → WsOrderUpdateDto
      await this._dispatchTo(this._onOrderUpdate, dto as WsOrderUpdateDto);
    }
  }

  /**
   * Dispatch DTO в Set callback-ов с изоляцией ошибок.
   *
   * @param callbacks - Set подписчиков
   * @param dto - Типизированный DTO для передачи
   */
  private async _dispatchTo<T>(
    callbacks: Set<(dto: T) => Promise<void>>,
    dto: T
  ): Promise<void> {
    for (const cb of callbacks) {
      try {
        await cb(dto);
      } catch (err) {
        this._logger.error('[PolymarketWsAdapter] Callback error', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }

  /**
   * Вызывает все onReconnect callbacks.
   */
  private _dispatchReconnect(): void {
    for (const cb of this._onReconnect) {
      try {
        cb();
      } catch (err) {
        this._logger.error('[PolymarketWsAdapter] Reconnect callback error', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
  }

  /**
   * Переподписывается на все tokens после reconnect.
   */
  private async _resubscribeAll(): Promise<void> {
    if (this._isDestroyed || this._subscribedTokens.size === 0) return;

    this._logger.info('[PolymarketWsAdapter] Resubscribing', {
      tokenCount: this._subscribedTokens.size,
    });

    await this._sendAllSubscriptions();
  }

  /**
   * Отправляет WS-подписку для всех tracked tokens.
   *
   * @remarks
   * Polymarket WebSocket ЗАМЕНЯЕТ подписки при каждом вызове.
   * Поэтому отправляем ВСЕ tokens в одном сообщении.
   */
  private async _sendAllSubscriptions(): Promise<void> {
    if (this._isDestroyed || this._subscribedTokens.size === 0) return;

    const tokens = Array.from(this._subscribedTokens);

    try {
      await this._client.reconnectWithTimeout(10_000);

      const params: SubscriptionParams = {
        assets_ids: tokens,
        type: 'market',
      };

      await this._client.subscribe('market', params);

      this._logger.debug('[PolymarketWsAdapter] Subscription sent', {
        tokenCount: tokens.length,
      });
    } catch (err) {
      if (!this._isDestroyed) {
        this._logger.error('[PolymarketWsAdapter] Failed to send subscriptions', {
          err: err instanceof Error ? err : new Error(String(err)),
          tokenCount: tokens.length,
        });
      }
    }
  }

  /**
   * Проверяет, уничтожен ли адаптер.
   *
   * @throws {Error} Если адаптер уничтожен
   */
  private _checkDestroyed(): void {
    if (this._isDestroyed) {
      throw new Error('PolymarketWsAdapter has been destroyed and cannot be used');
    }
  }
}
