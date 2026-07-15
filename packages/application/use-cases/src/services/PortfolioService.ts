/**
 * PortfolioService — операции над Portfolio aggregate.
 *
 * @remarks
 * Отвечает за обновление баланса и позиций Portfolio при:
 * - Размещении ордера (резервирование средств или токенов)
 * - Отмене ордера (`releaseOrderReservation` — снятие резервации по стороне ордера)
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
import { assetIdToInstrumentId, accountIdToString } from '@polymarket/ids';
import { Money } from '@polymarket/value-objects';
import type { Portfolio } from '@polymarket/portfolio';
import { SimplePosition } from '@polymarket/portfolio';
import type { IPortfolioStore, VersionConflictError } from '@polymarket/ports';
import type { Fill } from '@polymarket/fill';
import type { Order } from '@polymarket/order';

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
   * Возвращает актуальный снапшот Portfolio из хранилища.
   *
   * @param accountId - ID аккаунта
   * @returns Portfolio или undefined, если не инициализирован
   *
   * @remarks
   * Используется для authoritative risk-check внутри keyed mutex в
   * `PlaceOrderUseCase`: snapshot из `PlaceOrderInput` мог устареть, пока
   * ждали lock (конкурентный fill/place изменил баланс/экспозицию).
   */
  public getPortfolio(accountId: AccountId): Portfolio | undefined {
    return this._store.get(accountId);
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
    const version = this._store.getVersion(accountId);
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
    const version = this._store.getVersion(accountId);
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
    const version = this._store.getVersion(accountId);
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
    const version = this._store.getVersion(accountId);
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
   * Снимает резервацию Portfolio для отменённого/истёкшего/отклонённого ордера.
   *
   * @param accountId - ID аккаунта
   * @param order - Ордер после отмены (содержит side, price, remainingSize, asset)
   * @returns Ok(void) или Err при ошибке release/save
   *
   * @remarks
   * BUY: освобождает USDC-резервацию (price × remainingSize).
   * SELL: освобождает токенную резервацию (remainingSize по instrumentId);
   * нерезолвящийся instrumentId — тоже Err (резервацию невозможно снять).
   *
   * Ошибки логируются И возвращаются через Result — caller решает, что делать:
   * ордер к этому моменту обычно уже terminal (committed CAS save), поэтому
   * сбой release — это Order↔Portfolio desync (замороженная резервация),
   * а не warning; use case должен создать reconciliation issue, а не глотать.
   *
   * @example
   * ```typescript
   * // В CancelOrderUseCase после успешного CAS save:
   * const releaseResult = portfolioService.releaseOrderReservation(accountId, cancelledOrder);
   * if (!releaseResult.ok) {
   *   // committed cancel + frozen reservation → reconciliation issue
   * }
   * ```
   */
  public releaseOrderReservation(
    accountId: AccountId,
    order: Order,
  ): Result<void, PortfolioSaveError> {
    if (order.side === 'BUY') {
      const remainingNotional = order.price.value().times(order.remainingSize.value());
      const result = this.releaseReservation(accountId, remainingNotional);
      if (!result.ok) {
        this._logger.error('Failed to release USDC reservation for cancelled order', {
          accountId: accountIdToString(accountId),
          error: result.error.message,
        });
      }
      return result;
    }

    const instrumentId = assetIdToInstrumentId(order.asset);
    if (!instrumentId) {
      this._logger.warn('Could not resolve instrumentId for SELL order reservation release', {
        accountId: accountIdToString(accountId),
        asset: String(order.asset),
      });
      return Err(new TradingError(
        `Could not resolve instrumentId for SELL order reservation release: ${String(order.asset)}`,
        { context: { accountId: accountIdToString(accountId), orderId: String(order.id) } },
      ));
    }
    const result = this.releaseTokenReservation(accountId, instrumentId, order.remainingSize.value());
    if (!result.ok) {
      this._logger.error('Failed to release token reservation for cancelled order', {
        accountId: accountIdToString(accountId),
        instrumentId: String(instrumentId),
        error: result.error.message,
      });
    }
    return result;
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
   * 2. Позиция LONG: quantity += size - feeInTokens, пересчёт averageEntryPrice по VWAP
   *    (averageEntryPrice считается по fill.price — реальная цена исполнения)
   *    feeInTokens = feeUSDC / price (Polymarket списывает fee в shares при BUY)
   *
   * ### SELL fill:
   * 1. Снимаем токенную резервацию **строго** (НЕ best-effort): это local-order
   *    path — резервация была создана при размещении SELL-ордера
   *    (`reserveTokensForOrder`), и её отсутствие означает Order↔Portfolio
   *    desync, а не нормальный recovery-сценарий. При провере release → `Err`,
   *    caller (`ProcessFillUseCase`) переводит fill в RECONCILIATION_REQUIRED.
   *    Для external/recovery fills (ордер неизвестен) используется
   *    `applyDirectFill`, где release токенов остаётся best-effort.
   * 2. `applyCredit(price × size)` — зачисляет выручку на доступный баланс
   * 3. Позиция LONG: quantity -= size, isClosed() = true при quantity = 0
   *
   * tokenId используется как instrumentId для поиска/обновления позиции.
   */
  public applyFill(fill: Fill, orderPrice?: Decimal): Result<void, PortfolioSaveError> {
    const version = this._store.getVersion(fill.accountId);
    const portfolio = this._store.get(fill.accountId);
    if (!portfolio) {
      return Err(new TradingError(
        'Portfolio not found',
        { context: { accountId: accountIdToString(fill.accountId), fillId: String(fill.id) } },
      ));
    }

    const instrumentId = assetIdToInstrumentId(fill.tokenId);
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

    // Для SELL: снять токенную резервацию СТРОГО (local-order path).
    // Резервация создавалась при размещении SELL-ордера — её отсутствие/недостаток
    // здесь это Order↔Portfolio desync, а не нормальный recovery-случай.
    // Возвращаем Err, чтобы ProcessFillUseCase пометил fill RECONCILIATION_REQUIRED.
    // (external/recovery fills без ордера идут через applyDirectFill с best-effort.)
    let portfolioAfterTokenRelease = portfolio;
    if (fill.side === 'SELL') {
      const releaseResult = portfolio.releaseTokenReservation(instrumentId, fillQty);
      if (!releaseResult.ok) {
        this._logger.error('SELL_TOKEN_RESERVATION_RELEASE_FAILED: token reservation missing/insufficient for local SELL fill — Order↔Portfolio desync', {
          accountId: accountIdToString(fill.accountId),
          fillId: String(fill.id),
          instrumentId: String(instrumentId),
          fillQty: fillQty.toString(),
          error: releaseResult.error.message,
        });
        return Err(new TradingError(
          `Failed to release token reservation for SELL fill: ${releaseResult.error.message}`,
          { context: { fillId: String(fill.id), instrumentId: String(instrumentId), fillQty: fillQty.toString() } },
        ));
      }
      portfolioAfterTokenRelease = releaseResult.value;
    }

    // Диагностика: состояние портфеля до дебита
    this._logger.info('Portfolio before fill debit', {
      fillId: String(fill.id),
      side: fill.side,
      debitAmount: notional.toString(),
      available: portfolioAfterTokenRelease.balance.available().value().toString(),
      reserved: portfolioAfterTokenRelease.balance.reserved().value().toString(),
      storeVersion: version,
    });

    // Обновить баланс
    const balanceResult = fill.side === 'BUY'
      ? portfolioAfterTokenRelease.applyDebit(money)
      : portfolioAfterTokenRelease.applyCredit(money);

    if (!balanceResult.ok) {
      this._logger.error('Balance change failed', {
        fillId: String(fill.id),
        side: fill.side,
        debitAmount: notional.toString(),
        error: balanceResult.error.message,
      });
      return Err(new TradingError(
        `Failed to apply balance change: ${balanceResult.error.message}`,
        { context: { fillId: String(fill.id), side: fill.side } },
      ));
    }

    // Обновить позицию (с учётом fee deduction для BUY)
    const positionResult = this._applyPositionUpdate(balanceResult.value, instrumentId, fill);
    if (!positionResult.ok) {
      return Err(new TradingError(
        `Failed to update position: ${positionResult.error.message}`,
        { context: { fillId: String(fill.id), side: fill.side } },
      ));
    }

    const saveResult = this._store.save(positionResult.value, version);
    if (!saveResult.ok) {
      this._logger.error('Portfolio save after fill failed (version conflict)', {
        fillId: String(fill.id),
        expectedVersion: version,
        currentVersion: this._store.getVersion(fill.accountId),
      });
      return saveResult;
    }

    const updatedPosition = positionResult.value.getPosition(instrumentId);
    this._logger.info('Fill applied to portfolio', {
      accountId: accountIdToString(fill.accountId),
      fillId: String(fill.id),
      side: fill.side,
      notional: notional.toString(),
      newAvailable: positionResult.value.balance.available().value().toString(),
      newReserved: positionResult.value.balance.reserved().value().toString(),
    });
    // Лог позиции после обновления — для диагностики live reconciliation
    this._logger.info('Position after fill', {
      accountId: accountIdToString(fill.accountId),
      fillId: String(fill.id),
      instrumentId: String(instrumentId),
      side: fill.side,
      positionQty: updatedPosition?.quantity.value().toString() ?? '0',
      positionClosed: updatedPosition?.isClosed() ?? true,
      avgEntryPrice: updatedPosition?.averageEntryPrice.value().toString() ?? 'none',
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
   * External/recovery path: fill приходит на terminal или не найденный ордер.
   * Биржевое событие — источник истины: токены получены/переданы независимо
   * от локального состояния ордера. В отличие от `applyFill` (local-order path),
   * здесь release токенной резервации остаётся **best-effort**: ордер мог быть
   * внешним/восстановленным, резервации могло не быть вовсе — это НЕ desync.
   *
   * ### BUY fill:
   * - `applyDirectDebit(fill.price × size)` — прямой дебит из available
   *   (резервация уже снята CancelOrderUseCase или ордер был внешним)
   * - Позиция LONG: quantity += size
   *
   * ### SELL fill:
   * - Снимаем токенную резервацию (best effort — ордер мог быть внешним)
   * - `applyCredit(fill.price × size)` — зачисление выручки
   * - Позиция LONG: quantity -= size (best effort — позиции может не быть)
   */
  public applyDirectFill(fill: Fill): Result<void, PortfolioSaveError> {
    const version = this._store.getVersion(fill.accountId);
    const portfolio = this._store.get(fill.accountId);
    if (!portfolio) {
      return Err(new TradingError(
        'Portfolio not found',
        { context: { accountId: accountIdToString(fill.accountId), fillId: String(fill.id) } },
      ));
    }

    const instrumentId = assetIdToInstrumentId(fill.tokenId);
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

    const directUpdatedPosition = finalPortfolio.getPosition(instrumentId);
    this._logger.info('Direct fill applied to portfolio', {
      accountId: accountIdToString(fill.accountId),
      fillId: String(fill.id),
      side: fill.side,
      size: fillQty.toString(),
      price: fill.price.toNumber(),
      notional: notional.toString(),
    });
    // Лог позиции после direct fill — для диагностики live reconciliation
    this._logger.info('Position after direct fill', {
      accountId: accountIdToString(fill.accountId),
      fillId: String(fill.id),
      instrumentId: String(instrumentId),
      side: fill.side,
      positionQty: directUpdatedPosition?.quantity.value().toString() ?? '0',
      positionClosed: directUpdatedPosition?.isClosed() ?? true,
      avgEntryPrice: directUpdatedPosition?.averageEntryPrice.value().toString() ?? 'none',
    });
    return Ok(undefined);
  }

  /**
   * Откатывает ранее применённый Fill (при on-chain FAILED).
   *
   * @param fill - Fill, который был ранее применён через applyFill/applyDirectFill
   * @returns Ok(void) или Err при ошибке
   *
   * @remarks
   * Обратная операция к applyFill/applyDirectFill.
   * Вызывается FillOrchestrator при получении FILL_FAILED после MATCHED.
   *
   * ### BUY fill reversal:
   * 1. Позиция LONG: quantity -= (fillQty - feeInTokens) — снимаем то что было добавлено
   * 2. `applyCredit(price × size)` — возвращаем USDC на available баланс
   *    (резервация уже была consumed при applyFill, кредитуем в available)
   *
   * ### SELL fill reversal:
   * 1. `applyDirectDebit(price × size)` — снимаем USDC, которые были зачислены
   * 2. Позиция LONG: quantity += fillQty — восстанавливаем позицию
   *
   * ### Ограничения:
   * - averageEntryPrice не восстанавливается точно (VWAP пересчёт необратим)
   * - Если позиция была закрыта (SELL) и удалена из Portfolio — создаётся заново
   * - FAILED — крайне редкое событие, точность reversal достаточна
   */
  public reverseFill(fill: Fill): Result<void, PortfolioSaveError> {
    const version = this._store.getVersion(fill.accountId);
    const portfolio = this._store.get(fill.accountId);
    if (!portfolio) {
      return Err(new TradingError(
        'Portfolio not found for fill reversal',
        { context: { accountId: accountIdToString(fill.accountId), fillId: String(fill.id) } },
      ));
    }

    const instrumentId = assetIdToInstrumentId(fill.tokenId);
    if (!instrumentId) {
      return Err(new TradingError(
        `Invalid tokenId for fill reversal: ${String(fill.tokenId)}`,
        { context: { fillId: String(fill.id) } },
      ));
    }

    const fillQty = fill.size.value();
    const notional = fill.price.value().times(fillQty);
    const money = Money.of(notional, 'USDC');

    let portfolioAfterBalance: Portfolio;

    if (fill.side === 'BUY') {
      // BUY reversal: кредитуем USDC обратно (резервация была consumed, возвращаем в available)
      const creditResult = portfolio.applyCredit(money);
      if (!creditResult.ok) {
        return Err(new TradingError(
          `Failed to credit USDC for BUY fill reversal: ${creditResult.error.message}`,
          { context: { fillId: String(fill.id) } },
        ));
      }
      portfolioAfterBalance = creditResult.value;

      // Уменьшаем позицию (обратно BUY: снимаем добавленные токены)
      const existing = portfolioAfterBalance.getPosition(instrumentId);
      const currentQty = existing?.quantity.value() ?? new Decimal(0);

      let feeInTokens = new Decimal(0);
      if (!fill.fee.isZero()) {
        const feeUSDC = fill.fee.quantity.amount().value();
        feeInTokens = feeUSDC.div(fill.price.value());
      }
      const netFillQty = fillQty.minus(feeInTokens);
      const newQty = currentQty.minus(netFillQty);

      if (newQty.lte(0)) {
        // Позиция полностью обнулилась — SimplePosition с qty=0 будет удалена upsertPosition
        const zeroPosition = new SimplePosition({
          instrumentId,
          quantity: new Decimal(0),
          averageEntryPrice: new Decimal(0),
          side: 'LONG',
        });
        portfolioAfterBalance = portfolioAfterBalance.upsertPosition(zeroPosition);
      } else {
        const avgPrice = existing?.averageEntryPrice.value() ?? fill.price.value();
        const reversePosition = new SimplePosition({
          instrumentId,
          quantity: newQty,
          averageEntryPrice: avgPrice,
          side: 'LONG',
        });
        portfolioAfterBalance = portfolioAfterBalance.upsertPosition(reversePosition);
      }
    } else {
      // SELL reversal: дебетуем USDC (снимаем зачисленную выручку)
      const debitResult = portfolio.applyDirectDebit(money);
      if (!debitResult.ok) {
        return Err(new TradingError(
          `Failed to debit USDC for SELL fill reversal: ${debitResult.error.message}`,
          { context: { fillId: String(fill.id) } },
        ));
      }
      portfolioAfterBalance = debitResult.value;

      // Восстанавливаем позицию (обратно SELL: добавляем проданные токены)
      const existing = portfolioAfterBalance.getPosition(instrumentId);
      const currentQty = existing?.quantity.value() ?? new Decimal(0);
      const avgPrice = existing?.averageEntryPrice.value() ?? fill.price.value();
      const newQty = currentQty.plus(fillQty);

      const restorePosition = new SimplePosition({
        instrumentId,
        quantity: newQty,
        averageEntryPrice: avgPrice,
        side: 'LONG',
      });
      portfolioAfterBalance = portfolioAfterBalance.upsertPosition(restorePosition);
    }

    const saveResult = this._store.save(portfolioAfterBalance, version);
    if (!saveResult.ok) return saveResult;

    this._logger.warn('Fill reversed in portfolio (on-chain FAILED)', {
      accountId: accountIdToString(fill.accountId),
      fillId: String(fill.id),
      side: fill.side,
      size: fillQty.toString(),
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

      // Polymarket on-chain settlement списывает fee из получаемых токенов при BUY.
      // feeInTokens = feeUSDC / price — конвертация из USDC в shares.
      // Если fee = 0 (MAKER или zero-fee рынок) → feeInTokens = 0, ничего не вычитается.
      let feeInTokens = new Decimal(0);
      if (!fill.fee.isZero()) {
        const feeUSDC = fill.fee.quantity.amount().value();
        feeInTokens = feeUSDC.div(fillPrice);
      }
      const netFillQty = fillQty.minus(feeInTokens);

      const newQty = currentQty.plus(netFillQty);
      // Средневзвешенная цена входа (по net quantity — реально полученные токены)
      const newAvg = currentQty.isZero()
        ? fillPrice
        : currentQty.times(currentAvg).plus(netFillQty.times(fillPrice)).dividedBy(newQty);

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
