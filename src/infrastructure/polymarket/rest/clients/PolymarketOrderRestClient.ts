/**
 * REST-клиент для ордеров Polymarket
 *
 * @remarks
 * Обрабатывает эндпоинты /order и /orders:
 * - POST /order - Разместить новый ордер
 * - DELETE /order - Отменить ордер
 * - GET /orders - Получить открытые ордера
 *
 * Возвращает СЫРЫЕ ответы API (НЕ нормализованные).
 * Нормализация выполняется мапперами на более высоких уровнях.
 *
 * @example
 * ```typescript
 * const client = new PolymarketOrderRestClient(restClient, orderBuilder, logger);
 *
 * // Place order (nonce автоматически назначается API)
 * const order = await client.createOrder({
 *   tokenId: '0x123',
 *   side: 'BUY',
 *   price: 0.52,
 *   size: 100,
 * });
 *
 * // Cancel order
 * await client.cancelOrder('order-123');
 *
 * // Get open orders
 * const orders = await client.getOpenOrders('0x123');
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { PolymarketRestClient } from '../PolymarketRestClient.js';
import type { PolymarketOrderBuilder } from '../auth/PolymarketOrderBuilder.js';

/**
 * Запрос на создание ордера (упрощенный формат API)
 */
export interface CreateOrderRequest {
  /** ID токена */
  tokenId: string;

  /** Сторона ордера */
  side: 'BUY' | 'SELL';

  /** Цена (число: 0-1) */
  price: number;

  /** Размер (количество акций) */
  size: number;

  /** Ставка комиссии в базисных пунктах (по умолчанию: 0) */
  feeRateBps?: number;

  /**
   * Nonce для защиты от повторов (опционально)
   *
   * @remarks
   * Если не передан (undefined), API автоматически назначит nonce.
   * Если передан 0, API также автоматически назначит nonce.
   * Если передано конкретное значение > 0, оно будет использовано.
   */
  nonce?: number;

  /** Размер шага цены для округления (опционально, по умолчанию 0.01) */
  priceTick?: number;
}

/**
 * Ответ на создание ордера (сырой формат API)
 */
export interface CreateOrderResponse {
  /** Флаг успеха */
  success: boolean;

  /** Сообщение об ошибке (пустое при успехе) */
  errorMsg: string;

  /** ID ордера (Заглавная D!) */
  orderID: string;

  /** Статус ордера */
  status: 'pending' | 'live' | 'filled' | 'cancelled';

  /** Получаемая сумма */
  takingAmount: string;

  /** Размещаемая сумма */
  makingAmount: string;

  /** ID токена (опционально, не всегда присутствует) */
  tokenId?: string;

  /** Сторона ордера (опционально, не всегда присутствует) */
  side?: 'BUY' | 'SELL';

  /** Цена (опционально, не всегда присутствует) */
  price?: string;

  /** Размер (опционально, не всегда присутствует) */
  size?: string;

  /** Исполненный размер (опционально, не всегда присутствует) */
  filledSize?: string;

  /** Временная метка (опционально, не всегда присутствует) */
  timestamp?: number;
}

/**
 * Запрос на отмену ордера
 */
export interface CancelOrderRequest {
  /** ID ордера для отмены */
  orderId: string;

  /** Временная метка */
  timestamp: number;
}

/**
 * Ответ на отмену ордера
 */
export interface CancelOrderResponse {
  /** Флаг успеха */
  success: boolean;

  /** ID ордера */
  orderId: string;

  /** Статус после отмены */
  status: 'CANCELLED';
}

/**
 * Ответ на запрос ордеров
 */
export interface GetOrdersResponse {
  /** Массив ордеров */
  orders: CreateOrderResponse[];
}

/**
 * Ответ исполненного ордера из /data/orders (status=MATCHED)
 *
 * @remarks
 * Используется методом getMatchedOrders() для получения исполненных ордеров.
 * Поля size_matched и avg_price содержат агрегированную информацию.
 */
export interface MatchedOrderResponse {
  /** ID ордера (заглавная D!) */
  orderID: string;

  /** ID токена/актива */
  asset_id: string;

  /** Сторона ордера */
  side: 'BUY' | 'SELL';

  /** Исполненный размер (строка-число) */
  size_matched: string;

  /** Средняя цена исполнения (строка-число) */
  avg_price: string;

  /** Исходный размер ордера (строка-число) */
  original_size: string;

  /** Цена ордера (строка-число) */
  price: string;

  /** Статус ордера */
  status: 'MATCHED' | 'LIVE' | 'CANCELLED';

  /** Временная метка создания */
  created_at: string;

  /** Condition ID (ID рынка) */
  condition_id?: string;

  /** Ставка комиссии в bps */
  fee_rate_bps?: string;

  /** Адрес владельца */
  owner?: string;
}

/**
 * Ответ сделки из /data/trades
 *
 * @remarks
 * Используется методом getFilledOrders() для получения истории сделок.
 * Содержит детализацию каждой отдельной сделки (fill).
 */
export interface TradeResponse {
  /** ID сделки */
  id: string;

  /** ID ордера taker */
  taker_order_id: string;

  /** ID рынка */
  market: string;

  /** ID токена/актива */
  asset_id: string;

  /** Сторона сделки */
  side: 'BUY' | 'SELL';

  /** Размер сделки (строка-число) */
  size: string;

  /** Цена сделки (строка-число) */
  price: string;

  /** Роль трейдера в сделке */
  trader_side: 'MAKER' | 'TAKER';

  /** Адрес maker */
  maker_address?: string;

  /** Временная метка сделки */
  created_at?: string;

  /** ID транзакции */
  transaction_hash?: string;

  /** Комиссия (строка-число) */
  fee_amount?: string;
}

/**
 * Пагинированный ответ сделок из /data/trades
 */
export interface TradesPageResponse {
  /** Массив сделок */
  data: TradeResponse[];

  /** Курсор для следующей страницы */
  next_cursor: string;
}

/**
 * REST-клиент для ордеров Polymarket
 */
export class PolymarketOrderRestClient {
  constructor(
    private readonly restClient: PolymarketRestClient,
    private readonly orderBuilder: PolymarketOrderBuilder,
    private readonly logger: ILogger,
    private readonly makerAddress?: string // ✅ v7.7.10: Адрес MAKER для /data/trades
  ) {}

  /**
   * Получить адрес MAKER (адрес спонсора, НЕ адрес подписанта!)
   *
   * @returns Адрес MAKER
   *
   * @remarks
   * v7.7.10: Используется для эндпоинта /data/trades для получения исполнений пользователя.
   * КРИТИЧНО: Это адрес СПОНСОРА (прокси-кошелек), НЕ адрес ПОДПИСАНТА!
   */
  getMakerAddress(): string | undefined {
    return this.makerAddress;
  }

  /**
   * Разместить новый ордер
   *
   * @param request - Запрос ордера
   * @returns Сырой ответ ордера
   * @throws {ApiError} Если вызов API завершается с ошибкой
   *
   * @remarks
   * Возвращает сырой ответ API. Нормализация должна выполняться маппером.
   *
   * Если nonce не передан или равен 0, API автоматически назначит nonce.
   * Для явного контроля можно передать конкретное значение nonce > 0.
   *
   * @example
   * ```typescript
   * // Автоматическое назначение nonce (рекомендуется)
   * const order = await client.createOrder({
   *   tokenId: '0x123',
   *   side: 'BUY',
   *   price: 0.52,
   *   size: 100,
   * });
   *
   * // Явный nonce (для специфичных случаев)
   * const orderWithNonce = await client.createOrder({
   *   tokenId: '0x123',
   *   side: 'BUY',
   *   price: 0.52,
   *   size: 100,
   *   nonce: Date.now(),
   * });
   *
   * console.log(`Order created: ${order.orderId}`);
   * ```
   */
  async createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
    this.logger.debug('Creating order', {
      tokenId: request.tokenId,
      side: request.side,
      price: request.price,
      size: request.size,
      nonce: request.nonce,
    });

    // Использовать предоставленный nonce или 0 для автоматического назначения API
    // Если nonce = 0 или undefined, API автоматически назначит правильный nonce
    const exchangeNonce = request.nonce ?? 0;

    this.logger.debug('Using nonce for order', {
      requestNonce: request.nonce,
      exchangeNonce,
      autoAssigned: exchangeNonce === 0,
    });

    // Построить подписанный EIP-712 ордер
    const signedOrder = await this.orderBuilder.buildOrder({
      tokenId: request.tokenId,
      side: request.side,
      price: request.price,
      size: request.size,
      feeRateBps: request.feeRateBps ?? 0,
      nonce: exchangeNonce,
      expiration: 0, // Без срока действия
      priceTick: request.priceTick, // Передать шаг цены для округления
    });

    this.logger.debug('Order signed', {
      salt: signedOrder.salt,
      maker: signedOrder.maker,
      signer: signedOrder.signer,
      makerAmount: signedOrder.makerAmount,
      takerAmount: signedOrder.takerAmount,
    });

    // Отправить ордер в API (POST /order ожидает специфический формат)
    // КРИТИЧНО: owner ДОЛЖЕН быть строкой API KEY (UUID), НЕ адресом кошелька!
    // Ссылка на SDK: orderToJson(order, this.creds?.key, orderType, deferExec)
    const response = await this.restClient.post<CreateOrderResponse>(
      '/order',
      {
        order: signedOrder,
        owner: this.restClient.getApiKey(), // Строка API ключа (UUID)
        orderType: 'GTC', // Good Till Cancel (действует до отмены)
      },
      { requireSignature: false } // Ордер уже подписан с помощью EIP-712
    );

    this.logger.info('Order created successfully', {
      orderID: response.orderID,
      status: response.status,
      success: response.success,
    });

    this.logger.info('📤 POST /order FULL RESPONSE', {
      response: JSON.stringify(response, null, 2),
    });

    return response;
  }

  /**
   * Отменить ордер
   *
   * @param orderId - ID ордера для отмены
   * @returns Ответ на отмену
   * @throws {ApiError} Если вызов API завершается с ошибкой
   *
   * @example
   * ```typescript
   * await client.cancelOrder('order-123');
   * console.log('Order cancelled');
   * ```
   */
  async cancelOrder(orderId: string): Promise<CancelOrderResponse> {
    this.logger.debug('Cancelling order', { orderId });

    const response = await this.restClient.delete<CancelOrderResponse>('/order', {
      orderId,
      timestamp: Date.now(),
    });

    this.logger.info('Order cancelled successfully', { orderId });

    return response;
  }

  /**
   * Получить открытые ордера
   *
   * @param tokenId - Опционально: фильтр по ID токена
   * @returns Массив открытых ордеров
   * @throws {ApiError} Если вызов API завершается с ошибкой
   *
   * @remarks
   * Возвращает только ордера PENDING и LIVE.
   * Ордера FILLED и CANCELLED исключаются.
   *
   * @example
   * ```typescript
   * // All open orders
   * const allOrders = await client.getOpenOrders();
   *
   * // Orders for specific token
   * const tokenOrders = await client.getOpenOrders('0x123');
   * ```
   */
  async getOpenOrders(tokenId?: string): Promise<CreateOrderResponse[]> {
    this.logger.debug('Getting open orders', {
      tokenId,
      signatureType: this.restClient.getSignatureType(),
    });

    // ✅ КРИТИЧНОЕ ИСПРАВЛЕНИЕ: НЕ фильтруйте по signature_type!
    // signature_type фильтрует по адресу ПОДПИСАНТА, а не адресу MAKER
    // При использовании прокси-кошелька (signature_type=1) ордера создаются с MAKER=адрес спонсора
    // Но фильтр signature_type=1 возвращает ордера для адреса ПОДПИСАНТА (прокси)
    // Результат: бот не может видеть свои собственные ордера!
    // Решение: Удалить фильтр signature_type, чтобы получить ВСЕ ордера для этого аккаунта
    const params: Record<string, string> = {};

    if (tokenId) {
      params.asset_id = tokenId; // Использовать параметр 'asset_id', а не 'tokenId'
    }

    // КРИТИЧНО: Использовать эндпоинт /data/orders (не /orders - он возвращает HTTP 405)
    const response = await this.restClient.get<CreateOrderResponse[]>('/data/orders', params);

    // API возвращает массив напрямую, а не формат { orders: [...] }
    const orders = Array.isArray(response) ? response : [];

    this.logger.info('📥 GET /data/orders RESPONSE', {
      count: orders.length,
      tokenIdFilter: tokenId || 'none',
      orders: orders.length > 0 ? JSON.stringify(orders, null, 2) : 'NO ORDERS',
    });

    return orders;
  }

  /**
   * Получить ордер по ID
   *
   * @param orderId - ID ордера
   * @returns Ответ с ордером
   * @throws {ApiError} Если вызов API завершается с ошибкой или ордер не найден
   *
   * @example
   * ```typescript
   * const order = await client.getOrderById('order-123');
   * console.log(`Order status: ${order.status}`);
   * ```
   */
  async getOrderById(orderId: string): Promise<CreateOrderResponse> {
    this.logger.debug('Getting order by ID', { orderId });

    const response = await this.restClient.get<CreateOrderResponse>(`/order/${orderId}`);

    this.logger.debug('Order retrieved', {
      orderID: response.orderID,
      status: response.status,
    });

    return response;
  }

  /**
   * Получить совпавшие ордера (используя эндпоинт /data/orders?status=MATCHED)
   *
   * @param tokenId - Опционально: фильтр по ID токена
   * @param limit - Максимальное количество возвращаемых ордеров (по умолчанию: 100)
   * @returns Массив совпавших ордеров (АГРЕГИРОВАННЫХ по ордерам!)
   * @throws {ApiError} Если вызов API завершается с ошибкой
   *
   * @remarks
   * v7.7.11: ЗАПАСНОЙ метод, когда /data/trades возвращает пустой результат.
   * Использует /data/orders с параметром status=MATCHED (как старый бот).
   *
   * ВАЖНО: Возвращает ОРДЕРА, а не отдельные СДЕЛКИ!
   * - Один ордер = одна строка (даже если исполнен несколькими сделками)
   * - size_matched = общий исполненный размер (сумма всех сделок)
   * - avg_price = средняя цена исполнения (НЕ лимитная цена!)
   *
   * @example
   * ```typescript
   * // Get all matched orders
   * const orders = await client.getMatchedOrders('0x123...', 100);
   * // orders[0].size_matched - total filled
   * // orders[0].avg_price - average price
   * ```
   */
  async getMatchedOrders(tokenId?: string, limit: number = 100): Promise<MatchedOrderResponse[]> {
    this.logger.debug('[PolymarketOrderRestClient] v7.7.11: Getting matched orders from /data/orders', {
      tokenId: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
      limit,
    });

    const params: Record<string, string> = {
      limit: limit.toString(),
      status: 'MATCHED', // ✅ Только исполненные ордера
    };

    if (tokenId) {
      params.asset_id = tokenId;
    }

    // Использовать эндпоинт /data/orders (не /data/trades!)
    const response = await this.restClient.get<MatchedOrderResponse[]>('/data/orders', params);

    // API возвращает массив напрямую
    const orders: MatchedOrderResponse[] = Array.isArray(response) ? response : [];

    this.logger.info('[PolymarketOrderRestClient] 📊 v7.7.11: Matched orders from /data/orders retrieved', {
      count: orders.length,
      tokenIdFilter: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
      limit,
    });

    return orders;
  }

  /**
   * Получить исполненные ордера (используя эндпоинт /data/trades с maker_address)
   *
   * @param tokenId - Опционально: фильтр по ID токена
   * @param makerAddress - Адрес MAKER (СПОНСОР, НЕ ПОДПИСАНТ!)
   * @param limit - Максимальное количество возвращаемых сделок (по умолчанию: 100)
   * @returns Массив исполненных ордеров
   * @throws {ApiError} Если вызов API завершается с ошибкой
   *
   * @remarks
   * v7.7.10: Использует /data/trades с параметром maker_address (как официальный @polymarket/clob-client)
   * КРИТИЧНО: Необходимо использовать адрес MAKER (спонсор), НЕ адрес SIGNER (прокси)!
   *
   * v7.7.11: ЗАПАСНОЙ ВАРИАНТ - если возвращает пустой результат, вызовите getMatchedOrders()!
   *
   * Подход официального CLOB клиента:
   * ```typescript
   * getTrades({ maker_address: funderAddress, asset_id: tokenId })
   * ```
   *
   * @example
   * ```typescript
   * // Get all fills for MAKER address
   * const fills = await client.getFilledOrders('0x123...', '0xMAKER...', 100);
   * if (fills.length === 0) {
   *   // Fallback to matched orders
   *   const orders = await client.getMatchedOrders('0x123...', 100);
   * }
   * console.log(`Total fills: ${fills.length}`);
   * ```
   */
  async getFilledOrders(
    tokenId?: string,
    makerAddress?: string,
    limit: number = 100,
    options?: {
      onlyFirstPage?: boolean;
      includeAllTrades?: boolean;
    }
  ): Promise<TradeResponse[]> {
    // Опции по умолчанию
    const onlyFirstPage = options?.onlyFirstPage ?? false;
    const includeAllTrades = options?.includeAllTrades ?? true;

    // Fallback на this.makerAddress если makerAddress не передан
    const effectiveMaker = makerAddress ?? this.makerAddress;

    this.logger.debug('[PolymarketOrderRestClient] : Getting fills from /data/trades', {
      tokenId: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
      makerAddress: effectiveMaker ? effectiveMaker.substring(0, 10) + '...' : 'none',
      makerSource: makerAddress ? 'param' : 'this.makerAddress',
      limit,
      onlyFirstPage,
      includeAllTrades,
    });

    // ✅ v7.7.12: Пагинация по результатам (опционально)
    let allTrades: TradeResponse[] = [];
    let nextCursor = 'MA=='; // Начальный курсор
    const END_CURSOR = 'LTE='; // Маркер конца
    let pageCount = 0;

    while (nextCursor !== END_CURSOR) {
      const params: Record<string, string> = {
        limit: limit.toString(),
        next_cursor: nextCursor,
      };

      // Использовать effectiveMaker (параметр или this.makerAddress)
      if (effectiveMaker) {
        params.maker_address = effectiveMaker;
      }

      if (tokenId) {
        params.asset_id = tokenId;
      }

      // ✅ v7.7.10: Использовать эндпоинт /data/trades (не /data/orders!)
      // ✅ v7.7.11: API возвращает { data: [...], next_cursor: "..." }, НЕ массив напрямую!
      const response = await this.restClient.get<TradesPageResponse>('/data/trades', params);

      // ✅ v7.7.11: Извлечь поле data из ответа (формат пагинированного ответа)
      const trades: TradeResponse[] = Array.isArray(response?.data) ? response.data : [];

      pageCount++;

      this.logger.debug('[PolymarketOrderRestClient] v7.7.12: Page fetched', {
        page: pageCount,
        count: trades.length,
        nextCursor: response?.next_cursor || 'none',
      });

      allTrades = [...allTrades, ...trades];

      // Обновить курсор для следующей итерации
      nextCursor = response?.next_cursor || END_CURSOR;

      // Безопасность: остановиться, если больше нет данных
      if (trades.length === 0) {
        break;
      }

      // ✅ v7.7.12: Остановиться после первой страницы, если запрошено
      if (onlyFirstPage) {
        this.logger.debug('[PolymarketOrderRestClient] v7.7.12: Stopping after first page');
        break;
      }
    }

    this.logger.info('[PolymarketOrderRestClient]: Fills from /data/trades retrieved', {
      totalCount: allTrades.length,
      pages: pageCount,
      tokenIdFilter: tokenId ? tokenId.substring(0, 16) + '...' : 'all',
      makerAddress: effectiveMaker ? effectiveMaker.substring(0, 10) + '...' : 'none',
      limit,
      onlyFirstPage,
    });

    // ✅ v7.7.12: Отфильтровать сделки при необходимости
    if (!includeAllTrades) {
      const beforeFilter = allTrades.length;

      // Отфильтровать только сделки, где мы были MAKER
      allTrades = allTrades.filter((trade) => trade.trader_side === 'MAKER');

      this.logger.info('[PolymarketOrderRestClient] 📊 v7.7.12: Filtered to MAKER trades only', {
        before: beforeFilter,
        after: allTrades.length,
        filtered: beforeFilter - allTrades.length,
      });
    }

    return allTrades;
  }
}
