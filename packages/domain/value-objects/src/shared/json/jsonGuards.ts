/**
 * Гарды формы внешнего JSON — общие для ВСЕХ value objects.
 *
 * @remarks
 * Почему гарды возвращают ОПИСАНИЕ отказа, а не готовую ошибку.
 *
 * У доменов пакета исторически шесть разных форм `context` для одного и
 * того же класса отказа: одни кладут `kind:'invalid_json'` + `type`, другие
 * `reason: X.INVALID_FORMAT`, третьи прячут диагностику под `raw:{}`. Эти
 * формы закреплены тестами потребителей, и общий кодек, навязывающий одну
 * из них, сломал бы контракт остальным.
 *
 * Поэтому здесь общая МЕХАНИКА (что именно не так с данными), а построение
 * ошибки остаётся за доменом. Унификация словаря `context` — отдельное
 * осознанное решение со своей миграцией, а не побочный эффект дедупликации.
 *
 * Проверка наличия поля идёт через `Object.hasOwn`, а НЕ через `in`:
 * `in` проходит по цепочке прототипов, из-за чего `Object.create({ value: 1 })`
 * выглядит как объект с данными, хотя собственных полей у него нет. Для
 * границы с внешним миром это дыра — унаследованное значение данными
 * этого объекта не является.
 */
import { Result, Ok, Err } from '@polymarket/result';

/**
 * Чем именно внешнее значение отличается от ожидаемой формы.
 *
 * @remarks
 * Дискриминированное объединение, а не строка: домен по нему строит свой
 * `context`, и компилятор проверит, что разобраны все случаи.
 */
export type JsonFailure =
  /** Не объект: примитив, `null`, `undefined` */
  | { readonly kind: 'not_object'; readonly type: string }
  /** Массив там, где ожидался объект */
  | { readonly kind: 'array' }
  /** Нет обязательного собственного поля */
  | { readonly kind: 'missing_field'; readonly field: string }
  /** Поле есть, но неподходящего типа */
  | { readonly kind: 'bad_field_type'; readonly field: string; readonly type: string };

/** Допустимые примитивные типы значения поля. */
export type FieldType = 'string' | 'number' | 'boolean' | 'object';

/**
 * Возвращает читаемое имя типа значения.
 *
 * @param value - Произвольное значение
 * @returns `'null'`, `'array'` либо результат `typeof`
 *
 * @remarks
 * `typeof null === 'object'`, а `typeof []` — тоже `'object'`; для
 * диагностики это бесполезно, поэтому оба случая различаются явно.
 *
 * @example
 * ```typescript
 * describeType(null);      // 'null'
 * describeType([1, 2]);    // 'array'
 * describeType('x');       // 'string'
 * ```
 */
export function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Значение поля `type` в контексте ошибки парсинга.
 *
 * @param failure - Описание отказа
 * @returns `'array'`, `'missing_field'` либо имя типа значения
 *
 * @remarks
 * Домены этой группы кладут в `context.type` либо имя типа, либо маркер
 * `'missing_field'` — одно поле на две роли. Форма унаследована от
 * потребителей и здесь только воспроизводится.
 *
 * @example
 * ```typescript
 * jsonFailureType({ kind: 'not_object', type: 'undefined' }); // 'undefined'
 * jsonFailureType({ kind: 'missing_field', field: 'value' }); // 'missing_field'
 * ```
 */
export function jsonFailureType(failure: JsonFailure): string {
  switch (failure.kind) {
    case 'not_object':
      return failure.type;
    case 'array':
      return 'array';
    case 'missing_field':
      return 'missing_field';
    case 'bad_field_type':
      return failure.type;
  }
}

/**
 * Строит сообщение об ошибке парсинга.
 *
 * @param failure - Описание отказа
 * @param expected - Человекочитаемый список допустимых типов поля,
 *   например `'string'` или `'number or string'`
 * @returns Сообщение на английском (требование к текстам ошибок)
 *
 * @example
 * ```typescript
 * jsonFailureMessage({ kind: 'array' }, 'string');
 * // 'Expected object, got array'
 * jsonFailureMessage({ kind: 'bad_field_type', field: 'value', type: 'null' }, 'string');
 * // "Field 'value' must be string, got null"
 * ```
 */
export function jsonFailureMessage(failure: JsonFailure, expected: string): string {
  switch (failure.kind) {
    case 'not_object':
      return `Expected object, got ${failure.type}`;
    case 'array':
      return 'Expected object, got array';
    case 'missing_field':
      return `Missing required field '${failure.field}'`;
    case 'bad_field_type':
      return `Field '${failure.field}' must be ${expected}, got ${failure.type}`;
  }
}

/**
 * Проверяет, что внешнее значение — обычный объект.
 *
 * @param json - Произвольное значение из внешнего источника
 * @returns Объект как `Record` либо описание отказа
 * @throws Никогда — все отказы в `Result`
 *
 * @remarks
 * Массив отбраковывается отдельным случаем от «не объект»: у потребителей,
 * различающих их в `context.type`, это разные диагностики.
 *
 * @example
 * ```typescript
 * readJsonObject({ value: '1' });  // Ok({ value: '1' })
 * readJsonObject([1, 2]);          // Err({ kind: 'array' })
 * readJsonObject(undefined);       // Err({ kind: 'not_object', type: 'undefined' })
 * ```
 */
export function readJsonObject(json: unknown): Result<Record<string, unknown>, JsonFailure> {
  if (typeof json !== 'object' || json === null) {
    return Err({ kind: 'not_object', type: describeType(json) });
  }
  if (Array.isArray(json)) {
    return Err({ kind: 'array' });
  }
  return Ok(json as Record<string, unknown>);
}

/**
 * Читает обязательное СОБСТВЕННОЕ поле объекта с проверкой типа.
 *
 * @param obj - Объект, уже прошедший {@link readJsonObject}
 * @param field - Имя обязательного поля
 * @param allowed - Допустимые типы значения (хотя бы один)
 * @returns Значение поля либо описание отказа
 * @throws Никогда — все отказы в `Result`
 *
 * @remarks
 * Наличие проверяется через `Object.hasOwn` — унаследованное из прототипа
 * значение данными этого объекта не является; см. докблок модуля.
 *
 * @example
 * ```typescript
 * readField({ value: '1' }, 'value', ['string', 'number']); // Ok('1')
 * readField({}, 'value', ['string']);                       // Err({ kind: 'missing_field', ... })
 * readField({ value: [] }, 'value', ['string']);            // Err({ kind: 'bad_field_type', ... })
 * readField(Object.create({ value: '1' }), 'value', ['string']); // Err: missing_field
 * ```
 */
export function readField(
  obj: Record<string, unknown>,
  field: string,
  allowed: readonly FieldType[],
): Result<unknown, JsonFailure> {
  if (!Object.hasOwn(obj, field)) {
    return Err({ kind: 'missing_field', field });
  }
  const value = obj[field];
  const actual = describeType(value);
  // 'array' и 'null' сюда не подходят: describeType выделил их из 'object'
  if (!(allowed as readonly string[]).includes(actual)) {
    return Err({ kind: 'bad_field_type', field, type: actual });
  }
  return Ok(value);
}
