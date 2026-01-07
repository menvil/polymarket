/**
 * Market Mapper для конвертации между API и Domain Market
 *
 * @remarks
 * Конвертирует данные рынков между:
 * - Polymarket CLOB API формат → Domain Market entity
 * - Domain Market entity → Polymarket CLOB API формат
 *
 * Алгоритм маппинга:
 * 1. Маппит ID рынка (conditionId)
 * 2. Извлекает вопрос (question)
 * 3. Получает outcomes с tokenIds и names
 * 4. Конвертирует expiration (Unix seconds → Date)
 * 5. Маппит статус (active → ACTIVE, closed → CLOSED, resolved → RESOLVED)
 * 6. Обрабатывает resolved outcome если рынок resolved
 *
 * @example
 * ```typescript
 * // API → Domain
 * const apiMarket = {
 *   marketId: '0x123',
 *   question: 'Bitcoin Up or Down?',
 *   outcomes: [
 *     { tokenId: '0xabc', name: 'Up' },
 *     { tokenId: '0xdef', name: 'Down' }
 *   ],
 *   endDate: 1703980800,
 *   active: true
 * };
 * const domainMarket = MarketMapper.toDomain(apiMarket);
 * console.log(domainMarket.outcomes[0].name); // "Up"
 * ```
 */

import { Market, MarketStatus, OutcomeIndex, OutcomeToken } from '../../../domain/entities/Market.js';
import type { MarketData } from '../clients/CLOBClient.js';

/**
 * Outcome data from API
 */
export interface ApiOutcome {
  /** Token ID for this outcome */
  tokenId: string;
  /** Human-readable outcome name (e.g., "Up", "Down", "Yes", "No") */
  name: string;
}

/**
 * API Market данные от Polymarket CLOB
 */
export interface ApiMarket {
  /** ID рынка (condition ID) */
  marketId: string;
  /** Вопрос рынка */
  question: string;
  /** Market URL */
  marketUrl?: string;
  /** Outcomes array [outcome0, outcome1] */
  outcomes: [ApiOutcome, ApiOutcome];
  /** Дата окончания (Unix timestamp в секундах) */
  endDate: number;
  /** Активен ли рынок */
  active: boolean;
  /** Рынок closed? */
  closed?: boolean;
  /** Рынок resolved? */
  resolved?: boolean;
  /** Index of resolved outcome (0 or 1) */
  resolvedOutcomeIndex?: OutcomeIndex;
}

/**
 * Market Mapper
 *
 * @remarks
 * Статический класс для конвертации рынков.
 * Все методы статические, не требует инстанцирования.
 */
export class MarketMapper {
  /**
   * Конвертирует API market в Domain Market entity
   *
   * @param apiMarket - Рынок от Polymarket API
   * @returns Domain Market entity
   * @throws {Error} При ошибке парсинга или валидации
   *
   * @remarks
   * Алгоритм:
   * 1. Извлекает ID, question, outcomes
   * 2. Конвертирует Unix timestamp → Date
   * 3. Определяет статус (ACTIVE/CLOSED/RESOLVED) по флагам active/closed/resolved
   * 4. Маппит resolvedOutcomeIndex если рынок resolved
   * 5. Создаёт и валидирует Domain Market entity
   *
   * @example
   * ```typescript
   * const apiMarket = {
   *   marketId: '0x123',
   *   question: 'Bitcoin Up or Down?',
   *   outcomes: [
   *     { tokenId: '0xabc', name: 'Up' },
   *     { tokenId: '0xdef', name: 'Down' }
   *   ],
   *   endDate: 1703980800,
   *   active: true
   * };
   *
   * const market = MarketMapper.toDomain(apiMarket);
   * console.log(market.outcomes[0].name); // 'Up'
   * console.log(market.outcomes[1].name); // 'Down'
   * ```
   */
  public static toDomain(apiMarket: ApiMarket): Market {
    // Конвертируем timestamp (секунды → Date)
    const expirationDate = new Date(apiMarket.endDate * 1000);

    // Определяем статус на основе флагов
    const status = this.determineMarketStatus(
      apiMarket.active,
      apiMarket.closed,
      apiMarket.resolved
    );

    // Создаём outcomes tuple
    const outcomes: [OutcomeToken, OutcomeToken] = [
      { tokenId: apiMarket.outcomes[0].tokenId, name: apiMarket.outcomes[0].name },
      { tokenId: apiMarket.outcomes[1].tokenId, name: apiMarket.outcomes[1].name },
    ];

    // Создаём Domain Market
    return Market.create({
      id: apiMarket.marketId,
      question: apiMarket.question,
      marketUrl: apiMarket.marketUrl,
      outcomes,
      expirationDate,
      status,
      resolvedOutcomeIndex: apiMarket.resolvedOutcomeIndex ?? null,
    });
  }

  /**
   * Конвертирует MarketData (от CLOBClient) в Domain Market entity
   *
   * @param marketData - Данные рынка от CLOBClient
   * @returns Domain Market entity
   *
   * @remarks
   * Специализированный метод для обработки MarketData типа.
   * Использует реальные названия outcomes из API (например, "Up", "Down").
   *
   * @example
   * ```typescript
   * const marketData = await clobClient.getMarket('0x123');
   * const market = MarketMapper.fromMarketData(marketData);
   * ```
   */
  public static fromMarketData(marketData: MarketData): Market {
    // Use real outcome names from API (e.g., "Up", "Down", "Yes", "No")
    return this.toDomain({
      marketId: marketData.marketId,
      question: marketData.question,
      outcomes: [
        { tokenId: marketData.outcomes[0].tokenId, name: marketData.outcomeNames[0] },
        { tokenId: marketData.outcomes[1].tokenId, name: marketData.outcomeNames[1] },
      ],
      endDate: marketData.endDate,
      active: marketData.active,
    });
  }

  /**
   * Конвертирует Domain Market в API формат
   *
   * @param market - Domain Market entity
   * @returns API формат рынка
   *
   * @remarks
   * Конвертирует обратно: Domain → API формат.
   * Используется редко (API обычно только читаем).
   *
   * @example
   * ```typescript
   * const market = Market.create({...});
   * const apiMarket = MarketMapper.toApi(market);
   * ```
   */
  public static toApi(market: Market): ApiMarket {
    return {
      marketId: market.id,
      question: market.question,
      marketUrl: market.marketUrl ?? undefined,
      outcomes: [
        { tokenId: market.outcomes[0].tokenId, name: market.outcomes[0].name },
        { tokenId: market.outcomes[1].tokenId, name: market.outcomes[1].name },
      ],
      endDate: Math.floor(market.expirationDate.getTime() / 1000),
      active: market.status === 'ACTIVE',
      closed: market.status === 'CLOSED',
      resolved: market.status === 'RESOLVED',
      resolvedOutcomeIndex: market.resolvedOutcomeIndex ?? undefined,
    };
  }

  /**
   * Определяет Domain статус на основе API флагов
   *
   * @param active - Флаг active из API
   * @param closed - Флаг closed из API (опционально)
   * @param resolved - Флаг resolved из API (опционально)
   * @returns Domain MarketStatus
   *
   * @remarks
   * Логика определения статуса (приоритет сверху вниз):
   * 1. resolved=true → RESOLVED (окончательный статус)
   * 2. closed=true → CLOSED (закрыт для торговли)
   * 3. active=true → ACTIVE (открыт для торговли)
   * 4. по умолчанию → CLOSED
   */
  private static determineMarketStatus(
    active: boolean,
    closed?: boolean,
    resolved?: boolean
  ): MarketStatus {
    if (resolved) {
      return 'RESOLVED';
    }

    if (closed) {
      return 'CLOSED';
    }

    if (active) {
      return 'ACTIVE';
    }

    return 'CLOSED';
  }

  /**
   * Создаёт массив Domain Markets из массива API рынков
   *
   * @param apiMarkets - Массив рынков от API
   * @returns Массив Domain Market entities
   *
   * @remarks
   * Batch-конвертация с фильтрацией ошибок.
   * Рынки с ошибками парсинга пропускаются.
   */
  public static toDomainMany(apiMarkets: ApiMarket[]): Market[] {
    const markets: Market[] = [];

    for (const apiMarket of apiMarkets) {
      try {
        markets.push(this.toDomain(apiMarket));
      } catch (error) {
        // Пропускаем рынки с ошибками парсинга
        console.error(`Failed to parse market ${apiMarket.marketId}:`, error);
      }
    }

    return markets;
  }

  /**
   * Фильтрует активные рынки которые можно торговать
   *
   * @param markets - Массив Domain Markets
   * @returns Массив только торгуемых рынков
   */
  public static filterTradable(markets: Market[]): Market[] {
    return markets.filter((market) => market.canTrade());
  }

  /**
   * Находит рынок по ID
   *
   * @param markets - Массив Domain Markets
   * @param marketId - ID рынка для поиска
   * @returns Market или undefined если не найден
   */
  public static findById(markets: Market[], marketId: string): Market | undefined {
    return markets.find((market) => market.id === marketId);
  }
}
