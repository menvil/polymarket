/**
 * RTDS WebSocket клиент для реал-тайм крипто-цен Polymarket.
 *
 * @remarks
 * ### Протокол:
 * - Endpoint: `wss://ws-live-data.polymarket.com`
 * - PING text-frame каждые 5 секунд (сервер ожидает — иначе disconnect)
 * - Сообщения: `{ topic, type, timestamp, payload: { symbol, value, timestamp } }`
 * - Подписки аддитивные: каждый subscribe/unsubscribe добавляет/удаляет
 *
 * ### Topics и форматы подписок:
 * - `crypto_prices` (Binance): type `"update"`, filters comma-separated `"btcusdt,ethusdt"`
 * - `crypto_prices_chainlink` (Chainlink): type `"*"`, filters `""` (все) или JSON `'{"symbol":"btc/usd"}'`
 *
 * ### Standalone класс:
 * НЕ наследует BaseWebSocketTransport — RTDS использует другой протокол
 * (text frames, PING heartbeat, JSON subscribe/unsubscribe).
 *
 * @example
 * ```typescript
 * const client = new RtdsWebSocketClient(
 *   { url: 'wss://ws-live-data.polymarket.com' },
 *   logger,
 * );
 * await client.connect();
 * client.subscribe('crypto_prices', 'btcusdt');
 * const unsub = client.onPrice((symbol, price, ts) => {
 *   console.log(`${symbol}: $${price}`);
 * });
 *
 * // Позже:
 * unsub();
 * client.disconnect();
 * ```
 */

import type { ILogger } from '@polymarket/logger';

/**
 * Конфигурация RTDS клиента.
 *
 * @param url - WebSocket URL (e.g. 'wss://ws-live-data.polymarket.com')
 */
export interface RtdsConfig {
  readonly url: string;
  /** Максимальный возраст активной RTDS подписки без обновлений перед resubscribe. Default: 30000. */
  readonly staleMs?: number;
  /** Интервал проверки активных RTDS подписок на staleness. Default: 5000. */
  readonly staleCheckIntervalMs?: number;
}

/**
 * Callback для получения ценовых обновлений.
 */
type PriceCallback = (symbol: string, price: number, timestampMs: number) => void;

function splitSubscriptionKey(key: string): readonly [string, string] {
  const idx = key.indexOf(':');
  if (idx < 0) return [key, ''];
  return [key.slice(0, idx), key.slice(idx + 1)];
}

/**
 * RTDS WebSocket клиент.
 *
 * @remarks
 * Auto-reconnect с exponential backoff (1s → 30s).
 * Кэш подписок для восстановления после reconnect.
 */
export class RtdsWebSocketClient {
  private readonly _logger: ILogger;
  private readonly _url: string;
  private readonly _staleMs: number;
  private readonly _staleCheckIntervalMs: number;
  private _ws: WebSocket | null = null;
  private _connected = false;
  private _intentionalClose = false;
  private _pingInterval: ReturnType<typeof setInterval> | null = null;
  private _staleInterval: ReturnType<typeof setInterval> | null = null;
  private _reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private _reconnectDelay = 1000;

  /** Кэш активных подписок: Set<'topic:filter'> (для трекинга, фильтрация в коде caller'а) */
  private readonly _subscriptions = new Set<string>();
  /** Активные topic'и с subscribe на RTDS: topic → true если подписка отправлена */
  private readonly _activeTopics = new Set<string>();
  /** Callback'и на ценовые обновления */
  private readonly _priceCallbacks: PriceCallback[] = [];
  /** Счётчик сообщений для отладочного логирования */
  private _messageCount = 0;
  /** Дедупликация: symbol → последний emitted timestamp+price */
  private readonly _lastEmitted = new Map<string, { ts: number; price: number }>();
  /** Время последнего обновления по активной подписке: topic:filter → local timestamp ms */
  private readonly _lastSeenBySubscription = new Map<string, number>();
  /** Кол-во последовательных stale-срабатываний по подписке. */
  private readonly _staleCountsBySubscription = new Map<string, number>();
  /** Cooldown resubscribe на topic, чтобы stale watchdog не спамил RTDS. */
  private readonly _lastTopicRestartMs = new Map<string, number>();

  /**
   * Создаёт RtdsWebSocketClient.
   *
   * @param config - Конфигурация (url)
   * @param logger - Логгер
   */
  constructor(config: RtdsConfig, logger: ILogger) {
    this._url = config.url;
    this._staleMs = config.staleMs ?? 30_000;
    this._staleCheckIntervalMs = config.staleCheckIntervalMs ?? 5_000;
    this._logger = logger.child({ component: 'RtdsWebSocketClient' });
  }

  /**
   * Подключается к RTDS WebSocket.
   *
   * @returns Promise, разрешается после установки соединения
   *
   * @remarks
   * При ошибке подключения — автоматический reconnect.
   */
  async connect(): Promise<void> {
    if (this._connected) return;
    this._intentionalClose = false;

    return new Promise<void>((resolve, reject) => {
      try {
        this._ws = new WebSocket(this._url);

        this._ws.addEventListener('open', () => {
          this._connected = true;
          this._reconnectDelay = 1000;
          this._logger.info('RTDS WebSocket connected', { url: this._url });

          // Запускаем PING heartbeat
          this._startPing();
          this._startStaleWatchdog();

          // Восстанавливаем все подписки после reconnect одним сообщением
          this._sendSubscribeAll();

          resolve();
        });

        this._ws.addEventListener('message', (event) => {
          this._handleMessage(event.data as string);
        });

        this._ws.addEventListener('close', () => {
          this._connected = false;
          this._stopPing();
          this._stopStaleWatchdog();

          if (!this._intentionalClose) {
            this._logger.warn('RTDS WebSocket disconnected, scheduling reconnect', {
              delayMs: this._reconnectDelay,
            });
            this._scheduleReconnect();
          }
        });

        this._ws.addEventListener('error', (event) => {
          // ErrorEvent (browser/Node) имеет .message, обычный Event — нет
          const errMsg = 'message' in event ? String((event as { message: unknown }).message) : 'WebSocket error';
          this._logger.error('RTDS WebSocket error', { error: errMsg });
          if (!this._connected) {
            reject(new Error(`RTDS WebSocket connection failed: ${errMsg}`));
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Отключается от RTDS WebSocket.
   *
   * @remarks
   * Останавливает PING heartbeat, не запускает reconnect.
   */
  disconnect(): void {
    this._intentionalClose = true;
    this._stopPing();
    this._stopStaleWatchdog();

    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;
    }

    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }

    this._connected = false;
    this._lastEmitted.clear();
    this._lastSeenBySubscription.clear();
    this._staleCountsBySubscription.clear();
    this._logger.info('RTDS WebSocket disconnected intentionally');
  }

  /**
   * Подписывается на ценовые обновления символа.
   *
   * @param topic - RTDS topic (e.g. 'crypto_prices', 'crypto_prices_chainlink')
   * @param filter - Фильтр символа (e.g. 'btcusdt', 'btc/usd')
   *
   * @remarks
   * Подписка кэшируется для восстановления после reconnect.
   * Если WS подключён — отправляет subscribe немедленно.
   */
  subscribe(topic: string, filter: string): void {
    const key = `${topic}:${filter}`;
    if (this._subscriptions.has(key)) return;
    this._subscriptions.add(key);
    this._lastSeenBySubscription.set(key, Date.now());

    // Подписываемся на topic целиком (без фильтров) при первом символе на этом topic.
    // RTDS не поддерживает per-symbol фильтры для ongoing updates —
    // фильтрация по нужным символам происходит в onPrice callback caller'а.
    if (this._connected && this._ws && !this._activeTopics.has(topic)) {
      this._sendTopicSubscribe(topic);
      this._activeTopics.add(topic);
    }

    this._logger.debug('RTDS subscription added', { topic, filter });
  }

  /**
   * Отписывается от ценовых обновлений символа.
   *
   * @param topic - RTDS topic
   * @param filter - Фильтр символа
   *
   * @remarks
   * Unsubscribe от RTDS topic отправляется только когда на нём не осталось ни одного символа.
   */
  unsubscribe(topic: string, filter: string): void {
    const key = `${topic}:${filter}`;
    this._subscriptions.delete(key);
    this._lastSeenBySubscription.delete(key);
    this._staleCountsBySubscription.delete(key);

    // Если на topic не осталось подписок — отписываемся от RTDS
    const hasTopicLeft = [...this._subscriptions].some((k) => k.startsWith(`${topic}:`));
    if (!hasTopicLeft && this._connected && this._ws && this._activeTopics.has(topic)) {
      this._sendTopicUnsubscribe(topic);
      this._activeTopics.delete(topic);
    }

    // Очищаем дедупликацию для отписанного символа
    this._lastEmitted.delete(filter);

    this._logger.debug('RTDS subscription removed', { topic, filter });
  }

  /**
   * Регистрирует callback для ценовых обновлений.
   *
   * @param cb - Callback: (symbol, price, timestampMs) → void
   * @returns Функция отписки
   */
  onPrice(cb: PriceCallback): () => void {
    this._priceCallbacks.push(cb);
    return () => {
      const idx = this._priceCallbacks.indexOf(cb);
      if (idx >= 0) this._priceCallbacks.splice(idx, 1);
    };
  }

  // ── Внутренние методы ────────────────────────────────────────────────────

  /**
   * Обрабатывает входящее сообщение.
   *
   * @remarks
   * Символ всегда берётся из `payload.symbol` — это единственный надёжный
   * способ определить актив при множественных подписках на один topic.
   *
   * Поддерживаемые форматы:
   * - Batch (subscribe response): `{ payload: { data: [...], symbol: "btc/usd" } }`
   * - Update: `{ payload: { symbol: "btc/usd", value: 70000, timestamp: ... } }`
   */
  private _handleMessage(data: string): void {
    // Игнорируем пустые строки и PONG ответы
    if (!data || data === 'pong' || data === 'PONG') return;

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return; // молча игнорируем непарсящиеся фреймы (keepalive и т.п.)
    }

    // Логируем первые несколько сообщений для отладки формата
    if (this._messageCount < 10) {
      this._logger.info('RTDS message', {
        topic: msg['topic'],
        type: msg['type'],
        keys: Object.keys(msg).join(','),
        payloadKeys: msg['payload'] ? Object.keys(msg['payload'] as object).join(',') : '-',
        data: data.slice(0, 300),
      });
      this._messageCount++;
    }

    const payload = msg['payload'] as Record<string, unknown> | undefined;
    if (!payload) return;

    // Символ всегда из payload — надёжно при множественных подписках
    const symbol = payload['symbol'] as string | undefined;
    if (!symbol) return;

    // Формат 1: payload.data — массив [{timestamp, value}, ...] (batch при subscribe)
    const dataArr = payload['data'] as Array<{ timestamp?: number; value?: number | string }> | undefined;
    if (Array.isArray(dataArr) && dataArr.length > 0) {
      const lastPoint = dataArr[dataArr.length - 1]!;
      const price = Number(lastPoint.value);
      const timestampMs = Number(lastPoint.timestamp ?? Date.now());

      if (Number.isNaN(price)) return;
      this._emitPrice(String(msg['topic'] ?? ''), symbol, price, timestampMs);
      return;
    }

    // Формат 2: payload.value (одиночное обновление)
    const rawValue = payload['value'] ?? payload['price'];
    if (rawValue !== undefined) {
      const price = Number(rawValue);
      const timestampMs = Number(payload['timestamp'] ?? msg['timestamp'] ?? Date.now());
      if (Number.isNaN(price)) return;
      this._emitPrice(String(msg['topic'] ?? ''), symbol, price, timestampMs);
    }
  }

  /**
   * Отправляет ценовое обновление во все callback'и.
   *
   * @remarks
   * Дедупликация: пропускает события с тем же symbol+ts+price.
   * Каждый `_sendSubscribeAll()` вызывает batch-ответ RTDS с последними ценами,
   * при N параллельных рынках одного актива это N одинаковых batch'ей.
   */
  private _emitPrice(topic: string, symbol: string, price: number, timestampMs: number): void {
    const subscriptionKey = `${topic}:${symbol}`;
    if (this._subscriptions.has(subscriptionKey)) {
      this._lastSeenBySubscription.set(subscriptionKey, Date.now());
      this._staleCountsBySubscription.delete(subscriptionKey);
    }

    const last = this._lastEmitted.get(symbol);
    if (last && last.ts === timestampMs && last.price === price) return;
    this._lastEmitted.set(symbol, { ts: timestampMs, price });

    for (const cb of this._priceCallbacks) {
      try {
        cb(symbol, price, timestampMs);
      } catch (err) {
        this._logger.error('RTDS price callback error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Подписывается на RTDS topic целиком (без per-symbol фильтров).
   *
   * @remarks
   * Тест показал: RTDS поддерживает ТОЛЬКО подписку на ALL symbols per topic.
   * Per-symbol фильтры (comma-separated, JSON) ломают подписку целиком (0 сообщений).
   * Рабочий формат:
   * - Binance: `{ topic: "crypto_prices", type: "update" }` (без filters)
   * - Chainlink: `{ topic: "crypto_prices_chainlink", type: "*", filters: "" }`
   *
   * Фильтрация по нужным символам происходит на стороне caller'а через symbolToTokenIds.
   */
  private _sendTopicSubscribe(topic: string): void {
    const sub = topic === 'crypto_prices'
      ? { topic, type: 'update' }
      : { topic, type: '*', filters: '' };

    this._send(JSON.stringify({ action: 'subscribe', subscriptions: [sub] }));
    this._logger.info('RTDS topic subscribed (all symbols)', { topic });
  }

  /**
   * Отписывается от RTDS topic целиком.
   */
  private _sendTopicUnsubscribe(topic: string): void {
    const sub = topic === 'crypto_prices'
      ? { topic, type: 'update' }
      : { topic, type: '*', filters: '' };

    this._send(JSON.stringify({ action: 'unsubscribe', subscriptions: [sub] }));
    this._logger.info('RTDS topic unsubscribed', { topic });
  }

  /**
   * Восстанавливает подписки после reconnect.
   *
   * @remarks
   * Определяет уникальные topic'и из кэша и подписывается на каждый целиком.
   */
  private _sendSubscribeAll(): void {
    if (this._subscriptions.size === 0) return;

    // Собираем уникальные topic'и
    const topics = new Set<string>();
    for (const key of this._subscriptions) {
      const [topic] = key.split(':', 2);
      if (topic) topics.add(topic);
    }

    this._activeTopics.clear();
    for (const topic of topics) {
      this._sendTopicSubscribe(topic);
      this._activeTopics.add(topic);
    }

    this._logger.debug('RTDS resubscribed after reconnect', {
      topics: [...topics].join(', '),
      subscriptionCount: this._subscriptions.size,
    });
  }

  /**
   * Отправляет данные через WS.
   */
  private _send(data: string): void {
    if (this._ws && this._connected) {
      try {
        this._ws.send(data);
      } catch (err) {
        this._logger.error('RTDS send error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Запускает PING heartbeat каждые 5 секунд.
   */
  private _startPing(): void {
    this._stopPing();
    this._pingInterval = setInterval(() => {
      this._send('ping');
    }, 5000);
    this._pingInterval.unref();
  }

  /**
   * Останавливает PING heartbeat.
   */
  private _stopPing(): void {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  /**
   * Следит за активными RTDS подписками и перезапускает topic, если конкретный
   * symbol/filter давно не получал обновлений. Это защищает от случая, когда
   * WebSocket жив, но Chainlink topic или отдельный symbol перестал обновляться.
   */
  private _startStaleWatchdog(): void {
    this._stopStaleWatchdog();
    this._staleInterval = setInterval(() => {
      if (!this._connected || this._subscriptions.size === 0) return;

      const now = Date.now();
      for (const key of this._subscriptions) {
        const lastSeenMs = this._lastSeenBySubscription.get(key) ?? 0;
        const ageMs = now - lastSeenMs;
        if (ageMs <= this._staleMs) continue;

        const [topic, filter] = splitSubscriptionKey(key);
        if (!topic) continue;

        this._logger.warn('RTDS subscription stale, resubscribing topic', {
          topic,
          filter,
          ageMs,
          staleMs: this._staleMs,
        });
        const staleCount = (this._staleCountsBySubscription.get(key) ?? 0) + 1;
        this._staleCountsBySubscription.set(key, staleCount);
        if (staleCount >= 2) {
          this._forceReconnect('subscription_stale_after_resubscribe', {
            topic,
            filter,
            ageMs,
            staleMs: this._staleMs,
            staleCount,
          });
          return;
        }

        this._restartTopicSubscription(topic);
        this._lastSeenBySubscription.set(key, now);
      }
    }, this._staleCheckIntervalMs);
    this._staleInterval.unref();
  }

  private _stopStaleWatchdog(): void {
    if (this._staleInterval) {
      clearInterval(this._staleInterval);
      this._staleInterval = null;
    }
  }

  private _restartTopicSubscription(topic: string): void {
    const now = Date.now();
    const lastRestartMs = this._lastTopicRestartMs.get(topic) ?? 0;
    if (now - lastRestartMs < this._staleMs) return;
    this._lastTopicRestartMs.set(topic, now);

    this._sendTopicUnsubscribe(topic);
    this._sendTopicSubscribe(topic);
  }

  private _forceReconnect(reason: string, context: Record<string, unknown>): void {
    if (!this._connected || !this._ws) return;
    this._logger.warn('RTDS forcing reconnect', { reason, ...context });
    try {
      this._ws.close();
    } catch (err) {
      this._logger.error('RTDS force reconnect close error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Планирует reconnect с exponential backoff.
   */
  private _scheduleReconnect(): void {
    if (this._intentionalClose) return;

    this._reconnectTimeout = setTimeout(() => {
      this._reconnectTimeout = null;
      this._logger.info('RTDS: attempting reconnect...', { delayMs: this._reconnectDelay });
      void this.connect().catch((err) => {
        this._logger.error('RTDS reconnect failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this._reconnectDelay);
    this._reconnectTimeout.unref();

    // Exponential backoff: 1s → 2s → 4s → ... → 30s max
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30_000);
  }
}
