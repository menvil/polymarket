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
 * @param ratio - ROI как ДОЛЯ (0.127 → "+12.7%"), не как проценты
 * @param width - Минимальная ширина строки
 * @returns Форматированная строка
 *
 * @remarks
 * Здесь стояло «@param n - Процент (уже умноженный на 100)», а все четыре
 * вызова передавали долю `netPnl / entryCost`. ROI печатался в 100 раз
 * меньше: −6.0% за период выглядели как −0.1%.
 *
 * Умножение на 100 делается ЗДЕСЬ и только здесь — так у величины одна
 * размерность на всём пути от расчёта до печати.
 *
 * @example
 * ```typescript
 * fmtRoi(0.127);   // "+12.7%"
 * fmtRoi(-0.533);  // "-53.3%"
 * ```
 */
export function fmtRoi(ratio: number, width = 0): string {
  const percent = ratio * 100;
  const sign = percent >= 0 ? '+' : '-';
  const s = `${sign}${Math.abs(percent).toFixed(1)}%`;
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

/**
 * Форматирует величину, которой публичный API не предоставляет.
 *
 * @param n - Значение или `null`, если источник его не отдаёт
 * @param fmt - Форматтер для случая, когда значение есть
 * @returns Отформатированное значение либо прочерк
 *
 * @remarks
 * Комиссии учтены площадкой внутри `realizedPnl`, но отдельной строкой в
 * публичном контуре не показываются. Прочерк честнее нуля: ноль читается
 * как «комиссий не было».
 *
 * @example
 * ```typescript
 * fmtOptional(market.fees, (v) => fmtPnl(-v)); // "—" когда fees === null
 * ```
 */
export function fmtOptional(n: number | null, fmt: (v: number) => string): string {
  return n === null ? '—' : fmt(n);
}
