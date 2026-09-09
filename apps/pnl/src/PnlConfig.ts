/**
 * Конфигурация PnL-скрипта.
 *
 * @remarks
 * Источники (в порядке приоритета):
 * 1. CLI-аргументы: --from, --to, --mode, --json
 * 2. ENV-переменные: PRIVATE_KEY, FUNDER_ADDRESS, POLYMARKET_API_KEY, и др.
 *
 * @example
 * ```typescript
 * const config = parseConfig();
 * console.log(config.fromTs, config.toTs, config.mode);
 * ```
 */

/**
 * Режим вывода отчёта.
 * - `daily`    — краткая таблица по дням
 * - `detailed` — подробный отчёт по каждому рынку с fills
 */
export type ReportMode = 'daily' | 'detailed';

/**
 * Итоговая конфигурация скрипта.
 */
export interface PnlConfig {
  // ── Auth ────────────────────────────────────────────────────────────────────
  /**
   * Адрес кошелька, по которому строится отчёт.
   *
   * @remarks
   * Позиции и активность на Polymarket публичны, поэтому ни приватного
   * ключа, ни API-креденшелов инструменту не нужно. Берётся из
   * `WALLET_ADDRESS`, а если его нет — из `FUNDER_ADDRESS`.
   */
  readonly wallet: string;
  /** Включать ли ещё не закрытые позиции (`--include-open`) */
  readonly includeOpen: boolean;
  /** Начало периода в секундах Unix */
  readonly fromTs: number;
  /** Конец периода в секундах Unix */
  readonly toTs: number;

  // ── Output ──────────────────────────────────────────────────────────────────
  /** Режим отчёта */
  readonly mode: ReportMode;
  /** Выводить JSON вместо форматированного текста */
  readonly jsonOutput: boolean;
  /** Вывести сырые трейды из API (до нормализации) и выйти */
  readonly rawOutput: boolean;
}

// ── Вспомогательные функции ───────────────────────────────────────────────────

/**
 * Парсит дату в формате YYYY-MM-DD и возвращает Unix timestamp в секундах.
 *
 * @param dateStr - Строка даты в формате YYYY-MM-DD
 * @param endOfDay - Если true — берём конец дня (23:59:59), иначе начало (00:00:00)
 * @returns Unix timestamp в секундах
 * @throws {Error} Если формат даты неверный
 */
function parseDateToUnixSec(dateStr: string, endOfDay = false): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Invalid date format "${dateStr}". Expected YYYY-MM-DD.`);
  }
  const [year, month, day] = dateStr.split('-').map(Number) as [number, number, number];
  const d = endOfDay
    ? new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999))
    : new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  return Math.floor(d.getTime() / 1000);
}

/**
 * Возвращает дату сегодня в формате YYYY-MM-DD (UTC).
 *
 * @returns Строка даты
 */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Читает обязательную ENV-переменную.
 *
 * @param name - Имя переменной
 * @returns Значение переменной
 * @throws {Error} Если переменная не задана
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// ── Основная функция ──────────────────────────────────────────────────────────

/**
 * Парсит CLI-аргументы и ENV-переменные, возвращает конфиг скрипта.
 *
 * @returns Конфигурация PnL-скрипта
 * @throws {Error} При отсутствии обязательных ENV или неверных аргументах
 *
 * @example
 * ```bash
 * # Краткая сводка по дням за март
 * npx tsx src/main.ts --from 2026-03-01 --to 2026-03-31
 *
 * # Детальный отчёт за сегодня
 * npx tsx src/main.ts --from 2026-04-08 --mode detailed
 *
 * # JSON-вывод
 * npx tsx src/main.ts --from 2026-03-01 --json
 * ```
 */
export function parseConfig(): PnlConfig {
  // ── ENV ─────────────────────────────────────────────────────────────────────
  // Инструмент только читает: приватный ключ и API-креденшелы ему не нужны.
  // Достаточно адреса кошелька — позиции и активность публичны.
  const wallet = process.env['WALLET_ADDRESS'] ?? requireEnv('FUNDER_ADDRESS');

  // ── CLI args ─────────────────────────────────────────────────────────────────
  const args = process.argv.slice(2);

  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const hasFlag = (flag: string): boolean => args.includes(flag);

  const fromArg = getArg('--from');
  const toArg   = getArg('--to');
  const modeArg = getArg('--mode');

  if (!fromArg) {
    throw new Error('Missing required argument: --from YYYY-MM-DD');
  }

  const today    = todayUtc();
  const fromDate = fromArg;
  const toDate   = toArg ?? today;

  const fromTs = parseDateToUnixSec(fromDate, false);
  const toTs   = parseDateToUnixSec(toDate, true);

  if (fromTs > toTs) {
    throw new Error(`--from (${fromDate}) must be before --to (${toDate})`);
  }

  const mode: ReportMode = modeArg === 'detailed' ? 'detailed' : 'daily';
  const jsonOutput        = hasFlag('--json');
  const rawOutput         = hasFlag('--raw');
  const includeOpen       = hasFlag('--include-open');

  return {
    wallet,
    includeOpen,
    fromTs,
    toTs,
    mode,
    jsonOutput,
    rawOutput,
  };
}
