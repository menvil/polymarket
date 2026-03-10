/**
 * PortfolioService — операции над Portfolio aggregate.
 *
 * @remarks
 * Отвечает за обновление баланса и позиций Portfolio при:
 * - Размещении ордера (резервирование средств)
 * - Отмене ордера (снятие резервации)
 * - Исполнении fill (дебет/кредит баланса + обновление позиции)
 *
 * ### Схема обновления баланса при Fill:
 * - BUY fill: `applyDebit(price × size)` — снимает из зарезервированных средств
 * - SELL fill: `applyCredit(price × size)` — зачисляет на доступный баланс
 *
 * ### Позиции:
 * Позиции хранятся как SimplePosition (агрегированные qty + avgEntryPrice).
 * LONG: quantity увеличивается при BUY, уменьшается при SELL.
 *
 * @example
 * ```typescript
 * const service = new PortfolioService(portfolioStore, logger);
 * const result = await service.applyFill(fill, accountId);
 * if (!result.ok) {
 *   // VersionConflictError — повторить после re-read
 * }
 * ```
 */

import Decimal from 'decimal.js';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { AccountId, InstrumentId } from '@polymarket/ids';
import { asInstrumentId, assetIdToString } from '@polymarket/ids';
import { Money } from '@polymarket/value-objects';
import type { Portfolio } from '@polymarket/portfolio';
import type { IPortfolioStore, VersionConflictError } from '@polymarket/ports';
import type { Fill } from '@polymarket/fill';
import { SimplePosition } from './SimplePosition.js';

/** Объединённый тип ошибок сохранения Portfolio */
export type PortfolioSaveError = VersionConflictError | TradingError;

/** Сервис операций над Portfolio */
export class PortfolioService {
  private readonly _logger: ILogger;

  /**
   * @param portfolioStore - Хранилище Portfolio с CAS-защитой
   * @param logger - Logger (дочерний контекст 'PortfolioService' добавляется автоматически)
   */
  constructor(
    private readonly _store: IPortfolioStore,
    logger: ILogger,
  ) {
    this._logger = logger.child({ component: 'PortfolioService' });
  }

  /**
   * Резервирует средства для нового ордера.
   *
   * @param accountId - ID аккаунта
   * @param notional - Номинальная стоимость ордера (price × size) в USDC
   * @returns Ok(void) или Err при ошибке резервирования / конфликте версий
   *
   * @remarks
   * Вызывается в PlaceOrderUseCase перед отправкой на биржу.
   * При ошибке биржи необходимо вызвать releaseReservation для отката.
   */
  public reserveForOrder(
    accountId: AccountId,
    notional: Decimal,
  ): Result<void, PortfolioSaveError> {
    const portfolio = this._store.get(accountId);
    if (!portfolio) {
      return Err(new TradingError('Portfolio not found', { context: { accountId: String(accountId) } }));
    }

    const amount = Money.of(notional, 'USDC');
    const reserveResult = portfolio.reserveForOrder(amount);
    if (!reserveResult.ok) {
      return Err(new TradingError(
        `Failed to reserve balance: ${reserveResult.error.message}`,
        { context: { accountId: String(accountId), notional: notional.toString() } },
      ));
    }

    const saveResult = this._store.save(reserveResult.value, 0);
    if (!saveResult.ok) return saveResult;

    this._logger.debug('Balance reserved for order', {
      accountId: String(accountId),
      notional: notional.toString(),
    });
    return Ok(undefined);
  }

  /**
   * Снимает резервацию средств (при отмене или ошибке размещения ордера).
   *
   * @param accountId - ID аккаунта
   * @param notional - Ранее зарезервированная сумма в USDC
   * @returns Ok(void) или Err при ошибке
   *
   * @remarks
   * Вызывается в CancelOrderUseCase или при откате PlaceOrderUseCase.
   */
  public releaseReservation(
    accountId: AccountId,
    notional: Decimal,
  ): Result<void, PortfolioSaveError> {
    const portfolio = this._store.get(accountId);
    if (!portfolio) {
      return Err(new TradingError('Portfolio not found', { context: { accountId: String(accountId) } }));
    }

    const amount = Money.of(notional, 'USDC');
    const releaseResult = portfolio.releaseReservation(amount);
    if (!releaseResult.ok) {
      return Err(new TradingError(
        `Failed to release reservation: ${releaseResult.error.message}`,
        { context: { accountId: String(accountId), notional: notional.toString() } },
      ));
    }

    const saveResult = this._store.save(releaseResult.value, 0);
    if (!saveResult.ok) return saveResult;

    this._logger.debug('Reservation released', {
      accountId: String(accountId),
      notional: notional.toString(),
    });
    return Ok(undefined);
  }

  /**
   * Применяет Fill к Portfolio: обновляет баланс и позицию.
   *
   * @param fill - Исполнение ордера
   * @returns Ok(void) или Err при ошибке
   *
   * @remarks
   * ### BUY fill:
   * 1. `applyDebit(price × size)` — дебетует зарезервированные средства
   * 2. Позиция LONG: quantity += size, пересчёт averageEntryPrice по VWAP
   *
   * ### SELL fill:
   * 1. `applyCredit(price × size)` — зачисляет выручку на доступный баланс
   * 2. Позиция LONG: quantity -= size, isClosed() = true при quantity = 0
   *
   * tokenId используется как instrumentId для поиска/обновления позиции.
   */
  public applyFill(fill: Fill): Result<void, PortfolioSaveError> {
    const portfolio = this._store.get(fill.accountId);
    if (!portfolio) {
      return Err(new TradingError(
        'Portfolio not found',
        { context: { accountId: String(fill.accountId), fillId: String(fill.id) } },
      ));
    }

    const notional = fill.price.value().times(fill.size.value());
    const money = Money.of(notional, 'USDC');

    // 1. Обновить баланс
    const balanceResult = fill.side === 'BUY'
      ? portfolio.applyDebit(money)
      : portfolio.applyCredit(money);

    if (!balanceResult.ok) {
      return Err(new TradingError(
        `Failed to apply balance change: ${balanceResult.error.message}`,
        { context: { fillId: String(fill.id), side: fill.side } },
      ));
    }

    // 2. Обновить позицию
    const instrumentId = asInstrumentId(assetIdToString(fill.tokenId));
    if (!instrumentId) {
      return Err(new TradingError(
        `Invalid tokenId: ${String(fill.tokenId)}`,
        { context: { fillId: String(fill.id) } },
      ));
    }

    const positionResult = this._applyPositionUpdate(balanceResult.value, instrumentId, fill);
    if (!positionResult.ok) {
      return Err(new TradingError(
        `Failed to update position: ${positionResult.error.message}`,
        { context: { fillId: String(fill.id), side: fill.side } },
      ));
    }

    const saveResult = this._store.save(positionResult.value, 0);
    if (!saveResult.ok) return saveResult;

    this._logger.debug('Fill applied to portfolio', {
      accountId: String(fill.accountId),
      fillId: String(fill.id),
      side: fill.side,
      notional: notional.toString(),
    });
    return Ok(undefined);
  }

  // ── Приватные методы ───────────────────────────────────────────────────────

  /**
   * Обновляет позицию в Portfolio на основе Fill.
   *
   * @param portfolio - Portfolio с уже обновлённым балансом
   * @param instrumentId - ID инструмента
   * @param fill - Исполнение ордера
   * @returns Ok(Portfolio с обновлённой позицией) или Err при недопустимом состоянии
   *
   * @remarks
   * Для SELL: проверяет наличие позиции и достаточность количества токенов.
   */
  private _applyPositionUpdate(
    portfolio: Portfolio,
    instrumentId: InstrumentId,
    fill: Fill,
  ): Result<Portfolio, TradingError> {
    const existing = portfolio.getPosition(instrumentId);
    const fillQty = fill.size.value();
    const fillPrice = fill.price.value();

    if (fill.side === 'BUY') {
      const currentQty = existing?.quantity.value() ?? new Decimal(0);
      const currentAvg = existing?.averageEntryPrice.value() ?? new Decimal(0);

      const newQty = currentQty.plus(fillQty);
      // Средневзвешенная цена входа
      const newAvg = currentQty.isZero()
        ? fillPrice
        : currentQty.times(currentAvg).plus(fillQty.times(fillPrice)).dividedBy(newQty);

      const newPosition = new SimplePosition({
        instrumentId,
        quantity: newQty,
        averageEntryPrice: newAvg,
        side: 'LONG',
      });
      return Ok(portfolio.upsertPosition(newPosition));
    } else {
      // SELL: уменьшаем существующую LONG позицию
      if (!existing) {
        return Err(new TradingError(
          'No position found for SELL fill',
          { context: { fillId: String(fill.id), instrumentId: String(instrumentId) } },
        ));
      }
      const currentQty = existing.quantity.value();
      if (currentQty.lt(fillQty)) {
        return Err(new TradingError(
          'Sell size exceeds position quantity',
          {
            context: {
              fillId: String(fill.id),
              instrumentId: String(instrumentId),
              currentQty: currentQty.toString(),
              fillQty: fillQty.toString(),
            },
          },
        ));
      }
      const currentAvg = existing.averageEntryPrice.value();
      const newQty = currentQty.minus(fillQty);

      const newPosition = new SimplePosition({
        instrumentId,
        quantity: newQty,
        averageEntryPrice: currentAvg,
        side: 'LONG',
      });
      return Ok(portfolio.upsertPosition(newPosition));
    }
  }
}
