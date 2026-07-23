/**
 * Синхронный пре-трейд риск-чекер (иммутабельный).
 *
 * @remarks
 * ### Порядок проверок:
 * 1. side fail-closed — `'BUY'|'SELL'` иначе `RISK_INPUT_INCOMPLETE` (даже при
 *    пустой политике; неизвестный side НЕ трактуется как SELL)
 * 2. fail-closed валидация примитивных входов (openOrdersCount, finite
 *    timeToExpiryMs, pending для BUY)
 * 3. безопасное извлечение + валидация price/size → orderNotional
 * 4. лимиты (от дешёвых к дорогим):
 *    - expiry (minTimeToExpiryMs) — O(1), только BUY
 *    - maxOpenOrders — O(1), BUY и SELL
 *    - maxOrderNotional — O(1), BUY и SELL (fat-finger guard)
 *    - minAvailableBalance — O(1), только BUY
 *    - maxPositionSize — O(1), только BUY; проекция = filled + pending BUY + new
 *    - maxTotalExposure — O(N), только BUY; cost basis + reserved USDC + new notional
 *
 * ### Fail-closed:
 * checker не доверяет входам слепо — повреждённые side/price/size/notional/
 * pending/portfolio-derived значения (не-Decimal, NaN, Infinity, отрицательные,
 * бросающий VO getter) дают `RISK_INPUT_INCOMPLETE`, а не тихий обход лимита.
 * Portfolio-derived значения валидируются только в АКТИВНЫХ BUY-gate'ах (нет
 * безусловной рекурсивной валидации всего Portfolio).
 *
 * ### SELL (для long-only Polymarket):
 * SELL не увеличивает позиционный/total экспозиционный риск — это ликвидация.
 * Поэтому для SELL пропускаются: expiry, minAvailableBalance, maxPositionSize,
 * maxTotalExposure. Продолжают применяться: maxOpenOrders (антиспам) и
 * maxOrderNotional (operational/fat-finger). Безусловного раннего `Ok()` для SELL
 * НЕТ — иначе случайно отключились бы antispam и order-size guard.
 *
 * ### Иммутабельность:
 * Политика фиксируется в конструкторе ({@link RiskPolicy}) и не меняется в
 * runtime (`updateParams` убран). Чтобы поменять политику — создаётся новый
 * `OrderRiskChecker`. Кроме `_policy`/`_logger` checker полностью stateless.
 *
 * @example
 * ```typescript
 * const policy = RiskPolicy.create({ maxOpenOrders: 10, maxOrderNotional: new Decimal(5000) });
 * if (!policy.ok) throw policy.error;
 * const checker = new OrderRiskChecker(policy.value, logger);
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
import type { RiskPolicy } from './RiskPolicy.js';
import { RiskViolationError } from './RiskViolation.js';
import type { RiskViolationCode } from './RiskViolation.js';
import type { PreOrderCheckInput } from './PreOrderCheckInput.js';
import type { IOrderRiskChecker } from './IOrderRiskChecker.js';
import type { Result } from '@polymarket/result';

export class OrderRiskChecker implements IOrderRiskChecker {
  private readonly _params: Readonly<RiskParams>;
  private readonly _logger: ILogger;

  /**
   * @param policy - Провалидированная иммутабельная риск-политика
   *   ({@link RiskPolicy.create})
   * @param logger - Logger (дочерний контекст 'OrderRiskChecker' устанавливается автоматически)
   */
  constructor(policy: RiskPolicy, logger: ILogger) {
    this._params = policy.params;
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
    // Шаг 1: side fail-closed — ПЕРВЫМ, даже при пустой политике. Повреждённый
    // side (в т.ч. 'UNKNOWN') нельзя трактовать как SELL «потому что лимиты
    // отключены»: неизвестное направление = неизвестный риск → блокируем.
    if (input.side !== 'BUY' && input.side !== 'SELL') {
      return Err(this._violation(
        'RISK_INPUT_INCOMPLETE',
        `side must be 'BUY' or 'SELL', got ${String(input.side)}`,
        { side: String(input.side) },
      ));
    }
    const isBuy = input.side === 'BUY';

    // Шаг 2: fail-closed валидация примитивных authoritative-входов
    // (openOrdersCount, timeToExpiryMs finite, pending для BUY).
    const inputViolation = this._validateInputsFailClosed(input, isBuy);
    if (inputViolation) return Err(inputViolation);

    // Шаг 3: безопасное извлечение и валидация price/size → orderNotional
    // (до limit comparisons; не полагаемся на поведение Decimal с NaN).
    const extracted = this._extractOrder(input);
    if (!extracted.ok) return Err(extracted.error);
    const { orderNotional, orderSize } = extracted.value;

    // Шаг 4: лимиты.
    // 4.0 expiry — только BUY (SELL не блокируем)
    const expiryViolation = this._checkTimeToExpiry(input.timeToExpiryMs, isBuy);
    if (expiryViolation) return Err(expiryViolation);

    // 4.1 maxOpenOrders — BUY и SELL (антиспам)
    const openOrdersViolation = this._checkMaxOpenOrders(input.openOrdersCount, input.strategyId);
    if (openOrdersViolation) return Err(openOrdersViolation);

    // 4.2 maxOrderNotional — BUY и SELL (fat-finger guard)
    const notionalViolation = this._checkOrderNotional(orderNotional);
    if (notionalViolation) return Err(notionalViolation);

    // 4.3–4.5 — только BUY: SELL (ликвидация) не увеличивает balance/position/
    // exposure риск, поэтому эти gate'ы (и связанные с ними pending/portfolio
    // значения) для SELL не вычисляются.
    if (isBuy) {
      const balanceViolation = this._checkAvailableBalance(input, orderNotional);
      if (balanceViolation) return Err(balanceViolation);

      const positionViolation = this._checkPositionSize(input, orderSize);
      if (positionViolation) return Err(positionViolation);

      const exposureViolation = this._checkTotalExposure(input, orderNotional);
      if (exposureViolation) return Err(exposureViolation);
    }

    return Ok(undefined);
  }

  // ── Приватные проверки ─────────────────────────────────────────────────────

  /** @returns `true`, если `v` — `Decimal`, finite и `>= 0`. */
  private static _isFiniteNonNegativeDecimal(v: unknown): v is Decimal {
    return Decimal.isDecimal(v) && (v as Decimal).isFinite() && !(v as Decimal).isNegative();
  }

  /** @returns `true`, если `v` — `Decimal`, finite и `> 0`. */
  private static _isFinitePositiveDecimal(v: unknown): v is Decimal {
    return Decimal.isDecimal(v) && (v as Decimal).isFinite() && (v as Decimal).greaterThan(0);
  }

  /**
   * Fail-closed валидация примитивных authoritative-входов до применения лимитов.
   *
   * @param input - Входные данные проверки
   * @param isBuy - Нормализованное направление (`side === 'BUY'`)
   * @returns `RiskViolationError('RISK_INPUT_INCOMPLETE')` при повреждённом
   *   входе, иначе `undefined`
   *
   * @remarks
   * Checker не доверяет числовым входам слепо: сторонний repository adapter мог
   * бы вернуть `Decimal(NaN)` (тогда `after.gt(limit)` вернул бы `false` и BUY
   * прошёл бы) или отрицательное pending (занизило бы projected position).
   * Проверяется: `openOrdersCount` (целое `>= 0`, BUY и SELL); `timeToExpiryMs`
   * (finite, если задано); `pendingBuyQuantityForInstrument` (только BUY —
   * `Decimal`, finite, `>= 0`; для SELL нерелевантен и не проверяется).
   */
  private _validateInputsFailClosed(input: PreOrderCheckInput, isBuy: boolean): RiskViolationError | undefined {
    if (!Number.isInteger(input.openOrdersCount) || input.openOrdersCount < 0) {
      return this._violation(
        'RISK_INPUT_INCOMPLETE',
        `openOrdersCount must be a non-negative integer, got ${String(input.openOrdersCount)}`,
        { openOrdersCount: String(input.openOrdersCount) },
      );
    }
    if (input.timeToExpiryMs !== undefined && !Number.isFinite(input.timeToExpiryMs)) {
      return this._violation(
        'RISK_INPUT_INCOMPLETE',
        `timeToExpiryMs must be finite when provided, got ${String(input.timeToExpiryMs)}`,
        { timeToExpiryMs: String(input.timeToExpiryMs) },
      );
    }
    if (isBuy && !OrderRiskChecker._isFiniteNonNegativeDecimal(input.pendingBuyQuantityForInstrument)) {
      return this._violation(
        'RISK_INPUT_INCOMPLETE',
        `pendingBuyQuantityForInstrument must be a finite non-negative Decimal, got ${String(input.pendingBuyQuantityForInstrument)}`,
        { pendingBuyQuantityForInstrument: String(input.pendingBuyQuantityForInstrument) },
      );
    }
    return undefined;
  }

  /**
   * Безопасно извлекает и валидирует `price`/`size`, вычисляет `orderNotional`.
   *
   * @param input - Входные данные
   * @returns `Ok({ orderNotional, orderSize })` или
   *   `Err(RiskViolationError('RISK_INPUT_INCOMPLETE'))`
   *
   * @remarks
   * `.value()` может бросить (повреждённый VO) — ловим и возвращаем
   * `RISK_INPUT_INCOMPLETE`, не пробрасывая. `price`/`size` обязаны быть
   * `Decimal`, finite и `> 0`; `orderNotional = price × size` — finite и `> 0`.
   * Проверки не полагаются на поведение Decimal-сравнений с NaN (сначала
   * `isFinite`, потом сравнение).
   */
  private _extractOrder(
    input: PreOrderCheckInput,
  ): Result<{ orderNotional: Decimal; orderSize: Decimal }, RiskViolationError> {
    let priceVal: Decimal;
    let sizeVal: Decimal;
    try {
      priceVal = input.price.value();
      sizeVal = input.size.value();
    } catch (err) {
      return Err(this._violation(
        'RISK_INPUT_INCOMPLETE',
        'Failed to read price/size value',
        { error: err instanceof Error ? err.name : 'unknown' },
      ));
    }
    if (!OrderRiskChecker._isFinitePositiveDecimal(priceVal)) {
      return Err(this._violation(
        'RISK_INPUT_INCOMPLETE',
        `price must be a finite positive Decimal, got ${String(priceVal)}`,
        { price: String(priceVal) },
      ));
    }
    if (!OrderRiskChecker._isFinitePositiveDecimal(sizeVal)) {
      return Err(this._violation(
        'RISK_INPUT_INCOMPLETE',
        `size must be a finite positive Decimal, got ${String(sizeVal)}`,
        { size: String(sizeVal) },
      ));
    }
    let orderNotional: Decimal;
    try {
      orderNotional = priceVal.times(sizeVal);
    } catch (err) {
      return Err(this._violation(
        'RISK_INPUT_INCOMPLETE',
        'Failed to compute order notional',
        { error: err instanceof Error ? err.name : 'unknown' },
      ));
    }
    if (!orderNotional.isFinite() || orderNotional.lessThanOrEqualTo(0)) {
      return Err(this._violation(
        'RISK_INPUT_INCOMPLETE',
        `orderNotional must be finite and > 0, got ${String(orderNotional)}`,
        { notional: String(orderNotional) },
      ));
    }
    return Ok({ orderNotional, orderSize: sizeVal });
  }

  /**
   * Проверяет minTimeToExpiryMs — не размещать BUY-ордера слишком близко к экспирации.
   *
   * @param timeToExpiryMs - Время до экспирации в ms (`undefined` = данные недоступны;
   *   finite гарантирован `_validateInputsFailClosed`)
   * @param isBuy - Нормализованное направление. SELL не блокируется — ликвидация
   *   позиции у экспирации допустима.
   * @returns RiskViolationError или undefined если проверка пройдена
   *
   * @remarks
   * Fail-closed для BUY: если лимит включён (`minTimeToExpiryMs !== undefined`),
   * а `timeToExpiryMs` недоступно (`undefined`) — возвращается
   * `RISK_INPUT_INCOMPLETE`. Отрицательное `timeToExpiryMs` (рынок уже истёк)
   * блокирует BUY через `TOO_CLOSE_TO_EXPIRY`. SELL не блокируется ни при
   * `undefined`, ни при отрицательном значении.
   */
  private _checkTimeToExpiry(timeToExpiryMs: number | undefined, isBuy: boolean): RiskViolationError | undefined {
    if (this._params.minTimeToExpiryMs === undefined) return undefined;
    // SELL (ликвидация позиции) разрешён у самой экспирации и даже при отсутствии expiry.
    if (!isBuy) return undefined;
    // Fail-closed: BUY без доступного expiry при включённом лимите — блокируем.
    if (timeToExpiryMs === undefined) {
      return this._violation(
        'RISK_INPUT_INCOMPLETE',
        'Time to expiry unavailable for BUY while minTimeToExpiryMs limit is enabled',
        { minTimeToExpiryMs: this._params.minTimeToExpiryMs },
      );
    }
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
   * Проверяет минимальный доступный USDC-баланс (только BUY — вызывается под
   * `if (isBuy)`).
   *
   * @remarks
   * `available` валидируется fail-closed (`Decimal`, finite, `>= 0`) — иначе
   * `RISK_INPUT_INCOMPLETE`. Отрицательный `afterReserve` (ордер больше баланса)
   * — это ОБЫЧНОЕ `INSUFFICIENT_AVAILABLE_BALANCE`, а не повреждение входа.
   */
  private _checkAvailableBalance(
    input: PreOrderCheckInput,
    orderNotional: Decimal,
  ): RiskViolationError | undefined {
    if (this._params.minAvailableBalance === undefined) return undefined;

    let available: Decimal;
    try {
      available = input.portfolio.balance.available().value();
    } catch (err) {
      return this._violation('RISK_INPUT_INCOMPLETE', 'Failed to read available balance', {
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
    if (!OrderRiskChecker._isFiniteNonNegativeDecimal(available)) {
      return this._violation(
        'RISK_INPUT_INCOMPLETE',
        `available balance must be a finite non-negative Decimal, got ${String(available)}`,
        { available: String(available) },
      );
    }

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

  /**
   * Проверяет maxPositionSize (только BUY — вызывается под `if (isBuy)`).
   *
   * @param input - Входные данные
   * @param orderSize - Уже провалидированный размер ордера (finite, `> 0`)
   *
   * @remarks
   * Проекция позиции = исполненное количество (`portfolio.getPosition`) +
   * pending held BUY quantity + новый BUY. `current` валидируется fail-closed
   * (`Decimal`, finite, `>= 0`); pending уже проверен в
   * `_validateInputsFailClosed`; projected обязан быть finite и `>= 0` — иначе
   * `RISK_INPUT_INCOMPLETE`. pending-слагаемое обязательно: резервации под ещё не
   * исполненные/ambiguous BUY-ордера НЕ отражены в позиции.
   */
  private _checkPositionSize(input: PreOrderCheckInput, orderSize: Decimal): RiskViolationError | undefined {
    if (this._params.maxPositionSize === undefined) return undefined;

    let current: Decimal;
    try {
      const position = input.portfolio.getPosition(input.instrumentId);
      current = position ? position.quantity.value() : new Decimal(0);
    } catch (err) {
      return this._violation('RISK_INPUT_INCOMPLETE', 'Failed to read current position quantity', {
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
    if (!OrderRiskChecker._isFiniteNonNegativeDecimal(current)) {
      return this._violation(
        'RISK_INPUT_INCOMPLETE',
        `current position quantity must be a finite non-negative Decimal, got ${String(current)}`,
        { current: String(current) },
      );
    }

    const pending = input.pendingBuyQuantityForInstrument;
    const after = current.plus(pending).plus(orderSize);
    if (!after.isFinite() || after.isNegative()) {
      return this._violation(
        'RISK_INPUT_INCOMPLETE',
        `projected position must be finite and >= 0, got ${String(after)}`,
        { after: String(after) },
      );
    }
    if (!after.gt(this._params.maxPositionSize)) return undefined;

    return this._violation(
      'POSITION_LIMIT_EXCEEDED',
      `Position after order ${after.toString()} > limit ${this._params.maxPositionSize.toString()} tokens`,
      {
        instrumentId: String(input.instrumentId),
        current: current.toString(),
        pending: pending.toString(),
        after: after.toString(),
        limit: this._params.maxPositionSize.toString(),
      },
    );
  }

  /**
   * Вычисляет total exposure (только BUY — вызывается под `if (isBuy)`, O(N)).
   *
   * @remarks
   * Проекция (без double-counting):
   * ```
   * projectedTotalExposure =
   *   filledPositionCostBasis            // sum(quantity × averageEntryPrice)
   *   + portfolio.balance.reserved()     // остаток USDC под pending BUY-ордерами
   *   + newBuyNotional                   // price × size нового ордера
   * ```
   * `reserved()` — authoritative-сумма замороженного под BUY капитала (OPEN,
   * partial fills, UNKNOWN, terminal settlement pending). Исполненные позиции уже
   * списали свою резервацию (consumed), поэтому cost basis и reserved не
   * пересекаются. Все portfolio-derived значения валидируются fail-closed
   * (`quantity`/`reserved` — finite `>= 0`; `averageEntryPrice` — finite `> 0`;
   * накопленная и projected exposure — finite `>= 0`), иначе
   * `RISK_INPUT_INCOMPLETE`. Не требует markPrices — cost basis как консервативная
   * оценка.
   */
  private _checkTotalExposure(
    input: PreOrderCheckInput,
    orderNotional: Decimal,
  ): RiskViolationError | undefined {
    if (this._params.maxTotalExposure === undefined) return undefined;

    let currentExposure = new Decimal(0);
    let reserved: Decimal;
    try {
      for (const position of input.portfolio.getPositions()) {
        const qty = position.quantity.value();
        const avg = position.averageEntryPrice.value();
        if (!OrderRiskChecker._isFiniteNonNegativeDecimal(qty)) {
          return this._violation(
            'RISK_INPUT_INCOMPLETE',
            `position quantity must be a finite non-negative Decimal, got ${String(qty)}`,
            { quantity: String(qty) },
          );
        }
        if (!OrderRiskChecker._isFinitePositiveDecimal(avg)) {
          return this._violation(
            'RISK_INPUT_INCOMPLETE',
            `position averageEntryPrice must be a finite positive Decimal, got ${String(avg)}`,
            { averageEntryPrice: String(avg) },
          );
        }
        currentExposure = currentExposure.plus(qty.times(avg));
        if (!currentExposure.isFinite() || currentExposure.isNegative()) {
          return this._violation(
            'RISK_INPUT_INCOMPLETE',
            `accumulated exposure must be finite and >= 0, got ${String(currentExposure)}`,
            { currentExposure: String(currentExposure) },
          );
        }
      }
      reserved = input.portfolio.balance.reserved().value();
    } catch (err) {
      return this._violation('RISK_INPUT_INCOMPLETE', 'Failed to read portfolio exposure inputs', {
        error: err instanceof Error ? err.name : 'unknown',
      });
    }

    if (!OrderRiskChecker._isFiniteNonNegativeDecimal(reserved)) {
      return this._violation(
        'RISK_INPUT_INCOMPLETE',
        `reserved must be a finite non-negative Decimal, got ${String(reserved)}`,
        { reserved: String(reserved) },
      );
    }

    const after = currentExposure.plus(reserved).plus(orderNotional);
    if (!after.isFinite() || after.isNegative()) {
      return this._violation(
        'RISK_INPUT_INCOMPLETE',
        `projected exposure must be finite and >= 0, got ${String(after)}`,
        { after: String(after) },
      );
    }
    if (!after.gt(this._params.maxTotalExposure)) return undefined;

    return this._violation(
      'TOTAL_EXPOSURE_EXCEEDED',
      `Total exposure ${after.toFixed(2)} > limit ${this._params.maxTotalExposure.toFixed(2)} USDC`,
      {
        costBasis: currentExposure.toString(),
        reserved: reserved.toString(),
        newNotional: orderNotional.toString(),
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
