/**
 * REST-клиент рыночных данных Polymarket
 *
 * @remarks
 * Обрабатывает endpoints Gamma API Polymarket:
 * - GET /markets - Получить все маркеты
 * - GET /markets/{tokenId} - Получить информацию о конкретном маркете
 *
 * Возвращает сырые ответы API (`GammaMarketDto`) без нормализации.
 * Нормализация (маппинг в domain VO) выполняется `PolymarketMarketDiscoveryAdapter`.
 *
 * **ВАЖНО**: Использует Gamma API (публичный API), НЕ CLOB API.
 * Базовый URL: https://gamma-api.polymarket.com
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
 * ```
 */

import type { ILogger } from '@polymarket/logger';

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
 * DTO рыночных данных из Gamma API.
 *
 * @remarks
 * Gamma API возвращает поля в camelCase.
 *
 * Пример: https://gamma-api.polymarket.com/markets
 */
export interface GammaMarketDto {
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

  /** Описание рынка */
  description?: string;

  /** Теги рынка */
  tags?: string[];

  /** Источник разрешения рынка (URL биржи/оракула) */
  resolutionSource?: string;

  /** Время начала события (ISO строка) — для крипто-рынков */
  eventStartTime?: string;
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
 * Возвращает сырые DTO из Gamma API без преобразования в domain-объекты.
 * Маппинг в domain VO (InstrumentId, Price и т.д.) выполняется в адаптере.
 */
export class PolymarketMarketDataRestClient {
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
   * Получить все активные маркеты в виде сырых DTO.
   *
   * @returns Массив GammaMarketDto из Gamma API
   * @throws {Error} При ошибке API-вызова
   *
   * @remarks
   * Постранично загружает все активные рынки (до 25 000).
   * Сортировка по убыванию объёма (наибольший объём первым).
   *
   * @example
   * ```typescript
   * const markets = await client.getActiveMarkets();
   * console.log(`Active markets: ${markets.length}`);
   * ```
   */
  async getActiveMarkets(): Promise<GammaMarketDto[]> {
    const allMarkets: GammaMarketDto[] = [];
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

        const batch = await this.fetch<GammaMarketDto[]>(url.toString(), true);

        if (batch.length === 0) {
          break;
        }

        allMarkets.push(...batch);
        offset += limit;

        // Если получили меньше limit, значит достигли конца
        if (batch.length < limit) {
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
   * const market = await client.getMarketInfo('bitcoin-up-or-down-january-8');
   * console.log(`Market: ${market.question}`);
   * ```
   */
  async getMarketInfo(slugOrConditionId: string): Promise<GammaMarketDto> {
    this.logger.debug('Getting market info', { slugOrConditionId });

    const url = `${this.config.baseUrl}/markets/${slugOrConditionId}`;
    const market = await this.fetch<GammaMarketDto>(url);

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
   * @example
   * ```typescript
   * const constraints = await client.getMarketConstraints('bitcoin-up-or-down-january-8');
   * console.log(`Min size: ${constraints.minimum_order_size}`);
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
      return {
        minimum_order_value: 0,
        minimum_order_size: 1,
        maximum_order_size: 10000,
        minimum_tick_size: 0.01,
        minimum_price_tick: 0.0001,
      };
    }
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

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        const body = await response.text();
        throw new Error(
          `Expected JSON but got ${contentType || 'unknown content-type'}. ` +
          `Possible proxy/firewall redirect. Body: ${body.substring(0, 200)}`
        );
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
