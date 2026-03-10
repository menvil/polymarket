/**
 * PolymarketWebSocketManager — WebSocket-менеджер для Polymarket
 *
 * @remarks
 * Расширяет BaseWebSocketTransport Polymarket-специфичной функциональностью.
 * Использует паттерн композиции, внедряя PolymarketMessageFormatter и PolymarketMessageParser.
 *
 * Предоставляет:
 * - Удобные методы Polymarket (subscribeToTokens, unsubscribeFromTokens)
 * - Настроенный BaseWebSocketTransport с форматтером и парсером Polymarket
 * - Тот же API, что и старый WebSocketManager (обратная совместимость)
 *
 * Это тонкая обёртка, которая:
 * 1. Создаёт PolymarketMessageFormatter и PolymarketMessageParser
 * 2. Внедряет их в BaseWebSocketTransport через конструктор
 * 3. Предоставляет удобные методы для типовых операций Polymarket
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
 *   console.log('Orderbook update:', data);
 * });
 *
 * await manager.connect();
 * await manager.subscribeToTokens(['67704255...', '28257334...']);
 * ```
 *
 * @module infrastructure/polymarket/ws/PolymarketWebSocketManager
 */

import type { ILogger } from '@polymarket/logger';
import type { BaseWebSocketConfig, ConnectionStatus } from '../stubs/shared/websocket/types.js';
import { BaseWebSocketTransport } from '../stubs/shared/websocket/BaseWebSocketTransport.js';
import { PolymarketMessageFormatter } from './PolymarketMessageFormatter.js';
import { PolymarketMessageParser } from './PolymarketMessageParser.js';

/**
 * Конфигурация WebSocket для Polymarket
 *
 * @remarks
 * То же самое, что BaseWebSocketConfig, но с Polymarket-специфичными значениями по умолчанию.
 */
export interface PolymarketWebSocketConfig extends BaseWebSocketConfig {
  /** URL WebSocket (по умолчанию: wss://ws-subscriptions-clob.polymarket.com/ws/market) */
  url: string;
}

/**
 * PolymarketWebSocketManager
 *
 * @remarks
 * Polymarket-специфичный WebSocket-менеджер, использующий паттерн композиции.
 * Расширяет BaseWebSocketTransport и внедряет форматтер/парсер Polymarket.
 *
 * Возможности:
 * - Форматирование сообщений Polymarket (через PolymarketMessageFormatter)
 * - Парсинг сообщений Polymarket (через PolymarketMessageParser)
 * - Удобные методы для подписок на токены
 * - Тот же API, что и старый WebSocketManager (обратная совместимость)
 *
 * События (унаследованы от BaseWebSocketTransport):
 * - `connected` — успешное подключение
 * - `disconnected` — отключение
 * - `reconnecting` — начало попытки переподключения
 * - `error` — возникла ошибка
 * - `message` — raw данные WebSocket (Buffer, эмитируется ПЕРВЫМ)
 * - `raw` — распарсенное сообщение (после события message)
 * - `orderbook` — обновление стакана
 * - `trade` — обновление сделки
 */
export class PolymarketWebSocketManager extends BaseWebSocketTransport {
  /**
   * Коллбэки для подписок на сделки по tokenId
   *
   * @remarks
   * Используется для обнаружения fills на основе сделок в PAPER режиме.
   * Каждый tokenId может иметь один коллбэк.
   */
  private tradeCallbacks = new Map<
    string,
    (trade: { price: number; quantity: number; side: 'BUY' | 'SELL' | null }) => void
  >();

  /**
   * Флаг для отслеживания инициализации слушателя сделок
   */
  private tradeListenerInitialized = false;

  /**
   * Создаёт новый WebSocket-менеджер Polymarket
   *
   * @param config - Конфигурация WebSocket
   * @param logger - Экземпляр logger
   *
   * @throws {Error} Если config или logger равны null
   *
   * @remarks
   * Внутренне создаёт PolymarketMessageFormatter и PolymarketMessageParser
   * и внедряет их в BaseWebSocketTransport.
   *
   * Форматтер и парсер создаются с тем же logger для согласованного логирования.
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
    // Создаём специфичные для Polymarket formatter и parser
    const formatter = new PolymarketMessageFormatter(logger);
    const parser = new PolymarketMessageParser(logger);

    // Внедряем в BaseWebSocketTransport
    super(config, formatter, parser, logger);
  }

  /**
   * Подписывается на обновления токенов
   *
   * @param tokenIds - Массив token ID для подписки
   * @returns Promise, который разрешается при отправке сообщения подписки
   *
   * @remarks
   * Удобный метод для подписки на токены Polymarket.
   * Эквивалентно: subscribe('market', { assets_ids: tokenIds, type: 'market' })
   *
   * Возможности:
   * - Автоматическое удаление дублей (через PolymarketMessageFormatter)
   * - Валидация токенов (через PolymarketMessageFormatter)
   * - Подробное логирование
   *
   * @example
   * ```typescript
   * await manager.subscribeToTokens([
   *   '67704255197116168826604911233626301865010283966205730455742704536521111535950',
   *   '28257334928283890303635192969230584167951485435421345229067758649928042311681',
   * ]);
   *
   * manager.on('orderbook', (data) => {
   *   console.log('Orderbook for token:', data.asset_id);
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
   * @param tokenIds - Массив token ID для отписки
   * @returns Promise, который разрешается при отправке сообщения отписки
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
   * Переподключается для изменения подписок.
   *
   * @remarks
   * Stub — полная реализация в Phase 8.
   */
  public async reconnectForNewSubscription(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  /**
   * Возвращает текущий статус соединения.
   *
   * @remarks
   * Stub — возвращает 'disconnected' до Phase 8.
   */
  public getStatus(): ConnectionStatus {
    return 'disconnected';
  }

  /**
   * Проверяет подключён ли WebSocket.
   *
   * @remarks
   * Stub — возвращает false до Phase 8.
   */
  public isConnected(): boolean {
    return false;
  }

  /**
   * Подписывается на события сделок по конкретному токену
   *
   * @param tokenId - Token ID для фильтрации сделок
   * @param callback - Коллбэк, вызываемый для каждой сделки
   *
   * @remarks
   * v5.4: Для обнаружения fills на основе сделок в PAPER режиме.
   *
   * Коллбэк получает нормализованные данные сделки:
   * - price: number (распарсено из строки)
   * - quantity: number (распарсено из строки)
   * - side: 'BUY' | 'SELL' | null
   *
   * Поддерживается только один коллбэк на tokenId.
   * Повторный вызов с тем же tokenId заменяет предыдущий коллбэк.
   *
   * @example
   * ```typescript
   * manager.subscribeToTrades('67704255...', (trade) => {
   *   console.log(`Trade: ${trade.side} ${trade.quantity} @ ${trade.price}`);
   *   tradeAccumulator.addTrade(tokenId, trade);
   * });
   * ```
   */
  public subscribeToTrades(
    tokenId: string,
    callback: (trade: { price: number; quantity: number; side: 'BUY' | 'SELL' | null }) => void
  ): void {
    // Сохраняем коллбэк для этого tokenId
    this.tradeCallbacks.set(tokenId, callback);

    // Инициализируем слушатель сделок если ещё не был инициализирован
    if (!this.tradeListenerInitialized) {
      this.tradeListenerInitialized = true;

      // Слушаем все события сделок и маршрутизируем к соответствующим коллбэкам
      this.on('trade', (message: any) => {
        const assetId = message.asset_id;
        if (!assetId) return;

        const cb = this.tradeCallbacks.get(assetId);
        if (!cb) return;

        // Парсим и нормализуем данные сделки
        // PolymarketTradeMessage содержит: price (string), size (string), side ('BUY'|'SELL'|undefined)
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
   * Отписывается от событий сделок по конкретному токену
   *
   * @param tokenId - Token ID для отписки
   *
   * @remarks
   * v5.4: Удаляет коллбэк сделки для данного tokenId.
   * НЕ удаляет базовый слушатель события 'trade' (он остаётся активным для других токенов).
   */
  public unsubscribeFromTrades(tokenId: string): void {
    this.tradeCallbacks.delete(tokenId);
  }
}

// Реэкспорт типов из общего слоя для обратной совместимости
export type { ConnectionStatus } from '../stubs/shared/websocket/types.js';
export type { SubscriptionParams } from '../stubs/shared/websocket/types.js';
