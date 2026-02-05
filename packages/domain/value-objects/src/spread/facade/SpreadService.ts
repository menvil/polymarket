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
import { Spread } from '../core/index.js';
import { SpreadErrorReason } from '../errors/SpreadErrorReason.js';
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
   * @param amount - Величина сужения (должна быть >= 0)
   * @returns Result с новым Spread или InvalidSpreadError
   *
   * @remarks
   * **Операция:**
   * - Сдвигает bid вверх на amount: `newBid = bid + amount`
   * - Сдвигает ask вниз на amount: `newAsk = ask - amount`
   * - Результат: ширина уменьшается на `2 * amount`
   *
   * **Boundary behavior:**
   * - Если `amount > width/2`, автоматически ограничивается до `width/2`
   * - Минимальная ширина результата: 0 (zero-width spread)
   * - Если новые цены выходят за [MIN_PRICE, MAX_PRICE], возвращает Err
   *
   * **Immutability:**
   * Исходный spread НЕ изменяется. Возвращается новый Spread объект.
   *
   * **Validation:**
   * - amount должен быть finite
   * - amount должен быть non-negative
   * - amount может быть 0 (возвращает эквивалентный spread)
   *
   * @example
   * ```typescript
   * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
   *
   * // Нормальное сужение
   * const tightened = SpreadService.tighten(spread, new Decimal(0.01));
   * if (tightened.ok) {
   *   console.log(tightened.value.bid().value()); // 0.49
   *   console.log(tightened.value.ask().value()); // 0.51
   *   console.log(tightened.value.width()); // 0.02
   * }
   *
   * // Сужение > width/2 → zero-width spread
   * const collapsed = SpreadService.tighten(spread, new Decimal(0.05));
   * if (collapsed.ok) {
   *   console.log(collapsed.value.width().toNumber()); // 0
   *   console.log(collapsed.value.bid().equals(collapsed.value.ask())); // true
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
      SpreadErrorReason.INVALID_FORMAT,
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

      // Новые цены через math functions + createPrice helper
      const newBidValue = addDecimal(spread.bid().value(), actualAmount);
      const newBidResult = SpreadService.createPrice('tighten', 'bid', newBidValue, spread, 'add to bid');
      if (isErr(newBidResult)) {
        return newBidResult;
      }

      const newAskValue = subtractDecimal(spread.ask().value(), actualAmount);
      const newAskResult = SpreadService.createPrice('tighten', 'ask', newAskValue, spread, 'subtract from ask');
      if (isErr(newAskResult)) {
        return newAskResult;
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
   * @param amount - Величина расширения (должна быть >= 0)
   * @returns Result с новым Spread или InvalidSpreadError
   *
   * @remarks
   * **Операция:**
   * - Сдвигает bid вниз на amount: `newBid = bid - amount`
   * - Сдвигает ask вверх на amount: `newAsk = ask + amount`
   * - Результат: ширина увеличивается на `2 * amount`
   *
   * **Boundary behavior:**
   * - Если новые цены выходят за [MIN_PRICE, MAX_PRICE], возвращает Err
   * - Нет автоматического ограничения amount (в отличие от tighten)
   * - Максимальная ширина результата: `MAX_PRICE - MIN_PRICE`
   *
   * **Immutability:**
   * Исходный spread НЕ изменяется. Возвращается новый Spread объект.
   *
   * **Validation:**
   * - amount должен быть finite
   * - amount должен быть non-negative
   * - amount может быть 0 (возвращает эквивалентный spread)
   *
   * @example
   * ```typescript
   * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
   *
   * // Нормальное расширение
   * const widened = SpreadService.widen(spread, new Decimal(0.02));
   * if (widened.ok) {
   *   console.log(widened.value.bid().value()); // 0.46
   *   console.log(widened.value.ask().value()); // 0.54
   *   console.log(widened.value.width()); // 0.08
   * }
   *
   * // Расширение за границы → Err
   * const tooWide = SpreadService.widen(spread, new Decimal(0.5));
   * console.log(tooWide.ok); // false (bid < MIN_PRICE или ask > MAX_PRICE)
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
      SpreadErrorReason.INVALID_FORMAT,
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
      // Новые цены через math functions + createPrice helper
      const newBidValue = subtractDecimal(spread.bid().value(), amountDecimal);
      const newBidResult = SpreadService.createPrice('widen', 'bid', newBidValue, spread, 'subtract from bid');
      if (isErr(newBidResult)) {
        return newBidResult;
      }

      const newAskValue = addDecimal(spread.ask().value(), amountDecimal);
      const newAskResult = SpreadService.createPrice('widen', 'ask', newAskValue, spread, 'add to ask');
      if (isErr(newAskResult)) {
        return newAskResult;
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
   * @param amount - Величина сдвига (+ вверх, - вниз, может быть отрицательным)
   * @returns Result с новым Spread или InvalidSpreadError
   *
   * @remarks
   * **Операция:**
   * - Сдвигает bid на amount: `newBid = bid + amount`
   * - Сдвигает ask на amount: `newAsk = ask + amount`
   * - Результат: ширина сохраняется `width = ask - bid` (unchanged)
   *
   * **Boundary behavior:**
   * - Если новые цены выходят за [MIN_PRICE, MAX_PRICE], возвращает Err
   * - amount может быть отрицательным (сдвиг вниз)
   * - amount может быть 0 (возвращает эквивалентный spread)
   *
   * **Immutability:**
   * Исходный spread НЕ изменяется. Возвращается новый Spread объект.
   *
   * **Validation:**
   * - amount должен быть finite
   * - amount может быть отрицательным (в отличие от tighten/widen)
   * - Проверка границ выполняется для обеих новых цен
   *
   * @example
   * ```typescript
   * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
   *
   * // Сдвиг вверх
   * const shiftedUp = SpreadService.shift(spread, new Decimal(0.05));
   * if (shiftedUp.ok) {
   *   console.log(shiftedUp.value.bid().value()); // 0.53
   *   console.log(shiftedUp.value.ask().value()); // 0.57
   *   console.log(shiftedUp.value.width()); // 0.04 (unchanged)
   * }
   *
   * // Сдвиг вниз (отрицательный amount)
   * const shiftedDown = SpreadService.shift(spread, new Decimal(-0.03));
   * if (shiftedDown.ok) {
   *   console.log(shiftedDown.value.bid().value()); // 0.45
   *   console.log(shiftedDown.value.ask().value()); // 0.49
   * }
   *
   * // Сдвиг за границы → Err
   * const outOfBounds = SpreadService.shift(spread, new Decimal(0.5));
   * console.log(outOfBounds.ok); // false (ask > MAX_PRICE)
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
      SpreadErrorReason.INVALID_FORMAT,
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
      // Сдвигаем обе цены через math functions + createPrice helper
      const newBidValue = addDecimal(spread.bid().value(), amountDecimal);
      const newBidResult = SpreadService.createPrice('shift', 'bid', newBidValue, spread, 'shift bid');
      if (isErr(newBidResult)) {
        return newBidResult;
      }

      const newAskValue = addDecimal(spread.ask().value(), amountDecimal);
      const newAskResult = SpreadService.createPrice('shift', 'ask', newAskValue, spread, 'shift ask');
      if (isErr(newAskResult)) {
        return newAskResult;
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
   * Создаёт Price из spread.mid() Decimal значения через PriceService.
   * Математически mid всегда в границах если bid/ask валидны, но метод возвращает
   * Result для соблюдения контракта "Never Throw".
   *
   * Алгоритм:
   * 1. Вычисляет mid через spread.mid() - (bid + ask) / 2
   * 2. Создаёт Price объект через PriceService.create()
   * 3. Если создание не удалось (не должно случиться), возвращает Err
   *
   * @param spread - Spread для вычисления mid
   * @returns Result с Price mid или InvalidSpreadError
   *
   * @throws {InvalidSpreadError} Никогда не бросает - возвращает Result
   *
   * @example
   * ```typescript
   * const spreadResult = SpreadService.fromValues(0.48, 0.52);
   * if (spreadResult.ok) {
   *   const midResult = SpreadService.getMidPrice(spreadResult.value);
   *   if (midResult.ok) {
   *     console.log(midResult.value.value().toString()); // "0.5"
   *   }
   * }
   * ```
   */
  public static getMidPrice(spread: Spread): Result<Price, InvalidSpreadError> {
    const op = 'getMidPrice';
    const midDecimal = spread.mid();

    return wrapOp(SpreadService.SERVICE_NAME, op, {
      bid: spread.bid().value().toString(),
      ask: spread.ask().value().toString(),
      mid: midDecimal.toString()
    }, () => {
      // SAFETY: mid всегда в [MIN_PRICE, MAX_PRICE] если bid/ask валидны
      // bid <= ask (инвариант) и оба в [MIN, MAX] → mid в [MIN, MAX]
      // Но мы всё равно обрабатываем через Result для безопасности
      const priceResult = PriceService.create(midDecimal);
      if (isErr(priceResult)) {
        // Это не должно случиться, но если случилось - обрабатываем корректно
        return Err(rewrap(
          SpreadService.SERVICE_NAME,
          op,
          {
            reason: SpreadErrorReason.INVALID_AMOUNT,
            component: 'mid'
          },
          priceResult.error,
          InvalidSpreadError
        ));
      }
      return Ok(priceResult.value);
    }, InvalidSpreadError);
  }

  // ============================================================================
  // Alternative Factory Methods
  // ============================================================================

  /**
   * Создать spread из mid и width
   *
   * @param mid - Midpoint (середина между bid и ask)
   * @param width - Ширина спреда (ask - bid)
   * @returns Result со Spread или InvalidSpreadError
   *
   * @remarks
   * @todo Реализовать когда закончим с Ratio VO.
   *
   * Будет вычислять:
   * - bid = mid - width/2
   * - ask = mid + width/2
   *
   * @example
   * ```typescript
   * // TODO: Пример будет добавлен после реализации
   * const result = SpreadService.fromMidAndWidth(0.50, 0.04);
   * // bid = 0.48, ask = 0.52
   * ```
   */
  public static fromMidAndWidth(
    mid: Decimal | number | string,
    width: Decimal | number | string
  ): Result<Spread, InvalidSpreadError> {
    void mid;
    void width;
    throw new Error('Not implemented yet. TODO: Implement after Ratio VO is complete.');
  }

  /**
   * Создать spread из mid и ширины в процентах
   *
   * @param mid - Midpoint (середина между bid и ask)
   * @param widthPercentage - Ширина в процентах от mid
   * @returns Result со Spread или InvalidSpreadError
   *
   * @remarks
   * @todo Реализовать когда закончим с Ratio VO.
   *
   * Будет вычислять:
   * - width = mid * (widthPercentage / 100)
   * - bid = mid - width/2
   * - ask = mid + width/2
   *
   * @example
   * ```typescript
   * // TODO: Пример будет добавлен после реализации
   * const result = SpreadService.fromMidAndWidthPercentage(0.50, 8);
   * // width = 0.50 * 0.08 = 0.04
   * // bid = 0.48, ask = 0.52
   * ```
   */
  public static fromMidAndWidthPercentage(
    mid: Decimal | number | string,
    widthPercentage: Decimal | number | string
  ): Result<Spread, InvalidSpreadError> {
    void mid;
    void widthPercentage;
    throw new Error('Not implemented yet. TODO: Implement after Ratio VO is complete.');
  }

  // ============================================================================
  // Asymmetric Operations
  // ============================================================================

  /**
   * Независимо скорректировать bid цену
   *
   * @param spread - Исходный spread
   * @param amount - Величина корректировки (+ вверх, - вниз)
   * @returns Result с новым Spread или InvalidSpreadError
   *
   * @remarks
   * **Операция:**
   * - Изменяет только bid: `newBid = bid + amount`
   * - Ask остаётся неизменным
   * - Ширина изменяется на `-amount`
   *
   * **Boundary behavior:**
   * - Если newBid > ask, возвращает Err (нарушение инварианта)
   * - Если newBid выходит за [MIN_PRICE, MAX_PRICE], возвращает Err
   *
   * **Immutability:**
   * Исходный spread НЕ изменяется. Возвращается новый Spread объект.
   *
   * @example
   * ```typescript
   * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
   *
   * // Поднять bid
   * const adjusted = SpreadService.adjustBid(spread, new Decimal(0.01));
   * if (adjusted.ok) {
   *   console.log(adjusted.value.bid().value()); // 0.49
   *   console.log(adjusted.value.ask().value()); // 0.52 (unchanged)
   *   console.log(adjusted.value.width()); // 0.03 (was 0.04)
   * }
   * ```
   */
  public static adjustBid(
    spread: Spread,
    amount: Decimal | number | string
  ): Result<Spread, InvalidSpreadError | InvalidPriceError> {
    const op = 'adjustBid';

    // Парсим amount
    const amountResult = toDecimal<InvalidSpreadError>(
      'amount',
      amount,
      SpreadErrorReason.INVALID_FORMAT,
      InvalidSpreadError
    );
    if (isErr(amountResult)) {
      return Err(
        rewrap(SpreadService.SERVICE_NAME, op, {
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
          'Adjust amount must be finite',
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              service: SpreadService.SERVICE_NAME,
              op,
              amount: amountDecimal.toString(),
              spread: `${spread.bid().value()}-${spread.ask().value()}`,
              reason: SpreadErrorReason.INVALID_AMOUNT
            }
          }
        )
      );
    }

    try {
      // Новый bid через math + createPrice helper
      const newBidValue = addDecimal(spread.bid().value(), amountDecimal);
      const newBidResult = SpreadService.createPrice(op, 'bid', newBidValue, spread, 'adjust bid');
      if (isErr(newBidResult)) {
        return newBidResult;
      }

      return SpreadService.create(newBidResult.value, spread.ask());
    } catch (error) {
      return Err(
        unexpectedError(SpreadService.SERVICE_NAME, op, {
          spread: `${spread.bid().value()}-${spread.ask().value()}`,
          amount: amountDecimal.toString()
        }, error, InvalidSpreadError)
      );
    }
  }

  /**
   * Независимо скорректировать ask цену
   *
   * @param spread - Исходный spread
   * @param amount - Величина корректировки (+ вверх, - вниз)
   * @returns Result с новым Spread или InvalidSpreadError
   *
   * @remarks
   * **Операция:**
   * - Изменяет только ask: `newAsk = ask + amount`
   * - Bid остаётся неизменным
   * - Ширина изменяется на `+amount`
   *
   * **Boundary behavior:**
   * - Если newAsk < bid, возвращает Err (нарушение инварианта)
   * - Если newAsk выходит за [MIN_PRICE, MAX_PRICE], возвращает Err
   *
   * **Immutability:**
   * Исходный spread НЕ изменяется. Возвращается новый Spread объект.
   *
   * @example
   * ```typescript
   * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
   *
   * // Поднять ask
   * const adjusted = SpreadService.adjustAsk(spread, new Decimal(0.02));
   * if (adjusted.ok) {
   *   console.log(adjusted.value.bid().value()); // 0.48 (unchanged)
   *   console.log(adjusted.value.ask().value()); // 0.54
   *   console.log(adjusted.value.width()); // 0.06 (was 0.04)
   * }
   * ```
   */
  public static adjustAsk(
    spread: Spread,
    amount: Decimal | number | string
  ): Result<Spread, InvalidSpreadError | InvalidPriceError> {
    const op = 'adjustAsk';

    // Парсим amount
    const amountResult = toDecimal<InvalidSpreadError>(
      'amount',
      amount,
      SpreadErrorReason.INVALID_FORMAT,
      InvalidSpreadError
    );
    if (isErr(amountResult)) {
      return Err(
        rewrap(SpreadService.SERVICE_NAME, op, {
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
          'Adjust amount must be finite',
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              service: SpreadService.SERVICE_NAME,
              op,
              amount: amountDecimal.toString(),
              spread: `${spread.bid().value()}-${spread.ask().value()}`,
              reason: SpreadErrorReason.INVALID_AMOUNT
            }
          }
        )
      );
    }

    try {
      // Новый ask через math + createPrice helper
      const newAskValue = addDecimal(spread.ask().value(), amountDecimal);
      const newAskResult = SpreadService.createPrice(op, 'ask', newAskValue, spread, 'adjust ask');
      if (isErr(newAskResult)) {
        return newAskResult;
      }

      return SpreadService.create(spread.bid(), newAskResult.value);
    } catch (error) {
      return Err(
        unexpectedError(SpreadService.SERVICE_NAME, op, {
          spread: `${spread.bid().value()}-${spread.ask().value()}`,
          amount: amountDecimal.toString()
        }, error, InvalidSpreadError)
      );
    }
  }

  /**
   * Независимо скорректировать bid и ask цены
   *
   * @param spread - Исходный spread
   * @param bidAmount - Величина корректировки bid (+ вверх, - вниз)
   * @param askAmount - Величина корректировки ask (+ вверх, - вниз)
   * @returns Result с новым Spread или InvalidSpreadError
   *
   * @remarks
   * Комбинация adjustBid() и adjustAsk() в одной операции.
   * Сначала применяет adjustBid(), затем adjustAsk().
   *
   * **Immutability:**
   * Исходный spread НЕ изменяется. Возвращается новый Spread объект.
   *
   * @example
   * ```typescript
   * const spread = unwrap(SpreadService.fromValues(0.48, 0.52));
   *
   * // Поднять bid на 0.01, опустить ask на 0.01
   * const adjusted = SpreadService.adjustBidAsk(
   *   spread,
   *   new Decimal(0.01),
   *   new Decimal(-0.01)
   * );
   * if (adjusted.ok) {
   *   console.log(adjusted.value.bid().value()); // 0.49
   *   console.log(adjusted.value.ask().value()); // 0.51
   *   console.log(adjusted.value.width()); // 0.02 (was 0.04)
   * }
   * ```
   */
  public static adjustBidAsk(
    spread: Spread,
    bidAmount: Decimal | number | string,
    askAmount: Decimal | number | string
  ): Result<Spread, InvalidSpreadError | InvalidPriceError> {
    // Сначала корректируем bid
    const bidAdjusted = SpreadService.adjustBid(spread, bidAmount);
    if (isErr(bidAdjusted)) {
      return bidAdjusted;
    }

    // Затем корректируем ask
    return SpreadService.adjustAsk(bidAdjusted.value, askAmount);
  }

  // ============================================================================
  // Spread Combining
  // ============================================================================

  /**
   * Объединить два spread в один охватывающий оба
   *
   * @param s1 - Первый spread
   * @param s2 - Второй spread
   * @returns Result со Spread охватывающим оба входных
   *
   * @remarks
   * **Операция:**
   * - Результат.bid = min(s1.bid, s2.bid)
   * - Результат.ask = max(s1.ask, s2.ask)
   * - Результат содержит оба входных спреда
   *
   * **Use case:**
   * Объединение order books с разных бирж.
   *
   * **Immutability:**
   * Входные spreads НЕ изменяются. Возвращается новый Spread объект.
   *
   * @example
   * ```typescript
   * const s1 = unwrap(SpreadService.fromValues(0.48, 0.52));
   * const s2 = unwrap(SpreadService.fromValues(0.50, 0.54));
   *
   * const merged = SpreadService.merge(s1, s2);
   * if (merged.ok) {
   *   console.log(merged.value.bid().value()); // 0.48 (min)
   *   console.log(merged.value.ask().value()); // 0.54 (max)
   *   console.log(merged.value.width()); // 0.06
   * }
   * ```
   */
  public static merge(
    s1: Spread,
    s2: Spread
  ): Result<Spread, InvalidSpreadError> {
    const op = 'merge';

    return wrapOp(SpreadService.SERVICE_NAME, op, {
      s1: `${s1.bid().value()}-${s1.ask().value()}`,
      s2: `${s2.bid().value()}-${s2.ask().value()}`
    }, () => {
      // Находим минимальный bid и максимальный ask
      const minBid = s1.bid().value().lessThan(s2.bid().value()) ? s1.bid() : s2.bid();
      const maxAsk = s1.ask().value().greaterThan(s2.ask().value()) ? s1.ask() : s2.ask();

      return SpreadService.create(minBid, maxAsk);
    }, InvalidSpreadError);
  }

  /**
   * Найти пересечение двух spread
   *
   * @param s1 - Первый spread
   * @param s2 - Второй spread
   * @returns Result со Spread пересечением или Err если нет пересечения
   *
   * @remarks
   * **Операция:**
   * - Результат.bid = max(s1.bid, s2.bid)
   * - Результат.ask = min(s1.ask, s2.ask)
   * - Возвращает Err если результирующий bid > ask (нет пересечения)
   *
   * **Use case:**
   * Нахождение общего диапазона цен на разных биржах.
   *
   * **Immutability:**
   * Входные spreads НЕ изменяются. Возвращается новый Spread объект.
   *
   * @example
   * ```typescript
   * const s1 = unwrap(SpreadService.fromValues(0.40, 0.60));
   * const s2 = unwrap(SpreadService.fromValues(0.50, 0.70));
   *
   * const intersection = SpreadService.intersect(s1, s2);
   * if (intersection.ok) {
   *   console.log(intersection.value.bid().value()); // 0.50 (max)
   *   console.log(intersection.value.ask().value()); // 0.60 (min)
   *   console.log(intersection.value.width()); // 0.10
   * }
   *
   * // Нет пересечения
   * const s3 = unwrap(SpreadService.fromValues(0.70, 0.80));
   * const noIntersect = SpreadService.intersect(s1, s3);
   * console.log(noIntersect.ok); // false
   * ```
   */
  public static intersect(
    s1: Spread,
    s2: Spread
  ): Result<Spread, InvalidSpreadError> {
    const op = 'intersect';

    return wrapOp(SpreadService.SERVICE_NAME, op, {
      s1: `${s1.bid().value()}-${s1.ask().value()}`,
      s2: `${s2.bid().value()}-${s2.ask().value()}`
    }, () => {
      // Находим максимальный bid и минимальный ask
      const maxBid = s1.bid().value().greaterThan(s2.bid().value()) ? s1.bid() : s2.bid();
      const minAsk = s1.ask().value().lessThan(s2.ask().value()) ? s1.ask() : s2.ask();

      // Проверяем что есть пересечение (bid <= ask)
      if (maxBid.value().greaterThan(minAsk.value())) {
        return Err(new InvalidSpreadError(
          'Spreads do not intersect',
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              service: SpreadService.SERVICE_NAME,
              op,
              s1: `${s1.bid().value()}-${s1.ask().value()}`,
              s2: `${s2.bid().value()}-${s2.ask().value()}`,
              reason: SpreadErrorReason.BID_GREATER_THAN_ASK
            }
          }
        ));
      }

      return SpreadService.create(maxBid, minAsk);
    }, InvalidSpreadError);
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Создать Price с полным error context
   *
   * @remarks
   * Централизует логику создания Price объектов в операциях (tighten/widen/shift).
   * Добавляет полный error context включая source, raw, reason fields.
   *
   * @param op - Название операции (tighten/widen/shift)
   * @param field - Название поля ('bid' или 'ask')
   * @param value - Decimal значение для Price
   * @param spread - Исходный spread для контекста
   * @param operationDesc - Описание операции для контекста
   * @returns Result с Price или InvalidSpreadError
   *
   * @example
   * ```typescript
   * const result = SpreadService.createPrice(
   *   'tighten',
   *   'bid',
   *   new Decimal(0.49),
   *   spread,
   *   'add to bid'
   * );
   * ```
   */
  private static createPrice(
    op: string,
    field: 'bid' | 'ask',
    value: Decimal,
    spread: Spread,
    operationDesc: string
  ): Result<Price, InvalidSpreadError> {
    const priceResult = PriceService.create(value);
    if (isErr(priceResult)) {
      return Err(
        rewrap(
          SpreadService.SERVICE_NAME,
          op,
          {
            source: ErrorSource.SERVICE_CALL,
            reason: SpreadErrorReason.OPERATION_OUT_OF_BOUNDS,
            raw: {
              field,
              value: value.toString(),
              operation: operationDesc
            },
            spread: `${spread.bid().value()}-${spread.ask().value()}`
          },
          priceResult.error,
          InvalidSpreadError
        )
      );
    }
    return Ok(priceResult.value);
  }
}
