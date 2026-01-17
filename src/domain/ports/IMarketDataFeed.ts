/**
 * IMarketDataFeed port
 *
 * @remarks
 * Интерфейс для получения рыночных данных в реальном времени.
 * Реализация находится в infrastructure layer (WebSocket подписки).
 *
 * **Polymarket Token Model:**
 * - Каждый маркет имеет 2 токена: YES и NO
 * - WebSocket подписки работают на уровне токенов, не маркетов
 * - Для получения полной картины маркета нужно подписаться на оба токена
 * - tokenId - это уникальный идентификатор токена (YES или NO)
 *
 * Responsibilities:
 * - Получение снимков orderbook для конкретного токена
 * - Подписка на обновления orderbook по токену
 * - Подписка на поток сделок (trades) по токену
 * - Управление подписками
 *
 * @example
 * ```typescript
 * // Подписка на оба токена маркета
 * const upTokenId = market.outcomes[0].tokenId;
 * const downTokenId = market.outcomes[1].tokenId;
 *
 * dataFeed.subscribeToOrderbook(upTokenId, (ob) => {
 *   console.log('YES orderbook updated');
 * });
 *
 * dataFeed.subscribeToOrderbook(downTokenId, (ob) => {
 *   console.log('NO orderbook updated');
 * });
 * ```
 */
import { Orderbook } from '../entities/Orderbook.js';
import { Trade } from '../entities/Trade.js';

/**
 * Market data feed interface
 *
 * @remarks
 * Domain layer определяет контракт для получения рыночных данных.
 */
export interface IMarketDataFeed {
  /**
   * Получает текущий снимок orderbook
   *
   * @param tokenId - ID токена (YES или NO)
   * @returns Orderbook snapshot для указанного токена
   * @throws {Error} При ошибке получения данных
   *
   * @remarks
   * - Запрашивает текущее состояние стакана для конкретного токена
   * - Используется для инициализации перед подпиской
   * - Для полной картины маркета нужно получить orderbook обоих токенов
   */
  getOrderbook(tokenId: string): Promise<Orderbook>;

  /**
   * Подписывается на обновления orderbook
   *
   * @param tokenId - ID токена (YES или NO)
   * @param callback - Функция вызывается при каждом обновлении
   * @returns void
   *
   * @remarks
   * - Регистрирует callback для обновлений orderbook конкретного токена
   * - Callback вызывается при изменении стакана
   * - Обновления приходят с частотой ~100-500ms
   * - Используйте throttling если нужно снизить нагрузку
   * - **ВАЖНО**: Этот метод только регистрирует callback, реальная WebSocket
   *   подписка происходит через subscribeToMarket(upTokenId, downTokenId)
   */
  subscribeToOrderbook(
    tokenId: string,
    callback: (orderbook: Orderbook) => void
  ): void;

  /**
   * Подписывается на поток сделок
   *
   * @param tokenId - ID токена (YES или NO)
   * @param callback - Функция вызывается при каждой новой сделке
   * @returns void
   *
   * @remarks
   * - Регистрирует callback для сделок по конкретному токену
   * - Callback вызывается для каждой исполненной сделки
   * - Используется для анализа объёмов и давления на рынок
   * - **ВАЖНО**: Этот метод только регистрирует callback, реальная WebSocket
   *   подписка происходит через subscribeToMarket(upTokenId, downTokenId)
   */
  subscribeToTrades(
    tokenId: string,
    callback: (trade: Trade) => void
  ): void;

  /**
   * Отписывается от всех обновлений токена
   *
   * @param tokenId - ID токена
   * @returns void
   *
   * @remarks
   * - Закрывает все подписки для указанного токена
   * - Вызывайте при остановке стратегии
   * - **УСТАРЕЛО**: Используйте unsubscribeFromMarket(upTokenId, downTokenId)
   */
  unsubscribe(tokenId: string): void;

  /**
   * Отписывается от обновлений orderbook
   *
   * @param tokenId - ID токена
   * @returns void
   *
   * @remarks
   * - Закрывает подписку на orderbook для указанного токена
   * - Подписка на trades остаётся активной
   */
  unsubscribeFromOrderbook(tokenId: string): void;

  /**
   * Отписывается от потока сделок
   *
   * @param tokenId - ID токена
   * @returns void
   *
   * @remarks
   * - Закрывает подписку на trades для указанного токена
   * - Подписка на orderbook остаётся активной
   */
  unsubscribeFromTrades(tokenId: string): void;

  /**
   * Проверяет, активна ли подписка для токена
   *
   * @param tokenId - ID токена
   * @returns True если есть активные подписки для этого токена
   *
   * @remarks
   * - Проверяет наличие активных WebSocket подписок для конкретного токена
   * - Полезно для мониторинга состояния соединения
   */
  isSubscribed(tokenId: string): boolean;
}
