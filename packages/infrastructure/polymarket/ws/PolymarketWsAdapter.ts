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
import type { IPolymarketWsEmitter, UserChannelConfig } from './IPolymarketWsEmitter.js';
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

  /** Конфигурация user channel (null = не подписаны на user channel) */
  private _userChannelConfig: UserChannelConfig | null = null;

  private _isConnected = false;
  private _isDestroyed = false;
  /** true после первого успешного подключения — используется для отличия reconnect от first connect */
  private _hasEverConnected = false;

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
   * Подписывается на Polymarket user channel (fills + order lifecycle).
   *
   * @param config - Credentials для аутентификации: apiKey, secret, passphrase
   * @returns Promise, который разрешается после отправки subscription message
   *
   * @remarks
   * Сохраняет конфигурацию для автоматической переподписки после reconnect.
   * Если уже подключены — отправляет subscription message немедленно.
   *
   * User channel subscription format:
   * ```json
   * { "type": "user", "auth": { "apiKey": "...", "secret": "...", "passphrase": "..." } }
   * ```
   *
   * @throws {Error} Если адаптер уничтожен
   *
   * @example
   * ```typescript
   * await adapter.connect();
   * await adapter.subscribeUserChannel({ apiKey, secret, passphrase });
   * adapter.onUserFill(async (dto) => { ... });
   * ```
   */
  async subscribeUserChannel(config: UserChannelConfig): Promise<void> {
    this._checkDestroyed();
    this._userChannelConfig = config;

    if (this._isConnected) {
      await this._sendUserChannelSubscription();
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
    this._userChannelConfig = null;
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

    // Router эмитирует сообщения с event_type (Polymarket wire format).
    // parseWsMessage читает поле 'type', поэтому добавляем его явно при dispatch.
    this._router.on('orderbook', (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      void this._dispatchParsed({ ...(message as object), type: 'book' });
    });

    this._router.on('trade', (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      // parseWsMessage различит market trade и user fill по наличию taker_order_id
      void this._dispatchParsed({ ...(message as object), type: 'trade' });
    });

    // User channel: order lifecycle события (event_type: "order")
    this._router.on('order', (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      void this._dispatchParsed({ ...(message as object), type: 'order' });
    });

    this._router.on('error', (error: Error) => {
      this._logger.error('[PolymarketWsAdapter] Router error', {
        err: error,
      });
    });

    // События жизненного цикла
    this._client.on('connected', async () => {
      // Reconnect определяем по _hasEverConnected (не _isConnected, т.к. он сбрасывается при disconnect)
      const isReconnect = this._hasEverConnected;
      this._isConnected = true;
      this._hasEverConnected = true;

      if (isReconnect) {
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

    // WsUserFillDto не имеет поля 'type' — проверяем первым по наличию taker_order_id
    if ('taker_order_id' in dto) {
      await this._dispatchTo(this._onFill, dto as WsUserFillDto);
    } else if ('type' in dto && dto.type === 'book') {
      await this._dispatchTo(this._onSnapshot, dto as WsOrderbookSnapshotDto);
    } else if ('type' in dto && dto.type === 'trade') {
      await this._dispatchTo(this._onTrade, dto as WsTradeDto);
    } else if ('type' in dto && dto.type === 'order') {
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
   * Переподписывается на все tokens и user channel после reconnect.
   *
   * @remarks
   * Вызывается из события 'connected' клиента.
   * Если нет подписанных tokens И нет user channel — ничего не делает.
   */
  private async _resubscribeAll(): Promise<void> {
    if (this._isDestroyed) return;

    const hasMarket = this._subscribedTokens.size > 0;
    const hasUser = this._userChannelConfig !== null;

    if (!hasMarket && !hasUser) return;

    this._logger.info('[PolymarketWsAdapter] Resubscribing', {
      tokenCount: this._subscribedTokens.size,
      hasUserChannel: hasUser,
    });

    if (hasMarket) await this._sendAllSubscriptions();
    if (hasUser) await this._sendUserChannelSubscription();
  }

  /**
   * Отправляет WS-подписку для всех tracked tokens (market channel).
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

      this._logger.debug('[PolymarketWsAdapter] Market subscription sent', {
        tokenCount: tokens.length,
      });
    } catch (err) {
      if (!this._isDestroyed) {
        this._logger.error('[PolymarketWsAdapter] Failed to send market subscriptions', {
          err: err instanceof Error ? err : new Error(String(err)),
          tokenCount: tokens.length,
        });
      }
    }
  }

  /**
   * Отправляет WS-подписку на user channel с аутентификацией.
   *
   * @remarks
   * User channel subscription format:
   * ```json
   * { "type": "user", "auth": { "apiKey": "...", "secret": "...", "passphrase": "..." } }
   * ```
   * Получает fills (event_type: "trade" с taker_order_id) и order lifecycle (event_type: "order").
   */
  private async _sendUserChannelSubscription(): Promise<void> {
    if (this._isDestroyed || !this._userChannelConfig) return;

    const { apiKey, secret, passphrase } = this._userChannelConfig;

    try {
      await this._client.reconnectWithTimeout(10_000);

      const params: SubscriptionParams = {
        type: 'user',
        auth: { apiKey, secret, passphrase },
      };

      await this._client.subscribe('user', params);

      this._logger.debug('[PolymarketWsAdapter] User channel subscription sent');
    } catch (err) {
      if (!this._isDestroyed) {
        this._logger.error('[PolymarketWsAdapter] Failed to send user channel subscription', {
          err: err instanceof Error ? err : new Error(String(err)),
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
