/**
 * CLOB (Central Limit Order Book) REST API Client для Polymarket
 *
 * @remarks
 * Клиент для взаимодействия с Polymarket CLOB API.
 * Поддерживает:
 * - Размещение ордеров (POST /order)
 * - Отмену ордеров (DELETE /order)
 * - Получение баланса (GET /balances)
 * - Получение позиций (GET /positions)
 * - Получение данных о рынке (GET /markets)
 * - Аутентификацию и подписание запросов
 * - Обработку ошибок и повторные попытки
 *
 * @example
 * ```typescript
 * const client = new CLOBClient({
 *   apiUrl: 'https://clob.polymarket.com',
 *   privateKey: process.env.PRIVATE_KEY!,
 *   chainId: 137
 * });
 *
 * const order = await client.placeOrder({
 *   tokenId: '0x123...',
 *   side: 'BUY',
 *   price: '0.55',
 *   size: '100'
 * });
 * ```
 */

import { ethers } from 'ethers' // NOTE: Requires 'npm install ethers' for production use
import type { HttpClient } from '../../../shared/http/HttpClient.js';

/**
 * Конфигурация CLOB клиента
 */
export interface CLOBClientConfig {
  /** HttpClient instance для HTTP запросов */
  httpClient: HttpClient;
  /** Приватный ключ для подписания */
  privateKey: string;
  /** Chain ID (137 для Polygon) */
  chainId: number;
}

/**
 * Параметры для размещения ордера
 */
export interface PlaceOrderParams {
  /** ID токена */
  tokenId: string;
  /** Сторона (BUY/SELL) */
  side: 'BUY' | 'SELL';
  /** Цена (0.01-0.99) */
  price: string;
  /** Размер в USDC */
  size: string;
  /** Тип ордера (по умолчанию LIMIT) */
  orderType?: 'LIMIT' | 'MARKET';
  /** Nonce для предотвращения replay-атак */
  nonce?: number;
}

/**
 * Ответ API при размещении ордера
 */
export interface PlaceOrderResponse {
  /** ID созданного ордера */
  orderId: string;
  /** Статус ордера */
  status: 'PENDING' | 'LIVE' | 'FILLED' | 'CANCELLED';
  /** ID токена */
  tokenId: string;
  /** Сторона */
  side: 'BUY' | 'SELL';
  /** Цена */
  price: string;
  /** Размер */
  size: string;
  /** Заполненный размер */
  filledSize: string;
  /** Время создания */
  timestamp: number;
}

/**
 * Параметры для отмены ордера
 */
export interface CancelOrderParams {
  /** ID ордера для отмены */
  orderId: string;
}

/**
 * Ответ API при отмене ордера
 */
export interface CancelOrderResponse {
  /** Успешность отмены */
  success: boolean;
  /** ID отменённого ордера */
  orderId: string;
  /** Статус после отмены */
  status: 'CANCELLED';
}

/**
 * Баланс пользователя
 */
export interface Balance {
  /** Токен (USDC) */
  asset: string;
  /** Общий баланс */
  total: string;
  /** Доступный баланс */
  available: string;
  /** Заблокированный баланс */
  locked: string;
}

/**
 * Позиция пользователя
 */
export interface Position {
  /** ID токена */
  tokenId: string;
  /** Количество */
  quantity: string;
  /** Сторона (YES/NO) */
  side: 'YES' | 'NO';
  /** Средняя цена входа */
  averagePrice: string;
  /** Реализованный P&L */
  realizedPnl: string;
  /** Нереализованный P&L */
  unrealizedPnl: string;
}

/**
 * Данные о рынке
 */
/**
 * Outcome data in MarketData
 */
export interface MarketDataOutcome {
  /** Token ID for this outcome */
  tokenId: string;
}

/**
 * Market data from CLOB API
 */
export interface MarketData {
  /** ID рынка */
  marketId: string;
  /** Название рынка */
  question: string;
  /** Outcomes array [outcome0, outcome1] */
  outcomes: [MarketDataOutcome, MarketDataOutcome];
  /** Outcome names (e.g., "Up", "Down", "Yes", "No") - required */
  outcomeNames: [string, string];
  /** Время истечения */
  endDate: number;
  /** Статус рынка */
  active: boolean;
}

/**
 * CLOB REST API клиент
 *
 * @remarks
 * Клиент для работы с Polymarket CLOB API.
 * Автоматически подписывает все запросы приватным ключом.
 * Использует HttpClient для всех HTTP запросов (retry, timeout, error handling).
 */
export class CLOBClient {
  private readonly httpClient: HttpClient;
  private readonly wallet: ethers.Wallet;
  private readonly chainId: number;

  /**
   * Создаёт новый CLOB клиент
   *
   * @param config - Конфигурация клиента
   *
   * @example
   * ```typescript
   * const client = new CLOBClient({
   *   httpClient: httpClient,
   *   privateKey: process.env.PRIVATE_KEY!,
   *   chainId: 137
   * });
   * ```
   */
  constructor(config: CLOBClientConfig) {
    this.httpClient = config.httpClient;
    this.wallet = new ethers.Wallet(config.privateKey);
    this.chainId = config.chainId;
  }

  /**
   * Размещает ордер на бирже
   *
   * @param params - Параметры ордера
   * @returns Ответ с данными созданного ордера
   * @throws {Error} При ошибке API или сети
   *
   * @example
   * ```typescript
   * const order = await client.placeOrder({
   *   tokenId: '0x123...',
   *   side: 'BUY',
   *   price: '0.55',
   *   size: '100'
   * });
   * console.log('Order placed:', order.orderId);
   * ```
   */
  public async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResponse> {
    const nonce = params.nonce ?? Date.now();
    const orderData = {
      tokenId: params.tokenId,
      side: params.side,
      price: params.price,
      size: params.size,
      orderType: params.orderType ?? 'LIMIT',
      nonce,
    };

    // Подписываем данные ордера
    const signature = await this.signOrderData(orderData);

    const response = await this.httpClient.fetchJson<PlaceOrderResponse>('/order', {
      method: 'POST',
      body: {
        ...orderData,
        signature,
        address: this.wallet.address,
      },
    });

    return response;
  }

  /**
   * Отменяет ордер
   *
   * @param params - Параметры отмены
   * @returns Ответ с результатом отмены
   * @throws {Error} При ошибке API или сети
   *
   * @example
   * ```typescript
   * const result = await client.cancelOrder({ orderId: '123' });
   * console.log('Order cancelled:', result.success);
   * ```
   */
  public async cancelOrder(params: CancelOrderParams): Promise<CancelOrderResponse> {
    const cancelData = {
      orderId: params.orderId,
      timestamp: Date.now(),
    };

    // Подписываем данные отмены
    const signature = await this.signCancelData(cancelData);

    const response = await this.httpClient.fetchJson<CancelOrderResponse>('/order', {
      method: 'DELETE',
      body: {
        ...cancelData,
        signature,
        address: this.wallet.address,
      },
    });

    return response;
  }

  /**
   * Получает список открытых ордеров пользователя
   *
   * @param tokenId - Опциональный фильтр по tokenId
   * @returns Массив открытых ордеров
   * @throws {Error} При ошибке API или сети
   *
   * @remarks
   * Возвращает только PENDING и OPEN (LIVE) ордера.
   * FILLED и CANCELLED ордера не включаются в результат.
   *
   * @example
   * ```typescript
   * // Все открытые ордера
   * const allOrders = await client.getOrders();
   *
   * // Ордера для конкретного токена
   * const tokenOrders = await client.getOrders('0x123...');
   * ```
   */
  public async getOrders(tokenId?: string): Promise<PlaceOrderResponse[]> {
    // Build query string for GET request
    const params = new URLSearchParams({
      address: this.wallet.address,
    });

    if (tokenId) {
      params.append('tokenId', tokenId);
    }

    const url = `/orders?${params.toString()}`;
    const response = await this.httpClient.fetchJson<PlaceOrderResponse[]>(url, {
      method: 'GET',
    });

    return response;
  }

  /**
   * Получает баланс пользователя
   *
   * @returns Массив балансов по токенам
   * @throws {Error} При ошибке API или сети
   *
   * @example
   * ```typescript
   * const balances = await client.getBalances();
   * const usdcBalance = balances.find(b => b.asset === 'USDC');
   * console.log('Available USDC:', usdcBalance?.available);
   * ```
   */
  public async getBalances(): Promise<Balance[]> {
    const params = new URLSearchParams({
      address: this.wallet.address,
    });

    const url = `/balances?${params.toString()}`;
    const response = await this.httpClient.fetchJson<Balance[]>(url, {
      method: 'GET',
    });

    return response;
  }

  /**
   * Получает позиции пользователя
   *
   * @returns Массив открытых позиций
   * @throws {Error} При ошибке API или сети
   *
   * @example
   * ```typescript
   * const positions = await client.getPositions();
   * positions.forEach(p => {
   *   console.log(`${p.side}: ${p.quantity} @ ${p.averagePrice}`);
   * });
   * ```
   */
  public async getPositions(): Promise<Position[]> {
    const params = new URLSearchParams({
      address: this.wallet.address,
    });

    const url = `/positions?${params.toString()}`;
    const response = await this.httpClient.fetchJson<Position[]>(url, {
      method: 'GET',
    });

    return response;
  }

  /**
   * Получает данные о рынке
   *
   * @param marketId - ID рынка
   * @returns Данные о рынке
   * @throws {Error} При ошибке API или сети
   *
   * @example
   * ```typescript
   * const market = await client.getMarket('0xabc...');
   * console.log('Market:', market.question);
   * console.log('Expires:', new Date(market.endDate * 1000));
   * ```
   */
  public async getMarket(marketId: string): Promise<MarketData> {
    // Public endpoint - no auth required
    const url = `/markets/${marketId}`;
    const response = await this.httpClient.fetchJson<MarketData>(url, {
      method: 'GET',
    });

    return response;
  }

  /**
   * Подписывает данные ордера
   *
   * @param orderData - Данные ордера для подписи
   * @returns Подпись в hex формате
   */
  private async signOrderData(orderData: Record<string, unknown>): Promise<string> {
    const message = this.encodeOrderData(orderData);
    const signature = await this.wallet.signMessage(message);
    return signature;
  }

  /**
   * Подписывает данные отмены ордера
   *
   * @param cancelData - Данные отмены для подписи
   * @returns Подпись в hex формате
   */
  private async signCancelData(cancelData: Record<string, unknown>): Promise<string> {
    const message = this.encodeCancelData(cancelData);
    const signature = await this.wallet.signMessage(message);
    return signature;
  }

  /**
   * Кодирует данные ордера для подписи
   *
   * @param orderData - Данные ордера
   * @returns Закодированное сообщение
   */
  private encodeOrderData(orderData: Record<string, unknown>): string {
    // Простое кодирование для примера
    // В реальности нужно использовать EIP-712 typed data
    return JSON.stringify(orderData);
  }

  /**
   * Кодирует данные отмены для подписи
   *
   * @param cancelData - Данные отмены
   * @returns Закодированное сообщение
   */
  private encodeCancelData(cancelData: Record<string, unknown>): string {
    return JSON.stringify(cancelData);
  }


  /**
   * Возвращает адрес кошелька
   *
   * @returns Адрес кошелька
   */
  public getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Возвращает chainId
   *
   * @returns Chain ID
   */
  public getChainId(): number {
    return this.chainId;
  }
}
