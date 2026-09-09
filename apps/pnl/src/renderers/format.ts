/**
 * Форматирование величин отчёта.
 *
 * @remarks
 * Обёртки над форматтерами из `@polymarket/value-objects`. Собственная
 * арифметика здесь не ведётся — только то, чего VO-форматтеры не умеют:
 *
 * - **ведущий `+`** у положительных значений (`MoneyFormatter` его не ставит);
 * - **выравнивание по ширине** — нужно для колоночных таблиц;
 * - **разворачивание `Result`** — форматтеры возвращают `Result`, но в
 *   печати таблицы обрабатывать отказ нечем: величина уже прошла инварианты
 *   VO при создании, и отказ здесь означал бы дефект самого форматтера.
 *
 * Почему через VO, а не своим `toFixed`: размерность перестаёт быть
 * договорённостью. Ровно на этом обжигались — `fmtRoi` принимал «проценты,
 * уже умноженные на 100», а все вызовы передавали долю, и ROI печатался в
 * 100 раз меньше. `RatioFormatter` принимает долю и переводит сам.
 */
import type { Money, Ratio } from '@polymarket/value-objects';
import { MoneyFormatter, RatioFormatter } from '@polymarket/value-objects';
import { negateMoney } from '../core/vo.js';

/**
 * Разворачивает `Result` форматтера.
 *
 * @param result - Результат форматирования
 * @returns Отформатированная строка
 * @throws {Error} Если форматтер отказал — это дефект, а не ожидаемый случай
 *
 * @remarks
 * Величина уже прошла инварианты при создании VO, поэтому отказ форматтера
 * означает ошибку в нём самом. Прятать её за прочерком нельзя: тогда в
 * таблице появится «—» без единого следа о причине.
 */
function unwrap(result: { ok: true; value: string } | { ok: false; error: unknown }): string {
  if (result.ok) return result.value;
  throw new Error(`Formatter failed: ${String(result.error)}`);
}

/** Добавляет выравнивание по правому краю, если ширина задана. */
function pad(s: string, width: number): string {
  return width > 0 ? s.padStart(width) : s;
}

/**
 * Ставит ведущий `+`, если знака ещё нет.
 *
 * @param formatted - Отформатированная величина
 * @returns Строка, гарантированно начинающаяся со знака
 *
 * @remarks
 * Проверяется САМА СТРОКА, а не `isNegative()` величины: у отрицательного
 * нуля `isNegative()` возвращает `false`, тогда как форматтер печатает
 * «-$0.00» — и на выходе получалось «+-$0.00».
 */
function withLeadingSign(formatted: string): string {
  return formatted.startsWith('-') ? formatted : `+${formatted}`;
}

/**
 * Форматирует денежную сумму без знака: `"$142.50"`.
 *
 * @param money - Сумма
 * @param width - Минимальная ширина строки (правое выравнивание)
 * @returns Форматированная строка
 *
 * @example
 * ```typescript
 * fmtMoney(Money.of(new Decimal('142.5')));  // "$142.50"
 * ```
 */
export function fmtMoney(money: Money, width = 0): string {
  const abs = money.isNegative() ? money.value().negated() : money.value();
  return pad(`$${abs.toFixed(2)}`, width);
}

/**
 * Форматирует PnL со знаком: `"+$18.07"` или `"-$8.30"`.
 *
 * @param money - Сумма
 * @param width - Минимальная ширина строки
 * @returns Форматированная строка
 *
 * @remarks
 * `MoneyFormatter.toCurrency` уже ставит минус перед `$` (`"-$8.30"`), но
 * ведущего `+` у положительных не даёт — его добавляем здесь.
 *
 * @example
 * ```typescript
 * fmtPnl(Money.of(new Decimal('18.07')));   // "+$18.07"
 * fmtPnl(Money.of(new Decimal('-8.30')));   // "-$8.30"
 * ```
 */
export function fmtPnl(money: Money, width = 0): string {
  return pad(withLeadingSign(unwrap(MoneyFormatter.toCurrency(money, false))), width);
}

/**
 * Форматирует доходность со знаком: `"+12.7%"` или `"-53.3%"`.
 *
 * @param ratio - Доходность как ДОЛЯ (0.127 → `"+12.7%"`)
 * @param width - Минимальная ширина строки
 * @returns Форматированная строка
 *
 * @remarks
 * Перевод доли в проценты делает `RatioFormatter`. Здесь остаётся только
 * ведущий `+`: раньше умножение на 100 было договорённостью между
 * калькулятором и форматтером, и договорённость разъехалась.
 *
 * @example
 * ```typescript
 * fmtRoi(Ratio.of(new Decimal('0.127')));   // "+12.7%"
 * fmtRoi(Ratio.of(new Decimal('-0.533')));  // "-53.3%"
 * ```
 */
export function fmtRoi(ratio: Ratio, width = 0): string {
  return pad(withLeadingSign(unwrap(RatioFormatter.toPercent(ratio, 1))), width);
}

/**
 * Форматирует величину как ЗАТРАТУ: со знаком минус.
 *
 * @param money - Сумма затраты (положительная)
 * @param width - Минимальная ширина строки
 * @returns Форматированная строка вида `"-$1.39"`
 *
 * @remarks
 * Комиссия хранится положительным числом (сколько удержано), а в таблице
 * PnL печатается как отрицательное — она уменьшает результат. Отрицание
 * делается здесь, а не на вызове: раньше на вызовах стояло `fmtPnl(-v)`,
 * и знак был договорённостью, которую легко потерять.
 *
 * @example
 * ```typescript
 * fmtCost(Money.of(new Decimal('1.39')));  // "-$1.39"
 * ```
 */
export function fmtCost(money: Money, width = 0): string {
  return fmtPnl(negateMoney(money), width);
}

/**
 * Форматирует число с заданным количеством знаков.
 *
 * @param n - Число
 * @param decimals - Знаков после запятой
 * @param width - Минимальная ширина
 * @returns Форматированная строка
 *
 * @remarks
 * Остаётся на примитиве: используется для безразмерных величин (остаток
 * токенов, счётчики), у которых нет VO и нечего перепутать.
 *
 * @example
 * ```typescript
 * fmtNum(5, 1);  // "5.0"
 * ```
 */
export function fmtNum(n: number, decimals = 2, width = 0): string {
  return pad(n.toFixed(decimals), width);
}

/**
 * Создаёт горизонтальную разделительную линию.
 *
 * @param width - Длина линии
 * @param char - Символ линии
 * @returns Строка из повторённого символа
 *
 * @example
 * ```typescript
 * hline(5);  // "─────"
 * ```
 */
export function hline(width: number, char = '─'): string {
  return char.repeat(Math.max(0, width));
}

/**
 * Обрезает строку до максимальной длины, добавляя многоточие.
 *
 * @param s - Исходная строка
 * @param maxLen - Максимальная длина результата
 * @returns Обрезанная строка
 *
 * @example
 * ```typescript
 * truncate('Bitcoin Up or Down', 10);  // "Bitcoin U…"
 * ```
 */
export function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : `${s.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * Форматирует величину, которой может не быть.
 *
 * @param value - Значение или `null`, если источник его не даёт
 * @param fmt - Форматтер для случая, когда значение есть
 * @returns Отформатированное значение либо прочерк
 *
 * @remarks
 * Прочерк честнее нуля: ноль читается как «величины не было», тогда как
 * правда — «величина недоступна».
 *
 * @example
 * ```typescript
 * fmtOptional(market.fees, (m) => fmtPnl(m));  // "—" когда fees === null
 * ```
 */
export function fmtOptional<T>(value: T | null, fmt: (v: T) => string): string {
  return value === null ? '—' : fmt(value);
}
