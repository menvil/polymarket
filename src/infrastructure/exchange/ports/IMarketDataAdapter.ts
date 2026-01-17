import type { OrderSide } from '../types/OrderResponse.js';

/**
 * Общий интерфейс адаптера рыночных данных
 *
 * @remarks
 * Адаптер рыночных данных предоставляет доступ только для чтения к публичным данным рынка:
 * - Снимки orderbook
 * - Рыночные сделки (НЕ пользовательские - для них используйте IExecutionAdapter.getFillHistory)
 * - Информация о рынке (ограничения, лимиты и т.д.)
 *
 * **ВАЖНО**: Это ПУБЛИЧНЫЕ данные, НЕ специфичные для пользователя.
 * Для позиций/ордеров пользователя используйте IPortfolioAdapter / IExecutionAdapter.
 *
 * **Варианты использования**:
 * - Получение orderbook для торговых решений
 * - Получение недавних рыночных сделок
 * - Получение ограничений рынка (мин/макс размер, шаг цены)
 * - Отображение обзора рынка
 *
 * @example
 * ```typescript
 * const adapter = new PolymarketMarketDataAdapter(
 *   orderbookClient,
 *   tradesClient,
 *   marketDataClient,
 *   mapper,
 *   logger
 * );
 *
 * const orderbook = await adapter.getOrderbook('0x123');
 * console.log(`Лучший bid: ${orderbook.bids[0].price}`);
 *
 * const constraints = await adapter.getMarketConstraints('0x123');
 * console.log(`Мин размер: ${constraints.minOrderSize}`);
 * ```
 */

/**
 * Уровень orderbook (bid или ask)
 */
export interface OrderbookLevel {
  /** Цена */
  price: number;

  /** Размер на этой цене */
  size: number;
}

/**
 * Снимок orderbook
 */
export interface OrderbookSnapshot {
  /** ID токена */
  tokenId: string;

  /** Bids (отсортированы по убыванию цены) */
  bids: OrderbookLevel[];

  /** Asks (отсортированы по возрастанию цены) */
  asks: OrderbookLevel[];

  /** Временная метка снимка (мс) */
  timestamp: number;
}

/**
 * Рыночная сделка (НЕ пользовательская)
 */
export interface MarketTrade {
  /** ID сделки */
  tradeId: string;

  /** ID токена */
  tokenId: string;

  /** Сторона сделки (с точки зрения taker, UPPERCASE: 'BUY' | 'SELL') */
  side: OrderSide;

  /** Цена исполнения */
  price: number;

  /** Размер сделки */
  size: number;

  /** Временная метка исполнения (мс) */
  timestamp: number;
}

/**
 * Ограничения рынка
 */
export interface MarketConstraints {
  /** Минимальный размер ордера */
  minOrderSize: number;

  /** Максимальный размер ордера */
  maxOrderSize: number;

  /** Шаг размера (минимальный инкремент размера) */
  sizeTick: number;

  /** Шаг цены (минимальный инкремент цены) */
  priceTick: number;

  /** Минимальная цена */
  minPrice?: number;

  /** Максимальная цена */
  maxPrice?: number;
}

/**
 * Информация о рынке
 */
export interface MarketInfo {
  /** ID токена */
  tokenId: string;

  /** Название/описание рынка */
  name: string;

  /** Ограничения рынка */
  constraints: MarketConstraints;

  /** Статус рынка */
  status: 'active' | 'inactive' | 'closed';

  /** Опционально: временная метка истечения */
  expiresAt?: number;
}

/**
 * Общий интерфейс адаптера рыночных данных
 */
export interface IMarketDataAdapter {
  /**
   * Получить снимок orderbook
   *
   * @param tokenId - ID токена
   * @param depth - Опционально: количество уровней для возврата (по умолчанию: все)
   * @returns Снимок orderbook
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @example
   * ```typescript
   * const orderbook = await adapter.getOrderbook('0x123');
   * console.log(`Лучший bid: ${orderbook.bids[0].price}`);
   * console.log(`Лучший ask: ${orderbook.asks[0].price}`);
   *
   * const top10 = await adapter.getOrderbook('0x123', 10);
   * console.log(`Топ 10 уровней: ${top10.bids.length} bids`);
   * ```
   */
  getOrderbook(tokenId: string, depth?: number): Promise<OrderbookSnapshot>;

  /**
   * Получить недавние рыночные сделки
   *
   * @param tokenId - ID токена
   * @param limit - Опционально: максимальное количество сделок для возврата
   * @returns Массив рыночных сделок (отсортированы по убыванию временной метки)
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Возвращает ПУБЛИЧНЫЕ рыночные сделки (НЕ специфичные для пользователя).
   * Для истории исполнений пользователя используйте IExecutionAdapter.getFillHistory().
   *
   * @example
   * ```typescript
   * const trades = await adapter.getMarketTrades('0x123', 100);
   * console.log(`Последние 100 сделок: ${trades.length}`);
   * console.log(`Цена последней сделки: ${trades[0].price}`);
   * ```
   */
  getMarketTrades(tokenId: string, limit?: number): Promise<MarketTrade[]>;

  /**
   * Получить ограничения рынка
   *
   * @param tokenId - ID токена
   * @returns Ограничения рынка
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Возвращает мин/макс размеры, шаги цены и т.д.
   * Используется MarketConstraintsPolicy для нормализации.
   *
   * @example
   * ```typescript
   * const constraints = await adapter.getMarketConstraints('0x123');
   * console.log(`Мин размер: ${constraints.minOrderSize}`);
   * console.log(`Шаг размера: ${constraints.sizeTick}`);
   * ```
   */
  getMarketConstraints(tokenId: string): Promise<MarketConstraints>;

  /**
   * Получить информацию о рынке
   *
   * @param tokenId - ID токена
   * @returns Информация о рынке
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Возвращает полную информацию о рынке включая название, статус, истечение и т.д.
   *
   * @example
   * ```typescript
   * const info = await adapter.getMarketInfo('0x123');
   * console.log(`Рынок: ${info.name}`);
   * console.log(`Статус: ${info.status}`);
   * ```
   */
  getMarketInfo(tokenId: string): Promise<MarketInfo>;

  /**
   * Получить все активные рынки
   *
   * @returns Массив информации о рынках
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Опциональный метод. Возвращает список всех активных рынков.
   */
  getActiveMarkets?(): Promise<MarketInfo[]>;
}