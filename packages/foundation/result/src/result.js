/**
 * Result<T, E> - Railway-oriented programming для явной обработки ошибок
 *
 * @remarks
 * Замена exceptions на явные Result типы.
 * TypeScript гарантирует exhaustive checking всех error cases.
 *
 * Преимущества:
 * - Явная обработка ошибок (компилятор заставляет проверять .ok)
 * - Нет неожиданных exceptions
 * - Composable через map/flatMap
 * - Type-safe error handling
 *
 * @template T - Тип успешного результата
 * @template E - Тип ошибки
 *
 * @example
 * ```typescript
 * function divide(a: number, b: number): Result<number, string> {
 *   if (b === 0) return Err('Деление на ноль');
 *   return Ok(a / b);
 * }
 *
 * const result = divide(10, 2);
 * if (result.ok) {
 *   console.log('Результат:', result.value); // 5
 * } else {
 *   console.error('Ошибка:', result.error);
 * }
 * ```
 */
/**
 * Создаёт успешный Result
 *
 * @param value - Значение успешного результата
 * @returns Result с ok = true
 *
 * @example
 * ```typescript
 * const result = Ok(42);
 * // result: { ok: true, value: 42 }
 * ```
 */
export const Ok = (value) => ({
    ok: true,
    value,
});
/**
 * Создаёт Result с ошибкой
 *
 * @param error - Описание ошибки
 * @returns Result с ok = false
 *
 * @example
 * ```typescript
 * const result = Err('Что-то пошло не так');
 * // result: { ok: false, error: 'Что-то пошло не так' }
 * ```
 */
export const Err = (error) => ({
    ok: false,
    error,
});
/**
 * Type guard для проверки успешного Result
 *
 * @param result - Result для проверки
 * @returns true если Result успешный
 *
 * @example
 * ```typescript
 * const result = Ok(42);
 * if (isOk(result)) {
 *   console.log(result.value); // TypeScript знает что это Ok
 * }
 * ```
 */
export const isOk = (result) => result.ok === true;
/**
 * Type guard для проверки Result с ошибкой
 *
 * @param result - Result для проверки
 * @returns true если Result содержит ошибку
 *
 * @example
 * ```typescript
 * const result = Err('error');
 * if (isErr(result)) {
 *   console.error(result.error); // TypeScript знает что это Err
 * }
 * ```
 */
export const isErr = (result) => result.ok === false;
/**
 * Трансформирует успешное значение Result
 *
 * @param result - Исходный Result
 * @param fn - Функция для трансформации значения
 * @returns Новый Result с трансформированным значением или исходную ошибку
 *
 * @remarks
 * Если result.ok = false, возвращает исходную ошибку без вызова fn.
 * Если result.ok = true, применяет fn к значению.
 *
 * @example
 * ```typescript
 * const result = Ok(5);
 * const doubled = map(result, x => x * 2);
 * // doubled: Ok(10)
 *
 * const error = Err('упс');
 * const mapped = map(error, x => x * 2);
 * // mapped: Err('упс') - fn не вызывается
 * ```
 */
export const map = (result, fn) => {
    return result.ok ? Ok(fn(result.value)) : result;
};
/**
 * Цепочка Result-возвращающих операций (monadic bind)
 *
 * @param result - Исходный Result
 * @param fn - Функция возвращающая новый Result
 * @returns Новый Result или исходная ошибка
 *
 * @remarks
 * Позволяет цеплять операции которые могут упасть.
 * Если любая операция в цепочке вернёт Err, вся цепочка вернёт Err.
 *
 * @example
 * ```typescript
 * const divide = (a: number, b: number): Result<number, string> =>
 *   b === 0 ? Err('Деление на ноль') : Ok(a / b);
 *
 * const result = flatMap(
 *   divide(10, 2),  // Ok(5)
 *   x => divide(x, 0)  // Err('Деление на ноль')
 * );
 * // result: Err('Деление на ноль')
 * ```
 */
export const flatMap = (result, fn) => {
    return result.ok ? fn(result.value) : result;
};
/**
 * Трансформирует ошибку Result
 *
 * @param result - Исходный Result
 * @param fn - Функция для трансформации ошибки
 * @returns Result с трансформированной ошибкой или исходное значение
 *
 * @remarks
 * Если result.ok = true, возвращает исходное значение без вызова fn.
 * Если result.ok = false, применяет fn к ошибке.
 *
 * Полезно для маппинга ошибок в разные типы.
 *
 * @example
 * ```typescript
 * const result = Err({ code: 404, message: 'Не найдено' });
 * const mapped = mapErr(result, err => err.message);
 * // mapped: Err('Не найдено')
 * ```
 */
export const mapErr = (result, fn) => {
    return result.ok ? result : Err(fn(result.error));
};
/**
 * Объединяет массив Results в Result массива
 *
 * @param results - Массив Results
 * @returns Ok с массивом значений или первый Err
 *
 * @remarks
 * Если хотя бы один Result содержит ошибку, возвращает первую ошибку.
 * Если все Results успешные, возвращает массив всех значений.
 * Пустой массив возвращает Ok([]).
 *
 * @example
 * ```typescript
 * const results = [Ok(1), Ok(2), Ok(3)];
 * const combined = combine(results);
 * // combined: Ok([1, 2, 3])
 *
 * const withError = [Ok(1), Err('упс'), Ok(3)];
 * const failed = combine(withError);
 * // failed: Err('упс')
 *
 * const empty = combine([]);
 * // empty: Ok([])
 * ```
 */
export const combine = (results) => {
    const values = [];
    for (const result of results) {
        if (!result.ok) {
            return result; // Вернуть первую ошибку
        }
        values.push(result.value);
    }
    return Ok(values);
};
/**
 * Форматирует значение в строку для сообщений об ошибках
 *
 * @param value - Значение для форматирования
 * @returns Строковое представление значения
 *
 * @remarks
 * Безопасно обрабатывает любые значения, включая специальные случаи:
 * - Циклические ссылки (через WeakSet)
 * - Error объекты с именем и сообщением
 * - Date объекты (включая Invalid Date)
 * - Map, Set с их размером
 * - Symbol и toStringTag
 * - Функции с именем
 *
 * @example
 * ```typescript
 * formatValue(42) // "42"
 * formatValue(new Error('oops')) // "Error: oops"
 * formatValue(new Date('2024-01-01')) // "Date(2024-01-01T00:00:00.000Z)"
 * formatValue(new Date('invalid')) // "Date(Invalid Date)"
 * formatValue({ a: 1 }) // '{"a":1}'
 * ```
 *
 * @internal
 */
export function formatValue(value) {
    if (value === null)
        return 'null';
    if (value === undefined)
        return 'undefined';
    // Error обработка с именем и сообщением
    if (value instanceof Error) {
        return value.message ? `${value.name}: ${value.message}` : value.name;
    }
    // Примитивы
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }
    if (typeof value === 'symbol')
        return value.toString();
    if (typeof value === 'function') {
        return `[Function${value.name ? `: ${value.name}` : ''}]`;
    }
    // Специальные встроенные типы
    if (value instanceof Date) {
        // Проверяем валидность даты перед вызовом toISOString()
        // isNaN(value.getTime()) возвращает true для Invalid Date
        if (isNaN(value.getTime())) {
            return 'Date(Invalid Date)';
        }
        return `Date(${value.toISOString()})`;
    }
    if (value instanceof Map) {
        return `Map(${value.size} entries)`;
    }
    if (value instanceof Set) {
        return `Set(${value.size} items)`;
    }
    if (value instanceof RegExp) {
        return value.toString();
    }
    // Объекты с Symbol.toStringTag
    try {
        const tag = value[Symbol.toStringTag];
        if (tag && typeof tag === 'string') {
            return `[${tag}]`;
        }
    }
    catch {
        // Ignore - getter может выбросить исключение
    }
    // Попытка JSON.stringify с обработкой циклических ссылок
    try {
        const seen = new WeakSet();
        return JSON.stringify(value, (_key, val) => {
            if (typeof val === 'object' && val !== null) {
                if (seen.has(val)) {
                    return '[Circular]';
                }
                seen.add(val);
            }
            return val;
        }) ?? String(value);
    }
    catch {
        // Fallback для объектов которые нельзя сериализовать
        return String(value);
    }
}
/**
 * Unwrap с fallback значением
 *
 * @param result - Result для unwrap
 * @param defaultValue - Значение по умолчанию если result - ошибка
 * @returns Значение result или defaultValue
 *
 * @remarks
 * Безопасная альтернатива unwrap - возвращает defaultValue вместо exception.
 *
 * @example
 * ```typescript
 * const result = Err('упс');
 * const value = unwrapOr(result, 42); // 42
 *
 * const success = Ok(10);
 * const value = unwrapOr(success, 42); // 10
 * ```
 */
export const unwrapOr = (result, defaultValue) => {
    return result.ok ? result.value : defaultValue;
};
/**
 * Извлекает значение или вычисляет fallback через функцию
 *
 * @param result - Result для извлечения значения
 * @param fn - Функция вычисляющая fallback из ошибки
 * @returns Значение result или результат fn(error)
 *
 * @remarks
 * Безопасная альтернатива unwrap — не бросает исключений.
 * Если callback fn бросает исключение, оно propagate напрямую.
 *
 * @example
 * ```typescript
 * const result = Err('network error');
 * const value = unwrapOrElse(result, err => {
 *   console.log('Error:', err);
 *   return 0;
 * });
 * // value: 0
 *
 * const success = Ok(42);
 * const value2 = unwrapOrElse(success, () => 0); // 42
 * ```
 */
export const unwrapOrElse = (result, fn) => {
    return result.ok ? result.value : fn(result.error);
};
/**
 * Цепочка Result-операций с расширением типа ошибки (widen-вариант)
 *
 * @param result - Исходный Result<T, E>
 * @param fn - Функция возвращающая Result<U, F> (F может отличаться от E)
 * @returns Result<U, E | F> — тип ошибки расширяется до объединения
 *
 * @remarks
 * В отличие от flatMap (который требует fn: T → Result<U, E>),
 * flatMapW позволяет fn возвращать Result с другим типом ошибки F.
 * Это необходимо при работе с union-типами ошибок в длинных цепочках.
 *
 * Суффикс W = "Widened" (расширение типа).
 *
 * @example
 * ```typescript
 * type NetworkError = { type: 'network' };
 * type ValidationError = { type: 'validation' };
 *
 * const r1: Result<User, NetworkError> = Ok({ id: '1', name: 'Ivan' });
 * const r2: Result<ValidUser, NetworkError | ValidationError> =
 *   flatMapW(r1, user => validate(user)); // validate вернёт Result<ValidUser, ValidationError>
 * ```
 */
export const flatMapW = (result, fn) => {
    return result.ok ? fn(result.value) : result;
};
/**
 * Трансформирует ошибку с расширением типа ошибки (widen-вариант)
 *
 * @param result - Исходный Result<T, E>
 * @param fn - Функция трансформирующая E в F
 * @returns Result<T, F> с новым типом ошибки
 *
 * @remarks
 * Эквивалентен mapErr, но явно подчёркивает что тип ошибки меняется.
 * Используйте когда хотите явно показать расширение типа в цепочке.
 *
 * Суффикс W = "Widened" (расширение типа).
 *
 * @example
 * ```typescript
 * type HttpError = { status: number };
 * type AppError = { code: string; source: string };
 *
 * const r: Result<User, HttpError> = Err({ status: 404 });
 * const mapped: Result<User, AppError> = mapErrW(r, err => ({
 *   code: `HTTP_${err.status}`,
 *   source: 'api',
 * }));
 * ```
 */
export const mapErrW = (result, fn) => {
    return result.ok ? result : Err(fn(result.error));
};
/**
 * Recovery при ошибке с расширением типа ошибки (widen-вариант)
 *
 * @param result - Исходный Result<T, E>
 * @param fn - Функция восстановления, принимающая E и возвращающая Result<T, F>
 * @returns Result<T, F> — старый тип ошибки E заменяется на F
 *
 * @remarks
 * Если result — Ok, возвращает его как есть.
 * Если result — Err, вызывает fn с ошибкой и возвращает результат fn.
 * Тип ошибки меняется с E на F (в отличие от простого orElse).
 *
 * Если callback fn бросает исключение, оно propagate напрямую.
 *
 * Суффикс W = "Widened" (расширение типа).
 *
 * @example
 * ```typescript
 * type TempError = { retryable: boolean };
 * type FinalError = string;
 *
 * const r: Result<Data, TempError> = Err({ retryable: false });
 * const recovered: Result<Data, FinalError> = orElseW(r, err =>
 *   err.retryable ? Err('retry exhausted') : Err('permanent failure')
 * );
 * ```
 */
export const orElseW = (result, fn) => {
    return result.ok ? result : fn(result.error);
};
/**
 * Pattern matching для Result — выполняет один из двух обработчиков
 *
 * @param result - Исходный Result
 * @param handlers - Объект с обработчиками ok и err
 * @returns Результат выполнения соответствующего обработчика
 *
 * @remarks
 * Удобная альтернатива if/else для exhaustive pattern matching.
 * TypeScript гарантирует что оба случая обработаны.
 *
 * Если callback бросает исключение, оно propagate напрямую.
 *
 * @example
 * ```typescript
 * const result: Result<number, string> = Ok(42);
 * const message = match(result, {
 *   ok: value => `Success: ${value}`,
 *   err: error => `Error: ${error}`,
 * });
 * // message: 'Success: 42'
 *
 * // Для render UI:
 * const jsx = match(userResult, {
 *   ok: user => renderProfile(user),
 *   err: err => renderError(err),
 * });
 * ```
 */
export const match = (result, handlers) => {
    return result.ok ? handlers.ok(result.value) : handlers.err(result.error);
};
/**
 * Безопасно выполняет синхронную функцию, оборачивая исключения в Err
 *
 * @param fn - Thunk (функция без аргументов) которая может бросить исключение
 * @param onError - Функция для трансформации исключения в тип ошибки E
 * @returns Ok(результат) или Err(onError(исключение))
 *
 * @remarks
 * Используйте для оборачивания сторонних функций которые могут бросать.
 * Для функций с аргументами используйте fromThrowable.
 *
 * @example
 * ```typescript
 * const result = tryCatch(
 *   () => JSON.parse('invalid json'),
 *   (err) => `Parse error: ${err}`
 * );
 * // result: Err('Parse error: ...')
 *
 * const valid = tryCatch(
 *   () => JSON.parse('{"name":"Ivan"}'),
 *   (err) => `Parse error: ${err}`
 * );
 * // valid: Ok({ name: 'Ivan' })
 * ```
 */
export const tryCatch = (fn, onError) => {
    try {
        return Ok(fn());
    }
    catch (error) {
        return Err(onError(error));
    }
};
/**
 * Безопасно выполняет асинхронную функцию, оборачивая исключения/rejections в Err
 *
 * @param fn - Async thunk (функция без аргументов) которая может бросить/reject
 * @param onError - Функция для трансформации исключения в тип ошибки E
 * @returns Promise<Ok(результат)> или Promise<Err(onError(исключение))>
 *
 * @remarks
 * Перехватывает как синхронные исключения (если fn бросает до первого await),
 * так и async rejections.
 * Для функций с аргументами используйте fromPromise.
 *
 * @example
 * ```typescript
 * const result = await tryAsync(
 *   () => fetch('/api/user').then(r => r.json()),
 *   (err) => ({ type: 'network', message: String(err) })
 * );
 * // result: Ok(user) или Err({ type: 'network', ... })
 * ```
 */
export const tryAsync = async (fn, onError) => {
    try {
        const value = await fn();
        return Ok(value);
    }
    catch (error) {
        return Err(onError(error));
    }
};
/**
 * Конвертирует Promise в Result, оборачивая rejections в Err
 *
 * @param promise - Promise для конвертации
 * @param onError - Функция для трансформации rejection в тип ошибки E
 * @returns Promise<Result<T, E>>
 *
 * @remarks
 * Основной способ для интеграции Promise-based API в Railway-Oriented код.
 * Все rejections будут преобразованы в Err, никогда не выбросит сам.
 *
 * @example
 * ```typescript
 * const result = await fromPromise(
 *   fetch('/api/user').then(r => r.json()),
 *   (error) => ({ type: 'network', message: String(error) })
 * );
 *
 * if (result.ok) {
 *   console.log('User:', result.value);
 * } else {
 *   console.error('Network error:', result.error.message);
 * }
 * ```
 */
export async function fromPromise(promise, onError) {
    try {
        const value = await promise;
        return Ok(value);
    }
    catch (error) {
        return Err(onError(error));
    }
}
/**
 * Конвертирует nullable значение в Result
 *
 * @param value - Значение которое может быть null или undefined
 * @param error - Ошибка если значение отсутствует (null/undefined)
 * @returns Ok(value) если значение есть, Err(error) если null/undefined
 *
 * @remarks
 * Удобный способ интегрировать nullable API в Railway-Oriented цепочки.
 * Проверяет `value == null` (то есть null и undefined оба дают Err).
 *
 * @example
 * ```typescript
 * const maybeUser: User | null = findUser('123');
 * const result = fromNullable(maybeUser, 'User not found');
 *
 * if (result.ok) {
 *   console.log('User:', result.value.name);
 * }
 *
 * // Удобно в цепочках:
 * const name = fromNullable(getUser(), 'not found')
 * // result: Ok(user) или Err('not found')
 * ```
 */
export function fromNullable(value, error) {
    return value == null ? Err(error) : Ok(value);
}
/**
 * Оборачивает функцию которая может бросить исключение в Result-returning функцию
 *
 * @param fn - Функция которая может бросить исключение (любое число аргументов)
 * @param onError - Функция для трансформации исключения в тип ошибки E
 * @returns Обёрнутая функция с теми же аргументами, возвращающая Result<T, E>
 *
 * @remarks
 * Используется для создания "safe" обёрток над потенциально бросающими функциями.
 * Обёрнутая функция никогда не бросает — все исключения превращаются в Err.
 *
 * @example
 * ```typescript
 * const safeParseJSON = fromThrowable(
 *   (text: string) => JSON.parse(text) as unknown,
 *   (error) => `Parse error: ${error}`
 * );
 *
 * const result = safeParseJSON('{"name": "Ivan"}');
 * // result: Ok({ name: 'Ivan' })
 *
 * const failed = safeParseJSON('invalid');
 * // failed: Err('Parse error: SyntaxError: ...')
 * ```
 */
export function fromThrowable(fn, onError) {
    return function (...args) {
        try {
            const value = fn.call(this, ...args);
            return Ok(value);
        }
        catch (error) {
            return Err(onError(error));
        }
    };
}
//# sourceMappingURL=result.js.map