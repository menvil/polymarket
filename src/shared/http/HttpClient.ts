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
  /** Заголовки запроса */
  headers?: Record<string, string>;
  /** Тело запроса (будет сериализован в JSON) */
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
   * @returns Распарсенный JSON ответ
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

        // Парсим ответ (с защитой от пустых и не-JSON ответов)
        const data = await this.parseResponseBody<T>(response);

        this.logger.debug(`[HttpClient] Success: ${options.method || 'GET'} ${fullUrl}`);
        return data;
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
   * @param url - Полный URL
   * @param options - Опции запроса
   * @returns Response
   * @throws {HttpError} При тайм-ауте или HTTP ошибке
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

    // Используем локальный controller для композиции timeout + external signal
    // Это гарантирует что и timeout, и external abort работают корректно
    const controller = new AbortController();

    // Если передан внешний signal, пробрасываем его abort на наш controller
    let externalAbortHandler: (() => void) | undefined;
    if (options.signal) {
      // Если внешний signal уже aborted, сразу abort наш controller
      if (options.signal.aborted) {
        controller.abort();
      } else {
        externalAbortHandler = () => controller.abort();
        options.signal.addEventListener('abort', externalAbortHandler);
      }
    }

    // Таймер для abort (всегда работает через наш controller)
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

      // Выполняем fetch с нашим controller.signal (композиция timeout + external)
      const response = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body,
        signal: controller.signal,
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
      // Cleanup: удаляем listener и очищаем timeout
      clearTimeout(timeoutId);
      if (externalAbortHandler && options.signal) {
        options.signal.removeEventListener('abort', externalAbortHandler);
      }
    }
  }

  /**
   * Пытается распарсить JSON из response
   *
   * @param response - Объект Response
   * @returns Распарсенный JSON или null
   */
  private async tryParseJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return await response.text();
    }
  }

  /**
   * Парсит тело ответа с защитой от пустых и не-JSON ответов
   *
   * @param response - Объект Response
   * @returns Распарсенные данные или null для пустых ответов
   *
   * @remarks
   * Обрабатывает следующие случаи:
   * - 204 No Content / 205 Reset Content → null (нет тела)
   * - Content-Type без application/json → null
   * - Пустое тело → null
   * - JSON тело → распарсенный объект
   *
   * Это предотвращает ошибки при вызове response.json() на пустых ответах,
   * которые раньше вызывали retry loop для успешных запросов.
   */
  private async parseResponseBody<T>(response: Response): Promise<T | null> {
    // 204 No Content / 205 Reset Content - нет тела по определению
    if (response.status === 204 || response.status === 205) {
      return null;
    }

    // Проверяем Content-Type header
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      // Не JSON ответ - возвращаем null вместо ошибки парсинга
      return null;
    }

    // Пытаемся распарсить JSON
    try {
      return await response.json() as T;
    } catch {
      // Пустое тело или невалидный JSON - возвращаем null
      return null;
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
   * Повторная попытка выполняется для:
   * - HttpError с повторяемым статусом (5xx, 429, 408)
   * - Сетевые ошибки (TypeError, ошибки fetch)
   *
   * НЕ повторяемые:
   * - AbortError (внешняя/пользовательская отмена)
   * - Тайм-аут уже конвертирован в HttpError(408) в fetchWithTimeout
   */
  private shouldRetry(error: unknown, attempt: number): boolean {
    // Достигли лимита попыток
    if (attempt >= this.config.maxRetries) {
      return false;
    }

    // HttpError с повторяемым статусом
    if (error instanceof HttpError) {
      return error.isRetryable();
    }

    // Сетевые ошибки (НЕ AbortError - см. ниже)
    if (error instanceof Error) {
      // AbortError НЕ повторяемый:
      // - Тайм-аут уже конвертирован в HttpError(408) в fetchWithTimeout
      // - Любой AbortError здесь = внешняя/пользовательская отмена
      // - Пользовательская отмена не должна повторяться
      if (error.name === 'AbortError') {
        return false;
      }

      return (
        error.name === 'TypeError' || // Сетевая ошибка (напр., ошибка DNS)
        error.message.includes('fetch') ||
        error.message.includes('timeout')
      );
    }

    return false;
  }

  /**
   * Вычисляет задержку для retry с exponential backoff + jitter
   *
   * @param attempt - Номер попытки (0-based)
   * @returns Задержка в мс
   *
   * @remarks
   * Алгоритм: delay * (2 ^ attempt) * jitter
   * - Jitter: случайный множитель 0.5–1.5 для предотвращения эффекта "громовое стадо"
   * - Максимальная задержка ограничена maxRetryDelay
   *
   * Проблема "громового стада":
   * Без jitter все клиенты повторяют запросы одновременно после ошибки сервера,
   * создавая пиковую нагрузку. Jitter распределяет повторные попытки во времени.
   *
   * @example
   * ```
   * attempt 0: 500-1500ms (base 1000ms ± 50%)
   * attempt 1: 1000-3000ms (base 2000ms ± 50%)
   * attempt 2: 2000-6000ms (base 4000ms ± 50%)
   * attempt 3: maxRetryDelay (если base превышает)
   * ```
   */
  private calculateRetryDelay(attempt: number): number {
    // Базовая экспоненциальная задержка
    const baseDelay = this.config.retryDelay * Math.pow(2, attempt);

    // Jitter: множитель 0.5–1.5 для распределения повторных попыток во времени
    // Это предотвращает эффект "громового стада" когда много клиентов повторяют одновременно
    const jitter = 0.5 + Math.random(); // 0.5 to 1.5

    const delayWithJitter = baseDelay * jitter;

    // Ограничиваем максимальной задержкой
    return Math.min(delayWithJitter, this.config.maxRetryDelay);
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

    // Тайм-аут
    if (error.name === 'AbortError') {
      return new HttpError(408, `Request timeout: ${url}`);
    }

    // Сетевая ошибка
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
