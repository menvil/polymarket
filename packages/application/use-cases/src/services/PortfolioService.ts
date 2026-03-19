/**
 * PortfolioService — операции над Portfolio aggregate.
 *
 * @remarks
 * Отвечает за обновление баланса и позиций Portfolio при:
 * - Размещении ордера (резервирование средств или токенов)
 * - Отмене ордера (снятие резервации)
 * - Исполнении fill (дебет/кредит баланса + обновление позиции)
 *
 * ### Схема обновления баланса при Fill:
 * - BUY fill: `applyDebit(price × size)` — снимает из зарезервированных средств
 * - SELL fill: `applyCredit(price × size)` — зачисляет на доступный баланс
 *
 * ### Резервации токенов (SELL ордера):
 * - SELL order placed:    `reserveTokensForOrder(accountId, instrumentId, size)` → tokenReservations[id] += size
 * - SELL fill received:   `releaseTokenReservation(accountId, instrumentId, size)` → tokenReservations[id] -= size
 * - SELL order cancelled: `releaseTokenReservation(accountId, instrumentId, size)` → tokenReservations[id] -= size
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
import { asInstrumentId, assetIdToString, accountIdToString } from '@polymarket/ids';
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
    const version = this._store.getVersion?.(accountId) ?? 0;
    const portfolio = this._store.get(accountId);
    if (!portfolio) {
      return Err(new TradingError('Portfolio not found', { context: { accountId: accountIdToString(accountId) } }));
    }

    const amount = Money.of(notional, 'USDC');
    const reserveResult = portfolio.reserveForOrder(amount);
    if (!reserveResult.ok) {
      return Err(new TradingError(
        `Failed to reserve balance: ${reserveResult.error.message}`,
        { context: { accountId: accountIdToString(accountId), notional: notional.toString() } },
      ));
    }

    const saveResult = this._store.save(reserveResult.value, version);
    if (!saveResult.ok) return saveResult;

    this._logger.debug('Balance reserved for order', {
      accountId: accountIdToString(accountId),
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
    const version = this._store.getVersion?.(accountId) ?? 0;
    const portfolio = this._store.get(accountId);
    if (!portfolio) {
      return Err(new TradingError('Portfolio not found', { context: { accountId: accountIdToString(accountId) } }));
    }

    const amount = Money.of(notional, 'USDC');
    const releaseResult = portfolio.releaseReservation(amount);
    if (!releaseResult.ok) {
      return Err(new TradingError(
        `Failed to release reservation: ${releaseResult.error.message}`,
        { context: { accountId: accountIdToString(accountId), notional: notional.toString() } },
      ));
    }

    const saveResult = this._store.save(releaseResult.value, version);
    if (!saveResult.ok) return saveResult;

    this._logger.debug('Reservation released', {
      accountId: accountIdToString(accountId),
      notional: notional.toString(),
    });
    return Ok(undefined);
  }

  /**
   * Резервирует outcome-токены для нового SELL ордера.
   *
   * @param accountId - ID аккаунта
   * @param instrumentId - ID инструмента (outcome-токена)
   * @param qty - Количество токенов для резервирования
   * @returns Ok(void) или Err при ошибке резервирования / конфликте версий
   *
   * @remarks
   * Симметричен `reserveForOrder` (USDC-резервация для BUY).
   * Вызывается в PlaceOrderUseCase перед отправкой SELL ордера на биржу.
   * При ошибке биржи необходимо вызвать `releaseTokenReservation` для отката.
   */
  public reserveTokensForOrder(
    accountId: AccountId,
    instrumentId: InstrumentId,
    qty: Decimal,
  ): Result<void, PortfolioSaveError> {
    const version = this._store.getVersion?.(accountId) ?? 0;
    const portfolio = this._store.get(accountId);
    if (!portfolio) {
      return Err(new TradingError('Portfolio not found', { context: { accountId: accountIdToString(accountId) } }));
    }

    const reserveResult = portfolio.reserveTokensForOrder(instrumentId, qty);
    if (!reserveResult.ok) {
      return Err(new TradingError(
        `Failed to reserve tokens: ${reserveResult.error.message}`,
        { context: { accountId: accountIdToString(accountId), instrumentId: String(instrumentId), qty: qty.toString() } },
      ));
    }

    const saveResult = this._store.save(reserveResult.value, version);
    if (!saveResult.ok) return saveResult;

    this._logger.debug('Tokens reserved for SELL order', {
      accountId: accountIdToString(accountId),
      instrumentId: String(instrumentId),
      qty: qty.toString(),
    });
    return Ok(undefined);
  }

  /**
   * Снимает токенную резервацию (при исполнении или отмене SELL ордера).
   *
   * @param accountId - ID аккаунта
   * @param instrumentId - ID инструмента
   * @param qty - Ранее зарезервированное количество токенов
   * @returns Ok(void) или Err при ошибке
   *
   * @remarks
   * Симметричен `releaseReservation` (USDC-резервация для BUY).
   * Вызывается в CancelOrderUseCase или при откате PlaceOrderUseCase для SELL ордеров.
   * При fill SELL-ордера вызывается из `applyFill` (best-effort).
   */
  public releaseTokenReservation(
    accountId: AccountId,
    instrumentId: InstrumentId,
    qty: Decimal,
  ): Result<void, PortfolioSaveError> {
    const version = this._store.getVersion?.(accountId) ?? 0;
    const portfolio = this._store.get(accountId);
    if (!portfolio) {
      return Err(new TradingError('Portfolio not found', { context: { accountId: accountIdToString(accountId) } }));
    }

    const releaseResult = portfolio.releaseTokenReservation(instrumentId, qty);
    if (!releaseResult.ok) {
      return Err(new TradingError(
        `Failed to release token reservation: ${releaseResult.error.message}`,
        { context: { accountId: accountIdToString(accountId), instrumentId: String(instrumentId), qty: qty.toString() } },
      ));
    }

    const saveResult = this._store.save(releaseResult.value, version);
    if (!saveResult.ok) return saveResult;

    this._logger.debug('Token reservation released', {
      accountId: accountIdToString(accountId),
      instrumentId: String(instrumentId),
      qty: qty.toString(),
    });
    return Ok(undefined);
  }

  /**
   * Применяет Fill к Portfolio: обновляет баланс и позицию.
   *
   * @param fill - Исполнение ордера
   * @param orderPrice - Цена ордера (Decimal). Если передана для BUY fill,
   *   используется вместо `fill.price` для расчёта дебета.
   *   Это устраняет ошибку «Cannot unfreeze/consume X: only Y reserved»,
   *   возникающую когда биржа округляет цену в fill-событии (0.829 → 0.83),
   *   а зарезервировано было по точной цене ордера.
   * @returns Ok(void) или Err при ошибке
   *
   * @remarks
   * ### BUY fill:
   * 1. `applyDebit(orderPrice × size)` — дебетует зарезервированные средства
   *    (используем цену ордера, а не цену fill, чтобы точно совпасть с резервацией)
   * 2. Позиция LONG: quantity += size, пересчёт averageEntryPrice по VWAP
   *    (averageEntryPrice считается по fill.price — реальная цена исполнения)
   *
   * ### SELL fill:
   * 1. Снимаем токенную резервацию (best effort — бот мог перезапуститься)
   * 2. `applyCredit(price × size)` — зачисляет выручку на доступный баланс
   * 3. Позиция LONG: quantity -= size, isClosed() = true при quantity = 0
   *
   * tokenId используется как instrumentId для поиска/обновления позиции.
   */
  public applyFill(fill: Fill, orderPrice?: Decimal): Result<void, PortfolioSaveError> {
    const version = this._store.getVersion?.(fill.accountId) ?? 0;
    const portfolio = this._store.get(fill.accountId);
    if (!portfolio) {
      return Err(new TradingError(
        'Portfolio not found',
        { context: { accountId: accountIdToString(fill.accountId), fillId: String(fill.id) } },
      ));
    }

    // Для POLYMARKET_CTF_TOKEN извлекаем числовой tokenId напрямую,
    // чтобы InstrumentId совпадал с тем, что использует стратегия (asInstrumentId(tokenId)).
    // assetIdToString() для CTF_TOKEN возвращает "POLYMARKET_CTF_TOKEN:888...",
    // что создаёт InstrumentId отличный от "888..." → portfolio.getPosition() возвращает undefined.
    const rawTokenId = fill.tokenId.type === 'POLYMARKET_CTF_TOKEN'
      ? fill.tokenId.tokenId
      : assetIdToString(fill.tokenId);
    const instrumentId = asInstrumentId(rawTokenId);
    if (!instrumentId) {
      return Err(new TradingError(
        `Invalid tokenId: ${String(fill.tokenId)}`,
        { context: { fillId: String(fill.id) } },
      ));
    }

    const fillQty = fill.size.value();
    // Для BUY: используем цену ордера (если передана), чтобы точно совпасть с зарезервированной суммой.
    // Биржа может округлить цену в fill-событии (0.829 → 0.83), а резервация была по точной цене ордера.
    const priceForDebit = (fill.side === 'BUY' && orderPrice !== undefined) ? orderPrice : fill.price.value();
    const notional = priceForDebit.times(fillQty);
    const money = Money.of(notional, 'USDC');

    // Для SELL: снять токенную резервацию (best effort)
    let portfolioAfterTokenRelease = portfolio;
    if (fill.side === 'SELL') {
      const releaseResult = portfolio.releaseTokenReservation(instrumentId, fillQty);
      if (!releaseResult.ok) {
        // best effort: резервации может не быть (бот перезапустился)
        this._logger.warn('Token reservation not found for SELL fill — skipping release', {
          accountId: accountIdToString(fill.accountId),
          fillId: String(fill.id),
          instrumentId: String(instrumentId),
          fillQty: fillQty.toString(),
        });
      } else {
        portfolioAfterTokenRelease = releaseResult.value;
      }
    }

    // Обновить баланс
    const balanceResult = fill.side === 'BUY'
      ? portfolioAfterTokenRelease.applyDebit(money)
      : portfolioAfterTokenRelease.applyCredit(money);

    if (!balanceResult.ok) {
      return Err(new TradingError(
        `Failed to apply balance change: ${balanceResult.error.message}`,
        { context: { fillId: String(fill.id), side: fill.side } },
      ));
    }

    // Обновить позицию
    const positionResult = this._applyPositionUpdate(balanceResult.value, instrumentId, fill);
    if (!positionResult.ok) {
      return Err(new TradingError(
        `Failed to update position: ${positionResult.error.message}`,
        { context: { fillId: String(fill.id), side: fill.side } },
      ));
    }

    const saveResult = this._store.save(positionResult.value, version);
    if (!saveResult.ok) return saveResult;

    this._logger.debug('Fill applied to portfolio', {
      accountId: accountIdToString(fill.accountId),
      fillId: String(fill.id),
      side: fill.side,
      notional: notional.toString(),
    });
    return Ok(undefined);
  }

  /**
   * Применяет Fill напрямую к Portfolio без задействования резерваций.
   *
   * @param fill - Исполнение ордера
   * @returns Ok(void) или Err при ошибке
   *
   * @remarks
   * Используется когда fill приходит на terminal или не найденный ордер.
   * Биржевое событие — источник истины: токены получены/переданы независимо
   * от локального состояния ордера.
   *
   * ### BUY fill:
   * - `applyDirectDebit(fill.price × size)` — прямой дебит из available
   *   (резервация уже снята CancelOrderUseCase или ордер был внешним)
   * - Позиция LONG: quantity += size
   *
   * ### SELL fill:
   * - Снимаем токенную резервацию (best effort)
   * - `applyCredit(fill.price × size)` — зачисление выручки
   * - Позиция LONG: quantity -= size (best effort — позиции может не быть)
   */
  public applyDirectFill(fill: Fill): Result<void, PortfolioSaveError> {
    const version = this._store.getVersion?.(fill.accountId) ?? 0;
    const portfolio = this._store.get(fill.accountId);
    if (!portfolio) {
      return Err(new TradingError(
        'Portfolio not found',
        { context: { accountId: accountIdToString(fill.accountId), fillId: String(fill.id) } },
      ));
    }

    const rawTokenId = fill.tokenId.type === 'POLYMARKET_CTF_TOKEN'
      ? fill.tokenId.tokenId
      : assetIdToString(fill.tokenId);
    const instrumentId = asInstrumentId(rawTokenId);
    if (!instrumentId) {
      return Err(new TradingError(
        `Invalid tokenId: ${String(fill.tokenId)}`,
        { context: { fillId: String(fill.id) } },
      ));
    }

    const fillQty = fill.size.value();
    const notional = fill.price.value().times(fillQty);
    const money = Money.of(notional, 'USDC');

    let portfolioAfterBalance: Portfolio;

    if (fill.side === 'BUY') {
      // Прямой дебит из available (резервация уже снята или ордер внешний)
      const debitResult = portfolio.applyDirectDebit(money);
      if (!debitResult.ok) {
        return Err(new TradingError(
          `Failed direct debit for fill: ${debitResult.error.message}`,
          { context: { fillId: String(fill.id) } },
        ));
      }
      portfolioAfterBalance = debitResult.value;
    } else {
      // SELL: снимаем токенную резервацию best-effort + кредитуем USDC
      const releaseResult = portfolio.releaseTokenReservation(instrumentId, fillQty);
      const afterRelease = releaseResult.ok ? releaseResult.value : portfolio;
      const creditResult = afterRelease.applyCredit(money);
      if (!creditResult.ok) {
        return Err(new TradingError(
          `Failed credit for fill: ${creditResult.error.message}`,
          { context: { fillId: String(fill.id) } },
        ));
      }
      portfolioAfterBalance = creditResult.value;
    }

    // Обновляем позицию (для SELL — best effort: позиции может не быть)
    const positionResult = this._applyPositionUpdate(portfolioAfterBalance, instrumentId, fill);
    const finalPortfolio = positionResult.ok
      ? positionResult.value
      : portfolioAfterBalance; // SELL без позиции — только баланс

    if (!positionResult.ok) {
      this._logger.warn('Direct fill: position update skipped (best effort)', {
        fillId: String(fill.id),
        side: fill.side,
        instrumentId: String(instrumentId),
        reason: positionResult.error.message,
      });
    }

    const saveResult = this._store.save(finalPortfolio, version);
    if (!saveResult.ok) return saveResult;

    this._logger.info('Direct fill applied to portfolio', {
      accountId: accountIdToString(fill.accountId),
      fillId: String(fill.id),
      side: fill.side,
      size: fillQty.toString(),
      price: fill.price.toNumber(),
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
