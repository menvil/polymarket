/**
 * PortfolioReplayService — инициализация Portfolio из текущего баланса venue.
 *
 * @remarks
 * Вызывается на старте системы (до WS-подписок), гарантируя наличие
 * Portfolio в IPortfolioStore с актуальным балансом USDC.
 *
 * ### Алгоритм:
 * 1. Если Portfolio уже существует в store — пропустить (идемпотентно).
 * 2. Получить текущий USDC-баланс от venue через ICurrentBalanceProvider.
 * 3. Создать Portfolio с Balance.withZeroReserved(USDC, accountId, POLYMARKET).
 * 4. Сохранить в IPortfolioStore (версия 0 — новый агрегат).
 *
 * ### Почему не replay через fills:
 * Текущий баланс из REST уже отражает все исторические fill.
 * Восстановление через историю fills потребовало бы дополнительного хранилища
 * и FillMapper для REST-формата (отличного от WS-формата).
 * Текущий подход: быстро, без зависимости от истории fill.
 *
 * ### Порядок запуска:
 * ```
 * portfolioReplayService.replay(accountId)  ← Portfolio готов
 *   ↓
 * orderReconciler.reconcile(accountId)      ← ордера синхронизированы
 *   ↓
 * wsEmitter.start()                         ← live события
 * ```
 *
 * @example
 * ```typescript
 * const service = new PortfolioReplayService({
 *   balanceProvider,
 *   portfolioStore,
 *   logger,
 * });
 *
 * // На старте системы:
 * await service.replay(accountId);
 * ```
 */
import Decimal from 'decimal.js';
import type { ILogger } from '@polymarket/logger';
import type { AccountId } from '@polymarket/ids';
import { KnownVenues, accountIdToString } from '@polymarket/ids';
import { Balance, Money } from '@polymarket/value-objects';
import { asPortfolioId } from '@polymarket/portfolio';
import { Portfolio } from '@polymarket/portfolio';
import type { IPortfolioStore } from '@polymarket/ports';
import type { ICurrentBalanceProvider } from './ICurrentBalanceProvider.js';

/** Зависимости PortfolioReplayService */
export interface PortfolioReplayDeps {
  readonly balanceProvider: ICurrentBalanceProvider;
  readonly portfolioStore: IPortfolioStore;
  readonly logger: ILogger;
}

/**
 * Сервис восстановления Portfolio из текущего баланса venue.
 *
 * @remarks
 * Инициализирует IPortfolioStore актуальным состоянием на старте системы.
 * Идемпотентен: повторный вызов безопасен (skip если Portfolio уже есть).
 */
export class PortfolioReplayService {
  private readonly _logger: ILogger;

  /**
   * @param _deps - Зависимости сервиса
   */
  constructor(private readonly _deps: PortfolioReplayDeps) {
    this._logger = _deps.logger.child({ component: 'PortfolioReplayService' });
  }

  /**
   * Инициализирует Portfolio в IPortfolioStore из текущего баланса venue.
   *
   * @param accountId - ID аккаунта для инициализации
   *
   * @remarks
   * Идемпотентен: если Portfolio уже существует — возвращает без изменений.
   * При ошибке создания Portfolio логирует error (не бросает исключение).
   */
  public async replay(accountId: AccountId): Promise<void> {
    // Шаг 1: Проверить, существует ли Portfolio
    const existing = this._deps.portfolioStore.get(accountId);
    if (existing) {
      this._logger.info('Portfolio already initialized, skipping replay', {
        accountId: accountIdToString(accountId),
      });
      return;
    }

    // Шаг 2: Получить текущий USDC-баланс от venue
    let usdcBalance: Decimal;
    try {
      usdcBalance = await this._deps.balanceProvider.getUsdcBalance(accountId);
    } catch (err) {
      this._logger.error('Failed to fetch USDC balance from venue', {
        accountId: accountIdToString(accountId),
        error: String(err),
      });
      return;
    }

    // Шаг 3: Создать Portfolio
    const portfolioId = asPortfolioId(`portfolio-${accountIdToString(accountId)}`);
    const balance = Balance.withZeroReserved(
      Money.of(usdcBalance, 'USDC'),
      accountId,
      KnownVenues.POLYMARKET,
    );

    const portfolioResult = Portfolio.create({ id: portfolioId, accountId, balance });
    if (!portfolioResult.ok) {
      this._logger.error('Failed to create portfolio', {
        accountId: accountIdToString(accountId),
        error: portfolioResult.error.message,
      });
      return;
    }

    // Шаг 4: Сохранить в store (версия 0 — новый агрегат)
    const saveResult = this._deps.portfolioStore.save(portfolioResult.value, 0);
    if (!saveResult.ok) {
      this._logger.error('Failed to save portfolio to store', {
        accountId: accountIdToString(accountId),
        error: saveResult.error.message,
      });
      return;
    }

    this._logger.info('Portfolio initialized from venue balance', {
      accountId: accountIdToString(accountId),
      usdcBalance: usdcBalance.toString(),
    });
  }
}
