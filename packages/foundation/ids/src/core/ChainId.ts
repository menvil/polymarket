/**
 * ChainId - идентификатор blockchain сети
 *
 * @remarks
 * Branded type для type safety.
 * Представляет EVM chain ID.
 *
 * Известные chain IDs:
 * - 1: Ethereum Mainnet
 * - 137: Polygon (Polymarket)
 * - 8453: Base
 *
 * @example
 * ```typescript
 * const polygonChainId = 137 as ChainId;
 * const mainnetChainId = 1 as ChainId;
 * ```
 */
export type ChainId = number & { readonly __brand: 'ChainId' };

/**
 * Известные chain IDs
 */
export const KnownChainIds = {
  ETHEREUM_MAINNET: 1 as ChainId,
  POLYGON: 137 as ChainId,
  BASE: 8453 as ChainId,
} as const;

/**
 * Получить имя сети по chain ID
 */
export function getChainName(chainId: ChainId): string {
  switch (chainId) {
    case KnownChainIds.ETHEREUM_MAINNET:
      return 'Ethereum Mainnet';
    case KnownChainIds.POLYGON:
      return 'Polygon';
    case KnownChainIds.BASE:
      return 'Base';
    default:
      return `Chain ${chainId}`;
  }
}

/**
 * Type guard для проверки валидности ChainId
 *
 * @param n - Число для проверки
 * @returns true если n является валидным ChainId
 *
 * @remarks
 * Валидирует ChainId:
 * - Должен быть safe integer (не NaN, не Infinity, не float)
 * - Должен быть положительным (> 0)
 *
 * Chain ID в EVM всегда положительное целое число.
 * 0 зарезервирован и не используется.
 *
 * @example
 * ```typescript
 * isValidChainId(137); // → true (Polygon)
 * isValidChainId(1); // → true (Ethereum)
 * isValidChainId(0); // → false (зарезервирован)
 * isValidChainId(-1); // → false (отрицательный)
 * isValidChainId(3.14); // → false (float)
 * isValidChainId(NaN); // → false
 * isValidChainId(Infinity); // → false
 * ```
 */
export function isValidChainId(n: number): n is ChainId {
  return Number.isSafeInteger(n) && n > 0;
}

/**
 * Создать ChainId из числа с валидацией
 *
 * @param n - Число для преобразования
 * @returns ChainId или undefined если n невалидный
 *
 * @remarks
 * Безопасная фабрика для создания ChainId из runtime-значений.
 * Используй эту функцию вместо `as ChainId` каста.
 *
 * Для известных chain IDs используй константы из KnownChainIds.
 *
 * @example
 * ```typescript
 * // Создание из числа
 * const polygon = chainId(137); // → 137 as ChainId
 * const invalid = chainId(0); // → undefined
 *
 * // Использование констант (предпочтительно)
 * const polygon = KnownChainIds.POLYGON;
 * ```
 */
export function chainId(n: number): ChainId | undefined {
  return isValidChainId(n) ? (n as ChainId) : undefined;
}

/**
 * Парсинг ChainId из строки
 *
 * @param str - Строка для парсинга
 * @returns ChainId или undefined если формат невалидный
 *
 * @remarks
 * Парсит строковое представление chain ID в число.
 *
 * Валидация:
 * - Только цифры (regex `/^\d+$/`)
 * - После конвертации в число — проверка через isValidChainId
 *
 * Используй для:
 * - Парсинга из URL parameters
 * - Десериализации из строк
 * - Обработки конфигов
 *
 * @example
 * ```typescript
 * parseChainId('137'); // → 137 as ChainId (Polygon)
 * parseChainId('1'); // → 1 as ChainId (Ethereum)
 *
 * // Невалидные форматы
 * parseChainId('0'); // → undefined (не положительный)
 * parseChainId('137abc'); // → undefined (содержит буквы)
 * parseChainId('137.5'); // → undefined (float)
 * parseChainId('-1'); // → undefined (отрицательный)
 * parseChainId(''); // → undefined (пустая строка)
 * parseChainId(' 137'); // → undefined (пробел)
 * parseChainId('0x89'); // → undefined (hex формат)
 * ```
 */
export function parseChainId(str: string): ChainId | undefined {
  // Проверка формата: только цифры
  if (!/^\d+$/.test(str)) {
    return undefined;
  }

  // Конвертация в число
  const n = Number(str);

  // Валидация полученного числа
  return isValidChainId(n) ? (n as ChainId) : undefined;
}
