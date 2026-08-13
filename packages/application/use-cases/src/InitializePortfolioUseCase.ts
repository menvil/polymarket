/**
 * InitializePortfolioUseCase — инициализация Portfolio из текущего баланса venue.
 *
 * @remarks
 * Вызывается на старте системы (до WS-подписок), гарантируя наличие
 * Portfolio в IPortfolioStore с актуальным балансом USDC.
 *
 * ### Алгоритм:
 * 1. Если Portfolio уже существует в store — пропустить (идемпотентно).
 * 2. Получить текущий USDC-баланс от venue через ICurrentBalanceProvider.
 * 3. Создать Portfolio с Balance.withZeroReserved(USDC, accountId, POLYMARKET).
 * 4. Сохранить в IPortfolioStore (версия 0 — новый агрегат). Конфликт версии
 *    при save → перечитать store: если Portfolio уже есть (конкурирующий init
 *    успел между шагами 1 и 4) — идемпотентный Ok; если нет — Err.
 *
 * ### Почему не replay через fills:
 * Текущий баланс из REST уже отражает все исторические fill.
 * Восстановление через историю fills потребовало бы дополнительного хранилища
 * и FillMapper для REST-формата (отличного от WS-формата).
 * Текущий подход: быстро, без зависимости от истории fill.
 *
 * ### Порядок запуска:
 * ```
 * initializePortfolioUseCase.execute(accountId)  ← Portfolio готов
 *   ↓
 * reconcileOrdersUseCase.execute({ accountId })  ← ордера синхронизированы
 *   ↓
 * wsEmitter.start()                              ← live события
 * ```
 *
 * @example
 * ```typescript
 * const useCase = new InitializePortfolioUseCase({
 *   balanceProvider,
 *   portfolioStore,
 *   logger,
 * });
 *
 * // На старте системы:
 * await useCase.execute(accountId);
 * ```
 */
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { AccountId } from '@polymarket/ids';
import { KnownVenues, accountIdToString } from '@polymarket/ids';
import { Balance, Money } from '@polymarket/value-objects';
import { asPortfolioId } from '@polymarket/portfolio';
import { Portfolio } from '@polymarket/portfolio';
import type { IPortfolioStore, ICurrentBalanceProvider } from '@polymarket/ports';

/**
 * Зависимости InitializePortfolioUseCase.
 */
export interface InitializePortfolioDeps {
  readonly balanceProvider: ICurrentBalanceProvider;
  readonly portfolioStore: IPortfolioStore;
  readonly logger: ILogger;
}

/**
 * Use case инициализации Portfolio из баланса venue.
 *
 * @remarks
 * Идемпотентен: повторный вызов безопасен (skip если Portfolio уже есть).
 */
export class InitializePortfolioUseCase {
  private readonly _logger: ILogger;

  /**
   * @param _deps - Зависимости use case
   */
  constructor(private readonly _deps: InitializePortfolioDeps) {
    this._logger = _deps.logger.child({ component: 'InitializePortfolioUseCase' });
  }

  /**
   * Инициализирует Portfolio в IPortfolioStore из текущего баланса venue.
   *
   * @param accountId - ID аккаунта для инициализации
   * @returns Ok(void) при успехе или уже инициализированном Portfolio, Err при критической ошибке
   *
   * @remarks
   * Идемпотентен: если Portfolio уже существует — возвращает Ok без изменений.
   */
  public async execute(accountId: AccountId): Promise<Result<void, TradingError>> {
    // Шаг 1: Проверить, существует ли Portfolio
    const existing = this._deps.portfolioStore.get(accountId);
    if (existing) {
      this._logger.info('Portfolio already initialized, skipping', {
        accountId: accountIdToString(accountId),
      });
      return Ok(undefined);
    }

    // Шаг 2: Получить текущий USDC-баланс от venue
    let usdcBalance: Money;
    try {
      usdcBalance = await this._deps.balanceProvider.getUsdcBalance(accountId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._logger.error('Failed to fetch USDC balance from venue', {
        accountId: accountIdToString(accountId),
        error: message,
      });
      return Err(new TradingError(`Failed to fetch USDC balance: ${message}`, {
        context: { accountId: accountIdToString(accountId) },
      }));
    }

    // Шаг 3: Создать Portfolio
    const portfolioId = asPortfolioId(`portfolio-${accountIdToString(accountId)}`);
    const balance = Balance.withZeroReserved(
      usdcBalance,
      accountId,
      KnownVenues.POLYMARKET,
    );

    const portfolioResult = Portfolio.create({ id: portfolioId, accountId, balance });
    if (!portfolioResult.ok) {
      this._logger.error('Failed to create portfolio', {
        accountId: accountIdToString(accountId),
        error: portfolioResult.error.message,
      });
      return Err(new TradingError(`Failed to create Portfolio: ${portfolioResult.error.message}`, {
        context: { accountId: accountIdToString(accountId) },
      }));
    }

    // Шаг 4: Сохранить в store (версия 0 — новый агрегат)
    const saveResult = this._deps.portfolioStore.save(portfolioResult.value, 0);
    if (!saveResult.ok) {
      // Конфликт версии на save(…, 0) чаще всего означает, что КОНКУРИРУЮЩИЙ
      // init успел сохранить Portfolio между проверкой existing (шаг 1) и этим
      // save (между ними await balance provider). Состояние системы при этом
      // нормальное — Portfolio инициализирован, просто не нами. Перечитываем:
      // если Portfolio есть — идемпотентный Ok; если нет — настоящая ошибка.
      const existingAfterConflict = this._deps.portfolioStore.get(accountId);
      if (existingAfterConflict) {
        this._logger.warn('Portfolio was initialized concurrently during init — treating as idempotent success', {
          accountId: accountIdToString(accountId),
        });
        return Ok(undefined);
      }
      this._logger.error('Failed to save portfolio to store', {
        accountId: accountIdToString(accountId),
        error: saveResult.error.message,
      });
      return Err(new TradingError(`Failed to save Portfolio: ${saveResult.error.message}`, {
        context: { accountId: accountIdToString(accountId) },
      }));
    }

    this._logger.info('Portfolio initialized from venue balance', {
      accountId: accountIdToString(accountId),
      usdcBalance: usdcBalance.toString(),
    });

    return Ok(undefined);
  }
}
