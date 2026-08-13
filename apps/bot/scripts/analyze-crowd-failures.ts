/**
 * Анализирует journal-файлы calibrated/paired crowd стратегий и ищет конфигурации,
 * где направление толпы оказалось неверным и это привело к отрицательному PnL.
 *
 * @remarks
 * Важно разделять:
 * - `crowdWrong`: направление на входе не совпало с итоговой резолюцией;
 * - `negativePnl`: сделка закрылась в минус;
 * - `executionLoss`: минус при корректном направлении (спред/выход/тайминг).
 *
 * Скрипт агрегирует это по конфигурациям входа:
 * `(delta, tau, crowd, regime, side)` и печатает топ-зоны.
 *
 * @example
 * ```bash
 * cd apps/bot
 * npx tsx scripts/analyze-crowd-failures.ts \
 *   --journals ./data/backtest-journals/paired-cex-crowd-2026-04-21-verbose
 * ```
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

type EntrySide = 'up' | 'down';
type Resolution = 'UP' | 'DOWN' | 'UNKNOWN';
type Regime = 'up' | 'flat' | 'down';

interface Config {
  journalDirs: string[];
  top: number;
  minCount: number;
}

interface EntrySnapshot {
  file: string;
  marketId: string;
  marketQuestion?: string;
  strategyType?: string;
  entryTs: number;
  side: EntrySide;
  bidPrice?: number;
  delta?: number;
  tau?: number;
  crowd?: number;
  regime?: Regime;
  zoneDelta?: number;
  zoneTau?: number;
  zoneCrowd?: number;
  zoneRegime?: Regime;
  edgeCents?: number;
  ciEdgeCents?: number;
  composite?: number;
  pHat?: number;
  pLow?: number;
}

interface TradeRecord extends EntrySnapshot {
  resolution: Resolution;
  pnl: number;
  crowdWrong: boolean;
  negativePnl: boolean;
}

interface BucketAgg {
  key: string;
  side: EntrySide;
  zoneDelta?: number;
  zoneTau?: number;
  zoneCrowd?: number;
  zoneRegime?: Regime;
  trades: number;
  wrong: number;
  negative: number;
  wrongAndNegative: number;
  wrongButNonNegative: number;
  executionLossOnly: number;
  pnlSum: number;
  worstPnl: number;
  sampleQuestion?: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const cfg: Config = {
    journalDirs: [],
    top: 20,
    minCount: 3,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--journals' && next) {
      cfg.journalDirs = next.split(',').map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (arg === '--top' && next) {
      cfg.top = Number(next);
      i++;
    } else if (arg === '--min-count' && next) {
      cfg.minCount = Number(next);
      i++;
    }
  }

  if (cfg.journalDirs.length === 0) {
    console.error('Usage: --journals <dir1[,dir2,...]> [--top 20] [--min-count 3]');
    process.exit(1);
  }
  return cfg;
}

function collectJournalFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJournalFiles(full));
      continue;
    }
    if (entry.isFile() && full.endsWith('.journal.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

function toFixedOrDash(value: number | undefined, digits = 2): string {
  return value === undefined || Number.isNaN(value) ? 'n/a' : value.toFixed(digits);
}

function pct(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

function inferCrowdWrong(side: EntrySide, resolution: Resolution): boolean | null {
  if (resolution === 'UNKNOWN') return null;
  if (side === 'up') return resolution === 'DOWN';
  return resolution === 'UP';
}

function bucketKey(entry: EntrySnapshot): string {
  const d = entry.zoneDelta ?? 9999;
  const t = entry.zoneTau ?? 9999;
  const c = entry.zoneCrowd ?? 9999;
  const r = entry.zoneRegime ?? 'na';
  return `${entry.side}|${d}|${t}|${c}|${r}`;
}

function formatBucketLabel(agg: BucketAgg): string {
  return [
    `side=${agg.side.toUpperCase()}`,
    `delta=${agg.zoneDelta ?? 'n/a'}`,
    `tau=${agg.zoneTau ?? 'n/a'}`,
    `crowd=${agg.zoneCrowd ?? 'n/a'}`,
    `regime=${agg.zoneRegime ?? 'n/a'}`,
  ].join(' ');
}

function parseTradeFromJournal(file: string): TradeRecord | null {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);

  let marketQuestion: string | undefined;
  let strategyType: string | undefined;
  let entry: EntrySnapshot | null = null;
  let resolution: Resolution | undefined;
  let pnl: number | undefined;

  for (const line of lines) {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.t === 'session_start') {
      marketQuestion = typeof record.marketQuestion === 'string' ? record.marketQuestion : undefined;
      strategyType = typeof record.strategyType === 'string' ? record.strategyType : undefined;
      continue;
    }

    if (record.t === 'decision' && entry === null) {
      const action = record.action;
      const side = record.effectiveSide;
      if ((action === 'BUY' || action === 'BUY_COMP') && (side === 'up' || side === 'down')) {
        const state = record.state ?? {};
        const zone = state.zone ?? {};
        const key = zone.key ?? {};
        entry = {
          file,
          marketId: String(record.marketId),
          marketQuestion,
          strategyType,
          entryTs: Number(record.ts),
          side,
          bidPrice: typeof record.bidPrice === 'number' ? record.bidPrice : undefined,
          delta: typeof state.deltaDollars === 'number' ? state.deltaDollars : undefined,
          tau: typeof state.tauSec === 'number' ? state.tauSec : undefined,
          crowd: typeof state.midCents === 'number' ? state.midCents : undefined,
          regime: state.regime === 'up' || state.regime === 'flat' || state.regime === 'down'
            ? state.regime
            : undefined,
          zoneDelta: typeof key.delta === 'number' ? key.delta : undefined,
          zoneTau: typeof key.tau === 'number' ? key.tau : undefined,
          zoneCrowd: typeof key.crowd === 'number' ? key.crowd : undefined,
          zoneRegime: key.regime === 'up' || key.regime === 'flat' || key.regime === 'down'
            ? key.regime
            : undefined,
          edgeCents: typeof zone.edgeCents === 'number' ? zone.edgeCents : undefined,
          ciEdgeCents: typeof zone.entryCiEdgeCents === 'number'
            ? zone.entryCiEdgeCents
            : (typeof zone.edgeCents === 'number' ? zone.edgeCents : undefined),
          composite: typeof zone.composite === 'number' ? zone.composite : undefined,
          pHat: typeof zone.pHat === 'number' ? zone.pHat : undefined,
          pLow: typeof zone.pLow === 'number' ? zone.pLow : undefined,
        };
      }
      continue;
    }

    if (record.t === 'resolution') {
      resolution = record.resolution as Resolution;
      pnl = Number(record.pnl);
    }
  }

  if (entry === null || resolution === undefined || pnl === undefined || Number.isNaN(pnl)) {
    return null;
  }

  const crowdWrong = inferCrowdWrong(entry.side, resolution);
  if (crowdWrong === null) return null;

  return {
    ...entry,
    resolution,
    pnl,
    crowdWrong,
    negativePnl: pnl < 0,
  };
}

function main(): void {
  const cfg = parseArgs();

  const journalFiles = cfg.journalDirs
    .map((dir) => resolve(dir))
    .flatMap((dir) => collectJournalFiles(dir))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);

  const trades: TradeRecord[] = [];
  for (const file of journalFiles) {
    const trade = parseTradeFromJournal(file);
    if (trade) trades.push(trade);
  }

  const buckets = new Map<string, BucketAgg>();
  for (const trade of trades) {
    const key = bucketKey(trade);
    const agg = buckets.get(key) ?? {
      key,
      side: trade.side,
      zoneDelta: trade.zoneDelta,
      zoneTau: trade.zoneTau,
      zoneCrowd: trade.zoneCrowd,
      zoneRegime: trade.zoneRegime,
      trades: 0,
      wrong: 0,
      negative: 0,
      wrongAndNegative: 0,
      wrongButNonNegative: 0,
      executionLossOnly: 0,
      pnlSum: 0,
      worstPnl: Number.POSITIVE_INFINITY,
      sampleQuestion: trade.marketQuestion,
    };

    agg.trades++;
    agg.pnlSum += trade.pnl;
    agg.worstPnl = Math.min(agg.worstPnl, trade.pnl);
    if (trade.crowdWrong) agg.wrong++;
    if (trade.negativePnl) agg.negative++;
    if (trade.crowdWrong && trade.negativePnl) agg.wrongAndNegative++;
    if (trade.crowdWrong && !trade.negativePnl) agg.wrongButNonNegative++;
    if (!trade.crowdWrong && trade.negativePnl) agg.executionLossOnly++;

    buckets.set(key, agg);
  }

  const total = trades.length;
  const wrong = trades.filter((t) => t.crowdWrong).length;
  const negative = trades.filter((t) => t.negativePnl).length;
  const wrongAndNegative = trades.filter((t) => t.crowdWrong && t.negativePnl).length;
  const executionLossOnly = trades.filter((t) => !t.crowdWrong && t.negativePnl).length;

  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);

  console.log(`Journal files: ${journalFiles.length}`);
  console.log(`Trades found:  ${total}`);
  console.log(`Total PnL:     ${totalPnl.toFixed(4)}`);
  console.log('');
  console.log('Summary');
  console.log(`  crowd wrong:                 ${wrong} (${pct(wrong, total).toFixed(1)}%)`);
  console.log(`  negative pnl:                ${negative} (${pct(negative, total).toFixed(1)}%)`);
  console.log(`  crowd wrong + negative pnl:  ${wrongAndNegative} (${pct(wrongAndNegative, total).toFixed(1)}%)`);
  console.log(`  crowd right + negative pnl:  ${executionLossOnly} (${pct(executionLossOnly, total).toFixed(1)}%)`);
  console.log('');

  const ranked = Array.from(buckets.values())
    .filter((agg) => agg.trades >= cfg.minCount)
    .sort((a, b) => {
      if (b.wrongAndNegative !== a.wrongAndNegative) return b.wrongAndNegative - a.wrongAndNegative;
      if (b.wrong !== a.wrong) return b.wrong - a.wrong;
      return a.pnlSum - b.pnlSum;
    })
    .slice(0, cfg.top);

  console.log(`Top zones where crowd was wrong and pnl was negative (minCount=${cfg.minCount})`);
  if (ranked.length === 0) {
    console.log('  none');
    return;
  }

  for (const agg of ranked) {
    const avgPnl = agg.pnlSum / agg.trades;
    console.log('');
    console.log(formatBucketLabel(agg));
    console.log(`  trades=${agg.trades} wrong=${agg.wrong} negative=${agg.negative} wrong&neg=${agg.wrongAndNegative}`);
    console.log(`  wrongRate=${pct(agg.wrong, agg.trades).toFixed(1)}% negRate=${pct(agg.negative, agg.trades).toFixed(1)}%`);
    console.log(`  wrongNegRate=${pct(agg.wrongAndNegative, agg.trades).toFixed(1)}% executionLossOnly=${agg.executionLossOnly}`);
    console.log(`  avgPnl=${avgPnl.toFixed(4)} worstPnl=${agg.worstPnl.toFixed(4)}`);
    if (agg.sampleQuestion) console.log(`  sample="${agg.sampleQuestion}"`);
  }

  const rankedWrong = Array.from(buckets.values())
    .filter((agg) => agg.trades >= cfg.minCount)
    .sort((a, b) => {
      if (b.wrong !== a.wrong) return b.wrong - a.wrong;
      return a.pnlSum - b.pnlSum;
    })
    .slice(0, cfg.top);

  console.log('');
  console.log(`Top zones where crowd was wrong regardless of pnl (minCount=${cfg.minCount})`);
  if (rankedWrong.length === 0) {
    console.log('  none');
  } else {
    for (const agg of rankedWrong) {
      const avgPnl = agg.pnlSum / agg.trades;
      console.log('');
      console.log(formatBucketLabel(agg));
      console.log(`  trades=${agg.trades} wrong=${agg.wrong} wrong&neg=${agg.wrongAndNegative} wrong&nonNeg=${agg.wrongButNonNegative}`);
      console.log(`  wrongRate=${pct(agg.wrong, agg.trades).toFixed(1)}% negRate=${pct(agg.negative, agg.trades).toFixed(1)}%`);
      console.log(`  avgPnl=${avgPnl.toFixed(4)} pnlSum=${agg.pnlSum.toFixed(4)} worstPnl=${agg.worstPnl.toFixed(4)}`);
      if (agg.sampleQuestion) console.log(`  sample="${agg.sampleQuestion}"`);
    }
  }

  const rankedExecution = Array.from(buckets.values())
    .filter((agg) => agg.trades >= cfg.minCount && agg.executionLossOnly > 0)
    .sort((a, b) => {
      if (b.executionLossOnly !== a.executionLossOnly) return b.executionLossOnly - a.executionLossOnly;
      return a.pnlSum - b.pnlSum;
    })
    .slice(0, cfg.top);

  console.log('');
  console.log(`Top zones where crowd was right but pnl was negative (execution losses, minCount=${cfg.minCount})`);
  if (rankedExecution.length === 0) {
    console.log('  none');
    return;
  }

  for (const agg of rankedExecution) {
    const avgPnl = agg.pnlSum / agg.trades;
    console.log('');
    console.log(formatBucketLabel(agg));
    console.log(`  trades=${agg.trades} executionLossOnly=${agg.executionLossOnly} wrong=${agg.wrong} negative=${agg.negative}`);
    console.log(`  execLossRate=${pct(agg.executionLossOnly, agg.trades).toFixed(1)}% wrongRate=${pct(agg.wrong, agg.trades).toFixed(1)}%`);
    console.log(`  avgPnl=${avgPnl.toFixed(4)} pnlSum=${agg.pnlSum.toFixed(4)} worstPnl=${agg.worstPnl.toFixed(4)}`);
    if (agg.sampleQuestion) console.log(`  sample="${agg.sampleQuestion}"`);
  }
}

main();
