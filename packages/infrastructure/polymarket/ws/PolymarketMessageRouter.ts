/**
 * PolymarketMessageRouter - Слой парсинга и роутинга сообщений
 *
 * @remarks
 * Чистый роутинг сообщений, предоставляющий:
 * - Парсинг JSON из WebSocket данных
 * - Обработка batch сообщений (массивов сообщений)
 * - Роутинг по типу события
 * - Типизированную эмиссию событий
 * - Никакой бизнес-логики или создания domain entities
 *
 * Ответственность:
 * - Парсинг raw WebSocket данных в JSON
 * - Обработка как одиночных сообщений, так и массивов
 * - Роутинг сообщений по event_type
 * - Эмиссия типизированных событий для каждого типа сообщений
 * - Graceful обработка ошибок парсинга
 *
 * НЕ отвечает за:
 * - Управление подписками (обрабатывается Registry)
 * - Создание domain entities (обрабатывается Adapter)
 * - Управление WebSocket соединением (обрабатывается PolymarketWsClient)
 *
 * @example
 * ```typescript
 * const router = new PolymarketMessageRouter(logger);
 *
 * // Слушаем распарсенные события
 * router.on('orderbook', (data) => {
 *   console.log('Orderbook:', data.asset_id, data.bids.length, data.asks.length);
 * });
 *
 * router.on('trade', (data) => {
 *   console.log('Trade:', data.asset_id, data.price, data.size);
 * });
 *
 * // Обрабатываем raw WebSocket данные
 * router.processRawData(rawWebSocketData);
 * ```
 */

import { EventEmitter } from 'events';
import type { ILogger } from '@polymarket/logger';

/**
 * Типы сообщений Polymarket WebSocket
 *
 * @remarks
 * Основаны на реальных ответах Polymarket WebSocket API
 */
export type PolymarketEventType =
  | 'book'              // Snapshot/update стакана
  | 'trade'             // Исполненная сделка (market channel) или fill (user channel)
  | 'order'             // Lifecycle событие ордера (user channel)
  | 'last_trade_price'  // Обновление цены последней сделки
  | 'pong'              // Ответ на heartbeat
  | 'error'             // Сообщение об ошибке
  | 'subscribed'        // Подтверждение подписки
  | 'unsubscribed'      // Подтверждение отписки
  | 'price_change'      // Уведомление об изменении цены (игнорируется)
  | 'tick_size_change'; // Изменение tick size (игнорируется)

/**
 * Базовое сообщение Polymarket WebSocket
 */
export interface PolymarketBaseMessage {
  /** Тип события от Polymarket */
  event_type: PolymarketEventType;
  /** Asset ID (token ID) - присутствует в data событиях */
  asset_id?: string;
  /** Альтернативное поле для asset ID в некоторых сообщениях */
  market?: string;
  /** Timestamp (миллисекунды) */
  timestamp?: number;
}

/**
 * Сообщение orderbook от Polymarket
 *
 * @example
 * ```typescript
 * {
 *   event_type: 'book',
 *   asset_id: '67704255197116168826604911233626301865010283966205730455742704536521111535950',
 *   bids: [{price: '0.52', size: '100'}, {price: '0.51', size: '200'}],
 *   asks: [{price: '0.53', size: '150'}, {price: '0.54', size: '250'}],
 *   timestamp: 1766875759895
 * }
 * ```
 */
export interface PolymarketOrderbookMessage extends PolymarketBaseMessage {
  event_type: 'book';
  asset_id: string;
  /** Уровни bid: [{price: '0.52', size: '100'}, ...] */
  bids: Array<{ price: string; size: string }>;
  /** Уровни ask: [{price: '0.53', size: '150'}, ...] */
  asks: Array<{ price: string; size: string }>;
  timestamp: number;
}

/**
 * Сообщение о сделке от Polymarket
 *
 * @example
 * ```typescript
 * {
 *   event_type: 'trade',
 *   asset_id: '67704255197116168826604911233626301865010283966205730455742704536521111535950',
 *   price: '0.52',
 *   size: '50',
 *   side: 'BUY',
 *   timestamp: 1766875759895
 * }
 * ```
 */
export interface PolymarketTradeMessage extends PolymarketBaseMessage {
  event_type: 'trade' | 'last_trade_price';
  asset_id: string;
  /** Цена сделки в виде строки */
  price: string;
  /** Размер сделки в виде строки */
  size: string;
  /** Сторона сделки (BUY или SELL) - может отсутствовать в last_trade_price */
  side?: 'BUY' | 'SELL';
  timestamp?: number;
}

/**
 * Контрольное сообщение от Polymarket (pong, error, subscribed, и т.д.)
 */
export interface PolymarketControlMessage extends PolymarketBaseMessage {
  event_type: 'pong' | 'error' | 'subscribed' | 'unsubscribed' | 'price_change' | 'tick_size_change';
  /** Детали ошибки/подписки */
  message?: string;
  data?: unknown;
  channel?: string;
  params?: unknown;
}

/**
 * Union тип для всех сообщений Polymarket
 */
export type PolymarketMessage =
  | PolymarketOrderbookMessage
  | PolymarketTradeMessage
  | PolymarketControlMessage;

/**
 * Типы событий Router
 *
 * @remarks
 * События, эмитируемые router для разных типов сообщений
 */
export type RouterEvent =
  | 'orderbook'     // Обновление orderbook (book)
  | 'trade'         // Обновление trade (trade или last_trade_price)
  | 'order'         // Lifecycle событие ордера из user channel (event_type: "order")
  | 'message'       // Все сообщения (до роутинга)
  | 'raw'           // Data события с asset_id (до роутинга)
  | 'error'         // Ошибки парсинга или WebSocket
  | 'pong'          // Ответ на heartbeat
  | 'subscribed'    // Подписка подтверждена
  | 'unsubscribed'; // Отписка подтверждена

/**
 * Статистика Router
 */
export interface RouterStats {
  /** Всего обработано сообщений */
  totalMessages: number;
  /** Всего сообщений orderbook */
  orderbookMessages: number;
  /** Всего сообщений trade */
  tradeMessages: number;
  /** Всего order lifecycle сообщений из user channel */
  orderMessages: number;
  /** Всего ошибок парсинга */
  parsingErrors: number;
  /** Всего batch сообщений (массивов) */
  batchMessages: number;
  /** Всего пропущено контрольных сообщений */
  skippedMessages: number;
}

/**
 * PolymarketMessageRouter
 *
 * @remarks
 * Чистый слой парсинга и роутинга сообщений.
 * Наследует EventEmitter для чистого event-based API.
 *
 * Принципы дизайна:
 * 1. **Никакой бизнес-логики**: Только парсинг и роутинг
 * 2. **Типобезопасные события**: Строгая типизация для всех эмитируемых данных
 * 3. **Поддержка batch**: Обработка как одиночных, так и массивов сообщений
 * 4. **Устойчивость к ошибкам**: Graceful обработка ошибок
 */
export class PolymarketMessageRouter extends EventEmitter {
  private readonly logger: ILogger;
  private stats: RouterStats;

  /**
   * Создаёт PolymarketMessageRouter
   *
   * @param logger - Logger для операций router
   *
   * @throws {Error} Если logger равен null
   *
   * @example
   * ```typescript
   * const router = new PolymarketMessageRouter(logger);
   * ```
   */
  constructor(logger: ILogger) {
    super();

    if (!logger) {
      throw new Error('logger is required');
    }

    this.logger = logger.child ? logger.child('PolymarketMessageRouter') : logger;
    this.stats = {
      totalMessages: 0,
      orderbookMessages: 0,
      tradeMessages: 0,
      orderMessages: 0,
      parsingErrors: 0,
      batchMessages: 0,
      skippedMessages: 0,
    };
  }

  /**
   * Обрабатывает raw WebSocket данные
   *
   * @param data - Raw данные из WebSocket (Buffer или string)
   *
   * @remarks
   * Алгоритм:
   * 1. Конвертировать данные в строку
   * 2. Обработать пустые сообщения (heartbeat)
   * 3. Распарсить JSON
   * 4. Если массив → обработать каждый элемент (batch)
   * 5. Если объект → обработать одиночное сообщение
   * 6. Gracefully обработать ошибки парсинга
   *
   * @example
   * ```typescript
   * // Одиночное сообщение
   * router.processRawData('{"event_type":"book","asset_id":"...","bids":[],"asks":[]}');
   *
   * // Batch сообщения
   * router.processRawData('[{"event_type":"book",...},{"event_type":"trade",...}]');
   *
   * // Пустой heartbeat
   * router.processRawData('');
   * ```
   */
  public processRawData(data: Buffer | string): void {
    try {
      const rawData = data.toString().trim();

      // Пропускаем пустые сообщения (heartbeat)
      if (rawData === '') {
        this.logger.trace('Skipping empty heartbeat message');
        return;
      }

      // Парсим JSON
      const parsed = JSON.parse(rawData);

      // Обрабатываем batch сообщения (массивы)
      if (Array.isArray(parsed)) {
        this.stats.batchMessages++;
        this.logger.debug('Processing batch message', { count: parsed.length });

        for (const message of parsed) {
          this.processMessage(message);
        }
      } else {
        // Одиночное сообщение
        this.processMessage(parsed);
      }
    } catch (error) {
      this.stats.parsingErrors++;
      const rawData = data.toString().trim();

      // Известные ошибки Polymarket - логируем как warning
      const knownErrors = ['INVALID OPERATION', 'RATE_LIMIT', 'UNAUTHORIZED'];
      const isKnownError = knownErrors.some(e => rawData.includes(e));

      if (isKnownError) {
        this.logger.error('Polymarket WebSocket error', {
          errorMessage: rawData,
          hint: 'Check subscription format or API changes'
        });
        this.emit('error', new Error(rawData));
      } else {
        this.logger.error('Failed to parse WebSocket message', {
          err: error instanceof Error ? error : new Error(String(error)),
          rawData: rawData.substring(0, 200),
        });
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * Обрабатывает одиночное распарсенное сообщение
   *
   * @param message - Распарсенное JSON сообщение
   *
   * @remarks
   * Алгоритм:
   * 1. Эмитировать generic 'message' событие
   * 2. Извлечь event_type и asset_id
   * 3. Роутить контрольные сообщения (pong, error, subscribed, и т.д.)
   * 4. Пропустить игнорируемые сообщения (price_change, tick_size_change)
   * 5. Валидировать что data сообщения имеют asset_id
   * 6. Эмитировать 'raw' событие для data сообщений
   * 7. Роутить по event_type (book → orderbook, trade → trade)
   *
   * Типы сообщений:
   * - **book**: Обновление orderbook → emit('orderbook', message)
   * - **trade/last_trade_price**: Обновление trade → emit('trade', message)
   * - **pong**: Heartbeat → emit('pong')
   * - **error**: Ошибка → emit('error', Error)
   * - **subscribed/unsubscribed**: Событие подписки → emit(eventType)
   * - **price_change/tick_size_change**: Игнорируется (логируется как trace)
   *
   * @example
   * ```typescript
   * // Orderbook
   * router.processMessage({
   *   event_type: 'book',
   *   asset_id: '123...',
   *   bids: [{price: '0.5', size: '100'}],
   *   asks: [{price: '0.6', size: '100'}],
   *   timestamp: 1234567890
   * });
   * // → emit('message', ...), emit('raw', ...), emit('orderbook', ...)
   *
   * // Trade
   * router.processMessage({
   *   event_type: 'trade',
   *   asset_id: '123...',
   *   price: '0.52',
   *   size: '50',
   *   side: 'BUY'
   * });
   * // → emit('message', ...), emit('raw', ...), emit('trade', ...)
   * ```
   */
  public processMessage(message: any): void {
    try {
      // Валидируем что сообщение это объект
      if (!message || typeof message !== 'object') {
        throw new Error('Invalid message: not an object');
      }

      this.stats.totalMessages++;

      // Эмитируем generic событие message (все сообщения)
      this.emit('message', message);

      // Извлекаем тип события и asset ID
      const eventType = message.event_type || message.type;
      const assetId = message.asset_id || message.market;

      // Обрабатываем контрольные сообщения
      if (eventType === 'pong') {
        this.logger.trace('Pong received');
        this.emit('pong');
        return;
      }

      if (eventType === 'error') {
        this.logger.error('WebSocket error message', { message });
        // Пытаемся извлечь осмысленное сообщение об ошибке
        let errorMsg = 'Unknown WebSocket error';
        if (message.data && typeof message.data === 'object') {
          errorMsg = JSON.stringify(message.data);
        } else if (message.data) {
          errorMsg = String(message.data);
        } else if (message.message) {
          errorMsg = String(message.message);
        }
        this.emit('error', new Error(errorMsg));
        return;
      }

      if (eventType === 'subscribed') {
        this.logger.debug('Subscription confirmed', { message });
        this.emit('subscribed', message);
        return;
      }

      if (eventType === 'unsubscribed') {
        this.logger.debug('Unsubscription confirmed', { message });
        this.emit('unsubscribed', message);
        return;
      }

      // Пропускаем игнорируемые контрольные сообщения
      if (eventType === 'price_change') {
        this.stats.skippedMessages++;
        this.logger.trace('Skipping price_change event', {
          market: message.market?.substring(0, 16) + '...'
        });
        return;
      }

      if (eventType === 'tick_size_change') {
        this.stats.skippedMessages++;
        this.logger.trace('Skipping tick_size_change event', {
          market: message.market?.substring(0, 16) + '...'
        });
        return;
      }

      // User channel: lifecycle событие ордера (event_type: "order") — не требует asset_id
      if (eventType === 'order') {
        this.stats.orderMessages++;
        this.logger.trace('Routing order lifecycle message', { orderId: message.order_id });
        this.emit('order', message);
        return;
      }

      // Data сообщения должны иметь asset_id
      if (!assetId) {
        this.logger.warn('Data message without asset_id', { eventType, message });
        return;
      }

      // Эмитируем raw событие для data сообщений (до роутинга)
      this.emit('raw', message);

      // Роутим по типу события
      if (eventType === 'book') {
        this.stats.orderbookMessages++;
        this.logger.trace('Routing orderbook message', {
          assetId: assetId.substring(0, 16) + '...',
          bids: message.bids?.length,
          asks: message.asks?.length
        });
        this.emit('orderbook', message as PolymarketOrderbookMessage);
      } else if (eventType === 'trade' || eventType === 'last_trade_price') {
        // Валидируем обязательные поля
        if (message.price && message.size) {
          this.stats.tradeMessages++;
          this.logger.trace('Routing trade message', {
            assetId: assetId.substring(0, 16) + '...',
            price: message.price,
            size: message.size
          });
          this.emit('trade', message as PolymarketTradeMessage);
        } else {
          this.logger.warn('Trade message missing price/size', { message });
        }
      } else {
        this.logger.debug('Unknown event type', {
          eventType,
          assetId: assetId.substring(0, 16) + '...'
        });
      }
    } catch (error) {
      this.logger.error('Failed to process message', {
        err: error instanceof Error ? error : new Error(String(error)),
        message
      });
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Получает статистику router
   *
   * @returns Текущая статистика
   *
   * @example
   * ```typescript
   * const stats = router.getStats();
   * console.log('Processed:', stats.totalMessages);
   * console.log('Orderbooks:', stats.orderbookMessages);
   * console.log('Trades:', stats.tradeMessages);
   * ```
   */
  public getStats(): Readonly<RouterStats> {
    return { ...this.stats };
  }

  /**
   * Сбрасывает статистику router
   *
   * @example
   * ```typescript
   * router.resetStats();
   * ```
   */
  public resetStats(): void {
    this.stats = {
      totalMessages: 0,
      orderbookMessages: 0,
      tradeMessages: 0,
      orderMessages: 0,
      parsingErrors: 0,
      batchMessages: 0,
      skippedMessages: 0,
    };
    this.logger.debug('Router statistics reset');
  }
}
