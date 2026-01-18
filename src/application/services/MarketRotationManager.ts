/**
 * MarketRotationManager - управление ротацией маркетов
 *
 * @remarks
 * Отвечает за:
 * 1. Непрерывное сканирование маркетов в фоне
 * 2. Поддержание актуального списка кандидатов
 * 3. Определение момента переключения (когда маркет истёк)
 * 4. Координация переключения через Orchestrator
 *
 * Алгоритм работы:
 * - Scan Loop: сканирует маркеты → ждёт 30 сек → повторяет
 * - Expiry Check: каждую секунду проверяет isExpired()
 * - При истечении маркета → переключается на следующий
 *
 * @example
 * ```typescript
 * const rotationManager = new MarketRotationManager(
 *   marketDiscovery,
 *   orchestrator,
 *   logger,
 *   { scanPauseMs: 30000, expiryCheckIntervalMs: 1000 }
 * );
 *
 * await rotationManager.start(initialMarket);
 * ```
 */

import { Market } from '../../domain/entities/Market.js';
import { Money } from '../../domain/value-objects/Money.js';
import { ILogger } from '../../domain/ports/ILogger.js';
import { MarketDiscoveryService, MarketCandidate } from '../../domain/services/market-discovery/index.js';
import { MainTradingOrchestrator } from '../orchestrators/MainTradingOrchestrator.js';

/**
 * Конфигурация MarketRotationManager
 */
export interface MarketRotationConfig {
  /** Пауза между сканированиями (мс) */
  scanPauseMs: number;
  /** Интервал проверки истечения маркета (мс) */
  expiryCheckIntervalMs: number;
}

/**
 * MarketRotationManager
 *
 * @remarks
 * Управляет непрерывным сканированием маркетов и автоматическим
 * переключением на следующий маркет при истечении текущего.
 */
export class MarketRotationManager {
  private expiryCheckInterval: NodeJS.Timeout | null = null;
  private scanLoopRunning = false;
  private candidates: MarketCandidate[] = [];
  private currentMarket: Market | null = null;
  private currentMarketCandidate: MarketCandidate | null = null;
  private isRunning = false;
  private isSwitching = false;
  private initialBalance: Money;

  private readonly logger: ILogger;

  /**
   * Создаёт новый MarketRotationManager
   *
   * @param marketDiscovery - Сервис поиска маркетов
   * @param orchestrator - Торговый оркестратор
   * @param baseLogger - Логгер
   * @param config - Конфигурация
   */
  constructor(
    private readonly marketDiscovery: MarketDiscoveryService,
    private readonly orchestrator: MainTradingOrchestrator,
    baseLogger: ILogger,
    private readonly config: MarketRotationConfig
  ) {
    this.logger = baseLogger.child?.('MarketRotation') || baseLogger;
    this.initialBalance = Money.fromUSDC(10000); // Default, will be updated
  }

  /**
   * Запускает MarketRotationManager
   *
   * @param initialMarket - Начальный маркет
   * @param initialBalance - Начальный баланс
   *
   * @remarks
   * Алгоритм:
   * 1. Сохранить текущий маркет
   * 2. Запустить orchestrator
   * 3. Запустить scan loop (фоновый)
   * 4. Запустить expiry check (каждую секунду)
   */
  public async start(initialMarket: Market, initialBalance: Money): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('MarketRotationManager already running');
      return;
    }

    this.logger.info('Starting MarketRotationManager');
    this.isRunning = true;
    this.currentMarket = initialMarket;
    this.initialBalance = initialBalance;

    // Инициализируем и запускаем orchestrator
    await this.orchestrator.initialize(initialMarket, initialBalance);
    await this.orchestrator.start();

    // Запускаем фоновое сканирование
    this.startScanLoop();

    // Запускаем проверку истечения
    this.startExpiryCheck();

    this.logger.info('MarketRotationManager started', {
      market: initialMarket.question,
      expiresAt: initialMarket.expirationDate.toISOString(),
    });
  }

  /**
   * Останавливает MarketRotationManager
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('MarketRotationManager not running');
      return;
    }

    this.logger.info('Stopping MarketRotationManager');
    this.isRunning = false;

    // Останавливаем scan loop
    this.scanLoopRunning = false;

    // Останавливаем expiry check
    if (this.expiryCheckInterval) {
      clearInterval(this.expiryCheckInterval);
      this.expiryCheckInterval = null;
    }

    // Останавливаем orchestrator
    await this.orchestrator.stop();

    this.logger.info('MarketRotationManager stopped');
  }

  /**
   * Возвращает текущий маркет
   */
  public getCurrentMarket(): Market | null {
    return this.currentMarket;
  }

  /**
   * Возвращает список кандидатов
   */
  public getCandidates(): MarketCandidate[] {
    return [...this.candidates];
  }

  /**
   * Запускает непрерывный цикл сканирования
   *
   * @remarks
   * Алгоритм:
   * 1. Вызвать findBestMarket()
   * 2. Обновить candidates
   * 3. Ждать scanPauseMs
   * 4. Повторить
   */
  private startScanLoop(): void {
    this.scanLoopRunning = true;

    const runLoop = async () => {
      while (this.scanLoopRunning && this.isRunning) {
        try {
          this.logger.debug('Starting market scan...');
          const result = await this.marketDiscovery.findBestMarket();

          this.candidates = result.candidates;

          this.logger.info('Market scan complete', {
            totalFetched: result.totalFetched,
            totalFiltered: result.totalFiltered,
            candidatesCount: this.candidates.length,
            bestMarket: result.market?.question?.substring(0, 50),
          });

          // Если текущий маркет не в списке кандидатов - логируем
          if (this.currentMarket && this.currentMarketCandidate) {
            const stillValid = this.candidates.some(
              (c) => c.conditionId === this.currentMarketCandidate?.conditionId
            );
            if (!stillValid) {
              this.logger.warn('Current market no longer in candidates list', {
                currentMarket: this.currentMarket.question,
              });
            }
          }
        } catch (error) {
          this.logger.error('Error during market scan', { error });
        }

        // Ждём перед следующим сканированием
        if (this.scanLoopRunning && this.isRunning) {
          await this.sleep(this.config.scanPauseMs);
        }
      }

      this.logger.debug('Scan loop stopped');
    };

    // Запускаем loop в фоне (не await!)
    runLoop().catch((error) => {
      this.logger.error('Scan loop crashed', { error });
    });
  }

  /**
   * Запускает периодическую проверку истечения маркета
   *
   * @remarks
   * Каждую секунду проверяет isExpired().
   * Если маркет истёк → вызывает switchToNextMarket()
   */
  private startExpiryCheck(): void {
    this.expiryCheckInterval = setInterval(() => {
      if (!this.currentMarket || !this.isRunning || this.isSwitching) {
        return;
      }

      if (this.currentMarket.isExpired()) {
        this.logger.warn('Current market has expired!', {
          market: this.currentMarket.question,
          expiredAt: this.currentMarket.expirationDate.toISOString(),
        });

        // Переключаемся на следующий маркет
        this.switchToNextMarket().catch((error) => {
          this.logger.error('Failed to switch to next market', { error });
        });
      } else {
        // Логируем оставшееся время (каждые 60 секунд)
        const timeToExpiry = this.currentMarket.timeToExpiry();
        const secondsLeft = Math.floor(timeToExpiry / 1000);
        if (secondsLeft > 0 && secondsLeft % 60 === 0) {
          this.logger.debug('Time to market expiry', {
            secondsLeft,
            minutesLeft: Math.floor(secondsLeft / 60),
          });
        }
      }
    }, this.config.expiryCheckIntervalMs);
  }

  /**
   * Переключается на следующий маркет
   *
   * @remarks
   * Алгоритм:
   * 1. Остановить orchestrator
   * 2. Выбрать следующий маркет из candidates
   * 3. Если нет кандидатов → экстренное сканирование
   * 4. Создать новый Market entity
   * 5. Переинициализировать orchestrator
   * 6. Запустить orchestrator
   */
  private async switchToNextMarket(): Promise<void> {
    if (this.isSwitching) {
      this.logger.warn('Already switching markets, skipping...');
      return;
    }

    this.isSwitching = true;
    this.logger.info('Switching to next market...');

    try {
      // 1. Останавливаем торговлю
      await this.orchestrator.stop();

      // 2. Выбираем следующий маркет
      let nextCandidate = this.selectNextMarket();

      // 3. Если нет кандидатов - экстренное сканирование
      if (!nextCandidate) {
        this.logger.warn('No candidates available, performing emergency scan...');
        const result = await this.marketDiscovery.findBestMarket();
        this.candidates = result.candidates;
        nextCandidate = this.selectNextMarket();
      }

      // 4. Если всё ещё нет - ошибка, но продолжаем пытаться
      if (!nextCandidate) {
        this.logger.error('No valid markets found after emergency scan!');
        // Ждём и пробуем снова через 30 секунд
        await this.sleep(30000);
        this.isSwitching = false;
        return this.switchToNextMarket();
      }

      // 5. Создаём новый Market entity
      const newMarket = Market.create({
        id: nextCandidate.conditionId,
        question: nextCandidate.question,
        marketUrl: nextCandidate.marketUrl,
        outcomes: nextCandidate.outcomes,
        expirationDate: nextCandidate.endDate,
        status: 'ACTIVE',
      });

      // 6. Переинициализируем orchestrator
      await this.orchestrator.initialize(newMarket, this.initialBalance);
      await this.orchestrator.start();

      // 7. Обновляем состояние
      this.currentMarket = newMarket;
      this.currentMarketCandidate = nextCandidate;

      this.logger.info('Successfully switched to new market', {
        market: newMarket.question,
        expiresAt: newMarket.expirationDate.toISOString(),
        timeToExpiry: Math.floor(newMarket.timeToExpiry() / 1000) + ' seconds',
      });
    } catch (error) {
      this.logger.error('Error during market switch', { error });
    } finally {
      this.isSwitching = false;
    }
  }

  /**
   * Выбирает следующий маркет из списка кандидатов
   *
   * @returns Следующий маркет или null если нет подходящих
   *
   * @remarks
   * Исключает текущий/истёкший маркет из выбора.
   * Выбирает маркет с наименьшим временем до истечения (но не истёкший).
   */
  private selectNextMarket(): MarketCandidate | null {
    const now = Date.now();

    // Фильтруем: исключаем текущий маркет и уже истёкшие
    const validCandidates = this.candidates.filter((c) => {
      // Исключаем текущий маркет
      if (this.currentMarketCandidate && c.conditionId === this.currentMarketCandidate.conditionId) {
        return false;
      }

      // Исключаем истёкшие
      if (c.endDate.getTime() <= now) {
        return false;
      }

      return true;
    });

    if (validCandidates.length === 0) {
      return null;
    }

    // Выбираем первый (уже отсортирован по времени истечения)
    return validCandidates[0];
  }

  /**
   * Async sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}