import { type Result, Ok, Err, isErr } from '@polymarket/result';
import {
  InvalidSpreadError,
  InvalidPriceError,
  ErrorSource,
  toDecimal,
  rewrap,
  unexpectedError,
  wrapOp
} from '@polymarket/errors';
import Decimal from 'decimal.js';
import { Price, PriceService } from '../../price/index.js';
import { Spread, SpreadErrorReason } from '../core/index.js';
import { ValidateBidAsk } from '../rules/ValidateBidAsk.js';
import { addDecimal, subtractDecimal } from '@polymarket/math';

/**
 * Фасад для работы с Spread - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций со спредами.
 * Оркестрирует Core + Math + Rules.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы SpreadService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 * Любые исключения из @polymarket/math, Core инвариантов или Rules ловятся и преобразуются в Result.Err.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - context.op - название операции (верхний уровень)
 * - context.bid/ask - входные цены (если применимо)
 * - context.spread - входной spread (если применимо)
 * - context.amount - входная величина операции (если применимо)
 * - context.cause - для math-исключений: { name, message, stack? } (root-cause, не перетирается)
 * - context.reason - для инвариантов Core (SpreadErrorReason enum)
 *
 * **Правило возвращаемых типов:**
 * ВСЕ операции возвращают Result<T, InvalidSpreadError | InvalidPriceError>
 * ОЖИДАЕМЫЕ и НЕОЖИДАННЫЕ ошибки обрабатываются через Result
 *
 * @example
 * ```typescript
 * import { SpreadService } from '@polymarket/value-objects/spread';
 * import { PriceService } from '@polymarket/value-objects/price';
 *
 * const bidResult = PriceService.create(0.48);
 * const askResult = PriceService.create(0.52);
 * if (isErr(bidResult) || isErr(askResult)) {
 *   // handle error
 * }
 *
 * const result = SpreadService.create(bidResult.value, askResult.value);
 * if (result.ok) {
 *   console.log(result.value.width()); // Decimal(0.04)
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */
export class SpreadService {
  private static readonly SERVICE_NAME = 'SpreadService';

  // ============================================================================
  // Factory Methods
  // ============================================================================

  /**
   * Создать Spread из Price объектов
   *
   * @param bid - Bid price
   * @param ask - Ask price
   * @returns Result со Spread или InvalidSpreadError
   *
   * @remarks
   * Валидирует что bid <= ask через Rules перед созданием Core объекта.
   * Ловит SpreadInvariantViolation из Core и преобразует в Result.Err.
   *
   * @example
   * ```typescript
   * const bidResult = PriceService.create(0.48);
   * const askResult = PriceService.create(0.52);
   * if (isErr(bidResult) || isErr(askResult)) return;
   *
   * const result = SpreadService.create(bidResult.value, askResult.value);
   * if (result.ok) {
   *   console.log(result.value.width()); // Decimal(0.04)
   * } else {
   *   console.error(result.error.context); // { op, bid, ask, reason?, cause? }
   * }
   * ```
   */
  public static create(bid: Price, ask: Price): Result<Spread, InvalidSpreadError> {
    // Валидация через Rule (опционально, можно положиться на Core инвариант)
    const validationResult = ValidateBidAsk.check(bid, ask);
    if (isErr(validationResult)) {
      return Err(
        rewrap(SpreadService.SERVICE_NAME, 'create', {
          bid: bid.value().toString(),
          ask: ask.value().toString()
        }, validationResult.error, InvalidSpreadError)
      );
    }

    // Создание через Core (может бросить SpreadInvariantViolation)
    return wrapOp(
      SpreadService.SERVICE_NAME,
      'create',
      {
        bid: bid.value().toString(),
        ask: ask.value().toString()
      },
      () => {
        const spread = Spread.of(bid, ask);
        return Ok(spread);
      },
      InvalidSpreadError
    );
  }

  /**
   * Создать Spread из числовых значений
   *
   * @param bidValue - Значение bid
   * @param askValue - Значение ask
   * @returns Result со Spread или InvalidPriceError/InvalidSpreadError
   *
   * @example
   * ```typescript
   * const result = SpreadService.fromValues(0.48, 0.52);
   * if (result.ok) {
   *   const spread = result.value;
   *   console.log(spread.width()); // Decimal(0.04)
   * }
   * ```
   */
  public static fromValues(
    bidValue: number | Decimal,
    askValue: number | Decimal
  ): Result<Spread, InvalidPriceError | InvalidSpreadError> {
    // Создаём Price объекты через PriceService
    const bidDecimal = bidValue instanceof Decimal ? bidValue : new Decimal(bidValue);
    const askDecimal = askValue instanceof Decimal ? askValue : new Decimal(askValue);

    const bidResult = PriceService.create(bidDecimal);
    if (isErr(bidResult)) {
      return Err(
        rewrap(SpreadService.SERVICE_NAME, 'fromValues', {
          bidValue: bidDecimal.toString(),
          askValue: askDecimal.toString()
        }, bidResult.error as InvalidSpreadError, InvalidSpreadError)
      );
    }

    const askResult = PriceService.create(askDecimal);
    if (isErr(askResult)) {
      return Err(
        rewrap(SpreadService.SERVICE_NAME, 'fromValues', {
          bidValue: bidDecimal.toString(),
          askValue: askDecimal.toString()
        }, askResult.error as InvalidSpreadError, InvalidSpreadError)
      );
    }

    return SpreadService.create(bidResult.value, askResult.value);
  }

  /**
   * Создать spread с нулевой шириной
   *
   * @param price - Цена для bid и ask
   * @returns Spread с нулевой шириной
   *
   * @example
   * ```typescript
   * const priceResult = PriceService.create(0.50);
   * if (priceResult.ok) {
   *   const spread = SpreadService.zero(priceResult.value);
   *   console.log(spread.width().toNumber()); // 0
   * }
   * ```
   */
  public static zero(price: Price): Spread {
    return Spread.zero(price);
  }

  // ============================================================================
  // Operations
  // ============================================================================

  /**
   * Сузить spread (bid ↑, ask ↓)
   *
   * @param spread - Исходный spread
   * @param amount - Величина сужения
   * @returns Result с новым Spread или InvalidSpreadError
   *
   * @remarks
   * Сдвигает bid вверх и ask вниз на указанную величину.
   * Если amount > width/2, сужает до нулевой ширины.
   *
   * @example
   * ```typescript
   * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
   * const tightened = SpreadService.tighten(spread, new Decimal(0.01));
   * if (tightened.ok) {
   *   console.log(tightened.value.bid().value()); // 0.49
   *   console.log(tightened.value.ask().value()); // 0.51
   * }
   * ```
   */
  public static tighten(
    spread: Spread,
    amount: Decimal | number | string
  ): Result<Spread, InvalidSpreadError | InvalidPriceError> {
    // Парсим amount через toDecimal
    const amountResult = toDecimal<InvalidSpreadError>(
      'amount',
      amount,
      SpreadErrorReason.INVALID_AMOUNT,
      InvalidSpreadError
    );
    if (isErr(amountResult)) {
      return Err(
        rewrap(SpreadService.SERVICE_NAME, 'tighten', {
          spread: `${spread.bid().value()}-${spread.ask().value()}`,
          amount: String(amount)
        }, amountResult.error, InvalidSpreadError)
      );
    }

    const amountDecimal = amountResult.value;

    // Валидация amount
    if (!amountDecimal.isFinite()) {
      return Err(
        new InvalidSpreadError(
          'Tighten amount must be finite',
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              service: SpreadService.SERVICE_NAME,
              op: 'tighten',
              amount: amountDecimal.toString(),
              spread: `${spread.bid().value()}-${spread.ask().value()}`,
              reason: SpreadErrorReason.INVALID_AMOUNT
            }
          }
        )
      );
    }

    if (amountDecimal.isNegative()) {
      return Err(
        new InvalidSpreadError(
          'Tighten amount cannot be negative',
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              service: SpreadService.SERVICE_NAME,
              op: 'tighten',
              amount: amountDecimal.toString(),
              spread: `${spread.bid().value()}-${spread.ask().value()}`,
              reason: SpreadErrorReason.INVALID_AMOUNT
            }
          }
        )
      );
    }

    try {
      // Ограничиваем amount до halfWidth
      const halfWidth = spread.width().dividedBy(2);
      const actualAmount = amountDecimal.lessThanOrEqualTo(halfWidth) ? amountDecimal : halfWidth;

      // Новые цены через math functions + PriceService.create
      const newBidValue = addDecimal(spread.bid().value(), actualAmount);
      const newBidResult = PriceService.create(newBidValue);
      if (isErr(newBidResult)) {
        return Err(
          rewrap(SpreadService.SERVICE_NAME, 'tighten', {
            spread: `${spread.bid().value()}-${spread.ask().value()}`,
            amount: actualAmount.toString(),
            operation: 'add to bid'
          }, newBidResult.error as InvalidSpreadError, InvalidSpreadError)
        );
      }

      const newAskValue = subtractDecimal(spread.ask().value(), actualAmount);
      const newAskResult = PriceService.create(newAskValue);
      if (isErr(newAskResult)) {
        return Err(
          rewrap(SpreadService.SERVICE_NAME, 'tighten', {
            spread: `${spread.bid().value()}-${spread.ask().value()}`,
            amount: actualAmount.toString(),
            operation: 'subtract from ask'
          }, newAskResult.error as InvalidSpreadError, InvalidSpreadError)
        );
      }

      return SpreadService.create(newBidResult.value, newAskResult.value);
    } catch (error) {
      // Неожиданные ошибки
      return Err(
        unexpectedError(SpreadService.SERVICE_NAME, 'tighten', {
          spread: `${spread.bid().value()}-${spread.ask().value()}`,
          amount: amountDecimal.toString()
        }, error, InvalidSpreadError)
      );
    }
  }

  /**
   * Расширить spread (bid ↓, ask ↑)
   *
   * @param spread - Исходный spread
   * @param amount - Величина расширения
   * @returns Result с новым Spread или InvalidSpreadError
   *
   * @remarks
   * Сдвигает bid вниз и ask вверх на указанную величину.
   * Соблюдает границы цен [MIN_PRICE, MAX_PRICE].
   *
   * @example
   * ```typescript
   * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
   * const widened = SpreadService.widen(spread, new Decimal(0.02));
   * if (widened.ok) {
   *   console.log(widened.value.bid().value()); // 0.46
   *   console.log(widened.value.ask().value()); // 0.54
   * }
   * ```
   */
  public static widen(
    spread: Spread,
    amount: Decimal | number | string
  ): Result<Spread, InvalidSpreadError | InvalidPriceError> {
    // Парсим amount через toDecimal
    const amountResult = toDecimal<InvalidSpreadError>(
      'amount',
      amount,
      SpreadErrorReason.INVALID_AMOUNT,
      InvalidSpreadError
    );
    if (isErr(amountResult)) {
      return Err(
        rewrap(SpreadService.SERVICE_NAME, 'widen', {
          spread: `${spread.bid().value()}-${spread.ask().value()}`,
          amount: String(amount)
        }, amountResult.error, InvalidSpreadError)
      );
    }

    const amountDecimal = amountResult.value;

    // Валидация amount
    if (!amountDecimal.isFinite()) {
      return Err(
        new InvalidSpreadError(
          'Widen amount must be finite',
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              op: 'widen',
              amount: amountDecimal.toString(),
              spread: `${spread.bid().value()}-${spread.ask().value()}`,
              reason: SpreadErrorReason.INVALID_AMOUNT
            }
          }
        )
      );
    }

    if (amountDecimal.isNegative()) {
      return Err(
        new InvalidSpreadError(
          'Widen amount cannot be negative',
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              op: 'widen',
              amount: amountDecimal.toString(),
              spread: `${spread.bid().value()}-${spread.ask().value()}`,
              reason: SpreadErrorReason.INVALID_AMOUNT
            }
          }
        )
      );
    }

    try {
      // Новые цены через math functions + PriceService.create
      const newBidValue = subtractDecimal(spread.bid().value(), amountDecimal);
      const newBidResult = PriceService.create(newBidValue);
      if (isErr(newBidResult)) {
        return Err(
          rewrap(SpreadService.SERVICE_NAME, 'widen', {
            spread: `${spread.bid().value()}-${spread.ask().value()}`,
            amount: amountDecimal.toString(),
            operation: 'subtract from bid'
          }, newBidResult.error as InvalidSpreadError, InvalidSpreadError)
        );
      }

      const newAskValue = addDecimal(spread.ask().value(), amountDecimal);
      const newAskResult = PriceService.create(newAskValue);
      if (isErr(newAskResult)) {
        return Err(
          rewrap(SpreadService.SERVICE_NAME, 'widen', {
            spread: `${spread.bid().value()}-${spread.ask().value()}`,
            amount: amountDecimal.toString(),
            operation: 'add to ask'
          }, newAskResult.error as InvalidSpreadError, InvalidSpreadError)
        );
      }

      return SpreadService.create(newBidResult.value, newAskResult.value);
    } catch (error) {
      // Неожиданные ошибки
      return Err(
        unexpectedError(SpreadService.SERVICE_NAME, 'widen', {
          spread: `${spread.bid().value()}-${spread.ask().value()}`,
          amount: amountDecimal.toString()
        }, error, InvalidSpreadError)
      );
    }
  }

  /**
   * Сдвинуть spread вверх или вниз
   *
   * @param spread - Исходный spread
   * @param amount - Величина сдвига (+ вверх, - вниз)
   * @returns Result с новым Spread или InvalidSpreadError
   *
   * @remarks
   * Сдвигает bid и ask на одинаковую величину.
   * Ширина спреда сохраняется.
   * Соблюдает границы цен.
   *
   * @example
   * ```typescript
   * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
   * const shifted = SpreadService.shift(spread, new Decimal(0.05));
   * if (shifted.ok) {
   *   console.log(shifted.value.bid().value()); // 0.53
   *   console.log(shifted.value.ask().value()); // 0.57
   *   console.log(shifted.value.width()); // 0.04 (unchanged)
   * }
   * ```
   */
  public static shift(
    spread: Spread,
    amount: Decimal | number | string
  ): Result<Spread, InvalidSpreadError | InvalidPriceError> {
    // Парсим amount через toDecimal
    const amountResult = toDecimal<InvalidSpreadError>(
      'amount',
      amount,
      SpreadErrorReason.INVALID_AMOUNT,
      InvalidSpreadError
    );
    if (isErr(amountResult)) {
      return Err(
        rewrap(SpreadService.SERVICE_NAME, 'shift', {
          spread: `${spread.bid().value()}-${spread.ask().value()}`,
          amount: String(amount)
        }, amountResult.error, InvalidSpreadError)
      );
    }

    const amountDecimal = amountResult.value;

    // Валидация amount
    if (!amountDecimal.isFinite()) {
      return Err(
        new InvalidSpreadError(
          'Shift amount must be finite',
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              op: 'shift',
              amount: amountDecimal.toString(),
              spread: `${spread.bid().value()}-${spread.ask().value()}`,
              reason: SpreadErrorReason.INVALID_AMOUNT
            }
          }
        )
      );
    }

    try {
      // Сдвигаем обе цены через math functions + PriceService.create
      const newBidValue = addDecimal(spread.bid().value(), amountDecimal);
      const newBidResult = PriceService.create(newBidValue);
      if (isErr(newBidResult)) {
        return Err(
          rewrap(SpreadService.SERVICE_NAME, 'shift', {
            spread: `${spread.bid().value()}-${spread.ask().value()}`,
            amount: amountDecimal.toString(),
            operation: 'shift bid'
          }, newBidResult.error as InvalidSpreadError, InvalidSpreadError)
        );
      }

      const newAskValue = addDecimal(spread.ask().value(), amountDecimal);
      const newAskResult = PriceService.create(newAskValue);
      if (isErr(newAskResult)) {
        return Err(
          rewrap(SpreadService.SERVICE_NAME, 'shift', {
            spread: `${spread.bid().value()}-${spread.ask().value()}`,
            amount: amountDecimal.toString(),
            operation: 'shift ask'
          }, newAskResult.error as InvalidSpreadError, InvalidSpreadError)
        );
      }

      return SpreadService.create(newBidResult.value, newAskResult.value);
    } catch (error) {
      // Неожиданные ошибки
      return Err(
        unexpectedError(SpreadService.SERVICE_NAME, 'shift', {
          spread: `${spread.bid().value()}-${spread.ask().value()}`,
          amount: amountDecimal.toString()
        }, error, InvalidSpreadError)
      );
    }
  }

  /**
   * Получает mid price для spread
   *
   * @remarks
   * Создаёт Price из spread.mid() Decimal значения.
   * Математически безопасно - mid всегда в границах если bid/ask валидны.
   *
   * @param spread - Spread для вычисления mid
   * @returns Price mid
   *
   * @example
   * ```typescript
   * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
   * const mid = SpreadService.getMidPrice(spread);
   * console.log(mid.value().toString()); // "0.5"
   * ```
   */
  public static getMidPrice(spread: Spread): Price {
    const midDecimal = spread.mid();

    // SAFETY: mid всегда в [MIN_PRICE, MAX_PRICE] если bid/ask валидны
    // bid <= ask (инвариант) и оба в [MIN, MAX] → mid в [MIN, MAX]
    // Price.of() не должен бросить, но используем try-catch для безопасности
    try {
      return Price.of(midDecimal);
    } catch (error) {
      // Это не должно случиться - если случилось, это баг
      throw new Error(`Internal error: mid ${midDecimal} out of Price bounds`);
    }
  }
}
