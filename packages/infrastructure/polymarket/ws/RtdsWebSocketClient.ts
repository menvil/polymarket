/**
 * RTDS WebSocket клиент для реал-тайм крипто-цен Polymarket.
 *
 * @remarks
 * ### Протокол:
 * - Endpoint: `wss://ws-live-data.polymarket.com`
 * - Формат подписки: `{ type: 'subscribe', topic: 'crypto_prices', filter: 'btcusdt' }`
 * - Формат отписки: `{ type: 'unsubscribe', topic: 'crypto_prices', filter: 'btcusdt' }`
 * - PING text-frame каждые 5 секунд (сервер ожидает — иначе disconnect)
 * - Сообщения: `{ topic, type, payload: { symbol, value, timestamp } }`
 *
 * ### Topics:
 * - `crypto_prices` — Binance source (btcusdt, ethusdt, ...)
 * - `crypto_prices_chainlink` — Chainlink source (btc/usd, eth/usd, ...)
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
}

/**
 * Callback для получения ценовых обновлений.
 */
type PriceCallback = (symbol: string, price: number, timestampMs: number) => void;

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
  private _ws: WebSocket | null = null;
  private _connected = false;
  private _intentionalClose = false;
  private _pingInterval: ReturnType<typeof setInterval> | null = null;
  private _reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private _reconnectDelay = 1000;

  /** Кэш активных подписок: Set<'topic:filter'> */
  private readonly _subscriptions = new Set<string>();
  /** Callback'и на ценовые обновления */
  private readonly _priceCallbacks: PriceCallback[] = [];
  /** Счётчик сообщений для отладочного логирования */
  private _messageCount = 0;

  /**
   * Создаёт RtdsWebSocketClient.
   *
   * @param config - Конфигурация (url)
   * @param logger - Логгер
   */
  constructor(config: RtdsConfig, logger: ILogger) {
    this._url = config.url;
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

    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;
    }

    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }

    this._connected = false;
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
    this._subscriptions.add(key);

    if (this._connected && this._ws) {
      // RTDS заменяет ВСЕ подписки при каждом subscribe.
      // Отправляем полный набор подписок (все topic + filter) в одном сообщении.
      this._sendSubscribeAll();
    }

    this._logger.debug('RTDS subscription added', { topic, filter });
  }

  /**
   * Отписывается от ценовых обновлений символа.
   *
   * @param topic - RTDS topic
   * @param filter - Фильтр символа
   */
  unsubscribe(topic: string, filter: string): void {
    const key = `${topic}:${filter}`;
    this._subscriptions.delete(key);

    if (this._connected && this._ws) {
      // Переподписываем оставшиеся (RTDS заменяет всё целиком)
      if (this._subscriptions.size > 0) {
        this._sendSubscribeAll();
      } else {
        this._sendUnsubscribe(topic, filter);
      }
    }

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
      this._emitPrice(symbol, price, timestampMs);
      return;
    }

    // Формат 2: payload.value (одиночное обновление)
    const rawValue = payload['value'] ?? payload['price'];
    if (rawValue !== undefined) {
      const price = Number(rawValue);
      const timestampMs = Number(payload['timestamp'] ?? msg['timestamp'] ?? Date.now());
      if (Number.isNaN(price)) return;
      this._emitPrice(symbol, price, timestampMs);
    }
  }

  /**
   * Отправляет ценовое обновление во все callback'и.
   */
  private _emitPrice(symbol: string, price: number, timestampMs: number): void {
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
   * Отправляет subscribe для ВСЕХ активных подписок (все topic + filter) в одном сообщении.
   *
   * @remarks
   * RTDS заменяет ВСЕ подписки при каждом `action: 'subscribe'`.
   * Поэтому при добавлении нового символа надо переподписать всё целиком.
   */
  private _sendSubscribeAll(): void {
    if (this._subscriptions.size === 0) return;

    const subscriptions: Array<{ topic: string; type: string; filters: string }> = [];
    for (const key of this._subscriptions) {
      const [topic, filter] = key.split(':', 2);
      if (topic && filter) {
        subscriptions.push({
          topic,
          type: 'update',
          filters: JSON.stringify({ symbol: filter }),
        });
      }
    }

    this._send(JSON.stringify({ action: 'subscribe', subscriptions }));

    this._logger.debug('RTDS subscribed all', {
      count: subscriptions.length,
      keys: [...this._subscriptions].join(', '),
    });
  }

  /**
   * Отправляет unsubscribe сообщение в формате официального RTDS API.
   */
  private _sendUnsubscribe(topic: string, filter: string): void {
    this._send(JSON.stringify({
      action: 'unsubscribe',
      subscriptions: [{
        topic,
        type: 'update',
        filters: JSON.stringify({ symbol: filter }),
      }],
    }));
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
