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

import { PolymarketSigner } from '@polymarket/exchange/rest';

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
  /** Приватный ключ кошелька (0x...) */
  readonly privateKey: string;
  /** Polymarket L2 API key */
  readonly apiKey: string;
  /** Polymarket L2 API secret */
  readonly apiSecret: string;
  /** Polymarket L2 API passphrase */
  readonly apiPassphrase: string;
  /** Адрес фандера (для POLY_PROXY). Если не задан — используется адрес из PRIVATE_KEY. */
  readonly funderAddress: string | undefined;

  // ── Query ───────────────────────────────────────────────────────────────────
  /**
   * Адрес кошелька для фильтрации сделок (maker_address).
   * = FUNDER_ADDRESS ?? адрес из PRIVATE_KEY
   */
  readonly makerAddress: string;
  /** Начало периода в секундах Unix */
  readonly fromTs: number;
  /** Конец периода в секундах Unix */
  readonly toTs: number;

  // ── Output ──────────────────────────────────────────────────────────────────
  /** Режим отчёта */
  readonly mode: ReportMode;
  /** Выводить JSON вместо форматированного текста */
  readonly jsonOutput: boolean;
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
  const privateKey    = requireEnv('PRIVATE_KEY');
  const apiKey        = requireEnv('POLYMARKET_API_KEY');
  const apiSecret     = requireEnv('POLYMARKET_API_SECRET');
  const apiPassphrase = requireEnv('POLYMARKET_API_PASSPHRASE');
  const funderAddress = process.env['FUNDER_ADDRESS'] || undefined;

  // Определяем адрес кошелька для фильтрации сделок
  let makerAddress: string;
  if (funderAddress) {
    makerAddress = funderAddress;
  } else {
    // Получаем адрес из приватного ключа
    const signer = new PolymarketSigner(privateKey, 137);
    makerAddress = signer.getAddress();
  }

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

  return {
    privateKey,
    apiKey,
    apiSecret,
    apiPassphrase,
    funderAddress,
    makerAddress,
    fromTs,
    toTs,
    mode,
    jsonOutput,
  };
}
