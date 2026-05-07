/**
 * Polymarket REST Client
 *
 * @remarks
 * Базовый HTTP-клиент для Polymarket CLOB API.
 *
 * Возможности:
 * - Аутентификация (подписывает запросы приватным ключом)
 * - Ограничение частоты запросов
 * - Обработка ошибок
 * - Логика повтора (экспоненциальная задержка)
 * - Обработка таймаутов
 *
 * Это низкоуровневый клиент. Для конкретных эндпоинтов используйте специализированные клиенты:
 * - PolymarketOrderRestClient
 * - PolymarketBalanceRestClient
 * - PolymarketPositionsRestClient
 * - и т.д.
 *
 * @example
 * ```typescript
 * const client = new PolymarketRestClient({
 *   baseUrl: 'https://clob.polymarket.com',
 *   privateKey: process.env.PRIVATE_KEY!,
 *   chainId: 137,
 * }, logger);
 *
 * const data = await client.get<Balance[]>('/balances', {
 *   address: client.getAddress(),
 * });
 *
 * const order = await client.post<OrderResponse>('/order', {
 *   tokenId: '0x123',
 *   side: 'BUY',
 *   price: '0.52',
 *   size: '100',
 * });
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { PolymarketRestConfig, PolymarketL2Credentials } from './types.js';
import { SignatureType } from './types.js';
import { PolymarketSigner } from './auth/PolymarketSigner.js';
import { PolymarketL2Authenticator } from './auth/PolymarketL2Authenticator.js';
import type { DnsOverride } from '../dns/DnsOverride.js';

/**
 * Класс ошибки API
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Параметры запроса
 */
interface RequestOptions {
  /** Параметры строки запроса */
  params?: Record<string, string>;

  /** Заголовки запроса */
  headers?: Record<string, string>;

  /** Тело запроса */
  body?: unknown;

  /** Требовать подпись (по умолчанию: false для GET, true для POST/DELETE) */
  requireSignature?: boolean;
}

/**
 * Конфигурация Polymarket REST Client (с применёнными значениями по умолчанию)
 */
type ResolvedPolymarketRestConfig = Required<
  Omit<PolymarketRestConfig, 'l2Credentials' | 'funderAddress' | 'builderCode'>
> & {
  l2Credentials?: PolymarketL2Credentials;
  funderAddress?: string;
  builderCode?: string;
};

/**
 * Polymarket REST-клиент
 */
export class PolymarketRestClient {
  private readonly config: ResolvedPolymarketRestConfig;
  private readonly signer: PolymarketSigner;
  private readonly l2Authenticator: PolymarketL2Authenticator | null;
  private readonly logger: ILogger;
  private readonly _dnsOverride: DnsOverride | undefined;

  /**
   * Создаёт Polymarket REST-клиент
   *
   * @param config - Конфигурация клиента
   * @param logger - Экземпляр логгера
   * @param dnsOverride - Опциональный DnsOverride для обхода DNS-блокировок
   *
   * @example
   * ```typescript
   * const client = new PolymarketRestClient({
   *   baseUrl: 'https://clob.polymarket.com',
   *   privateKey: process.env.PRIVATE_KEY!,
   *   chainId: 137,
   * }, logger);
   * ```
   */
  constructor(config: PolymarketRestConfig, logger: ILogger, dnsOverride?: DnsOverride) {
    this.config = {
      ...config,
      timeout: config.timeout ?? 30000, // 30 секунд по умолчанию
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 1000,
      signatureType: config.signatureType ?? SignatureType.EOA, // По умолчанию EOA
    };

    this.signer = new PolymarketSigner(config.privateKey, config.chainId);
    this.logger = logger.child({ component: 'PolymarketRestClient' });
    this._dnsOverride = dnsOverride;

    // Создаём L2 аутентификатор если переданы credentials
    if (config.l2Credentials) {
      // POLY_ADDRESS = адрес оператора (из PRIVATE_KEY), даже при POLY_PROXY.
      // API ключ создаётся через подпись оператора → привязан к его адресу.
      this.l2Authenticator = new PolymarketL2Authenticator(
        config.l2Credentials,
        this.signer.getAddress(),
      );
      this.logger.debug('L2 authenticator initialized', {
        apiKey: config.l2Credentials.apiKey,
        address: this.signer.getAddress(),
        signatureType: this.config.signatureType,
      });
    } else {
      this.l2Authenticator = null;
      this.logger.warn('No L2 credentials provided - L2 endpoints will fail with 401');
    }
  }

  /**
   * GET-запрос
   *
   * @param endpoint - Эндпоинт API (например, '/balances')
   * @param params - Параметры строки запроса
   * @returns Данные ответа
   * @throws {ApiError} Если запрос завершился ошибкой
   *
   * @example
   * ```typescript
   * const balances = await client.get<Balance[]>('/balances', {
   *   address: client.getAddress(),
   * });
   * ```
   */
  async get<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>('GET', endpoint, { params });
  }

  /**
   * POST-запрос
   *
   * @param endpoint - Эндпоинт API (например, '/order')
   * @param body - Тело запроса
   * @param options - Дополнительные параметры
   * @returns Данные ответа
   * @throws {ApiError} Если запрос завершился ошибкой
   *
   * @example
   * ```typescript
   * const order = await client.post<OrderResponse>('/order', {
   *   tokenId: '0x123',
   *   side: 'BUY',
   *   price: '0.52',
   *   size: '100',
   *   nonce: Date.now(),
   * });
   * ```
   */
  async post<T>(endpoint: string, body: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', endpoint, {
      ...options,
      body,
      requireSignature: options?.requireSignature ?? true,
    });
  }

  /**
   * DELETE-запрос
   *
   * @param endpoint - Эндпоинт API (например, '/order')
   * @param body - Тело запроса
   * @param options - Дополнительные параметры
   * @returns Данные ответа
   * @throws {ApiError} Если запрос завершился ошибкой
   *
   * @example
   * ```typescript
   * await client.delete('/order', {
   *   orderId: 'order-123',
   *   timestamp: Date.now(),
   * });
   * ```
   */
  async delete<T>(endpoint: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', endpoint, {
      ...options,
      body,
      requireSignature: options?.requireSignature ?? true,
    });
  }

  /**
   * Универсальный HTTP-запрос с логикой повтора
   *
   * @param method - HTTP-метод
   * @param endpoint - Эндпоинт API
   * @param options - Параметры запроса
   * @returns Данные ответа
   * @throws {ApiError} Если все попытки завершились ошибкой
   */
  private async request<T>(
    method: string,
    endpoint: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const url = this.buildUrl(endpoint, options.params);

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await this.executeRequest<T>(method, url, options);
        return response;
      } catch (error) {
        const isLastAttempt = attempt === this.config.maxRetries;

        // Не повторяем при клиентских ошибках (4xx) — это постоянные сбои
        if (error instanceof ApiError && error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
          this.logger.error('Client error (4xx), not retrying', {
            method,
            endpoint,
            statusCode: error.statusCode,
            err: error,
          });
          throw error;
        }

        if (isLastAttempt) {
          this.logger.error(`Request failed after ${attempt + 1} attempts`, {
            method,
            endpoint,
            err: error,
          });
          throw error;
        }

        // Экспоненциальная задержка повтора
        const delay = this.config.retryDelay * Math.pow(2, attempt);
        this.logger.warn(`Request failed, retrying in ${delay}ms (attempt ${attempt + 1})`, {
          method,
          endpoint,
          error,
        });

        await this.sleep(delay);
      }
    }

    // Сюда никогда не должны попасть из-за throw в цикле
    throw new ApiError('Request failed after all retries');
  }

  /**
   * Выполняет одиночный HTTP-запрос
   *
   * @param method - HTTP-метод
   * @param url - Полный URL
   * @param options - Параметры запроса
   * @returns Данные ответа
   * @throws {ApiError} Если запрос завершился ошибкой
   */
  private async executeRequest<T>(
    method: string,
    url: string,
    options: RequestOptions
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    let body = options.body;

    // КРИТИЧНЫЙ ПОРЯДОК: Сначала добавляем EIP-712 подпись к телу, ЗАТЕМ создаём L2 HMAC подпись
    // Старый метод аутентификации (EIP-712) — добавляет поля signature/address к телу запроса
    if (options.requireSignature && body) {
      const signature = await this.signer.signData(body as Record<string, unknown>);
      body = {
        ...(body as Record<string, unknown>),
        signature,
        address: this.signer.getAddress(),
      };
    }

    // Добавляем заголовки L2 аутентификации если аутентификатор доступен
    // ВАЖНО: Это должно произойти ПОСЛЕ добавления EIP-712 подписи к телу!
    if (this.l2Authenticator) {
      // Извлекаем путь запроса из URL (ВАЖНО: без query-параметров!)
      // Официальный клиент Polymarket подписывает только путь, не query params
      const urlObj = new URL(url);
      const requestPath = urlObj.pathname;

      // Создаём строку тела для подписи (пустая строка для GET/DELETE)
      // КРИТИЧНО: Используем ФИНАЛЬНОЕ тело (с EIP-712 подписью если присутствует)
      const bodyString = body ? JSON.stringify(body) : '';

      // Создаём заголовки L2 аутентификации
      const l2Headers = this.l2Authenticator.createAuthHeaders(
        method,
        requestPath,
        bodyString
      );

      // Сливаем L2 заголовки с существующими
      Object.assign(headers, l2Headers);

      this.logger.debug('Added L2 authentication headers', {
        method,
        requestPath,
        fullUrl: url,
        apiKey: l2Headers.POLY_API_KEY,
        timestamp: l2Headers.POLY_TIMESTAMP,
      });
    }

    this.logger.debug(`${method} ${url}`, {
      headers,
      body: body ? JSON.stringify(body).substring(0, 200) : undefined,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        this.logger.error(`HTTP ${response.status} error`, {
          method,
          url,
          status: response.status,
          requestBody: body ? JSON.stringify(body).substring(0, 500) : undefined,
          responseBody: errorBody,
        });

        throw new ApiError(
          `HTTP ${response.status}: ${response.statusText}${errorBody ? ` - ${errorBody}` : ''}`,
          response.status,
          errorBody
        );
      }

      const data = await response.json();
      this.logger.debug(`${method} ${url} → OK`, {
        status: response.status,
      });

      return data as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof ApiError) {
        throw error;
      }

      if ((error as Error).name === 'AbortError') {
        throw new ApiError(`Request timeout after ${this.config.timeout}ms`);
      }

      // Уведомляем DNS override о сбое — следующий запрос получит другой IP
      if (this._dnsOverride) {
        try {
          const hostname = new URL(url).hostname;
          this._dnsOverride.notifyConnectionFailed(hostname);
        } catch {
          // игнорируем ошибки парсинга URL
        }
      }

      throw new ApiError(`Network error: ${(error as Error).message}`);
    }
  }

  /**
   * Формирует полный URL с параметрами строки запроса
   *
   * @param endpoint - Эндпоинт API
   * @param params - Параметры строки запроса
   * @returns Полный URL
   */
  private buildUrl(endpoint: string, params?: Record<string, string>): string {
    const url = new URL(endpoint, this.config.baseUrl);

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    return url.toString();
  }

  /**
   * Ожидает указанное количество миллисекунд
   *
   * @param ms - Количество миллисекунд для ожидания
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Возвращает адрес кошелька
   *
   * @returns Адрес кошелька
   */
  getAddress(): string {
    return this.signer.getAddress();
  }

  /**
   * Возвращает ID сети
   *
   * @returns ID сети
   */
  getChainId(): number {
    return this.signer.getChainId();
  }

  /**
   * Возвращает тип подписи
   *
   * @returns Тип подписи
   *
   * @remarks
   * Тип подписи определяет, какой тип кошелька используется:
   * - EOA (0): Стандартный аккаунт Ethereum
   * - POLY_PROXY (1): Proxy-кошелёк Polymarket (адрес фандера)
   * - POLY_GNOSIS_SAFE (2): Gnosis Safe мультиподпись
   */
  getSignatureType(): SignatureType {
    return this.config.signatureType!;
  }

  /**
   * Возвращает API-ключ
   *
   * @returns API-ключ для L2-аутентификации
   */
  getApiKey(): string {
    if (!this.l2Authenticator) {
      throw new Error('L2 authenticator not initialized - missing API credentials');
    }
    return this.config.l2Credentials!.apiKey;
  }

  /**
   * Возвращает подписант (для построения ордеров)
   *
   * @returns Экземпляр подписанта
   */
  getSigner() {
    return this.signer;
  }
}
