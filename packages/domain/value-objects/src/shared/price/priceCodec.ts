/**
 * Форматирование и JSON round-trip цен — общие для всех ценовых доменов.
 *
 * @remarks
 * Обе операции от домена не зависят: форматирование — это `Decimal.toFixed`,
 * а JSON-представление у любой цены одно и то же — `{ value: string }`
 * строкой ради сохранения точности. Доменной операцию делает
 * {@link PriceDomain}: он задаёт фабрику (через неё значение из JSON
 * проверяется инвариантами домена), тип ошибки и имя сервиса в её контексте.
 *
 * Доменным здесь остаётся ровно одно — представления, у которых в другом
 * домене нет смысла. Например `toPercentage` живёт в `outcome-price`: доля
 * исхода в процентах читается («52%»), а цена актива — нет («7846850%»).
 */
import { Result, Ok, Err } from '@polymarket/result';
import type { AnyTradingError } from '@polymarket/errors';
import { ErrorSource } from '@polymarket/errors';
import type { DecimalPrice } from './DecimalPrice.js';
import type { PriceDomain } from './priceDomain.js';
import type { JsonFailure } from '../json/index.js';
import {
  jsonFailureMessage,
  jsonFailureType,
  readField,
  readJsonObject,
  safeStringify,
} from '../json/index.js';

/**
 * JSON-представление цены.
 *
 * @remarks
 * Значение — СТРОКА, а не число: `number` теряет точность на длинных
 * десятичных дробях (`78376.356031481042173952`), и round-trip перестал бы
 * возвращать исходное значение.
 */
export interface PriceJSON {
  readonly value: string;
}

/**
 * Форматирует цену с фиксированным числом знаков.
 *
 * @param domain - Ценовой домен
 * @param price - Цена
 * @param decimals - Количество знаков после запятой
 * @param serviceName - Имя сервиса-адаптера для контекста ошибки
 * @returns Строка либо доменная ошибка при некорректном `decimals`
 *
 * @example
 * ```typescript
 * formatPriceFixed(OUTCOME_DOMAIN, price, 4, 'OutcomePriceFormatter'); // "0.5200"
 * formatPriceFixed(ASSET_DOMAIN, price, 2, 'AssetPriceFormatter');     // "78468.50"
 * ```
 */
export function formatPriceFixed<TPrice extends DecimalPrice, TError extends AnyTradingError>(
  domain: PriceDomain<TPrice, TError>,
  price: TPrice,
  decimals: number,
  serviceName: string,
): Result<string, TError> {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    return Err(
      new domain.ErrorConstructor('decimals argument must be a non-negative integer', {
        context: {
          source: ErrorSource.RULE_VALIDATION,
          service: serviceName,
          op: 'toFixed',
          decimals: String(decimals),
          priceValue: price.value().toString(),
        },
      }),
    );
  }
  return Ok(price.value().toFixed(decimals));
}

/**
 * Сериализует цену в JSON.
 *
 * @param price - Цена
 * @returns `{ value: string }` без потери точности
 */
export function priceToJSON(price: DecimalPrice): PriceJSON {
  return { value: price.value().toString() };
}

/**
 * Восстанавливает цену из JSON.
 *
 * @param domain - Ценовой домен
 * @param json - Произвольное значение из внешнего источника
 * @param serviceName - Имя сервиса-адаптера для контекста ошибки
 * @returns Цена либо доменная ошибка с причиной отказа
 *
 * @remarks
 * Проверяется всё, чем внешний ввод может отличаться от ожидаемой формы:
 * не объект, массив, отсутствие поля `value`, неподходящий тип значения.
 * Само значение проверяется фабрикой домена — то есть цена из JSON проходит
 * ровно те же инварианты, что и созданная в коде.
 *
 * Поле ищется через `Object.hasOwn`, а не `in`: значение из prototype chain
 * не является данными этого объекта.
 *
 * @example
 * ```typescript
 * priceFromJSON(ASSET_DOMAIN, { value: '78468.50' }, 'AssetPriceSerializer');
 * priceFromJSON(ASSET_DOMAIN, [1, 2], 'AssetPriceSerializer'); // Err: invalid_json
 * ```
 */
export function priceFromJSON<TPrice extends DecimalPrice, TError extends AnyTradingError>(
  domain: PriceDomain<TPrice, TError>,
  json: unknown,
  serviceName: string,
): Result<TPrice, TError> {
  const fail = (message: string, type: string): Result<TPrice, TError> =>
    Err(
      new domain.ErrorConstructor(message, {
        context: {
          source: ErrorSource.PARSING,
          service: serviceName,
          op: 'fromJSON',
          kind: 'invalid_json',
          type,
          json: safeStringify(json),
        },
      }),
    );

  const failFrom = (failure: JsonFailure): Result<TPrice, TError> =>
    fail(jsonFailureMessage(failure, 'number or string'), jsonFailureType(failure));

  const obj = readJsonObject(json);
  if (!obj.ok) {
    return failFrom(obj.error);
  }

  const value = readField(obj.value, 'value', ['string', 'number']);
  if (!value.ok) {
    return failFrom(value.error);
  }

  // Создание делегируется домену: значение из JSON проходит те же
  // инварианты, что и созданное в коде
  return domain.create(value.value as number | string);
}
