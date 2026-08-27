/**
 * Общие операции над ценами — одна реализация на все ценовые домены.
 *
 * @remarks
 * Арифметика, выравнивание по тику, форматирование и JSON round-trip
 * идентичны для доли исхода и для цены актива: это операции над `Decimal`.
 * Доменным их делает единственная вещь — {@link PriceDomain}, через который
 * результат собирается обратно в цену и проверяется инвариантами домена.
 *
 * Тик-операции принимают базовый тик ПАРАМЕТРОМ, а не константой: у рынка
 * предсказаний он `0.0001`, у биржи свой на каждый инструмент и приходит из
 * market info. Захардкоженный базовый тик и был причиной, по которой прежняя
 * реализация не переносилась на второй домен.
 *
 * @example
 * ```typescript
 * const half = multiplyPrice(OUTCOME_DOMAIN, price, 0.5);
 * const rounded = roundPriceToTick(ASSET_DOMAIN, price, '0.01', '0.00000001');
 * ```
 */
import Decimal from 'decimal.js';
import { Result, Ok, Err, isErr } from '@polymarket/result';
import type { AnyTradingError } from '@polymarket/errors';
import { toDecimal, wrapOp, rewrap, ErrorSource } from '@polymarket/errors';
import {
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  roundToTick,
  floorToTick,
  ceilToTick,
} from '@polymarket/math';
import type { DecimalPrice } from './DecimalPrice.js';
import type { PriceDomain } from './priceDomain.js';
import { ValidateFactorForPriceMultiplication } from './ValidateFactorForPriceMultiplication.js';
import { ValidateDivisorForPriceDivision } from './ValidateDivisorForPriceDivision.js';
import { ValidateTickSizeMultipleOfBaseTick } from './ValidateTickSizeMultipleOfBaseTick.js';

/** Режим округления цены к тику. */
export type TickRoundingMode = 'nearest' | 'floor' | 'ceil';

/**
 * Парсит операнд в `Decimal`, сообщая об ошибке в терминах домена.
 *
 * @param domain - Ценовой домен
 * @param field - Имя поля операнда (для контекста ошибки)
 * @param op - Имя операции (для контекста ошибки)
 * @param raw - Значение операнда
 * @param context - Дополнительный контекст ошибки
 * @returns `Decimal` либо доменная ошибка
 */
function parseOperand<TPrice extends DecimalPrice, TError extends AnyTradingError>(
  domain: PriceDomain<TPrice, TError>,
  field: string,
  op: string,
  raw: number | string | Decimal,
  context: Record<string, unknown>,
): Result<Decimal, TError> {
  const parsed = toDecimal(field, raw, domain.invalidFormatReason, domain.ErrorConstructor);
  if (isErr(parsed)) {
    return Err(rewrap(domain.serviceName, op, context, parsed.error, domain.ErrorConstructor));
  }
  return Ok(parsed.value);
}

/**
 * Переносит ошибку правила в тип ошибки домена.
 *
 * @param domain - Ценовой домен
 * @param op - Имя операции
 * @param context - Контекст ошибки
 * @param error - Ошибка правила (`InvalidOperandError`, `InvalidDivisorError`, ...)
 * @returns Ошибка домена с сохранённой причиной и цепочкой операций
 *
 * @remarks
 * `rewrap` объявляет `err: TError`, то есть требует, чтобы входная ошибка
 * УЖЕ была ошибкой домена. Для правил это ограничение избыточно: правила
 * проверяют ОПЕРАНД (множитель, делитель) и о цене ничего не знают, поэтому
 * возвращают свои типы. Сам `rewrap` из входной ошибки читает только
 * `message`/`context` и конструирует НОВЫЙ объект через `ErrorConstructor` —
 * доменная специфика входного типа ему не нужна.
 *
 * Приведение изолировано здесь одной строкой вместо повторения в каждой
 * операции.
 */
function ruleErrorToDomain<TPrice extends DecimalPrice, TError extends AnyTradingError>(
  domain: PriceDomain<TPrice, TError>,
  op: string,
  context: Record<string, unknown>,
  error: AnyTradingError,
): TError {
  return rewrap(domain.serviceName, op, context, error as TError, domain.ErrorConstructor);
}

/**
 * Умножает цену на множитель.
 *
 * @param domain - Ценовой домен
 * @param price - Исходная цена
 * @param factor - Множитель (`number`, `string` или `Decimal`)
 * @returns Новая цена либо доменная ошибка
 *
 * @remarks
 * Результат проверяется инвариантами домена: для рынка предсказаний
 * `multiply(0.5, 2)` даст `Err` (выход за `0.9999`), для цены актива — `Ok`.
 *
 * @example
 * ```typescript
 * multiplyPrice(OUTCOME_DOMAIN, price, 2);
 * ```
 */
export function multiplyPrice<TPrice extends DecimalPrice, TError extends AnyTradingError>(
  domain: PriceDomain<TPrice, TError>,
  price: TPrice,
  factor: number | string | Decimal,
): Result<TPrice, TError> {
  const context = { price: price.value().toString(), factor: String(factor) };

  const parsed = parseOperand(domain, 'factor', 'multiply', factor, context);
  if (isErr(parsed)) return parsed;

  const validated = ValidateFactorForPriceMultiplication.check(parsed.value);
  if (isErr(validated)) {
    return Err(ruleErrorToDomain(domain, 'multiply', context, validated.error));
  }

  return wrapOp(
    domain.serviceName,
    'multiply',
    context,
    () => domain.create(multiplyDecimal(price.value(), parsed.value)),
    domain.ErrorConstructor,
  );
}

/**
 * Делит цену на делитель.
 *
 * @param domain - Ценовой домен
 * @param price - Исходная цена
 * @param divisor - Делитель (`number`, `string` или `Decimal`)
 * @returns Новая цена либо доменная ошибка
 *
 * @remarks
 * Нулевой и отрицательный делитель отвергаются правилом
 * {@link ValidateDivisorForPriceDivision} до самого деления.
 */
export function dividePrice<TPrice extends DecimalPrice, TError extends AnyTradingError>(
  domain: PriceDomain<TPrice, TError>,
  price: TPrice,
  divisor: number | string | Decimal,
): Result<TPrice, TError> {
  const context = { price: price.value().toString(), divisor: String(divisor) };

  const parsed = parseOperand(domain, 'divisor', 'divide', divisor, context);
  if (isErr(parsed)) return parsed;

  const validated = ValidateDivisorForPriceDivision.check(parsed.value);
  if (isErr(validated)) {
    return Err(ruleErrorToDomain(domain, 'divide', context, validated.error));
  }

  return wrapOp(
    domain.serviceName,
    'divide',
    context,
    () => domain.create(divideDecimal(price.value(), parsed.value)),
    domain.ErrorConstructor,
  );
}

/**
 * Среднее арифметическое двух цен.
 *
 * @param domain - Ценовой домен
 * @param first - Первая цена
 * @param second - Вторая цена
 * @returns Средняя цена либо доменная ошибка
 */
export function averagePrices<TPrice extends DecimalPrice, TError extends AnyTradingError>(
  domain: PriceDomain<TPrice, TError>,
  first: TPrice,
  second: TPrice,
): Result<TPrice, TError> {
  const context = { price1: first.value().toString(), price2: second.value().toString() };

  return wrapOp(
    domain.serviceName,
    'average',
    context,
    () => domain.create(divideDecimal(addDecimal(first.value(), second.value()), new Decimal(2))),
    domain.ErrorConstructor,
  );
}

/**
 * Применяет относительное изменение к цене.
 *
 * @param domain - Ценовой домен
 * @param price - Исходная цена
 * @param change - Относительное изменение дробью (`0.02` = +2%, `-0.05` = −5%)
 * @returns Новая цена либо доменная ошибка
 *
 * @remarks
 * `price × (1 + change)`, затем выравнивание к сетке тика: цена, не лежащая
 * на сетке, будет отвергнута venue, поэтому сдвиг и выравнивание — одна
 * операция, а не две.
 *
 * Выход результата за домен — `Err`, а не тихое усечение к границе: молча
 * подменять цену границей значило бы возвращать число, которого рынок не
 * показывал.
 */
export function applyRelativeChangeToPrice<
  TPrice extends DecimalPrice,
  TError extends AnyTradingError,
>(
  domain: PriceDomain<TPrice, TError>,
  price: TPrice,
  change: number | string | Decimal,
  tickSize: number | string | Decimal,
  baseTick: number | string | Decimal,
  mode: TickRoundingMode = 'nearest',
): Result<TPrice, TError> {
  const context = {
    price: price.value().toString(),
    ratio: String(change),
    tickSize: String(tickSize),
    roundingMode: mode,
  };

  const parsed = parseOperand(domain, 'ratio', 'applyRelativeChange', change, context);
  if (isErr(parsed)) return parsed;

  const tick = parseOperand(domain, 'tickSize', 'applyRelativeChange', tickSize, context);
  if (isErr(tick)) return tick;

  const validated = validateTickAgainstBase(
    domain,
    'applyRelativeChange',
    tick.value,
    baseTick,
    context,
  );
  if (isErr(validated)) return validated;

  return wrapOp(
    domain.serviceName,
    'applyRelativeChange',
    context,
    () => {
      const shifted = multiplyDecimal(price.value(), addDecimal(new Decimal(1), parsed.value));
      return domain.create(alignToTick(shifted, tick.value, mode));
    },
    domain.ErrorConstructor,
  );
}

/**
 * Выравнивает значение к сетке тика выбранным режимом.
 *
 * @param value - Значение
 * @param tick - Шаг сетки
 * @param mode - Режим округления
 * @returns Значение на сетке
 *
 * @remarks
 * Само округление берётся из `@polymarket/math` — своя копия здесь была бы
 * вторым источником истины о том, что такое «тик».
 */
function alignToTick(value: Decimal, tick: Decimal, mode: TickRoundingMode): Decimal {
  if (mode === 'floor') return floorToTick(value, tick);
  if (mode === 'ceil') return ceilToTick(value, tick);
  return roundToTick(value, tick, Decimal.ROUND_HALF_UP);
}

/**
 * Округляет цену к сетке тика.
 *
 * @param domain - Ценовой домен
 * @param price - Исходная цена
 * @param tickSize - Шаг сетки
 * @param baseTick - Базовый тик площадки: `tickSize` обязан быть ему кратен
 * @param mode - Режим округления (по умолчанию `nearest`)
 * @returns Выровненная цена либо доменная ошибка
 *
 * @remarks
 * `baseTick` — ПАРАМЕТР, а не константа: у рынка предсказаний он `0.0001`,
 * у биржи свой на каждый инструмент. Прежняя реализация хардкодила
 * `0.0001`, и ровно поэтому не переносилась на второй домен.
 *
 * @example
 * ```typescript
 * roundPriceToTick(OUTCOME_DOMAIN, price, '0.01', '0.0001');
 * roundPriceToTick(ASSET_DOMAIN, price, '0.01', '0.00000001', 'floor');
 * ```
 */
export function roundPriceToTick<TPrice extends DecimalPrice, TError extends AnyTradingError>(
  domain: PriceDomain<TPrice, TError>,
  price: TPrice,
  tickSize: number | string | Decimal,
  baseTick: number | string | Decimal,
  mode: TickRoundingMode = 'nearest',
  opName = 'roundToTick',
): Result<TPrice, TError> {
  const context = { price: price.value().toString(), tickSize: String(tickSize), roundingMode: mode };

  const tick = parseOperand(domain, 'tickSize', opName, tickSize, context);
  if (isErr(tick)) return tick;

  const validated = validateTickAgainstBase(domain, opName, tick.value, baseTick, context);
  if (isErr(validated)) return validated;

  return wrapOp(
    domain.serviceName,
    opName,
    context,
    () => domain.create(alignToTick(price.value(), tick.value, mode)),
    domain.ErrorConstructor,
  );
}

/**
 * Проверяет, что цена лежит точно на сетке тика.
 *
 * @param domain - Ценовой домен
 * @param price - Проверяемая цена
 * @param tickSize - Шаг сетки
 * @param baseTick - Базовый тик площадки
 * @returns `Ok(void)` либо доменная ошибка с причиной рассогласования
 *
 * @remarks
 * Нужна перед отправкой ордера: venue отвергает цену вне своей сетки, и
 * узнать об этом лучше до отправки, чем из отказа биржи.
 */
export function ensurePriceAlignedToTick<
  TPrice extends DecimalPrice,
  TError extends AnyTradingError,
>(
  domain: PriceDomain<TPrice, TError>,
  price: TPrice,
  tickSize: number | string | Decimal,
  baseTick: number | string | Decimal,
  opName = 'ensureAlignedToTick',
): Result<void, TError> {
  const context = { price: price.value().toString(), tickSize: String(tickSize) };

  const tick = parseOperand(domain, 'tickSize', opName, tickSize, context);
  if (isErr(tick)) return tick;

  const validated = validateTickAgainstBase(domain, opName, tick.value, baseTick, context);
  if (isErr(validated)) return validated;

  const remainder = price.value().modulo(tick.value);
  if (!remainder.isZero()) {
    // Контракт ошибки совпадает с правилом выравнивания: `field: 'price'`
    // и `reason: 'not_aligned'` — потребители опираются именно на них,
    // и общая реализация не имеет права их менять
    return Err(
      new domain.ErrorConstructor(
        `Price ${price.value().toString()} is not aligned to tick ${tick.value.toString()}`,
        {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            field: 'price',
            reason: 'not_aligned',
            price: price.value().toString(),
            tickSize: tick.value.toString(),
            service: domain.serviceName,
            op: opName,
          },
        },
      ),
    );
  }
  return Ok(undefined);
}

/**
 * Проверяет пригодность шага сетки и его кратность базовому тику.
 *
 * @param domain - Ценовой домен
 * @param op - Имя операции (для контекста ошибки)
 * @param tick - Разобранный шаг сетки
 * @param baseTick - Базовый тик площадки
 * @param context - Контекст ошибки
 * @returns `Ok(void)` либо доменная ошибка
 *
 * @remarks
 * Делегирует существующим правилам, а не проверяет само: у них уже есть
 * структурированные `reason` (`is_nan`, `not_positive`, `exceeds_range`,
 * `not_multiple_of_base_tick`), на которые опираются потребители. Своя
 * проверка стала бы вторым источником истины о том, что такое валидный тик.
 */
function validateTickAgainstBase<TPrice extends DecimalPrice, TError extends AnyTradingError>(
  domain: PriceDomain<TPrice, TError>,
  op: string,
  tick: Decimal,
  baseTick: number | string | Decimal,
  context: Record<string, unknown>,
): Result<void, TError> {
  const base = parseOperand(domain, 'baseTick', op, baseTick, context);
  if (isErr(base)) return base;

  const validated = ValidateTickSizeMultipleOfBaseTick.check(tick, base.value, domain.maxTickSize);
  if (isErr(validated)) {
    return Err(ruleErrorToDomain(domain, op, context, validated.error));
  }
  return Ok(undefined);
}

/**
 * Разность двух цен как `Decimal`.
 *
 * @param first - Уменьшаемое
 * @param second - Вычитаемое
 * @returns Разность
 *
 * @remarks
 * Возвращает `Decimal`, а НЕ цену: разность может быть нулевой и
 * отрицательной, тогда как оба ценовых домена требуют строго
 * положительного значения. Заворачивать её в цену — та же ошибка, из-за
 * которой нулевой спред раньше молча превращался в «спреда нет».
 */
export function priceDifference(first: DecimalPrice, second: DecimalPrice): Decimal {
  return subtractDecimal(first.value(), second.value());
}
