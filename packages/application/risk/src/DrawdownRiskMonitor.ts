/**
 * Async post-trade мониторинг просадки портфеля.
 *
 * @remarks
 * Подписывается на FILL_RECEIVED — проверяет portfolio value после каждого fill.
 * Использует IMarkPricesProvider для расчёта mark-to-market стоимости позиций.
 *
 * ### Формула полной стоимости портфеля:
 * ```
 * totalValue = balance.total() + sum(position.quantity × markPrice)
 * ```
 * `balance.available()` — только свободный cash.
 * `balance.total()` — available + reserved (включая зарезервированные под ордера).
 *
 * ### Алгоритм:
 * 1. После каждого FILL_RECEIVED вычисляем currentValue для конкретного accountId
 * 2. Обновляем _peakValues[accountId] если currentValue > peak
 * 3. drawdown = (peak - current) / peak
 * 4. Если drawdown > maxDrawdown → публикуем RISK_LIMIT_BREACHED
 *
 * ### Пиковые значения per-account:
 * _peakValues хранит пиковые значения для каждого accountId независимо.
 * Это необходимо для корректной работы при мульти-аккаунтной торговле.
 *
 * @example
 * ```typescript
 * const monitor = new DrawdownRiskMonitor(
 *   eventBus, portfolioStore, markPrices, clock,
 *   { maxDrawdown: new Decimal(0.1) }, // 10%
 *   logger,
 * );
 * monitor.register(); // подписывается на FILL_RECEIVED
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { AccountId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/value-objects';
import { getTotalValue } from '@polymarket/portfolio';
import type { IEventBus } from '@polymarket/event-bus';
import type { IPortfolioStore } from '@polymarket/ports';
import type { IMarkPricesProvider } from './IMarkPricesProvider.js';
import type { RiskParams } from './RiskParams.js';
import Decimal from 'decimal.js';

export class DrawdownRiskMonitor {
  /** Пиковые значения стоимости портфеля per-accountId с момента запуска или последнего сброса */
  private readonly _peakValues = new Map<string, Decimal>();

  /**
   * @param _eventBus - Event bus для подписки на FILL_RECEIVED и публикации RISK_LIMIT_BREACHED
   * @param _portfolioStore - Хранилище portfolio для получения текущего состояния
   * @param _markPrices - Провайдер текущих рыночных цен
   * @param _clock - Источник времени для triggeredAt в событии
   * @param _params - Параметры риска (используется только maxDrawdown)
   * @param _logger - Logger
   */
  constructor(
    private readonly _eventBus: IEventBus,
    private readonly _portfolioStore: IPortfolioStore,
    private readonly _markPrices: IMarkPricesProvider,
    private readonly _clock: IClock,
    private readonly _params: Pick<RiskParams, 'maxDrawdown'>,
    private readonly _logger: ILogger,
  ) {}

  /**
   * Регистрирует подписку на FILL_RECEIVED.
   *
   * @remarks
   * Должен быть вызван один раз при инициализации системы.
   * После вызова монитор автоматически проверяет просадку после каждого fill.
   */
  public register(): void {
    this._eventBus.subscribe('FILL_RECEIVED', async (event) => {
      try {
        await this._checkDrawdown(event.fill.accountId);
      } catch (err) {
        this._logger.error('DrawdownRiskMonitor check failed', {
          err: err instanceof Error ? err : new Error(String(err)),
          accountId: String(event.fill.accountId),
        });
      }
    });
    this._logger.info('DrawdownRiskMonitor registered', {});
  }

  /**
   * Сбрасывает пиковые значения для всех аккаунтов (например, при смене торговой сессии).
   */
  public resetPeak(): void {
    this._peakValues.clear();
    this._logger.info('DrawdownRiskMonitor peak reset', {});
  }

  // ── Приватная логика ───────────────────────────────────────────────────────

  /**
   * Проверяет просадку для заданного accountId.
   *
   * @param accountId - ID аккаунта из FILL_RECEIVED события
   */
  private async _checkDrawdown(accountId: AccountId): Promise<void> {
    if (!this._params.maxDrawdown) return;

    const portfolio = this._portfolioStore.get(accountId);
    if (!portfolio) return;

    // Полная стоимость = total cash + mark-to-market positions
    const positionsValue = getTotalValue(
      portfolio.getPositions(),
      (id) => this._markPrices.getPrice(id),
      'USDC',
    ).value();
    const currentValue = portfolio.balance.total().value().plus(positionsValue);

    const accountKey = String(accountId);
    const peakValue = this._peakValues.get(accountKey) ?? new Decimal(0);

    // Обновляем пик для данного аккаунта
    if (currentValue.gt(peakValue)) {
      this._peakValues.set(accountKey, currentValue);
    }

    // Нет смысла считать просадку если пик ещё не установлен
    if ((this._peakValues.get(accountKey) ?? new Decimal(0)).isZero()) return;

    const currentPeak = this._peakValues.get(accountKey)!;
    const drawdown = currentPeak.minus(currentValue).dividedBy(currentPeak);
    if (!drawdown.gt(this._params.maxDrawdown)) return;

    const tsResult = TimestampService.fromDate(this._clock.now());
    if (!tsResult.ok) {
      this._logger.error('Failed to create timestamp for RISK_LIMIT_BREACHED', {
        error: tsResult.error.message,
      });
      return;
    }

    await this._eventBus.publish({
      type: 'RISK_LIMIT_BREACHED',
      violationType: 'DRAWDOWN',
      violation: `Drawdown ${drawdown.times(100).toFixed(2)}% exceeded max ${this._params.maxDrawdown.times(100).toFixed(2)}%`,
      triggeredAt: tsResult.value,
      accountId,
    });

    this._logger.error('Drawdown limit breached', {
      drawdown: drawdown.toString(),
      peak: currentPeak.toString(),
      current: currentValue.toString(),
      limit: this._params.maxDrawdown.toString(),
    });
  }
}
