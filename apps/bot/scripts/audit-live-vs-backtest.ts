/**
 * Аудит live-торговли CalibratedCrowdStrategy против edge-таблицы и backtest.
 *
 * @remarks
 * Для каждого fill из журнала:
 * 1. Поднимает соответствующий recording, находит observation на момент fill.
 * 2. Считает зону (delta, tau, crowd, regime) по bucketing из edge-таблицы.
 * 3. Сверяет fill-зону с тем, что таблица говорит (composite, pHat, edge, OOS).
 * 4. Смотрит, что crowd сделала в окнах 30s/60s после входа → оценка adverse selection.
 * 5. На том же рынке симулирует backtest-логику страт (первая валидная BUY-зона
 *    после warmup) и сравнивает с реальным входом.
 *
 * Цель — количественно увидеть разрыв между тем, что бэктест «торговал бы»,
 * и тем, что реально исполнилось в live.
 *
 * @example
 * ```bash
 * npx tsx scripts/audit-live-vs-backtest.ts \
 *   --journal-dir data/journals/2026-04-21 \
 *   --recording-dir data/live-recordings/2026-04-21 \
 *   --table tables/edge-table-5min.json
 * ```
 */

/* eslint-disable no-console */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  parseSnapshot, classifyRegime,
  type MarketData, type Observation, type Regime,
} from './analyze-crowd-calibration.js';
import { EdgeTable, type EdgeZone } from '../src/strategies/calibrated-crowd/EdgeTable.js';

// ── ANSI ─────────────────────────────────────────────────────────────────────

const R = '\x1b[0m';
const B = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

function money(x: number): string {
  const s = (x >= 0 ? '+' : '') + x.toFixed(2);
  return x > 0 ? `${GREEN}${s}${R}` : x < 0 ? `${RED}${s}${R}` : s;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

interface Cli {
  journalDir: string;
  recordingDir: string;
  tablePath: string;
  warmupSec: number;
  minComposite: number;
  maxSharesPerMarket: number;
}

function parseCli(): Cli {
  const a = process.argv.slice(2);
  const cli: Cli = {
    journalDir: '',
    recordingDir: '',
    tablePath: 'tables/edge-table-5min.json',
    warmupSec: 15,
    minComposite: 0.3,
    maxSharesPerMarket: 5,
  };
  for (let i = 0; i < a.length; i++) {
    const v = a[i + 1];
    if (a[i] === '--journal-dir' && v) { cli.journalDir = v; i++; }
    else if (a[i] === '--recording-dir' && v) { cli.recordingDir = v; i++; }
    else if (a[i] === '--table' && v) { cli.tablePath = v; i++; }
    else if (a[i] === '--warmup-sec' && v) { cli.warmupSec = Number(v); i++; }
    else if (a[i] === '--min-composite' && v) { cli.minComposite = Number(v); i++; }
    else if (a[i] === '--max-shares' && v) { cli.maxSharesPerMarket = Number(v); i++; }
  }
  if (!cli.journalDir || !cli.recordingDir) {
    console.error('Usage: --journal-dir <dir> --recording-dir <dir> [--table ...] [--warmup-sec 15] [--min-composite 0.3]');
    process.exit(1);
  }
  return cli;
}

// ── Журнал ───────────────────────────────────────────────────────────────────

interface JournalFill {
  ts: number;
  orderId: string;
  side: 'BUY' | 'SELL';
  priceCents: number;
  size: number;
  partial: boolean;
  slippageCents?: number;
}

interface JournalOrder {
  ts: number;
  orderId: string;
  side: 'BUY' | 'SELL';
  priceCents: number;
  size: number;
}

interface Journal {
  path: string;
  conditionId: string;
  instrumentId: string;
  tokenIds: string[];
  question: string;
  eventStartMs: number;
  expiresAtMs: number;
  orders: JournalOrder[];
  fills: JournalFill[];
  resolution?: 'UP' | 'DOWN';
  resolutionPnL?: number;
  settlementPrice?: number;
}

function loadJournal(path: string): Journal | null {
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  const first = JSON.parse(lines[0]);
  if (first.t !== 'session_start') return null;

  const j: Journal = {
    path,
    conditionId: first.marketId,
    instrumentId: first.instrumentId,
    tokenIds: first.tokenIds ?? [],
    question: first.marketQuestion ?? '',
    eventStartMs: first.eventStartMs ?? 0,
    expiresAtMs: first.expiresAtMs ?? 0,
    orders: [],
    fills: [],
  };

  for (let i = 1; i < lines.length; i++) {
    const e = JSON.parse(lines[i]);
    if (e.t === 'order') {
      j.orders.push({
        ts: e.ts,
        orderId: e.orderId,
        side: e.side,
        priceCents: Math.round(Number(e.price) * 100),
        size: Number(e.size),
      });
    } else if (e.t === 'fill') {
      j.fills.push({
        ts: e.ts,
        orderId: e.orderId,
        side: e.side,
        priceCents: Math.round(Number(e.price) * 100),
        size: Number(e.size),
        partial: Boolean(e.partial),
        slippageCents: e.slippageCents,
      });
    } else if (e.t === 'resolution') {
      j.resolution = e.resolution;
      j.resolutionPnL = e.pnl !== undefined ? Number(e.pnl) : undefined;
      j.settlementPrice = e.settlementPrice !== undefined ? Number(e.settlementPrice) : undefined;
    }
  }
  return j;
}

// ── Матчинг журнала и recording ──────────────────────────────────────────────

function findRecording(recordingDir: string, conditionId: string): string | null {
  // conditionId.slice(0, 40) используется в имени журнала и recording-файлов.
  const shortId = conditionId.slice(0, 40);
  const files = readdirSync(recordingDir);
  for (const f of files) {
    if (f.includes(shortId) && (f.endsWith('.jsonl') || f.endsWith('.jsonl.gz'))) {
      return join(recordingDir, f);
    }
  }
  return null;
}

// ── Bucketing (копия из EdgeTable для локальных нужд) ────────────────────────

function toBucket(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

interface ZoneBucket {
  delta: number;
  tau: number;
  crowd: number;
  regime: Regime;
}

function bucketize(o: Observation, meta: EdgeTable['meta']): ZoneBucket | null {
  const m = meta.bucketing;
  if (Math.abs(o.delta) > m.maxDelta) return null;
  if (o.tauSec < 0 || o.tauSec > m.maxTau) return null;
  return {
    delta: toBucket(o.delta, m.deltaStep),
    tau: toBucket(o.tauSec, m.tauStep),
    crowd: toBucket(o.midPriceCents, m.crowdStep),
    regime: classifyRegime(o.trendSlope, m.regimeThreshold),
  };
}

// ── Поиск observation на момент tsMs ─────────────────────────────────────────

function findObsAt(obs: Observation[], tsMs: number, maxDriftMs = 5_000): Observation | null {
  let best: Observation | null = null;
  let bestDt = Number.POSITIVE_INFINITY;
  for (const o of obs) {
    const dt = Math.abs(o.tsMs - tsMs);
    if (dt < bestDt) { best = o; bestDt = dt; }
  }
  if (!best || bestDt > maxDriftMs) return null;
  return best;
}

function obsInWindow(obs: Observation[], startMs: number, windowMs: number): Observation[] {
  return obs.filter((o) => o.tsMs >= startMs && o.tsMs <= startMs + windowMs);
}

// ── Симуляция backtest-входа на том же рынке ─────────────────────────────────

interface BacktestEntry {
  tsMs: number;
  tauSec: number;
  priceCents: number;      // наш bid = bestBid+1 если spread позволяет
  zone: EdgeZone;
  midCents: number;
  deltaDollars: number;
  regime: Regime;
}

function computeEntryBidCents(o: Observation): number {
  const aggressive = Math.round(o.bestBidCents) + 1;
  const bid = aggressive < Math.round(o.bestAskCents)
    ? aggressive : Math.round(o.bestBidCents);
  return Math.max(1, Math.min(99, bid));
}

function simulateBacktestEntry(
  md: MarketData,
  table: EdgeTable,
  cfg: { warmupSec: number; minComposite: number },
): BacktestEntry | null {
  const marketStartMs = md.endDateMs - md.durationMin * 60_000;
  for (const o of md.observations) {
    const elapsed = o.tsMs - marketStartMs;
    if (elapsed < cfg.warmupSec * 1000) continue;
    const bucket = bucketize(o, table.meta);
    if (!bucket) continue;
    const zone = table.lookup({
      deltaDollars: o.delta,
      tauSec: o.tauSec,
      midCents: o.midPriceCents,
      regime: bucket.regime,
    });
    if (!zone) continue;
    if (zone.signal !== 'BUY' || zone.kelly.side !== 'UP') continue;
    if (zone.weights.composite < cfg.minComposite) continue;
    if (zone.kelly.size <= 0) continue;
    return {
      tsMs: o.tsMs,
      tauSec: o.tauSec,
      priceCents: computeEntryBidCents(o),
      zone,
      midCents: o.midPriceCents,
      deltaDollars: o.delta,
      regime: bucket.regime,
    };
  }
  return null;
}

// ── Per-fill анализ ──────────────────────────────────────────────────────────

interface FillAudit {
  journalQuestion: string;
  fillTs: number;
  orderId: string;
  fillPriceCents: number;
  fillSize: number;
  partial: boolean;
  slippageCents: number | undefined;
  /** Observation рядом с fill.ts */
  obsNear: Observation | null;
  driftMs: number;
  bucket: ZoneBucket | null;
  zone: EdgeZone | undefined;
  crowdAtFillCents: number | undefined;
  crowdIn30sCents: { min: number; max: number; last: number } | undefined;
  crowdIn60sCents: { min: number; max: number; last: number } | undefined;
  resolution: 'UP' | 'DOWN' | undefined;
  /** PnL per share at expiry. BUY: UP wins → (1 - entryPrice). */
  pnlAtExpiry: number;
}

function analyzeFill(
  fill: JournalFill,
  md: MarketData,
  table: EdgeTable,
  resolution: 'UP' | 'DOWN' | undefined,
  question: string,
): FillAudit {
  const obsNear = findObsAt(md.observations, fill.ts, 10_000);
  const driftMs = obsNear ? Math.abs(obsNear.tsMs - fill.ts) : -1;
  const bucket = obsNear ? bucketize(obsNear, table.meta) : null;
  const zone = obsNear && bucket ? table.lookup({
    deltaDollars: obsNear.delta,
    tauSec: obsNear.tauSec,
    midCents: obsNear.midPriceCents,
    regime: bucket.regime,
  }) : undefined;

  const window30 = obsInWindow(md.observations, fill.ts, 30_000);
  const window60 = obsInWindow(md.observations, fill.ts, 60_000);
  const summarize = (w: Observation[]) => w.length === 0 ? undefined : {
    min: Math.min(...w.map((x) => x.midPriceCents)),
    max: Math.max(...w.map((x) => x.midPriceCents)),
    last: w[w.length - 1].midPriceCents,
  };

  // PnL per share at expiry for BUY side:
  const entryUsd = fill.priceCents / 100;
  const payoff = resolution === 'UP' ? 1 : 0;
  const pnlPerShare = fill.side === 'BUY' ? (payoff - entryUsd) : (entryUsd - payoff);
  const pnlAtExpiry = pnlPerShare * fill.size;

  return {
    journalQuestion: question,
    fillTs: fill.ts,
    orderId: fill.orderId,
    fillPriceCents: fill.priceCents,
    fillSize: fill.size,
    partial: fill.partial,
    slippageCents: fill.slippageCents,
    obsNear,
    driftMs,
    bucket,
    zone,
    crowdAtFillCents: obsNear?.midPriceCents,
    crowdIn30sCents: summarize(window30),
    crowdIn60sCents: summarize(window60),
    resolution,
    pnlAtExpiry,
  };
}

// ── Отчёты ───────────────────────────────────────────────────────────────────

function fmtZone(z: EdgeZone | undefined): string {
  if (!z) return `${DIM}no-zone${R}`;
  const parts = [
    `${z.signal}`,
    `comp=${z.weights.composite.toFixed(2)}`,
    `pHat=${(z.train.pHat * 100).toFixed(1)}`,
    `edge=${(z.train.edge * 100).toFixed(1)}`,
    `oos=${z.oos ? (z.oos.passes ? 'pass' : 'fail') : 'n/a'}`,
    `n=${z.train.n}`,
  ];
  const color = z.signal === 'BUY' ? GREEN : z.signal === 'SELL' ? RED : DIM;
  return `${color}${parts.join(' ')}${R}`;
}

function printFillReport(audit: FillAudit): void {
  console.log(`${B}${CYAN}▸ FILL${R} ${audit.journalQuestion}`);
  console.log(`  orderId: ${audit.orderId.slice(0, 18)}...  ts: ${new Date(audit.fillTs).toISOString()}`);
  console.log(`  fill:    ${audit.fillSize} @ ${audit.fillPriceCents}¢ ${audit.partial ? '(partial)' : ''}  notional=$${(audit.fillSize * audit.fillPriceCents / 100).toFixed(2)}  slippage=${audit.slippageCents ?? 'n/a'}¢`);
  if (!audit.obsNear) {
    console.log(`  ${RED}нет observation рядом с fill.ts${R}`);
  } else {
    const o = audit.obsNear;
    console.log(`  obs@fill: mid=${o.midPriceCents}¢  spread=${o.spreadCents}¢  delta=${o.delta.toFixed(1)}$  tau=${o.tauSec.toFixed(0)}s  slope=${o.trendSlope.toFixed(1)}$/min  drift=${audit.driftMs}ms`);
    const b = audit.bucket!;
    console.log(`  bucket:   delta=${b.delta} tau=${b.tau} crowd=${b.crowd} regime=${b.regime}`);
    console.log(`  zone:     ${fmtZone(audit.zone)}`);
  }
  const fmtWin = (w: { min: number; max: number; last: number } | undefined): string => {
    if (!w) return 'n/a';
    const atFill = audit.crowdAtFillCents ?? audit.fillPriceCents;
    const dLast = w.last - atFill;
    const arrow = dLast > 0 ? GREEN + '▲' + R : dLast < 0 ? RED + '▼' + R : '·';
    return `last=${w.last}¢ ${arrow}${dLast > 0 ? '+' : ''}${dLast}¢  min=${w.min}¢ max=${w.max}¢`;
  };
  console.log(`  +30s:     ${fmtWin(audit.crowdIn30sCents)}`);
  console.log(`  +60s:     ${fmtWin(audit.crowdIn60sCents)}`);
  const resStr = audit.resolution ?? 'unknown';
  const pnlStr = audit.resolution ? money(audit.pnlAtExpiry) : `${DIM}n/a${R}`;
  console.log(`  resolve:  ${resStr}  pnl@expiry=${pnlStr}  (entry ${audit.fillPriceCents}¢ × ${audit.fillSize} shares)`);
  console.log('');
}

interface MarketSummary {
  question: string;
  conditionId: string;
  resolution: 'UP' | 'DOWN' | undefined;
  liveFills: FillAudit[];
  liveNotionalUsd: number;
  livePnLUsd: number;
  backtestEntry: BacktestEntry | null;
  backtestPnLUsd: number; // per share × maxShares
}

function printMarketSummary(s: MarketSummary): void {
  console.log(`${B}═══ ${s.question} ═══${R}`);
  console.log(`resolution: ${s.resolution ?? 'unknown'}`);
  console.log(`live fills: ${s.liveFills.length}  notional=$${s.liveNotionalUsd.toFixed(2)}  pnl=${money(s.livePnLUsd)}`);
  if (s.backtestEntry) {
    const e = s.backtestEntry;
    console.log(`backtest would enter: tau=${e.tauSec.toFixed(0)}s  bid=${e.priceCents}¢  delta=${e.deltaDollars.toFixed(1)}$  regime=${e.regime}  zone: ${fmtZone(e.zone)}`);
    console.log(`backtest pnl (1 share × 5): ${money(s.backtestPnLUsd)}`);
  } else {
    console.log(`${DIM}backtest would NOT enter (нет валидной BUY-зоны)${R}`);
  }
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli = parseCli();
  const table = EdgeTable.fromFile(cli.tablePath);
  console.log(`${B}Edge table:${R} ${cli.tablePath}  zones=${table.size}  sampleMode=${table.meta.sampleMode ?? 'markets'}`);
  console.log(`${B}Config:${R} warmupSec=${cli.warmupSec}  minComposite=${cli.minComposite}  maxSharesPerMarket=${cli.maxSharesPerMarket}`);
  console.log('');

  const journalFiles = readdirSync(cli.journalDir).filter((f) => f.endsWith('.journal.jsonl'));
  console.log(`Journals: ${journalFiles.length}`);

  const summaries: MarketSummary[] = [];

  for (const jf of journalFiles) {
    const jpath = join(cli.journalDir, jf);
    const journal = loadJournal(jpath);
    if (!journal) { console.warn(`skip ${jf}: cannot parse session_start`); continue; }

    const recPath = findRecording(cli.recordingDir, journal.conditionId);
    if (!recPath) {
      console.warn(`skip ${journal.question}: no recording for ${journal.conditionId.slice(0, 40)}`);
      continue;
    }

    // parseSnapshot использует --token up; outcomeIndex=0 значит UP (это наш сценарий для BTC UpDown).
    const parsed = await parseSnapshot(recPath, table.meta.bucketing.maxTau, 'up', /* approxResolution */ false);
    if (!parsed.data) {
      console.warn(`skip ${journal.question}: parse failed (reason=${parsed.skipReason})`);
      continue;
    }
    const md = parsed.data;

    // Резолюцию берём из журнала (надёжнее, т.к. recording может ещё не иметь market_resolved).
    const resolution = journal.resolution ?? md.resolution;

    // Per-fill audit (только BUY, т.к. стратегия hold-to-expiry без exit).
    const audits: FillAudit[] = [];
    const buyFills = journal.fills.filter((f) => f.side === 'BUY');
    for (const f of buyFills) {
      audits.push(analyzeFill(f, md, table, resolution, journal.question));
    }

    // Backtest simulation.
    const bt = simulateBacktestEntry(md, table, {
      warmupSec: cli.warmupSec,
      minComposite: cli.minComposite,
    });
    let btPnL = 0;
    if (bt && resolution) {
      const btEntry = bt.priceCents / 100;
      const payoff = resolution === 'UP' ? 1 : 0;
      btPnL = (payoff - btEntry) * cli.maxSharesPerMarket;
    }

    const liveNotional = audits.reduce((s, a) => s + a.fillPriceCents * a.fillSize / 100, 0);
    const livePnL = audits.reduce((s, a) => s + a.pnlAtExpiry, 0);

    summaries.push({
      question: journal.question,
      conditionId: journal.conditionId,
      resolution,
      liveFills: audits,
      liveNotionalUsd: liveNotional,
      livePnLUsd: livePnL,
      backtestEntry: bt,
      backtestPnLUsd: btPnL,
    });

    // Печатаем детали по каждому fill сразу.
    for (const a of audits) printFillReport(a);
  }

  // Итоги по рынкам.
  console.log(`${B}${CYAN}═══════════════════════════════════════════════${R}`);
  console.log(`${B}${CYAN}  PER-MARKET SUMMARY${R}`);
  console.log(`${B}${CYAN}═══════════════════════════════════════════════${R}`);
  console.log('');
  for (const s of summaries) printMarketSummary(s);

  // Глобальный итог.
  const totLiveNotional = summaries.reduce((s, x) => s + x.liveNotionalUsd, 0);
  const totLivePnL = summaries.reduce((s, x) => s + x.livePnLUsd, 0);
  const totBtPnL = summaries.reduce((s, x) => s + x.backtestPnLUsd, 0);
  const liveFillsCnt = summaries.reduce((s, x) => s + x.liveFills.length, 0);
  const btEntryCnt = summaries.filter((x) => x.backtestEntry).length;

  console.log(`${B}${CYAN}═══════════════════════════════════════════════${R}`);
  console.log(`${B}${CYAN}  TOTALS${R}`);
  console.log(`${B}${CYAN}═══════════════════════════════════════════════${R}`);
  console.log(`markets analyzed:   ${summaries.length}`);
  console.log(`live fills:         ${liveFillsCnt}  notional=$${totLiveNotional.toFixed(2)}  pnl=${money(totLivePnL)}`);
  console.log(`backtest entries:   ${btEntryCnt}  pnl=${money(totBtPnL)}  (1 entry per market, ${cli.maxSharesPerMarket} shares @ best-bid+1)`);
  console.log('');

  // Adverse-selection индикатор: на сколько crowd изменилась в +30s от fill.
  const adverse30: number[] = [];
  for (const s of summaries) {
    for (const a of s.liveFills) {
      if (a.crowdAtFillCents !== undefined && a.crowdIn30sCents !== undefined) {
        adverse30.push(a.crowdIn30sCents.last - a.crowdAtFillCents);
      }
    }
  }
  if (adverse30.length > 0) {
    const avg = adverse30.reduce((s, x) => s + x, 0) / adverse30.length;
    const neg = adverse30.filter((x) => x < 0).length;
    console.log(`crowd drift +30s after fill (BUY): avg=${avg > 0 ? '+' : ''}${avg.toFixed(1)}¢  negative=${neg}/${adverse30.length}`);
    console.log(`  (отрицательный drift = мы купили вершину; adverse-selection индикатор)`);
  }

  // Zone-coverage: в каких зонах fill попал в SKIP-зоны или вообще no-zone.
  let hitBuy = 0, hitNonBuy = 0, hitNoZone = 0, hitLowComp = 0, hitNoOos = 0;
  for (const s of summaries) {
    for (const a of s.liveFills) {
      if (!a.zone) { hitNoZone++; continue; }
      if (a.zone.signal !== 'BUY') hitNonBuy++;
      else {
        hitBuy++;
        if (a.zone.weights.composite < cli.minComposite) hitLowComp++;
        if (!a.zone.oos || !a.zone.oos.passes) hitNoOos++;
      }
    }
  }
  console.log('');
  console.log(`zone coverage:`);
  console.log(`  fill-зон с signal=BUY:           ${hitBuy}/${liveFillsCnt}`);
  console.log(`  fill в SKIP/SELL-зоне:           ${hitNonBuy}/${liveFillsCnt}  ${hitNonBuy > 0 ? YELLOW + '← bucket-drift между live и table' + R : ''}`);
  console.log(`  fill без зоны в таблице:         ${hitNoZone}/${liveFillsCnt}`);
  console.log(`  из BUY: composite<${cli.minComposite}:   ${hitLowComp}/${hitBuy}`);
  console.log(`  из BUY: без прошедшего OOS:      ${hitNoOos}/${hitBuy}  ${hitNoOos > 0 ? YELLOW + '← непровалидированная OOS' + R : ''}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
