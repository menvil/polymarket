/**
 * REST-клиент рыночных данных Polymarket
 *
 * @remarks
 * Обрабатывает endpoints Gamma API Polymarket:
 * - GET /markets - Получить все маркеты
 * - GET /markets/{tokenId} - Получить информацию о конкретном маркете
 *
 * Возвращает СЫРЫЕ ответы API (НЕ нормализованные).
 * Нормализация выполняется маппером в вышестоящих слоях.
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

import type { ILogger } from '@polymarket/logger';
import type { GammaMarketData } from '../../stubs/domain/services/market-discovery/types.js';
import type { IMarketDataProvider } from '../../stubs/domain/services/market-discovery/MarketDiscoveryService.js';

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
 * Ответ с исходом маркета (сырой формат API)
 */
export interface MarketOutcomeResponse {
  /** Идентификатор токена */
  token_id: string;

  /** Название исхода (например, "Up", "Down") */
  name: string;

  /** Текущая цена */
  price?: string;
}

/**
 * Ответ с информацией о маркете (сырой формат API от Gamma API)
 *
 * @remarks
 * Gamma API возвращает поля в camelCase, а НЕ в snake_case!
 *
 * Пример: https://gamma-api.polymarket.com/markets
 */
export interface MarketInfoResponse {
  /** Идентификатор условия маркета */
  conditionId: string;

  /** Вопрос маркета */
  question: string;

  /** Слаг маркета для URL */
  slug?: string;

  /** Идентификаторы CLOB-токенов — JSON-строка массива */
  clobTokenIds: string;  // Всегда строка из API: "[\"token1\", \"token2\"]"

  /** Исходы — JSON-строка массива */
  outcomes: string;  // Всегда строка из API: "[\"Yes\", \"No\"]"

  /** Статус маркета */
  active: boolean;

  /** Статус закрытого маркета */
  closed: boolean;

  /** Стакан ордеров включён */
  enableOrderBook: boolean;

  /** Дата окончания (строка ISO) */
  endDate: string;  // Формат ISO: "2026-01-25T00:00:00Z"

  /** Ликвидность (строковое число) */
  liquidity?: string;

  /** Объём (строковое число) */
  volume?: string;

  /** Спред (bid-ask спред) */
  spread?: number;

  /** Лучшая цена bid */
  bestBid?: number;

  /** Лучшая цена ask */
  bestAsk?: number;

  /** Цены исходов — JSON-строка массива */
  outcomePrices?: string;

  /** Минимальный шаг цены ордера */
  orderPriceMinTickSize?: number;

  /** Минимальный размер ордера */
  orderMinSize?: number;
}

/**
 * Ограничения маркета
 */
export interface MarketConstraintsResponse {
  /** Минимальная СТОИМОСТЬ ордера в USD для BUY-ордеров ($1) */
  minimum_order_value?: number;

  /** Минимальный РАЗМЕР ордера в акциях для SELL-ордеров */
  minimum_order_size?: number;

  /** Максимальный размер ордера */
  maximum_order_size: number;

  /** Шаг размера (минимальный шаг увеличения размера) */
  minimum_tick_size: number;

  /** Шаг цены (минимальный шаг увеличения цены) */
  minimum_price_tick: number;
}

/**
 * REST-клиент рыночных данных Polymarket
 *
 * @remarks
 * Реализует IMarketDataProvider для использования с MarketDiscoveryService.
 * Маппирует сырые ответы API (snake_case) в доменные типы (camelCase).
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

    this.logger = logger.child({ component: 'PolymarketMarketDataRestClient' });
  }

  /**
   * Получить все активные маркеты (реализация IMarketDataProvider)
   *
   * @returns Массив рыночных данных в доменном формате (GammaMarketData)
   * @throws {Error} При ошибке API-вызова
   *
   * @remarks
   * Реализует интерфейс IMarketDataProvider.
   * Запрашивает сырые данные API и маппирует в доменный формат (camelCase).
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
    const maxPages = 50; // Максимум 25 000 маркетов

    this.logger.info('[Gamma API] Fetching active markets...');

    try {
      for (let page = 0; page < maxPages; page++) {
        const url = new URL(`${this.config.baseUrl}/markets`);
        url.searchParams.set('closed', 'false');
        url.searchParams.set('limit', limit.toString());
        url.searchParams.set('offset', offset.toString());
        url.searchParams.set('order', 'volume'); // Сортировка по объёму
        url.searchParams.set('ascending', 'false'); // По убыванию (наибольший объём первым)

        const rawMarkets = await this.fetch<MarketInfoResponse[]>(url.toString(), true);

        if (rawMarkets.length === 0) {
          break;
        }

        // Маппируем и накапливаем
        const mappedMarkets = rawMarkets.map((raw) => this.mapToDomainFormat(raw));
        allMarkets.push(...mappedMarkets);

        offset += limit;

        // Если получили меньше limit, значит достигли конца
        if (rawMarkets.length < limit) {
          break;
        }
      }

      this.logger.info('[Gamma API] Fetched active markets', {
        total: allMarkets.length,
      });

      return allMarkets;
    } catch (error) {
      this.logger.error('[Gamma API] Failed to fetch active markets', { err: error instanceof Error ? error : new Error(String(error)) });
      throw error;
    }
  }

  /**
   * Получить сырые активные маркеты (для внутреннего использования)
   *
   * @returns Массив сырых ответов с информацией о маркетах
   * @throws {Error} При ошибке API-вызова
   *
   * @remarks
   * Возвращает сырой ответ API без маппинга.
   * Используйте getActiveMarkets() для доменного формата.
   */
  async getRawActiveMarkets(): Promise<MarketInfoResponse[]> {
    this.logger.debug('Getting raw active markets');

    const url = `${this.config.baseUrl}/markets?active=true`;
    const markets = await this.fetch<MarketInfoResponse[]>(url);

    this.logger.debug('Raw active markets retrieved', {
      count: markets.length,
    });

    return markets;
  }

  /**
   * Получить информацию о маркете по slug или condition ID
   *
   * @param slugOrConditionId - Слаг маркета (предпочтительно) или condition ID (запасной вариант)
   * @returns Информация о маркете
   * @throws {Error} При ошибке API-вызова или если маркет не найден
   *
   * @remarks
   * Gamma API использует **slug** (например, "bitcoin-up-or-down-january-8")
   * для endpoint /markets/{slug}, а НЕ conditionId.
   *
   * Если API вернёт 404, conditionId может сработать как запасной вариант для некоторых маркетов.
   *
   * @example
   * ```typescript
   * // Предпочтительно: использовать slug
   * const market = await client.getMarketInfo('bitcoin-up-or-down-january-8');
   *
   * // Запасной вариант: использовать conditionId (может не работать для всех маркетов)
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
   * Получить ограничения маркета
   *
   * @param slugOrConditionId - Слаг маркета (предпочтительно) или condition ID (запасной вариант)
   * @returns Ограничения маркета
   * @throws {Error} При ошибке API-вызова
   *
   * @remarks
   * Возвращает min/max размеры, шаги цены и т.д.
   * Если ограничения недоступны из API, возвращает безопасные значения по умолчанию.
   *
   * **ВАЖНО**: Gamma API использует **slug** (НЕ conditionId) для /markets/{id}.
   * Если передать conditionId и получить HTTP 422 "id is invalid" — это ожидаемо.
   * Метод вернёт безопасные значения по умолчанию.
   *
   * Для лучших результатов передавайте market.slug вместо market.conditionId.
   *
   * @example
   * ```typescript
   * // Предпочтительно: использовать slug
   * const constraints = await client.getMarketConstraints('bitcoin-up-or-down-january-8');
   *
   * // Запасной вариант: использовать conditionId (вернёт дефолты при 422)
   * const constraints2 = await client.getMarketConstraints('0x123...');
   * ```
   */
  async getMarketConstraints(slugOrConditionId: string): Promise<MarketConstraintsResponse> {
    this.logger.debug('Getting market constraints', { slugOrConditionId });

    try {
      const market = await this.getMarketInfo(slugOrConditionId);

      const constraints: MarketConstraintsResponse = {
        minimum_order_value: 0, // Нет минимального значения — требуется минимум 1 акция
        minimum_order_size: market.orderMinSize ?? 10, // Минимум акций для SELL-ордеров
        maximum_order_size: 10000, // API не предоставляет максимум — используем дефолт
        minimum_tick_size: 0.01, // API не предоставляет шаг размера — используем дефолт
        minimum_price_tick: market.orderPriceMinTickSize ?? 0.0001,
      };

      this.logger.debug('Market constraints retrieved', {
        slugOrConditionId,
        constraints,
      });

      return constraints;
    } catch (error) {
      // HTTP 422 ожидаем, если передан conditionId вместо slug
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

      // Возвращаем безопасные значения по умолчанию
      // КРИТИЧНО: minimum_order_size = 1 (запасной вариант, когда API недоступен)
      return {
        minimum_order_value: 0, // Нет минимального значения — требуется минимум 1 акция
        minimum_order_size: 1, // Безопасный дефолт: минимум 1 акция
        maximum_order_size: 10000,
        minimum_tick_size: 0.01,
        minimum_price_tick: 0.0001,
      };
    }
  }

  /**
   * Маппировать сырой ответ API в доменный формат
   *
   * @param raw - Сырой ответ с информацией о маркете (camelCase от Gamma API)
   * @returns Рыночные данные в доменном формате (camelCase)
   *
   * @remarks
   * Gamma API уже возвращает camelCase, поэтому маппинг минимален.
   * API возвращает JSON-строки для clobTokenIds и outcomes — передаём как есть.
   * MarketFilter разберёт их позже.
   */
  private mapToDomainFormat(raw: MarketInfoResponse): GammaMarketData {
    return {
      conditionId: raw.conditionId,
      question: raw.question,
      slug: raw.slug,
      endDate: raw.endDate,  // Уже строка ISO из API
      active: raw.active,
      closed: raw.closed,
      enableOrderBook: raw.enableOrderBook,
      clobTokenIds: raw.clobTokenIds, // JSON-строка: "[\"token1\", \"token2\"]"
      outcomes: raw.outcomes, // JSON-строка: "[\"Yes\", \"No\"]"
      liquidity: raw.liquidity, // Строковое число из API
      spread: raw.spread, // Спред bid-ask из API
      bestBid: raw.bestBid, // Лучший bid из API
      bestAsk: raw.bestAsk, // Лучший ask из API
      orderMinSize: raw.orderMinSize, // Минимальный размер ордера из API (напр., 5 акций)
      orderPriceMinTickSize: raw.orderPriceMinTickSize, // Шаг цены из API (напр., 0.01)
      // Необязательные поля, отсутствующие в ответе API
      description: undefined,
      tags: undefined,
    };
  }

  /**
   * Универсальный помощник для HTTP-запросов
   *
   * @param url - Полный URL
   * @param silent - Пропустить debug-логирование (для пакетных операций)
   * @returns Данные ответа
   * @throws {Error} При ошибке запроса
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

        // HTTP 422 ожидаем — используется conditionId вместо slug
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

        const error: any = new Error(`HTTP ${response.status}: ${response.statusText}`);
        error.statusCode = response.status;
        throw error;
      }

      const data = await response.json();

      if (!silent) {
        this.logger.debug(`GET ${url} → OK`);
      }

      return data as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if ((error as Error).name === 'AbortError') {
        throw new Error(`Request timeout after ${this.config.timeout}ms`);
      }

      throw error;
    }
  }
}
