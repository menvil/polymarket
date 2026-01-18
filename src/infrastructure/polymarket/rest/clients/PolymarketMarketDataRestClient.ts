/**
 * REST-клиент для рыночных данных Polymarket
 *
 * @remarks
 * Обрабатывает эндпоинты Gamma API Polymarket:
 * - GET /markets - Получить все рынки
 * - GET /markets/{tokenId} - Получить информацию о конкретном рынке
 *
 * Возвращает СЫРЫЕ ответы API (НЕ нормализованные).
 * Нормализация выполняется мапперами на более высоких уровнях.
 *
 * **ВАЖНО**: Использует Gamma API (публичный API), НЕ CLOB API.
 * Базовый URL: https://gamma-api.polymarket.com
 *
 * Заменяет GammaApiClient.
 *
 * @example
 * ```typescript
 * const client = new PolymarketMarketDataRestClient(config, logger);
 *
 * const markets = await client.getActiveMarkets();
 * console.log(`Active markets: ${markets.length}`);
 *
 * const market = await client.getMarketInfo('0x123');
 * console.log(`Market: ${market.question}`);
 *
 * const constraints = await client.getMarketConstraints('0x123');
 * console.log(`Min size: ${constraints.minimum_order_size}`);
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { GammaMarketData } from '../../../../domain/services/market-discovery/types.js';
import type { IMarketDataProvider } from '../../../../domain/services/market-discovery/MarketDiscoveryService.js';
import { ApiError } from '../../../../shared/errors/TradingError.js';

/**
 * Конфигурация клиента рыночных данных
 */
export interface MarketDataClientConfig {
  /** Базовый URL Gamma API */
  baseUrl: string;

  /** Таймаут запроса в миллисекундах */
  timeout?: number;
}

/**
 * Ответ с исходом рынка (сырой формат API)
 */
export interface MarketOutcomeResponse {
  /** ID токена */
  token_id: string;

  /** Название исхода (например, "Up", "Down") */
  name: string;

  /** Текущая цена */
  price?: string;
}

/**
 * Ответ с информацией о рынке (сырой формат API из Gamma API)
 *
 * @remarks
 * Gamma API возвращает имена полей в формате camelCase, НЕ snake_case!
 *
 * Пример: https://gamma-api.polymarket.com/markets
 */
export interface MarketInfoResponse {
  /** ID условия рынка */
  conditionId: string;

  /** Вопрос рынка */
  question: string;

  /** Слаг рынка для URL */
  slug?: string;

  /** ID токенов CLOB - JSON строка массива */
  clobTokenIds: string;  // Всегда строка из API: "[\"token1\", \"token2\"]"

  /** Исходы - JSON строка массива */
  outcomes: string;  // Всегда строка из API: "[\"Yes\", \"No\"]"

  /** Статус рынка */
  active: boolean;

  /** Статус закрытия рынка */
  closed: boolean;

  /** Книга ордеров включена */
  enableOrderBook: boolean;

  /** Дата окончания (ISO строка) */
  endDate: string;  // Формат ISO: "2026-01-25T00:00:00Z"

  /** Ликвидность (строковое число) */
  liquidity?: string;

  /** Объем (строковое число) */
  volume?: string;

  /** Спред (спред бид-аск) */
  spread?: number;

  /** Лучшая цена бида */
  bestBid?: number;

  /** Лучшая цена аска */
  bestAsk?: number;

  /** Цены исходов - JSON строка массива */
  outcomePrices?: string;

  /** Минимальный шаг цены ордера */
  orderPriceMinTickSize?: number;

  /** Минимальный размер ордера */
  orderMinSize?: number;
}

/**
 * Ограничения рынка
 */
export interface MarketConstraintsResponse {
  /** Минимальная СТОИМОСТЬ ордера в USD для ордеров BUY */
  minimum_order_value?: number;

  /** Минимальный РАЗМЕР ордера в акциях для ордеров SELL */
  minimum_order_size?: number;

  /** Максимальный размер ордера */
  maximum_order_size: number;

  /** Шаг размера (минимальное приращение размера) */
  minimum_tick_size: number;

  /** Шаг цены (минимальное приращение цены) */
  minimum_price_tick: number;
}

/**
 * REST-клиент для рыночных данных Polymarket
 *
 * @remarks
 * Реализует IMarketDataProvider для использования с MarketDiscoveryService.
 * Преобразует сырые ответы API (snake_case) в доменные типы (camelCase).
 */
export class PolymarketMarketDataRestClient implements IMarketDataProvider {
  private readonly config: Required<MarketDataClientConfig>;
  private readonly logger: ILogger;

  /**
   * Создать клиент рыночных данных Polymarket
   *
   * @param config - Конфигурация клиента
   * @param logger - Экземпляр логгера
   *
   * @example
   * ```typescript
   * const client = new PolymarketMarketDataRestClient({
   *   baseUrl: 'https://gamma-api.polymarket.com',
   * }, logger);
   * ```
   */
  constructor(config: MarketDataClientConfig, logger: ILogger) {
    this.config = {
      ...config,
      timeout: config.timeout ?? 30000, // 30 секунд по умолчанию
    };

    this.logger = logger.child?.('PolymarketMarketDataRestClient') ?? logger;
  }

  /**
   * Получить все активные рынки (реализация IMarketDataProvider)
   *
   * @returns Массив рыночных данных в доменном формате (GammaMarketData)
   * @throws {ApiError} Если вызов API завершается с ошибкой
   *
   * @remarks
   * Реализует интерфейс IMarketDataProvider.
   * Получает сырые данные API и преобразует их в доменный формат (camelCase).
   *
   * @example
   * ```typescript
   * const markets = await client.getActiveMarkets();
   * console.log(`Active markets: ${markets.length}`);
   *
   * markets.forEach(market => {
   *   console.log(`${market.question} - Ends: ${market.endDate}`);
   * });
   * ```
   */
  async getActiveMarkets(): Promise<GammaMarketData[]> {
    const allMarkets: GammaMarketData[] = [];
    let offset = 0;
    const limit = 500;
    const maxPages = 50; // Максимум 25 000 рынков

    this.logger.info('[Gamma API] Fetching active markets...');

    try {
      for (let page = 0; page < maxPages; page++) {
        const url = new URL(`${this.config.baseUrl}/markets`);
        // Полный набор фильтров для активных рынков (как в официальном Polymarket agents)
        url.searchParams.set('active', 'true');
        url.searchParams.set('closed', 'false');
        url.searchParams.set('archived', 'false');
        url.searchParams.set('limit', limit.toString());
        url.searchParams.set('offset', offset.toString());
        url.searchParams.set('order', 'volume'); // Сортировка по объему
        url.searchParams.set('ascending', 'false'); // По убыванию (сначала наибольший объем)

        const rawMarkets = await this.fetch<MarketInfoResponse[]>(url.toString(), true);

        if (rawMarkets.length === 0) {
          break;
        }

        // Преобразовать и накопить
        const mappedMarkets = rawMarkets.map((raw) => this.mapToDomainFormat(raw));
        allMarkets.push(...mappedMarkets);

        offset += limit;

        // Если получили меньше лимита, значит достигнут конец
        if (rawMarkets.length < limit) {
          break;
        }
      }

      this.logger.info('[Gamma API] Fetched active markets', {
        total: allMarkets.length,
      });

      return allMarkets;
    } catch (error) {
      this.logger.error('[Gamma API] Failed to fetch active markets', error);
      throw error;
    }
  }

  /**
   * Получить сырые активные рынки (для внутреннего использования)
   *
   * @returns Массив сырых ответов с информацией о рынках
   * @throws {Error} Если вызов API завершается с ошибкой
   *
   * @remarks
   * Возвращает сырой ответ API без преобразования.
   * Используйте getActiveMarkets() для доменного формата.
   */
  async getRawActiveMarkets(): Promise<MarketInfoResponse[]> {
    this.logger.debug('Getting raw active markets');

    // Полный набор фильтров для активных рынков (как в официальном Polymarket agents)
    const url = `${this.config.baseUrl}/markets?active=true&closed=false&archived=false`;
    const markets = await this.fetch<MarketInfoResponse[]>(url);

    this.logger.debug('Raw active markets retrieved', {
      count: markets.length,
    });

    return markets;
  }

  /**
   * Получить информацию о рынке по слагу или ID условия
   *
   * @param slugOrConditionId - Слаг рынка (предпочтительно) или ID условия (запасной вариант)
   * @returns Информация о рынке
   * @throws {Error} Если вызов API завершается с ошибкой или рынок не найден
   *
   * @remarks
   * Gamma API в основном использует **slug** (например, "bitcoin-up-or-down-january-8")
   * для эндпоинта /markets/{slug}, НЕ conditionId.
   *
   * Если API возвращает 404, conditionId может работать как запасной вариант для некоторых рынков.
   *
   * @example
   * ```typescript
   * // Preferred: use slug
   * const market = await client.getMarketInfo('bitcoin-up-or-down-january-8');
   *
   * // Fallback: use conditionId (may not work for all markets)
   * const market2 = await client.getMarketInfo('0x123...');
   * ```
   */
  async getMarketInfo(slugOrConditionId: string): Promise<MarketInfoResponse> {
    this.logger.debug('Getting market info', { slugOrConditionId });

    const url = `${this.config.baseUrl}/markets/${slugOrConditionId}`;
    const market = await this.fetch<MarketInfoResponse>(url);

    this.logger.debug('Market info retrieved', {
      slug: market.slug,
      conditionId: market.conditionId,
      question: market.question,
      active: market.active,
    });

    return market;
  }

  /**
   * Получить ограничения рынка
   *
   * @param slugOrConditionId - Слаг рынка (предпочтительно) или ID условия (запасной вариант)
   * @returns Ограничения рынка
   * @throws {Error} Если вызов API завершается с ошибкой
   *
   * @remarks
   * Возвращает мин/макс размеры, размеры шагов и т.д.
   * Если ограничения недоступны из API, возвращает безопасные значения по умолчанию.
   *
   * **ВАЖНО**: Gamma API использует **slug** (НЕ conditionId) для /markets/{id}.
   * Если вы передаете conditionId и получаете HTTP 422 "id is invalid", это ожидаемо.
   * Метод вернет безопасные значения по умолчанию.
   *
   * Для лучших результатов передавайте market.slug вместо market.conditionId.
   *
   * @example
   * ```typescript
   * // Preferred: use slug
   * const constraints = await client.getMarketConstraints('bitcoin-up-or-down-january-8');
   *
   * // Fallback: use conditionId (will return defaults on 422)
   * const constraints2 = await client.getMarketConstraints('0x123...');
   * ```
   */
  async getMarketConstraints(slugOrConditionId: string): Promise<MarketConstraintsResponse> {
    this.logger.debug('Getting market constraints', { slugOrConditionId });

    try {
      const market = await this.getMarketInfo(slugOrConditionId);

      const constraints: MarketConstraintsResponse = {
        minimum_order_value: 0, // Нет минимальной стоимости - требуется только минимум 1 акция
        minimum_order_size: market.orderMinSize ?? 1, // Минимум акций для ордеров SELL
        maximum_order_size: 10000, // API не предоставляет максимум, используем значение по умолчанию
        minimum_tick_size: 0.01, // API не предоставляет шаг размера, используем значение по умолчанию
        minimum_price_tick: market.orderPriceMinTickSize ?? 0.0001,
      };

      this.logger.debug('Market constraints retrieved', {
        slugOrConditionId,
        constraints,
      });

      return constraints;
    } catch (error) {
      // HTTP 422 ожидается, если передается conditionId вместо slug
      const is422 = error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 422;

      if (is422) {
        this.logger.debug('Market constraints unavailable (422 - need slug, not conditionId), using defaults', {
          slugOrConditionId,
        });
      } else {
        this.logger.warn('Failed to fetch market constraints, using defaults', {
          slugOrConditionId,
          error,
        });
      }

      // Вернуть безопасные значения по умолчанию
      // КРИТИЧНО: minimum_order_size = 1 (запасной вариант, когда API недоступен)
      return {
        minimum_order_value: 0, // Нет минимальной стоимости - требуется только минимум 1 акция
        minimum_order_size: 1, // Безопасное значение по умолчанию: минимум 1 акция
        maximum_order_size: 10000,
        minimum_tick_size: 0.01,
        minimum_price_tick: 0.0001,
      };
    }
  }

  /**
   * Преобразовать сырой ответ API в доменный формат
   *
   * @param raw - Сырой ответ с информацией о рынке (camelCase из Gamma API)
   * @returns Рыночные данные в доменном формате (camelCase)
   *
   * @remarks
   * Gamma API уже возвращает camelCase, поэтому преобразование минимально.
   * API возвращает JSON строки для clobTokenIds и outcomes - передаем как есть.
   * MarketFilter распарсит их позже.
   */
  private mapToDomainFormat(raw: MarketInfoResponse): GammaMarketData {
    return {
      conditionId: raw.conditionId,
      question: raw.question,
      slug: raw.slug,
      endDate: raw.endDate,  // Уже ISO строка из API
      active: raw.active,
      closed: raw.closed,
      enableOrderBook: raw.enableOrderBook,
      clobTokenIds: raw.clobTokenIds, // JSON строка: "[\"token1\", \"token2\"]"
      outcomes: raw.outcomes, // JSON строка: "[\"Yes\", \"No\"]"
      liquidity: raw.liquidity, // Строковое число из API
      spread: raw.spread, // Спред бид-аск из API
      bestBid: raw.bestBid, // Лучшая цена бида из API
      bestAsk: raw.bestAsk, // Лучшая цена аска из API
      orderMinSize: raw.orderMinSize, // Минимальный размер ордера из API (например, 5 акций)
      orderPriceMinTickSize: raw.orderPriceMinTickSize, // Шаг цены из API (например, 0.01)
      // Опциональные поля, отсутствующие в ответе API
      description: undefined,
      tags: undefined,
    };
  }

  /**
   * Универсальный помощник для запросов
   *
   * @param url - Полный URL
   * @param silent - Пропустить отладочное логирование (для пакетных операций)
   * @returns Данные ответа
   * @throws {Error} Если запрос завершается с ошибкой
   */
  private async fetch<T>(url: string, silent = false): Promise<T> {
    if (!silent) {
      this.logger.debug(`GET ${url}`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();

        // HTTP 422 ожидается при использовании conditionId вместо slug
        if (response.status === 422) {
          if (!silent) {
            this.logger.debug(`HTTP 422 (expected - need slug, not conditionId)`, {
              url,
              body: errorBody,
            });
          }
        } else {
          this.logger.error(`HTTP ${response.status} error`, {
            url,
            status: response.status,
            body: errorBody,
          });
        }

        throw new ApiError(`HTTP ${response.status}: ${response.statusText}`, {
          statusCode: response.status,
          endpoint: url,
          method: 'GET',
          responseBody: errorBody,
        });
      }

      const data = await response.json();

      if (!silent) {
        this.logger.debug(`GET ${url} → OK`);
      }

      return data as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if ((error as Error).name === 'AbortError') {
        throw new ApiError(`Request timeout after ${this.config.timeout}ms`, {
          endpoint: url,
          method: 'GET',
        });
      }

      throw error;
    }
  }
}
