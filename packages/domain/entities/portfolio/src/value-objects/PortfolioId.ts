/**
 * PortfolioId — branded type для идентификатора портфеля
 *
 * @remarks
 * Nominal typing через brand: компилятор различает PortfolioId и обычную строку.
 * Предотвращает передачу произвольных строк вместо валидного идентификатора.
 *
 * @example
 * ```typescript
 * import { parsePortfolioId, asPortfolioId } from './PortfolioId';
 *
 * const id = parsePortfolioId('portfolio-123'); // PortfolioId | undefined
 * const id2 = asPortfolioId('portfolio-123');  // PortfolioId (throws при пустой строке)
 * ```
 */

/**
 * PortfolioId — уникальный идентификатор портфеля
 *
 * @remarks
 * Branded type: `string & { readonly __brand: 'PortfolioId' }`.
 * Несовместим с обычными строками на уровне типов TypeScript.
 */
export type PortfolioId = string & { readonly __brand: 'PortfolioId' };

/**
 * Парсит строку в PortfolioId с валидацией
 *
 * @param raw - Строка для парсинга
 * @returns PortfolioId если строка непустая, иначе undefined
 *
 * @remarks
 * Применяет trim перед проверкой.
 * Возвращает undefined для пустых строк или строк только из пробелов.
 *
 * @example
 * ```typescript
 * parsePortfolioId('portfolio-abc');  // → 'portfolio-abc' as PortfolioId
 * parsePortfolioId('  portfolio  ');  // → 'portfolio' as PortfolioId (trimmed)
 * parsePortfolioId('');               // → undefined
 * parsePortfolioId('   ');            // → undefined
 * ```
 */
export function parsePortfolioId(raw: string): PortfolioId | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed as PortfolioId;
}

/**
 * Создаёт PortfolioId без safe-обёртки
 *
 * @param raw - Строка для приведения к PortfolioId
 * @returns PortfolioId
 * @throws {Error} Если строка пустая или состоит только из пробелов
 *
 * @remarks
 * Используй когда уверен в валидности строки (например, в тестах или при создании агрегата).
 * Для внешних данных предпочитай parsePortfolioId().
 *
 * @example
 * ```typescript
 * asPortfolioId('portfolio-abc');  // → 'portfolio-abc' as PortfolioId
 * asPortfolioId('');               // throws Error: 'PortfolioId cannot be empty'
 * ```
 */
export function asPortfolioId(raw: string): PortfolioId {
  const result = parsePortfolioId(raw);
  if (!result) {
    throw new Error(`PortfolioId cannot be empty`);
  }
  return result;
}
