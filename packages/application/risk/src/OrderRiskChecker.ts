/**
 * Синхронный пре-трейд риск-чекер.
 *
 * @remarks
 * ### Порядок проверок — от дешёвых O(1) к более дорогим:
 * 1. maxOpenOrders       — O(1), сравнение счётчика
 * 2. maxOrderNotional    — O(1), price × size
 * 3. minAvailableBalance — O(1), portfolio.balance.available()
 * 4. maxPositionSize     — O(1), portfolio.getPosition(instrumentId)
 * 5. maxTotalExposure    — O(N), итерация позиций по cost basis (averageEntryPrice × quantity)
 *
 * ### Ни одна проверка не обращается к внешним сервисам.
 * OrderRiskChecker полностью stateless кроме _params.
 *
 * @example
 * ```typescript
 * const checker = new OrderRiskChecker(
 *   { maxOpenOrders: 10, maxOrderNotional: new Decimal(5000) },
 *   logger,
 * );
 *
 * const result = checker.checkBeforeOrder(input);
 * if (!result.ok) {
 *   logger.warn('Pre-trade risk check failed', { code: result.error.riskCode });
 * }
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import { Ok, Err } from '@polymarket/result';
import Decimal from 'decimal.js';
import type { RiskParams } from './RiskParams.js';
import { RiskViolationError } from './RiskViolation.js';
import type { RiskViolationCode } from './RiskViolation.js';
import type { PreOrderCheckInput } from './PreOrderCheckInput.js';
import type { IOrderRiskChecker } from './IOrderRiskChecker.js';
import type { Result } from '@polymarket/result';

export class OrderRiskChecker implements IOrderRiskChecker {
  private _params: RiskParams;
  private readonly _logger: ILogger;

  /**
   * @param params - Начальные параметры риска
   * @param logger - Logger (дочерний контекст 'OrderRiskChecker' устанавливается автоматически)
   */
  constructor(params: RiskParams, logger: ILogger) {
    this._params = params;
    this._logger = logger.child({ component: 'OrderRiskChecker' });
  }

  /**
   * Выполняет пре-трейд риск-проверку.
   *
   * @param input - Входные данные с portfolio, openOrdersCount, ордерными параметрами
   * @returns Ok(undefined) если все проверки пройдены, Err(RiskViolationError) при первом нарушении
   *
   * @remarks
   * Возвращает ошибку при первом нарушении (fail-fast).
   * Не публикует RISK_LIMIT_BREACHED — это задача вызывающей стороны.
   */
  public checkBeforeOrder(input: PreOrderCheckInput): Result<void, RiskViolationError> {
    const orderNotional = input.price.value().times(input.size.value());

    // 0. minTimeToExpiryMs — O(1), только для BUY (SELL ликвидирует позицию — не блокируем)
    const expiryViolation = this._checkTimeToExpiry(input.timeToExpiryMs, input.side);
    if (expiryViolation) return Err(expiryViolation);

    // 1. maxOpenOrders — O(1)
    const openOrdersViolation = this._checkMaxOpenOrders(input.openOrdersCount, input.strategyId);
    if (openOrdersViolation) return Err(openOrdersViolation);

    // 2. maxOrderNotional — O(1)
    const notionalViolation = this._checkOrderNotional(orderNotional);
    if (notionalViolation) return Err(notionalViolation);

    // 3. minAvailableBalance — O(1)
    const balanceViolation = this._checkAvailableBalance(input, orderNotional);
    if (balanceViolation) return Err(balanceViolation);

    // 4. maxPositionSize — O(1), только для BUY
    const positionViolation = this._checkPositionSize(input);
    if (positionViolation) return Err(positionViolation);

    // 5. maxTotalExposure — O(N), по cost basis
    const exposureViolation = this._checkTotalExposure(input, orderNotional);
    if (exposureViolation) return Err(exposureViolation);

    return Ok(undefined);
  }

  /**
   * Обновляет параметры риска в runtime.
   *
   * @param params - Частичные параметры для обновления
   */
  public updateParams(params: Partial<RiskParams>): void {
    this._params = { ...this._params, ...params };
    this._logger.info('Risk params updated', { keys: Object.keys(params) });
  }

  // ── Приватные проверки ─────────────────────────────────────────────────────

  /**
   * Проверяет minTimeToExpiryMs — не размещать BUY-ордера слишком близко к экспирации.
   *
   * @param timeToExpiryMs - Время до экспирации в ms (undefined = не проверять)
   * @param side - Сторона ордера. SELL не блокируется — ликвидация позиции у экспирации допустима.
   * @returns RiskViolationError или undefined если проверка пройдена
   */
  private _checkTimeToExpiry(timeToExpiryMs: number | undefined, side: unknown): RiskViolationError | undefined {
    if (this._params.minTimeToExpiryMs === undefined) return undefined;
    if (timeToExpiryMs === undefined) return undefined;
    // Только BUY: SELL-ордера (ликвидация позиции) разрешены у самой экспирации
    if (String(side) !== 'BUY') return undefined;
    if (timeToExpiryMs >= this._params.minTimeToExpiryMs) return undefined;

    return this._violation(
      'TOO_CLOSE_TO_EXPIRY',
      `Time to expiry ${timeToExpiryMs}ms < min ${this._params.minTimeToExpiryMs}ms`,
      {
        timeToExpiryMs,
        minTimeToExpiryMs: this._params.minTimeToExpiryMs,
      },
    );
  }

  /**
   * @returns RiskViolationError или undefined если проверка пройдена
   */
  private _checkMaxOpenOrders(
    openOrdersCount: number,
    strategyId?: string,
  ): RiskViolationError | undefined {
    if (this._params.maxOpenOrders === undefined) return undefined;
    if (openOrdersCount < this._params.maxOpenOrders) return undefined;

    return this._violation(
      'MAX_OPEN_ORDERS_EXCEEDED',
      `Open orders ${openOrdersCount} >= limit ${this._params.maxOpenOrders}`,
      { current: openOrdersCount, limit: this._params.maxOpenOrders, strategyId },
    );
  }

  private _checkOrderNotional(orderNotional: Decimal): RiskViolationError | undefined {
    if (this._params.maxOrderNotional === undefined) return undefined;
    if (!orderNotional.gt(this._params.maxOrderNotional)) return undefined;

    return this._violation(
      'ORDER_NOTIONAL_EXCEEDED',
      `Order notional ${orderNotional.toFixed(2)} > limit ${this._params.maxOrderNotional.toFixed(2)} USDC`,
      {
        notional: orderNotional.toString(),
        limit: this._params.maxOrderNotional.toString(),
      },
    );
  }

  /**
   * Проверяет минимальный доступный USDC-баланс.
   *
   * @remarks
   * Только для BUY: SELL не расходует USDC (продаёт токены за USDC).
   * Без этого skip'а SELL с нулевым USDC-балансом ложно блокируется,
   * хотя токены для продажи есть.
   */
  private _checkAvailableBalance(
    input: PreOrderCheckInput,
    orderNotional: Decimal,
  ): RiskViolationError | undefined {
    if (this._params.minAvailableBalance === undefined) return undefined;
    // SELL не расходует USDC — пропускаем проверку баланса
    if (String(input.side) !== 'BUY') return undefined;

    const available = input.portfolio.balance.available().value();
    const afterReserve = available.minus(orderNotional);
    if (!afterReserve.lt(this._params.minAvailableBalance)) return undefined;

    return this._violation(
      'INSUFFICIENT_AVAILABLE_BALANCE',
      `Balance after reserve ${afterReserve.toFixed(2)} < min ${this._params.minAvailableBalance.toFixed(2)} USDC`,
      {
        available: available.toString(),
        afterReserve: afterReserve.toString(),
        minRequired: this._params.minAvailableBalance.toString(),
      },
    );
  }

  private _checkPositionSize(input: PreOrderCheckInput): RiskViolationError | undefined {
    if (this._params.maxPositionSize === undefined) return undefined;
    // Ограничение на размер применяется только для BUY (открытие LONG)
    if (String(input.side) !== 'BUY') return undefined;

    const current =
      input.portfolio.getPosition(input.instrumentId)?.quantity.value() ?? new Decimal(0);
    const after = current.plus(input.size.value());
    if (!after.gt(this._params.maxPositionSize)) return undefined;

    return this._violation(
      'POSITION_LIMIT_EXCEEDED',
      `Position after order ${after.toString()} > limit ${this._params.maxPositionSize.toString()} tokens`,
      {
        instrumentId: String(input.instrumentId),
        current: current.toString(),
        after: after.toString(),
        limit: this._params.maxPositionSize.toString(),
      },
    );
  }

  /**
   * Вычисляет total exposure по cost basis (O(N) итерация позиций).
   *
   * @remarks
   * Exposure = sum(position.quantity × position.averageEntryPrice) для всех позиций.
   * Не требует markPrices — использует cost basis как консервативную оценку.
   */
  private _checkTotalExposure(
    input: PreOrderCheckInput,
    orderNotional: Decimal,
  ): RiskViolationError | undefined {
    if (this._params.maxTotalExposure === undefined) return undefined;

    let currentExposure = new Decimal(0);
    for (const position of input.portfolio.getPositions()) {
      currentExposure = currentExposure.plus(
        position.quantity.value().times(position.averageEntryPrice.value()),
      );
    }

    // SELL уменьшает общую экспозицию — вычитаем notional
    // BUY увеличивает — прибавляем notional
    const after = String(input.side) === 'SELL'
      ? Decimal.max(new Decimal(0), currentExposure.minus(orderNotional))
      : currentExposure.plus(orderNotional);
    if (!after.gt(this._params.maxTotalExposure)) return undefined;

    return this._violation(
      'TOTAL_EXPOSURE_EXCEEDED',
      `Total exposure ${after.toFixed(2)} > limit ${this._params.maxTotalExposure.toFixed(2)} USDC`,
      {
        current: currentExposure.toString(),
        after: after.toString(),
        limit: this._params.maxTotalExposure.toString(),
      },
    );
  }

  private _violation(
    riskCode: RiskViolationCode,
    message: string,
    context: Record<string, unknown>,
  ): RiskViolationError {
    this._logger.warn('Risk limit violated', { riskCode, ...context });
    return new RiskViolationError(riskCode, message, context);
  }
}
