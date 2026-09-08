/**
 * Сводная таблица конфигов с мета-данными (_meta блок).
 *
 * @remarks
 * Читает все JSON-файлы из configs/ и выводит таблицу конфигов,
 * у которых есть поле _meta. Конфиги без _meta показываются в конце
 * как "no meta" если передан флаг --all.
 *
 * Схема _meta (добавляй в любой конфиг):
 * ```json
 * {
 *   "_meta": {
 *     "desc": "CexLeadLag UP+DOWN skewed, 5min BTC",
 *     "status": "live",
 *     "backtest": {
 *       "dataset": "live-recordings 2026-04-22/2026-04-28",
 *       "pnl": "+69.09 USDC",
 *       "markets": 245,
 *       "wr": "68%",
 *       "date": "2026-04-29",
 *       "notes": "UP +32.16, DOWN +36.93"
 *     },
 *     "paper": {
 *       "period": "2026-04-29/2026-05-03",
 *       "pnl": "+4.12 USDC",
 *       "trades": 18,
 *       "wr": "67%",
 *       "date": "2026-05-03",
 *       "notes": "5d stable"
 *     },
 *     "live": {
 *       "started": "2026-05-05",
 *       "pnl": "active",
 *       "notes": ""
 *     }
 *   }
 * }
 * ```
 *
 * Поле `status`:
 *   wip           — в разработке/эксперимент
 *   insample      — только in-sample backtest
 *   oos           — OOS backtest проведён
 *   oos-validated — OOS подтверждён (стабильный результат)
 *   paper         — запущен paper trading
 *   live          — запущен live trading
 *   archived      — устарел, не использовать
 *
 * @example
 * ```bash
 * npx tsx scripts/config-summary.ts
 * npx tsx scripts/config-summary.ts --status live
 * npx tsx scripts/config-summary.ts --status paper,live
 * npx tsx scripts/config-summary.ts --strategy cex-lead-lag
 * npx tsx scripts/config-summary.ts --all
 * ```
 */

import { readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';

// ── Типы ──────────────────────────────────────────────────────────────────────

type ConfigStatus = 'wip' | 'insample' | 'oos' | 'oos-validated' | 'paper' | 'live' | 'archived';

interface BacktestMeta {
  readonly dataset: string;
  readonly pnl: string;
  readonly markets?: number;
  readonly wr?: string;
  readonly date?: string;
  readonly notes?: string;
}

interface PaperMeta {
  readonly period: string;
  readonly pnl: string;
  readonly trades?: number;
  readonly wr?: string;
  readonly date?: string;
  readonly notes?: string;
}

interface LiveMeta {
  readonly started: string;
  readonly pnl?: string;
  readonly trades?: number;
  readonly notes?: string;
}

interface ConfigMeta {
  readonly desc: string;
  readonly status: ConfigStatus;
  readonly backtest?: BacktestMeta;
  readonly paper?: PaperMeta;
  readonly live?: LiveMeta;
}

interface ConfigEntry {
  readonly file: string;
  readonly strategy: string;
  readonly meta: ConfigMeta | null;
}

// ── Статусы: порядок для сортировки ─────────────────────────────────────────

const STATUS_ORDER: Record<ConfigStatus, number> = {
  live: 0,
  paper: 1,
  'oos-validated': 2,
  oos: 3,
  insample: 4,
  wip: 5,
  archived: 6,
};

// ── ANSI цвета ───────────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

function colorStatus(status: ConfigStatus): string {
  switch (status) {
    case 'live':          return `${C.green}${C.bold}live${C.reset}`;
    case 'paper':         return `${C.cyan}paper${C.reset}`;
    case 'oos-validated': return `${C.blue}oos-val${C.reset}`;
    case 'oos':           return `${C.blue}oos${C.reset}`;
    case 'insample':      return `${C.yellow}insample${C.reset}`;
    case 'wip':           return `${C.gray}wip${C.reset}`;
    case 'archived':      return `${C.dim}archived${C.reset}`;
  }
}

function colorPnl(pnl: string): string {
  if (pnl.startsWith('+')) return `${C.green}${pnl}${C.reset}`;
  if (pnl.startsWith('-')) return `${C.red}${pnl}${C.reset}`;
  return `${C.gray}${pnl}${C.reset}`;
}

// ── Утилиты ──────────────────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  // Pad без учёта ANSI escape codes
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  const diff = n - visible.length;
  return s + (diff > 0 ? ' '.repeat(diff) : '');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ── Загрузка конфигов ─────────────────────────────────────────────────────────

function loadConfigs(dir: string): ConfigEntry[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  return files.map((file) => {
    try {
      const content = readFileSync(join(dir, file), 'utf-8');
      const raw = JSON.parse(content) as Record<string, unknown>;
      return {
        file: basename(file, '.json'),
        strategy: (raw['strategy'] as string | undefined) ?? 'unknown',
        meta: (raw['_meta'] as ConfigMeta | undefined) ?? null,
      };
    } catch {
      return { file: basename(file, '.json'), strategy: 'parse-error', meta: null };
    }
  });
}

// ── Вывод ────────────────────────────────────────────────────────────────────

function formatPnlCell(backtest?: BacktestMeta, label = true): string {
  if (!backtest) return C.gray + '-' + C.reset;
  const pnl = colorPnl(backtest.pnl);
  const wr = backtest.wr ? ` ${C.dim}(${backtest.wr})${C.reset}` : '';
  return pnl + wr;
}

function formatPaperCell(paper?: PaperMeta): string {
  if (!paper) return C.gray + '-' + C.reset;
  return colorPnl(paper.pnl) + (paper.wr ? ` ${C.dim}(${paper.wr})${C.reset}` : '');
}

function formatLiveCell(live?: LiveMeta): string {
  if (!live) return C.gray + '-' + C.reset;
  const pnl = live.pnl ? colorPnl(live.pnl) : `${C.green}active${C.reset}`;
  return pnl;
}

function printTable(entries: ConfigEntry[], showNoMeta: boolean): void {
  const withMeta = entries.filter((e) => e.meta !== null);
  const noMeta   = entries.filter((e) => e.meta === null);

  // Сортировка: по status → по имени
  withMeta.sort((a, b) => {
    const sa = STATUS_ORDER[a.meta!.status] ?? 99;
    const sb = STATUS_ORDER[b.meta!.status] ?? 99;
    if (sa !== sb) return sa - sb;
    return a.file.localeCompare(b.file);
  });

  // Ширины колонок
  const W = { file: 32, strategy: 22, status: 9, bt: 20, paper: 16, live: 12, desc: 46 };

  const divider = '─'.repeat(W.file + W.strategy + W.status + W.bt + W.paper + W.live + W.desc + 14);

  console.log(`\n${C.bold}CONFIG SUMMARY${C.reset}  ${C.gray}(${withMeta.length} with meta, ${noMeta.length} without)${C.reset}`);
  console.log(divider);
  console.log(
    C.bold +
    pad('CONFIG', W.file) + '  ' +
    pad('STRATEGY', W.strategy) + '  ' +
    pad('STATUS', W.status) + '  ' +
    pad('BACKTEST', W.bt) + '  ' +
    pad('PAPER', W.paper) + '  ' +
    pad('LIVE', W.live) + '  ' +
    'DESC' +
    C.reset,
  );
  console.log(divider);

  let lastStatus: string | null = null;

  for (const e of withMeta) {
    const m = e.meta!;
    if (lastStatus !== null && lastStatus !== m.status) {
      console.log(C.dim + '─'.repeat(divider.length) + C.reset);
    }
    lastStatus = m.status;

    const btCell    = formatPnlCell(m.backtest);
    const paperCell = formatPaperCell(m.paper);
    const liveCell  = formatLiveCell(m.live);
    const statusCell = colorStatus(m.status);

    console.log(
      pad(`${C.cyan}${truncate(e.file, W.file)}${C.reset}`, W.file + C.cyan.length + C.reset.length) + '  ' +
      pad(truncate(e.strategy, W.strategy), W.strategy) + '  ' +
      pad(statusCell, W.status + (colorStatus(m.status).length - m.status.length)) + '  ' +
      pad(btCell, W.bt + (btCell.length - btCell.replace(/\x1b\[[0-9;]*m/g, '').length)) + '  ' +
      pad(paperCell, W.paper + (paperCell.length - paperCell.replace(/\x1b\[[0-9;]*m/g, '').length)) + '  ' +
      pad(liveCell, W.live + (liveCell.length - liveCell.replace(/\x1b\[[0-9;]*m/g, '').length)) + '  ' +
      C.dim + truncate(m.desc, W.desc) + C.reset,
    );

    // Детальные notes под строкой (если есть)
    const noteLines: string[] = [];
    if (m.backtest?.notes) noteLines.push(`  bt: ${m.backtest.notes}`);
    if (m.backtest?.dataset) noteLines.push(`  dataset: ${m.backtest.dataset}${m.backtest.markets ? `, ${m.backtest.markets} markets` : ''}`);
    if (m.paper?.notes) noteLines.push(`  paper: ${m.paper.notes}`);
    if (m.live?.notes) noteLines.push(`  live: ${m.live.notes}`);
    if (noteLines.length > 0) {
      for (const line of noteLines) {
        console.log(C.dim + ' '.repeat(W.file + 2) + truncate(line, 120) + C.reset);
      }
    }
  }

  console.log(divider);
  console.log(`${C.gray}Total with meta: ${withMeta.length}${C.reset}`);

  if (showNoMeta && noMeta.length > 0) {
    console.log(`\n${C.dim}--- NO META (${noMeta.length} configs) ---${C.reset}`);
    const cols = 4;
    for (let i = 0; i < noMeta.length; i += cols) {
      const row = noMeta.slice(i, i + cols).map((e) => e.file.padEnd(38)).join('');
      console.log(C.gray + row + C.reset);
    }
  }

  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const showAll       = args.includes('--all');
const statusFilter  = args.find((a) => a.startsWith('--status='))?.split('=')[1]?.split(',');
const stratFilter   = args.find((a) => a.startsWith('--strategy='))?.split('=')[1];

const configsDir = new URL('../configs', import.meta.url).pathname;
let entries = loadConfigs(configsDir);

if (statusFilter && statusFilter.length > 0) {
  entries = entries.filter(
    (e) => e.meta !== null && statusFilter.includes(e.meta.status),
  );
}

if (stratFilter) {
  entries = entries.filter(
    (e) => e.strategy.includes(stratFilter) || e.file.includes(stratFilter),
  );
}

printTable(entries, showAll);
