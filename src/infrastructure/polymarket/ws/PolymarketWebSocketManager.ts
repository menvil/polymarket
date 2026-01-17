/**
 * PolymarketWebSocketManager - Менеджер WebSocket для Polymarket
 *
 * @remarks
 * Расширяет BaseWebSocketTransport функциональностью специфичной для Polymarket.
 * Использует паттерн композиции путем инжектирования PolymarketMessageFormatter и PolymarketMessageParser.
 *
 * Предоставляет:
 * - Удобные методы специфичные для Polymarket (subscribeToTokens, unsubscribeFromTokens)
 * - Сконфигурированный BaseWebSocketTransport с форматтером и парсером для Polymarket
 * - Тот же API что и старый WebSocketManager (обратная совместимость)
 *
 * Это тонкая обертка которая:
 * 1. Создает PolymarketMessageFormatter и PolymarketMessageParser
 * 2. Инжектирует их в BaseWebSocketTransport через конструктор
 * 3. Предоставляет удобные методы для общих операций с Polymarket
 *
 * @example
 * ```typescript
 * const manager = new PolymarketWebSocketManager(
 *   {
 *     url: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
 *     reconnectDelay: 1000,
 *   },
 *   logger
 * );
 *
 * manager.on('orderbook', (data) => {
 *   console.log('Обновление orderbook:', data);
 * });
 *
 * await manager.connect();
 * await manager.subscribeToTokens(['67704255...', '28257334...']);
 * ```
 *
 * @module infrastructure/polymarket/ws/PolymarketWebSocketManager
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import type { BaseWebSocketConfig } from '../../../shared/websocket/types.js';
import { BaseWebSocketTransport } from '../../../shared/websocket/BaseWebSocketTransport.js';
import { PolymarketMessageFormatter } from './PolymarketMessageFormatter.js';
import { PolymarketMessageParser } from './PolymarketMessageParser.js';

/**
 * Конфигурация WebSocket для Polymarket
 *
 * @remarks
 * Аналогична BaseWebSocketConfig но с настройками по умолчанию специфичными для Polymarket.
 */
export interface PolymarketWebSocketConfig extends BaseWebSocketConfig {
  /** URL WebSocket (по умолчанию: wss://ws-subscriptions-clob.polymarket.com/ws/market) */
  url: string;
}

/**
 * PolymarketWebSocketManager
 *
 * @remarks
 * Менеджер WebSocket специфичный для Polymarket использующий паттерн композиции.
 * Расширяет BaseWebSocketTransport и инжектирует форматтер/парсер для Polymarket.
 *
 * Возможности:
 * - Форматирование сообщений Polymarket (через PolymarketMessageFormatter)
 * - Парсинг сообщений Polymarket (через PolymarketMessageParser)
 * - Удобные методы для подписок на токены
 * - Тот же API что и старый WebSocketManager (обратная совместимость)
 *
 * События (унаследованы от BaseWebSocketTransport):
 * - `connected` - Успешно подключено
 * - `disconnected` - Отключено
 * - `reconnecting` - Начата попытка переподключения
 * - `error` - Произошла ошибка
 * - `message` - Сырые данные WebSocket (Buffer, эмитируется ПЕРВЫМ)
 * - `raw` - Распарсенное сообщение (после события message)
 * - `orderbook` - Обновление orderbook
 * - `trade` - Обновление trade
 */
export class PolymarketWebSocketManager extends BaseWebSocketTransport {
  /**
   * v5.4: Callbacks для подписок на трейды для каждого tokenId
   *
   * @remarks
   * Используется для обнаружения исполнений на основе трейдов в режиме PAPER.
   * Каждый tokenId может иметь один callback.
   */
  private tradeCallbacks = new Map<
    string,
    (trade: { price: number; quantity: number; side: 'BUY' | 'SELL' | null }) => void
  >();

  /**
   * v5.4: Флаг для отслеживания был ли уже настроен обработчик трейдов
   */
  private tradeListenerInitialized = false;

  /**
   * Создает новый менеджер WebSocket для Polymarket
   *
   * @param config - Конфигурация WebSocket
   * @param logger - Экземпляр логгера
   *
   * @throws {Error} Если config или logger равны null
   *
   * @remarks
   * Создает PolymarketMessageFormatter и PolymarketMessageParser внутренне
   * и инжектирует их в BaseWebSocketTransport.
   *
   * Форматтер и парсер создаются с одним логгером для согласованного логирования.
   *
   * @example
   * ```typescript
   * const manager = new PolymarketWebSocketManager(
   *   {
   *     url: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
   *     reconnectDelay: 1000,
   *     maxReconnectDelay: 30000,
   *     heartbeatInterval: 30000,
   *     heartbeatTimeout: 5000,
   *   },
   *   logger
   * );
   * ```
   */
  constructor(config: PolymarketWebSocketConfig, logger: ILogger) {
    // Создаем форматтер и парсер специфичные для Polymarket
    const formatter = new PolymarketMessageFormatter(logger);
    const parser = new PolymarketMessageParser(logger);

    // Инжектируем в BaseWebSocketTransport
    super(config, formatter, parser, logger);
  }

  /**
   * Подписывается на обновления токенов
   *
   * @param tokenIds - Массив ID токенов для подписки
   * @returns Promise который разрешается при отправке сообщения подписки
   *
   * @remarks
   * Удобный метод для подписки на токены Polymarket.
   * Эквивалентно: subscribe('market', { assets_ids: tokenIds, type: 'market' })
   *
   * Возможности:
   * - Автоматическое удаление дубликатов (через PolymarketMessageFormatter)
   * - Валидация токенов (через PolymarketMessageFormatter)
   * - Детальное логирование
   *
   * @example
   * ```typescript
   * await manager.subscribeToTokens([
   *   '67704255197116168826604911233626301865010283966205730455742704536521111535950',
   *   '28257334928283890303635192969230584167951485435421345229067758649928042311681',
   * ]);
   *
   * manager.on('orderbook', (data) => {
   *   console.log('Orderbook для токена:', data.asset_id);
   * });
   * ```
   */
  public async subscribeToTokens(tokenIds: string[]): Promise<void> {
    return this.subscribe('market', {
      assets_ids: tokenIds,
      type: 'market',
    });
  }

  /**
   * Отписывается от обновлений токенов
   *
   * @param tokenIds - Массив ID токенов для отписки
   * @returns Promise который разрешается при отправке сообщения отписки
   *
   * @remarks
   * Удобный метод для отписки от токенов Polymarket.
   * Эквивалентно: unsubscribe('market', { assets_ids: tokenIds, type: 'market' })
   *
   * @example
   * ```typescript
   * await manager.unsubscribeFromTokens([
   *   '67704255197116168826604911233626301865010283966205730455742704536521111535950',
   * ]);
   * ```
   */
  public async unsubscribeFromTokens(tokenIds: string[]): Promise<void> {
    return this.unsubscribe('market', {
      assets_ids: tokenIds,
      type: 'market',
    });
  }

  /**
   * Подписывается на события трейдов для конкретного токена
   *
   * @param tokenId - ID токена для фильтрации трейдов
   * @param callback - Callback вызываемый для каждого трейда
   *
   * @remarks
   * v5.4: Для обнаружения исполнений на основе трейдов в режиме PAPER.
   *
   * Callback получает нормализованные данные трейда:
   * - price: number (распарсено из строки)
   * - quantity: number (распарсено из строки)
   * - side: 'BUY' | 'SELL' | null
   *
   * Поддерживается только один callback на tokenId.
   * Повторный вызов с тем же tokenId заменяет предыдущий callback.
   *
   * @example
   * ```typescript
   * manager.subscribeToTrades('67704255...', (trade) => {
   *   console.log(`Трейд: ${trade.side} ${trade.quantity} @ ${trade.price}`);
   *   tradeAccumulator.addTrade(tokenId, trade);
   * });
   * ```
   */
  public subscribeToTrades(
    tokenId: string,
    callback: (trade: { price: number; quantity: number; side: 'BUY' | 'SELL' | null }) => void
  ): void {
    // Сохраняем callback для этого tokenId
    this.tradeCallbacks.set(tokenId, callback);

    // Инициализируем обработчик трейдов если еще не сделано
    if (!this.tradeListenerInitialized) {
      this.tradeListenerInitialized = true;

      // Слушаем все события трейдов и маршрутизируем к соответствующим callbacks
      this.on('trade', (message: any) => {
        const assetId = message.asset_id;
        if (!assetId) return;

        const cb = this.tradeCallbacks.get(assetId);
        if (!cb) return;

        // Парсим и нормализуем данные трейда
        // PolymarketTradeMessage имеет: price (строка), size (строка), side ('BUY'|'SELL'|undefined)
        const tradeData = {
          price: parseFloat(message.price) || 0,
          quantity: parseFloat(message.size) || 0,
          side: (message.side as 'BUY' | 'SELL') || null,
        };

        cb(tradeData);
      });
    }
  }

  /**
   * Отписывается от событий трейдов для конкретного токена
   *
   * @param tokenId - ID токена для отписки
   *
   * @remarks
   * v5.4: Удаляет trade callback для этого tokenId.
   * НЕ удаляет базовый обработчик события 'trade' (он остается активным для других токенов).
   */
  public unsubscribeFromTrades(tokenId: string): void {
    this.tradeCallbacks.delete(tokenId);
  }
}

// Реэкспортируем типы из shared слоя для обратной совместимости
export type { ConnectionStatus } from '../../../shared/websocket/types.js';
export type { SubscriptionParams } from '../../../shared/websocket/types.js';
