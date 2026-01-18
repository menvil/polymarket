/**
 * Data Collector Service - координатор сбора market data
 *
 * @remarks
 * Связывает WebSocket события с DataRecorder.
 * Управляет регистрацией маркетов и записью событий.
 *
 * Особенности:
 * - Подписывается на 'raw' события от WebSocketManager
 * - Маппит tokenId → slug для маршрутизации
 * - Работает параллельно с торговлей (если включено)
 * - Может работать standalone (только сбор данных)
 *
 * @example
 * ```typescript
 * const collector = new DataCollectorService(dataRecorder, logger);
 *
 * // При старте
 * await collector.initialize();
 *
 * // Регистрация маркета (вызывается из MultiMarketTrader)
 * collector.registerMarket(marketCandidate);
 *
 * // Обработка raw событий (подписка на wsManager)
 * wsManager.on('raw', (event) => collector.handleRawEvent(event));
 *
 * // При истечении маркета
 * await collector.finalizeMarket(conditionId, true);
 *
 * // При shutdown
 * await collector.close();
 * ```
 *
 * @module application/services
 */

import type { ILogger } from '../../domain/ports/ILogger.js';
import type { IDataRecorder, RawWsEvent } from '../../domain/ports/IDataRecorder.js';
import type { MarketCandidate } from '../../domain/services/market-discovery/types.js';

/**
 * Информация о зарегистрированном маркете
 */
interface RegisteredMarket {
  /** Condition ID */
  conditionId: string;
  /** Slug маркета */
  slug: string;
  /** Question */
  question: string;
  /** Token IDs [YES, NO] */
  tokenIds: string[];
  /** End date */
  endDate: Date;
  /** Время регистрации */
  registeredAt: Date;
}

/**
 * Data Collector Service
 *
 * @remarks
 * Координирует сбор данных с рынков.
 * Работает как слой между WebSocket и DataRecorder.
 */
export class DataCollectorService {
  private readonly dataRecorder: IDataRecorder;
  private readonly logger: ILogger;

  /** Маппинг conditionId → RegisteredMarket */
  private readonly markets: Map<string, RegisteredMarket> = new Map();

  /** Маппинг tokenId → conditionId */
  private readonly tokenToConditionId: Map<string, string> = new Map();

  /** Включен ли сбор */
  private enabled: boolean;

  /**
   * Создаёт новый DataCollectorService
   *
   * @param dataRecorder - DataRecorder для записи
   * @param logger - Логгер
   */
  constructor(dataRecorder: IDataRecorder, logger: ILogger) {
    this.dataRecorder = dataRecorder;
    this.logger = logger;
    this.enabled = dataRecorder.isEnabled();

    if (this.enabled) {
      this.logger.info('DataCollectorService created (enabled)');
    } else {
      this.logger.debug('DataCollectorService created (disabled)');
    }
  }

  /**
   * Инициализация при старте
   *
   * @remarks
   * Очищает incomplete данные от предыдущих запусков.
   */
  async initialize(): Promise<void> {
    if (!this.enabled) return;

    await this.dataRecorder.cleanup();
    this.logger.info('DataCollectorService initialized');
  }

  /**
   * Проверить, включен ли сбор
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Регистрирует маркет для записи данных
   *
   * @param candidate - MarketCandidate из discovery
   *
   * @remarks
   * Вызывается из MultiMarketTrader при добавлении маркета.
   * Извлекает slug из rawData и регистрирует в DataRecorder.
   */
  registerMarket(candidate: MarketCandidate): void {
    if (!this.enabled) return;

    const conditionId = candidate.conditionId;

    // Проверяем, не зарегистрирован ли уже
    if (this.markets.has(conditionId)) {
      this.logger.debug('Market already registered', { conditionId });
      return;
    }

    // Извлекаем slug из rawData
    const rawData = candidate.rawData;
    const slug = rawData.slug || conditionId;
    const question = candidate.question;
    const tokenIds = [candidate.outcomes[0].tokenId, candidate.outcomes[1].tokenId];

    // Регистрируем в DataRecorder
    this.dataRecorder.registerMarket(slug, question, rawData, tokenIds);

    // Сохраняем информацию
    const market: RegisteredMarket = {
      conditionId,
      slug,
      question,
      tokenIds,
      endDate: candidate.endDate,
      registeredAt: new Date(),
    };

    this.markets.set(conditionId, market);

    // Маппинг tokenId → conditionId
    for (const tokenId of tokenIds) {
      this.tokenToConditionId.set(tokenId, conditionId);
    }

    this.logger.info('Market registered for data collection', {
      conditionId: conditionId.substring(0, 16) + '...',
      slug,
      question: question.substring(0, 50) + '...',
    });
  }

  /**
   * Обрабатывает raw WebSocket событие
   *
   * @param event - Raw событие от WebSocket
   *
   * @remarks
   * Вызывается для каждого raw события (book, trade, last_trade_price).
   * Маршрутизирует событие в соответствующий DataRecorder по tokenId.
   */
  handleRawEvent(event: RawWsEvent): void {
    if (!this.enabled) return;

    this.logger.trace('Received raw event', {
      eventType: event.event_type,
      assetId: event.asset_id?.substring(0, 16) + '...',
      fullAssetId: event.asset_id, // Full for debugging
    });

    // Записываем raw событие
    this.dataRecorder.recordRawEvent(event.asset_id, event);
  }

  /**
   * Финализирует маркет
   *
   * @param conditionId - Condition ID маркета
   * @param expired - Истёк ли маркет
   *
   * @remarks
   * Вызывается из MultiMarketTrader при удалении маркета.
   */
  async finalizeMarket(conditionId: string, expired: boolean): Promise<void> {
    if (!this.enabled) return;

    const market = this.markets.get(conditionId);
    if (!market) {
      // Market already finalized or never registered - this is normal during shutdown/expiry race
      this.logger.debug('Market already finalized or not registered', { conditionId });
      return;
    }

    // Финализируем в DataRecorder
    await this.dataRecorder.finalizeMarket(market.slug, expired);

    // Очищаем mapping
    for (const tokenId of market.tokenIds) {
      this.tokenToConditionId.delete(tokenId);
    }
    this.markets.delete(conditionId);

    this.logger.info('Market finalized in collector', {
      conditionId: conditionId.substring(0, 16) + '...',
      slug: market.slug,
      expired,
    });
  }

  /**
   * Flush все буферы
   */
  async flush(): Promise<void> {
    if (!this.enabled) return;
    await this.dataRecorder.flush();
  }

  /**
   * Закрыть сервис
   */
  async close(): Promise<void> {
    if (!this.enabled) return;

    await this.dataRecorder.close();
    this.markets.clear();
    this.tokenToConditionId.clear();

    this.logger.info('DataCollectorService closed');
  }

  /**
   * Получить статистику
   */
  getStats() {
    return {
      enabled: this.enabled,
      registeredMarkets: this.markets.size,
      recorderStats: this.dataRecorder.getStats(),
    };
  }
}
