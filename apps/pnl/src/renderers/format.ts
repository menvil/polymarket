/**
 * Вспомогательные функции форматирования для рендереров.
 *
 * @remarks
 * Все функции возвращают строки с выравниванием (padding).
 */

/**
 * Форматирует число как денежную сумму: "$142.50"
 *
 * @param n - Число
 * @param width - Минимальная ширина строки (правое выравнивание)
 * @returns Форматированная строка
 */
export function fmtMoney(n: number, width = 0): string {
  const s = `$${Math.abs(n).toFixed(2)}`;
  return width > 0 ? s.padStart(width) : s;
}

/**
 * Форматирует PnL со знаком: "+$18.07" или "-$8.30"
 *
 * @param n - Число
 * @param width - Минимальная ширина строки
 * @returns Форматированная строка
 */
export function fmtPnl(n: number, width = 0): string {
  const sign = n >= 0 ? '+' : '-';
  const s = `${sign}$${Math.abs(n).toFixed(2)}`;
  return width > 0 ? s.padStart(width) : s;
}

/**
 * Форматирует ROI со знаком: "+12.7%" или "-53.3%"
 *
 * @param n - Процент (уже умноженный на 100)
 * @param width - Минимальная ширина строки
 * @returns Форматированная строка
 */
export function fmtRoi(n: number, width = 0): string {
  const sign = n >= 0 ? '+' : '-';
  const s = `${sign}${Math.abs(n).toFixed(1)}%`;
  return width > 0 ? s.padStart(width) : s;
}

/**
 * Форматирует число с заданным количеством знаков после запятой.
 *
 * @param n - Число
 * @param decimals - Знаков после запятой
 * @param width - Минимальная ширина
 * @returns Форматированная строка
 */
export function fmtNum(n: number, decimals = 2, width = 0): string {
  const s = n.toFixed(decimals);
  return width > 0 ? s.padStart(width) : s;
}

/**
 * Создаёт горизонтальную разделительную линию.
 *
 * @param width - Ширина линии
 * @param char - Символ линии
 * @returns Строка-разделитель
 */
export function hline(width: number, char = '─'): string {
  return char.repeat(width);
}

/**
 * Обрезает строку до maxLen символов, добавляя "…" если нужно.
 *
 * @param s - Исходная строка
 * @param maxLen - Максимальная длина
 * @returns Обрезанная строка
 */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}
