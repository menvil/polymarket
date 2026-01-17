/**
 * HttpClient - базовый HTTP клиент с retry/timeout/error wrapping
 *
 * @remarks
 * Унифицированный HTTP клиент для всех REST API запросов.
 * Поддерживает:
 * - Retry с exponential backoff
 * - Timeout для запросов
 * - Error wrapping (HttpError)
 * - Structured logging
 * - Abort signal для отмены запросов
 *
 * Используется CLOBClient, GammaApiClient, OrderbookRestClient.
 *
 * @example
 * ```typescript
 * const client = new HttpClient({
 *   baseUrl: 'https://api.example.com',
 *   timeout: 10000,
 *   maxRetries: 3,
 *   retryDelay: 1000,
 * }, logger);
 *
 * const data = await client.fetchJson<ApiResponse>('/markets/123');
 * ```
 */

import type { ILogger } from '../../domain/ports/ILogger.js';
import { HttpError } from './HttpError.js';

/**
 * Конфигурация HttpClient
 */
export interface HttpClientConfig {
  /** Base URL для запросов */
  baseUrl: string;
  /** Timeout для запросов (мс) */
  timeout?: number;
  /** Максимальное количество retry попыток */
  maxRetries?: number;
  /** Начальная задержка между retry (мс) */
  retryDelay?: number;
  /** Максимальная задержка между retry (мс) */
  maxRetryDelay?: number;
  /** Custom headers для всех запросов */
  headers?: Record<string, string>;
}

/**
 * Опции для fetch запроса
 */
export interface FetchOptions {
  /** HTTP метод */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Request headers */
  headers?: Record<string, string>;
  /** Request body (будет сериализован в JSON) */
  body?: unknown;
  /** Abort signal для отмены запроса */
  signal?: AbortSignal;
  /** Переопределить timeout для этого запроса */
  timeout?: number;
}

/**
 * HttpClient - унифицированный HTTP клиент
 *
 * @remarks
 * Базовый клиент для всех REST API запросов.
 * Автоматически добавляет retry, timeout, error handling.
 */
export class HttpClient {
  private readonly config: Required<HttpClientConfig>;
  private readonly logger: ILogger;

  /**
   * Создаёт HttpClient
   *
   * @param config - Конфигурация клиента
   * @param logger - Logger для structured logging
   *
   * @example
   * ```typescript
   * const client = new HttpClient({
   *   baseUrl: 'https://clob.polymarket.com',
   *   timeout: 30000,
   *   maxRetries: 3,
   * }, logger);
   * ```
   */
  constructor(config: HttpClientConfig, logger: ILogger) {
    this.config = {
      baseUrl: config.baseUrl,
      timeout: config.timeout ?? 30000,
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 1000,
      maxRetryDelay: config.maxRetryDelay ?? 10000,
      headers: config.headers ?? {},
    };
    this.logger = logger;
  }

  /**
   * Выполняет HTTP запрос и парсит JSON ответ
   *
   * @param url - Относительный URL (будет добавлен к baseUrl)
   * @param options - Опции запроса
   * @returns Parsed JSON response
   * @throws {HttpError} При HTTP ошибке или timeout
   *
   * @remarks
   * Алгоритм:
   * 1. Попытка выполнить запрос с timeout
   * 2. При временной ошибке → retry с exponential backoff
   * 3. При успехе → parse JSON и вернуть
   * 4. При не-retryable ошибке → выбросить HttpError
   *
   * @example
   * ```typescript
   * const orderbook = await client.fetchJson<ApiOrderbook>('/markets/123/orderbook');
   * console.log(`Best bid: ${orderbook.bids[0].price}`);
   * ```
   */
  public async fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
    const fullUrl = this.buildUrl(url);
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        this.logger.debug(`[HttpClient] Request: ${options.method || 'GET'} ${fullUrl} (attempt ${attempt + 1}/${this.config.maxRetries + 1})`);

        // Выполняем запрос с timeout
        const response = await this.fetchWithTimeout(fullUrl, options);

        // Парсим JSON
        const data = await response.json();

        this.logger.debug(`[HttpClient] Success: ${options.method || 'GET'} ${fullUrl}`);
        return data as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Проверяем, нужен ли retry
        const shouldRetry = this.shouldRetry(error, attempt);

        if (!shouldRetry) {
          this.logger.error(`[HttpClient] Non-retryable error: ${lastError.message}`, {
            url: fullUrl,
            attempt: attempt + 1,
            error: lastError.message,
          });
          throw this.wrapError(lastError, fullUrl);
        }

        // Вычисляем задержку для retry (exponential backoff)
        const delay = this.calculateRetryDelay(attempt);

        this.logger.warn(`[HttpClient] Retry after ${delay}ms: ${lastError.message}`, {
          url: fullUrl,
          attempt: attempt + 1,
          maxRetries: this.config.maxRetries + 1,
        });

        // Ждём перед следующей попыткой
        await this.sleep(delay);
      }
    }

    // Все попытки исчерпаны
    this.logger.error(`[HttpClient] All retries failed: ${lastError?.message}`, {
      url: fullUrl,
      maxRetries: this.config.maxRetries + 1,
    });

    throw this.wrapError(lastError!, fullUrl);
  }

  /**
   * Выполняет fetch с timeout
   *
   * @param url - Full URL
   * @param options - Fetch options
   * @returns Response
   * @throws {HttpError} При timeout или HTTP ошибке
   *
   * @remarks
   * Использует AbortController для timeout.
   * Проверяет response.ok и выбрасывает HttpError при ошибке.
   */
  private async fetchWithTimeout(
    url: string,
    options: FetchOptions
  ): Promise<Response> {
    const timeout = options.timeout ?? this.config.timeout;
    const controller = new AbortController();
    const signal = options.signal ?? controller.signal;

    // Таймер для abort
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // Подготавливаем headers
      const headers = {
        'Content-Type': 'application/json',
        ...this.config.headers,
        ...options.headers,
      };

      // Подготавливаем body
      const body = options.body ? JSON.stringify(options.body) : undefined;

      // Выполняем fetch
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body,
        signal,
      });

      // Проверяем status
      if (!response.ok) {
        const responseBody = await this.tryParseJson(response);
        throw new HttpError(
          response.status,
          `HTTP ${response.status}: ${response.statusText}`,
          responseBody
        );
      }

      return response;
    } catch (error) {
      // Обработка timeout
      if (error instanceof Error && error.name === 'AbortError') {
        throw new HttpError(408, `Request timeout after ${timeout}ms`);
      }

      // Пробрасываем другие ошибки
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Пытается распарсить JSON из response
   *
   * @param response - Response объект
   * @returns Parsed JSON или null
   */
  private async tryParseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return await response.text();
    }
  }

  /**
   * Проверяет, нужен ли retry для ошибки
   *
   * @param error - Ошибка
   * @param attempt - Номер текущей попытки (0-based)
   * @returns true если нужен retry
   *
   * @remarks
   * Retry выполняется для:
   * - HttpError с retryable status (5xx, 429, 408)
   * - Network errors
   * - Timeout errors
   */
  private shouldRetry(error: unknown, attempt: number): boolean {
    // Достигли лимита попыток
    if (attempt >= this.config.maxRetries) {
      return false;
    }

    // HttpError с retryable status
    if (error instanceof HttpError) {
      return error.isRetryable();
    }

    // Network errors, timeout
    if (error instanceof Error) {
      return (
        error.name === 'AbortError' ||
        error.name === 'TypeError' || // Network error
        error.message.includes('fetch') ||
        error.message.includes('timeout')
      );
    }

    return false;
  }

  /**
   * Вычисляет задержку для retry с exponential backoff
   *
   * @param attempt - Номер попытки (0-based)
   * @returns Задержка в мс
   *
   * @remarks
   * Алгоритм: delay * (2 ^ attempt)
   * Максимальная задержка ограничена maxRetryDelay.
   *
   * @example
   * ```
   * attempt 0: 1000ms
   * attempt 1: 2000ms
   * attempt 2: 4000ms
   * attempt 3: 8000ms (или maxRetryDelay)
   * ```
   */
  private calculateRetryDelay(attempt: number): number {
    const delay = this.config.retryDelay * Math.pow(2, attempt);
    return Math.min(delay, this.config.maxRetryDelay);
  }

  /**
   * Оборачивает ошибку в HttpError
   *
   * @param error - Исходная ошибка
   * @param url - URL запроса
   * @returns HttpError
   */
  private wrapError(error: Error, url: string): HttpError {
    if (error instanceof HttpError) {
      return error;
    }

    // Timeout
    if (error.name === 'AbortError') {
      return new HttpError(408, `Request timeout: ${url}`);
    }

    // Network error
    return new HttpError(0, `Network error: ${error.message}`, { url });
  }

  /**
   * Строит полный URL из baseUrl и относительного URL
   *
   * @param url - Относительный URL
   * @returns Полный URL
   */
  private buildUrl(url: string): string {
    // Если URL уже полный (начинается с http/https)
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }

    // Убираем trailing slash из baseUrl
    const base = this.config.baseUrl.replace(/\/$/, '');

    // Убираем leading slash из url
    const path = url.replace(/^\//, '');

    return `${base}/${path}`;
  }

  /**
   * Асинхронная задержка
   *
   * @param ms - Задержка в мс
   * @returns Promise который resolve через ms
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
