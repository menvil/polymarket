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
 * ### Протокол подписки Polymarket:
 * Polymarket WS принимает ТОЛЬКО ОДНО subscription-сообщение на соединение.
 * Любое последующее сообщение на том же соединении возвращает INVALID OPERATION.
 * Поэтому изменение набора токенов требует полного переподключения:
 * `reconnectForNewSubscription()` очищает кэш, переподключается, затем
 * PolymarketWsAdapter посылает актуальный список токенов.
 *
 * ### Unsubscribe (истечение рынков):
 * `unsubscribeFromToken()` только удаляет токен из внутреннего set — НЕ посылает
 * subscription update на сервер. Сервер продолжает слать данные по удалённому токену,
 * но Adapter фильтрует их по `_subscribedTokens`. Controlled reconnect через 10 секунд
 * применяет актуальный полный список токенов на сервере.
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

const SUBSCRIPTION_ADD_RECONNECT_DEBOUNCE_MS = 500;
const SUBSCRIPTION_REFRESH_RECONNECT_DEBOUNCE_MS = 10_000;

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
  /** Подписчики на raw сообщения (оригинальный wire-format, до DTO-маппинга) */
  private readonly _onRawMessage = new Set<(tokenId: string, rawMsg: unknown) => void>();

  /** Отслеживает подписанные tokens для переподписки после reconnect */
  private readonly _subscribedTokens = new Set<string>();

  /** Конфигурация user channel (null = не подписаны на user channel) */
  private _userChannelConfig: UserChannelConfig | null = null;

  private _isConnected = false;
  private _isDestroyed = false;
  /** true после первого успешного подключения — используется для отличия reconnect от first connect */
  private _hasEverConnected = false;

  /**
   * Флаг: запланирован reconnect для смены подписки.
   *
   * @remarks
   * Дебаунс для `_reconnectForSubscription()`: несколько быстрых вызовов
   * `subscribeToToken()` (например, при открытии рынка с 2 токенами) коллапсируются
   * в один reconnect. Без этого флага каждый вызов инициировал бы отдельный reconnect.
   */
  private _reconnectForSubscriptionPending = false;

  /** Таймер дебаунса для subscription-change reconnect */
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Время последнего connect (для подавления INVALID OPERATION сразу после reconnect) */
  private _lastConnectMs = 0;

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

  /**
   * Подписывается на сырые рыночные сообщения в оригинальном wire-формате.
   *
   * @param cb - Callback: `tokenId` = `asset_id` из сообщения, `rawMsg` = JSON-объект
   * @returns Функция отписки
   *
   * @remarks
   * Вызывается ДО DTO-маппинга — содержит все оригинальные поля.
   * Используется DataRecorder в collect-data режиме.
   */
  onRawMessage(cb: (tokenId: string, rawMsg: unknown) => void): () => void {
    this._onRawMessage.add(cb);
    return () => this._onRawMessage.delete(cb);
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
   * Регистрирует tokenId для получения рыночных данных.
   *
   * @param tokenId - Token ID для подписки
   *
   * @remarks
   * Добавляет tokenId во внутренний set. Если адаптер уже был подключён ранее
   * (`_hasEverConnected = true`) и сейчас подключён — планирует reconnect
   * через `_scheduleReconnectForSubscription()`. При первом подключении токены
   * будут отправлены в `_resubscribeAll()` по событию 'connected'.
   *
   * Несколько последовательных вызовов (например, при открытии рынка с 2 токенами)
   * коллапсируются в один быстрый reconnect. Если уже запланирован delayed refresh
   * после unsubscribe, новый токен попадёт в тот же полный reconnect.
   *
   * ### Почему reconnect, а не subscription update:
   * Polymarket WS принимает только ОДНО subscription-сообщение на соединение.
   * Любое последующее сообщение возвращает INVALID OPERATION.
   * Единственный способ изменить подписку — переподключиться.
   */
  async subscribeToToken(tokenId: string): Promise<void> {
    this._checkDestroyed();
    const wasNew = !this._subscribedTokens.has(tokenId);
    this._subscribedTokens.add(tokenId);
    if (wasNew && this._hasEverConnected && this._isConnected) {
      this._scheduleReconnectForSubscription();
    }
  }

  /**
   * Убирает tokenId из набора отслеживаемых токенов.
   *
   * @param tokenId - Token ID для отписки
   *
   * @remarks
   * Удаляет tokenId из внутреннего set, но НЕ инициирует reconnect.
   * Сервер продолжит слать данные по удалённому токену до controlled reconnect;
   * локально эти сообщения фильтруются по `_subscribedTokens`.
   */
  async unsubscribeFromToken(tokenId: string): Promise<void> {
    this._checkDestroyed();
    const wasDeleted = this._subscribedTokens.delete(tokenId);
    if (wasDeleted && this._hasEverConnected && this._isConnected) {
      this._scheduleReconnectForSubscription(
        SUBSCRIPTION_REFRESH_RECONNECT_DEBOUNCE_MS,
        'token_unsubscribed',
      );
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

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

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
    this._client.removeAllListeners();
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

    // Router эмитирует 'raw' для всех data-сообщений ДО типизированного роутинга.
    // Это оригинальный wire-format с event_type, asset_id, last_trade_price и т.д.
    this._router.on('raw', (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const tokenId = (message as Record<string, unknown>)['asset_id'];
      if (typeof tokenId === 'string' && tokenId.length > 0) {
        // Игнорируем данные от unsubscribed токенов.
        // После unsubscribeFromToken сервер продолжает слать данные
        // до следующего reconnect — фильтруем их здесь.
        if (!this._subscribedTokens.has(tokenId)) return;
        for (const cb of this._onRawMessage) {
          cb(tokenId, message);
        }
      }
    });

    // Router эмитирует сообщения с event_type (Polymarket wire format).
    // parseWsMessage читает поле 'type', поэтому добавляем его явно при dispatch.
    this._router.on('orderbook', (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      // Фильтруем по _subscribedTokens
      const tokenId = (message as Record<string, unknown>)['asset_id'];
      if (typeof tokenId === 'string' && !this._subscribedTokens.has(tokenId)) return;
      void this._dispatchParsed({ ...(message as object), type: 'book' });
    });

    this._router.on('trade', (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      // Фильтруем market trades по _subscribedTokens, но пропускаем user fills.
      // User fills (из user channel) имеют taker_order_id — не фильтруем их,
      // т.к. user WS не имеет subscribedTokens.
      const msg = message as Record<string, unknown>;
      const tokenId = msg['asset_id'];
      const isUserFill = 'taker_order_id' in msg;
      if (!isUserFill && typeof tokenId === 'string' && !this._subscribedTokens.has(tokenId)) return;
      void this._dispatchParsed({ ...(message as object), type: 'trade' });
    });

    // User channel: order lifecycle события (event_type: "order")
    // Polymarket использует поле 'type' для обозначения вида события (PLACEMENT, CANCELLATION, ...).
    // НО parseWsMessage использует 'type' как дискриминант для маршрутизации (type='order').
    // Поэтому сохраняем оригинальный 'type' в 'orderEventType' ДО того, как перезаписываем его.
    this._router.on('order', (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const msg = message as Record<string, unknown>;
      void this._dispatchParsed({
        ...msg,
        orderEventType: msg['type'],  // PLACEMENT / CANCELLATION — из wire-формата Polymarket
        type: 'order',                // дискриминант для parseWsMessage
      });
    });

    this._router.on('error', (error: Error) => {
      if (error.message === 'INVALID OPERATION') {
        // Polymarket отвечает INVALID OPERATION если subscription message отправлен
        // на уже существующем соединении (после первоначальной подписки).
        // Игнорируем в первые 3с после connect: user channel subscription
        // посылается ПОСЛЕ market subscription — это ожидаемый INVALID OPERATION.
        const msSinceConnect = Date.now() - this._lastConnectMs;
        if (msSinceConnect < 3000) {
          this._logger.debug('[PolymarketWsAdapter] INVALID OPERATION ignored (within 3s of connect, likely user channel)', {
            msSinceConnect,
          });
        } else if (this._isConnected && !this._reconnectForSubscriptionPending) {
          this._logger.warn('[PolymarketWsAdapter] Received INVALID OPERATION, scheduling reconnect', {
            tokenCount: this._subscribedTokens.size,
            reconnectPending: this._reconnectForSubscriptionPending,
          });
          this._scheduleReconnectForSubscription(
            SUBSCRIPTION_ADD_RECONNECT_DEBOUNCE_MS,
            'invalid_operation',
          );
        }
      } else {
        this._logger.error('[PolymarketWsAdapter] Router error', {
          err: error,
        });
      }
    });

    // Обязательно слушаем 'error' на клиенте — иначе Node.js упадёт при ошибке соединения
    this._client.on('error', (error: Error) => {
      this._logger.error('[PolymarketWsAdapter] Client error', {
        err: error,
      });
    });

    // События жизненного цикла
    this._client.on('connected', async () => {
      // Reconnect определяем по _hasEverConnected (не _isConnected, т.к. он сбрасывается при disconnect)
      const isReconnect = this._hasEverConnected;
      this._isConnected = true;
      this._hasEverConnected = true;
      this._lastConnectMs = Date.now();

      if (isReconnect) {
        // Reconnect — инвалидируем кэши стаканов у подписчиков
        this._logger.info('[PolymarketWsAdapter] Reconnected — dispatching onReconnect');
        this._dispatchReconnect();
      } else {
        this._logger.info('[PolymarketWsAdapter] Connected');
      }

      // Переподписываемся на все tokens
      try {
        await this._resubscribeAll(isReconnect);
      } catch (err) {
        this._logger.error('[PolymarketWsAdapter] Failed to resubscribe after connect', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    });

    this._client.on('disconnected', () => {
      if (!this._isConnected) {
        // Отложенный onclose старого WS после явного disconnect() — уже обработано.
        this._logger.debug('[PolymarketWsAdapter] Duplicate disconnected event (delayed WS onclose), ignoring');
        return;
      }
      this._isConnected = false;
      this._logger.info('[PolymarketWsAdapter] Disconnected');
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
   * Переподписывается на все tokens и user channel после connect/reconnect.
   *
   * @param isReconnect - `true` при реконнекте, `false` при первом подключении
   *
   * @remarks
   * ### Два сценария:
   *
   * **Первое подключение** (`isReconnect=false`):
   * BaseWebSocket кэш пуст → market channel посылаем здесь.
   *
   * **Любой reconnect** (`isReconnect=true`):
   * BaseWebSocket._resubscribeAll() уже послал подписку из кэша (вызывается в onopen
   * до emit('connected')). При subscription-change reconnect кэш был обновлён перед
   * переподключением → BaseWebSocket послал актуальный список токенов. Дублировать нельзя.
   *
   * User channel всегда посылаем здесь — BaseWebSocket его не кэширует корректно
   * при subscription-change reconnect (разные каналы не взаимодействуют).
   */
  private async _resubscribeAll(isReconnect: boolean): Promise<void> {
    if (this._isDestroyed) return;

    const hasMarket = this._subscribedTokens.size > 0;
    const hasUser = this._userChannelConfig !== null;

    if (!hasMarket && !hasUser) return;

    this._logger.info('[PolymarketWsAdapter] Resubscribing', {
      tokenCount: this._subscribedTokens.size,
      hasUserChannel: hasUser,
      isReconnect,
    });

    // При reconnect BaseWebSocket уже послал market subscription из кэша
    // (кэш обновлён в _reconnectForSubscription() прямо перед connect()).
    // При первом подключении кэш пуст — посылаем здесь.
    if (hasMarket && !isReconnect) await this._sendAllSubscriptions();
    if (hasUser) await this._sendUserChannelSubscription();
  }

  /**
   * Планирует reconnect для применения изменений подписки.
   *
   * @remarks
   * Несколько быстрых вызовов (открытие рынка с 2 токенами = 2 subscribeToToken за ~0ms)
   * коллапсируются в один reconnect. `_reconnectForSubscriptionPending` гарантирует
   * единственный запланированный reconnect в каждый момент времени.
   */
  private _scheduleReconnectForSubscription(
    delayMs = SUBSCRIPTION_ADD_RECONNECT_DEBOUNCE_MS,
    reason = 'subscription_changed',
  ): void {
    if (this._reconnectForSubscriptionPending) return;
    this._reconnectForSubscriptionPending = true;

    this._logger.info('[PolymarketWsAdapter] Scheduling subscription refresh reconnect', {
      delayMs,
      reason,
      tokenCount: this._subscribedTokens.size,
    });

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._isDestroyed) {
        this._reconnectForSubscriptionPending = false;
        return;
      }
      this._reconnectForSubscription().catch((err) => {
        this._logger.error('[PolymarketWsAdapter] Failed to reconnect for subscription change', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
        this._reconnectForSubscriptionPending = false;
      });
    }, delayMs);
  }

  /**
   * Выполняет reconnect для применения изменений в наборе подписанных токенов.
   *
   * @remarks
   * ### Алгоритм:
   * 1. `disconnect()` — корректно закрывает соединение, предотвращает auto-reconnect
   * 2. `await sleep(300ms)` — ждём пока `onclose` старого WS сработает до `connect()`
   *    (предотвращает race condition: `_handleClose()` после нового соединения)
   * 3. `subscribe('market', updatedTokens)` — обновляем кэш BaseWebSocket пока disconnected
   *    (BaseWebSocket не шлёт — status='disconnected')
   * 4. `connect()` — BaseWebSocket открывает новое соединение →
   *    `_resubscribeAll()` в onopen шлёт из обновлённого кэша (ОДИН send) → emit('connected')
   *
   * ### Почему не `reconnectForNewSubscription()`:
   * `PolymarketWebSocketManager.reconnectForNewSubscription()` переопределяет метод и
   * вызывает просто `disconnect() + connect()` БЕЗ очистки кэша. В результате
   * BaseWebSocket на reconnect шлёт старую подписку из кэша, а затем наш
   * `_resubscribeAll(isReconnect=true)` шлёт повторно → INVALID OPERATION.
   */
  private async _reconnectForSubscription(): Promise<void> {
    if (this._isDestroyed) {
      this._reconnectForSubscriptionPending = false;
      return;
    }

    // Если за время debounce (500ms) все токены были unsubscribed — reconnect не нужен.
    // Иначе BaseWebSocket отправил бы устаревший кэш рыночной подписки (удалённые токены),
    // Polymarket ответил бы INVALID OPERATION → бесконечный reconnect-цикл.
    if (this._subscribedTokens.size === 0) {
      this._logger.debug('[PolymarketWsAdapter] No tokens after debounce — skipping subscription-change reconnect');
      this._reconnectForSubscriptionPending = false;
      return;
    }

    this._logger.info('[PolymarketWsAdapter] Reconnecting to apply subscription changes', {
      tokenCount: this._subscribedTokens.size,
    });

    try {
      // Шаг 1: Корректное отключение (устанавливает _isShuttingDown=true, предотвращает auto-reconnect)
      await this._client.disconnect();

      // Шаг 2: Пауза чтобы onclose старого WebSocket сработал до нового connect()
      // Без паузы: _handleClose() может сработать ПОСЛЕ connect() и сбросить _status='disconnected'
      await new Promise<void>((r) => setTimeout(r, 300));

      if (this._isDestroyed) return;

      // Шаг 3+4: Обновляем кэш и подключаемся АТОМАРНО.
      // Захватываем _subscribedTokens прямо перед connect() чтобы включить
      // токены добавленные openMarket() во время disconnect/sleep окна.
      // Без этого: openMarket добавляет токен ПОСЛЕ cache update → BaseWebSocket
      // шлёт stale кэш → стратегия не получает данных.
      const currentTokens = Array.from(this._subscribedTokens);
      if (currentTokens.length > 0) {
        await this._client.subscribe('market', {
          assets_ids: currentTokens,
          type: 'market',
        });
      }

      // connect() → BaseWebSocket шлёт из только что обновлённого кэша
      await this._client.connect();

    } catch (err) {
      this._logger.error('[PolymarketWsAdapter] Reconnect for subscription change failed', {
        err: err instanceof Error ? err : new Error(String(err)),
        tokenCount: this._subscribedTokens.size,
      });
      // Гарантированный retry-connect через 3s — страховка на случай если BaseWebSocket
      // не запланирует reconnect самостоятельно (onclose не сработал при ошибке handshake).
      // Подписка уже обновлена в кэше BaseWebSocket — просто переподключаемся.
      if (!this._isDestroyed) {
        setTimeout(() => {
          if (this._isDestroyed || this._isConnected) return;
          this._logger.info('[PolymarketWsAdapter] Forcing reconnect after subscription-change failure', {
            tokenCount: this._subscribedTokens.size,
          });
          this._client.connect().catch((retryErr) => {
            this._logger.warn('[PolymarketWsAdapter] Forced reconnect also failed (BaseWebSocket will retry)', {
              err: retryErr instanceof Error ? retryErr.message : String(retryErr),
            });
          });
        }, 3_000);
      }
    } finally {
      this._reconnectForSubscriptionPending = false;
    }
  }

  /**
   * Отправляет WS-подписку для всех tracked tokens (market channel).
   *
   * @remarks
   * Polymarket WebSocket принимает subscription-сообщение только ОДИН РАЗ на соединение.
   * Вызывается из `_resubscribeAll()` — только при первом подключении или после
   * subscription-change reconnect (когда BaseWebSocket кэш был очищен).
   */
  private async _sendAllSubscriptions(): Promise<void> {
    if (this._isDestroyed || this._subscribedTokens.size === 0) return;

    const tokens = Array.from(this._subscribedTokens);

    const params: SubscriptionParams = {
      assets_ids: tokens,
      type: 'market',
    };

    this._logger.info('[PolymarketWsAdapter] Sending market subscription', {
      tokenCount: tokens.length,
    });

    try {
      await this._client.subscribe('market', params);

      this._logger.debug('[PolymarketWsAdapter] Market subscription sent successfully', {
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

    const params: SubscriptionParams = {
      type: 'user',
      auth: { apiKey, secret, passphrase },
    };

    try {
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
