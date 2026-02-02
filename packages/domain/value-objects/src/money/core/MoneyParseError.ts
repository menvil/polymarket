/**
 * Ошибка парсинга входных данных в Decimal.
 *
 * @remarks
 * Это НЕ инвариант. Парсинг происходит ДО создания Decimal.
 * Инварианты проверяются УЖЕ существующего Decimal.
 *
 * Используется только в Money.of().
 *
 * @example
 * ```typescript
 * throw new MoneyParseError('abc');
 * ```
 */
export class MoneyParseError extends Error {
  constructor(public readonly input: string) {
    super(`Money parse error: ${input}`);
    this.name = 'MoneyParseError';
  }
}
