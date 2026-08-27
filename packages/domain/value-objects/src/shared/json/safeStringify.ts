/**
 * Безопасно приводит произвольное значение к строке для диагностики.
 *
 * @param value - Значение любого типа, включая враждебный внешний ввод
 * @returns Строковое представление; циклические ссылки — `[Circular]`,
 *   несериализуемое целиком — `[Unstringifiable]`, отсутствие результата
 *   у `JSON.stringify` — `[Undefined]`
 * @throws Никогда — формирование диагностики не имеет права само упасть
 *
 * @remarks
 * Функция обязана пережить ЛЮБОЙ ввод: её единственный вызывающий — код,
 * который УЖЕ формирует сообщение об ошибке, и исключение оттуда потеряло
 * бы исходную причину отказа.
 *
 * Три разных исхода, а не один общий:
 *
 * 1. Циклы гасятся replacer-ом, а не `try/catch`, чтобы остальная часть
 *    объекта всё же попала в контекст — «[Circular] в одном поле»
 *    полезнее, чем «[Unstringifiable]» целиком.
 * 2. `JSON.stringify` возвращает `undefined` (НЕ строку) для `undefined`,
 *    функций и символов. Без явной подстановки функция вернула бы
 *    `undefined` при объявленном `string` — тип соврал бы, а в контекст
 *    ошибки попало бы отсутствующее поле вместо диагностики.
 * 3. Всё остальное (например, `BigInt`) бросает — это `[Unstringifiable]`.
 *
 * @example
 * ```typescript
 * safeStringify({ a: 1 });        // '{"a":1}'
 * safeStringify(undefined);       // '[Undefined]'
 * safeStringify(() => {});        // '[Undefined]'
 * safeStringify(1n);              // '[Unstringifiable]'
 *
 * const cyclic: Record<string, unknown> = { a: 1 };
 * cyclic.self = cyclic;
 * safeStringify(cyclic);          // '{"a":1,"self":"[Circular]"}'
 * ```
 */
export function safeStringify(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    const result = JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val as unknown;
    });
    // JSON.stringify(undefined) даёт undefined, а не строку — см. @remarks
    return result ?? '[Undefined]';
  } catch {
    return '[Unstringifiable]';
  }
}
