/**
 * Точка входа для кросс-маркетного арбитражного бектеста.
 *
 * @remarks
 * Standalone скрипт, не затрагивающий существующий main.ts и runBacktest().
 * Поддерживает два режима:
 *
 * ### Режим 1: Два файла (--easy + --hard)
 * Анализирует конкретную пару файлов снапшотов.
 * ```bash
 * npx tsx src/arbitrage/runArbBacktest.ts \
 *   --easy ../../packages/apps/collect-data/snapshots/2026-03-23/Bitcoin_15m.jsonl.gz \
 *   --hard ../../packages/apps/collect-data/snapshots/2026-03-23/Bitcoin_5m.jsonl.gz
 * ```
 *
 * ### Режим 2: Директория (--dir)
 * Сканирует все файлы, находит пары автоматически.
 * ```bash
 * # Бектест за 23 марта:
 * npx tsx src/arbitrage/runArbBacktest.ts \
 *   --dir ../../packages/apps/collect-data/snapshots \
 *   --date 2026-03-23
 *
 * # С фильтрами:
 * npx tsx src/arbitrage/runArbBacktest.ts \
 *   --dir ../../packages/apps/collect-data/snapshots \
 *   --date 2026-03-23 \
 *   --assets BTC,ETH \
 *   --pairs 5m-15m,5m-hourly
 *
 * # С новой моделью комиссий (после 30 марта):
 * npx tsx src/arbitrage/runArbBacktest.ts \
 *   --dir ../../packages/apps/collect-data/snapshots \
 *   --date 2026-03-23 \
 *   --fee-model march30
 * ```
 *
 * ### Общие опции:
 * - `--max-depth <N>` — максимальная глубина ордербука (default: 5)
 * - `--fee-model current|march30` — модель комиссий (default: current)
 * - `--min-spread <N>` — минимальный spread после fees (default: 0.005)
 *
 * ### ENV переменные:
 * - `ARB_SNAPSHOT_DIR` — путь к директории снапшотов (альтернатива --dir)
 * - `ARB_MAX_DEPTH` — максимальная глубина ордербука (default: 5)
 * - `ARB_FEE_MODEL` — модель комиссий: 'current' | 'march30' (default: current)
 * - `ARB_MIN_SPREAD` — минимальный spread после fees (default: 0.005)
 * - `ARB_ASSETS` — фильтр по активам (comma-separated)
 * - `ARB_PAIRS` — фильтр по типам пар (comma-separated)
 */

import * as path from 'node:path';
import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { CrossMarketBacktestEngine } from '@polymarket/backtesting';
import { FEE_MODEL_CURRENT, FEE_MODEL_MARCH30 } from '@polymarket/cross-market';
import type { PairResult, PairSimulationResult, SharedBalanceSimulationResult, SimulatedTrade, OpportunityWindow } from '@polymarket/backtesting';

// ── Парсинг аргументов ──────────────────────────────────────────────────────

/**
 * Режим запуска: два файла или сканирование директории.
 */
type RunMode =
  | { kind: 'pair'; easyFile: string; hardFile: string }
  | { kind: 'dir'; dir: string; date?: string; assets?: string[]; pairs?: string[] };

/**
 * Общие опции бектеста.
 */
interface CommonOpts {
  maxDepth: number;
  feeModel: 'current' | 'march30';
  minSpread: number;
  balance?: number;
  gapTolerance: number;
  latency: number;
  slippage: number;
}

/**
 * Парсит аргументы командной строки.
 *
 * @returns Режим запуска и общие опции
 */
function parseArgs(): { mode: RunMode; opts: CommonOpts } {
  const args = process.argv.slice(2);
  let dir = process.env['ARB_SNAPSHOT_DIR'] ?? '';
  let date: string | undefined = process.env['ARB_DATE'];
  let maxDepth = parseInt(process.env['ARB_MAX_DEPTH'] ?? '5', 10);
  let feeModel: 'current' | 'march30' = (process.env['ARB_FEE_MODEL'] as 'current' | 'march30') ?? 'current';
  let minSpread = parseFloat(process.env['ARB_MIN_SPREAD'] ?? '0.005');
  let assets: string[] | undefined = process.env['ARB_ASSETS']?.split(',').map(s => s.trim());
  let pairs: string[] | undefined = process.env['ARB_PAIRS']?.split(',').map(s => s.trim());
  let easyFile = '';
  let hardFile = '';
  let balance: number | undefined;
  let gapTolerance = 500;
  let latency = 150;
  let slippage = 0;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dir':
        dir = args[++i] ?? '';
        break;
      case '--date':
        date = args[++i] ?? '';
        break;
      case '--easy':
        easyFile = args[++i] ?? '';
        break;
      case '--hard':
        hardFile = args[++i] ?? '';
        break;
      case '--max-depth':
        maxDepth = parseInt(args[++i] ?? '5', 10);
        break;
      case '--fee-model':
        feeModel = (args[++i] ?? 'current') as 'current' | 'march30';
        break;
      case '--min-spread':
        minSpread = parseFloat(args[++i] ?? '0.005');
        break;
      case '--assets':
        assets = (args[++i] ?? '').split(',').map(s => s.trim());
        break;
      case '--pairs':
        pairs = (args[++i] ?? '').split(',').map(s => s.trim());
        break;
      case '--balance':
        balance = parseFloat(args[++i] ?? '1000');
        break;
      case '--gap-tolerance':
        gapTolerance = parseInt(args[++i] ?? '500', 10);
        break;
      case '--latency':
        latency = parseInt(args[++i] ?? '150', 10);
        break;
      case '--slippage':
        slippage = parseFloat(args[++i] ?? '0');
        break;
    }
  }

  const opts: CommonOpts = { maxDepth, feeModel, minSpread, balance, gapTolerance, latency, slippage };

  // Режим двух файлов
  if (easyFile && hardFile) {
    return {
      mode: {
        kind: 'pair',
        easyFile: path.resolve(easyFile),
        hardFile: path.resolve(hardFile),
      },
      opts,
    };
  }

  // Режим директории
  if (dir) {
    return {
      mode: {
        kind: 'dir',
        dir: path.resolve(dir),
        date,
        assets,
        pairs,
      },
      opts,
    };
  }

  console.error(
    'Usage:\n' +
    '  Режим двух файлов:\n' +
    '    npx tsx src/arbitrage/runArbBacktest.ts --easy <file> --hard <file>\n' +
    '  Режим директории:\n' +
    '    npx tsx src/arbitrage/runArbBacktest.ts --dir <snapshot-dir> [--date YYYY-MM-DD]\n',
  );
  process.exit(1);
}

// ── Форматирование результатов ──────────────────────────────────────────────

function printResults(pairResults: readonly PairResult[]): void {
  // Фильтруем только пары с расхождениями
  const divergent = pairResults.filter(r => r.divergentSnapshots > 0);

  if (divergent.length === 0) {
    console.log('\nNo divergences found.');
    return;
  }

  // Сортируем по bestPnl descending
  const sorted = [...divergent].sort((a, b) => b.bestPnl - a.bestPnl);

  console.log(`\n${'='.repeat(120)}`);
  console.log('CROSS-MARKET ARBITRAGE BACKTEST RESULTS');
  console.log(`${'='.repeat(120)}`);

  console.log(
    `${'Asset'.padStart(5)} | ${'EndDate'.padStart(16)} | ${'Pair'.padStart(12)} | ` +
    `${'Diverg'.padStart(6)}/${'Total'.padStart(5)} | ${'Pct'.padStart(5)} | ` +
    `${'BestPnL'.padStart(9)} | ${'AvgPnL/u'.padStart(9)} | ` +
    `${'BestDepth'.padStart(9)} | ${'ExecSize'.padStart(9)}`
  );
  console.log('-'.repeat(120));

  let totalBestPnl = 0;

  for (const r of sorted) {
    const pct = ((r.divergentSnapshots / r.totalSnapshots) * 100).toFixed(0);
    const best = r.bestSignal;
    totalBestPnl += r.bestPnl;

    console.log(
      `${r.pair.easy.asset.padStart(5)} | ` +
      `${r.pair.easy.endDate.slice(0, 16).padStart(16)} | ` +
      `${r.pair.pairType.padStart(12)} | ` +
      `${String(r.divergentSnapshots).padStart(6)}/${String(r.totalSnapshots).padStart(5)} | ` +
      `${pct.padStart(4)}% | ` +
      `$${r.bestPnl.toFixed(2).padStart(8)} | ` +
      `${r.avgPnlPerUnit.toFixed(4).padStart(9)} | ` +
      `${best ? String(best.optimalDepth.depth).padStart(9) : 'N/A'.padStart(9)} | ` +
      `${best ? best.optimalDepth.execSize.toFixed(0).padStart(9) : 'N/A'.padStart(9)}`
    );
  }

  console.log('-'.repeat(120));
  console.log(`TOTAL: ${divergent.length} pairs with divergence, best PnL sum: $${totalBestPnl.toFixed(2)}`);
}

// ── Форматирование симуляции ─────────────────────────────────────────────────

/**
 * Форматирует timestamp в читаемую строку HH:MM:SS.
 */
function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/**
 * Форматирует длительность в секундах/минутах.
 */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(0)}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

/**
 * Печатает детальный результат симуляции.
 */
function printSimulation(sim: PairSimulationResult): void {
  const p = sim.pair;
  const easyRec = p.easy.recurrence;
  const hardRec = p.hard.recurrence;

  console.log(`\n${'='.repeat(100)}`);
  console.log(`TRADE SIMULATION: ${p.easy.asset} ${p.pairType} (end: ${p.easy.endDate.slice(0, 16)})`);
  console.log(`${'='.repeat(100)}`);

  console.log(`\n  Initial balance:  $${sim.initialBalance.toFixed(2)}`);
  console.log(`  Snapshots:        ${sim.divergentSnapshots} divergent / ${sim.totalSnapshots} total (${((sim.divergentSnapshots / sim.totalSnapshots) * 100).toFixed(0)}%)`);
  console.log(`  Windows:          ${sim.windows.length}`);
  console.log(`  Trades:           ${sim.trades.length}`);

  // ── Окна возможностей ───────────────────────────────────────────────────
  if (sim.windows.length > 0) {
    console.log(`\n${'─'.repeat(100)}`);
    console.log('OPPORTUNITY WINDOWS');
    console.log(`${'─'.repeat(100)}`);
    console.log(
      `${'#'.padStart(3)} | ${'Start'.padStart(8)} | ${'End'.padStart(8)} | ` +
      `${'Duration'.padStart(8)} | ${'Snaps'.padStart(5)} | ` +
      `${'EntryPnL/u'.padStart(10)} | ${'BestPnL/u'.padStart(10)}`
    );
    console.log('-'.repeat(100));

    for (let i = 0; i < sim.windows.length; i++) {
      const w = sim.windows[i];
      console.log(
        `${String(i + 1).padStart(3)} | ` +
        `${fmtTime(w.startMs).padStart(8)} | ` +
        `${fmtTime(w.endMs).padStart(8)} | ` +
        `${fmtDuration(w.durationMs).padStart(8)} | ` +
        `${String(w.snapshots).padStart(5)} | ` +
        `${w.entrySignal.optimalDepth.pnlPerUnit.toFixed(4).padStart(10)} | ` +
        `${w.bestSignal.optimalDepth.pnlPerUnit.toFixed(4).padStart(10)}`
      );
    }
  }

  // ── Сделки ──────────────────────────────────────────────────────────────
  if (sim.trades.length > 0) {
    const asset = p.easy.asset;

    console.log(`\n${'─'.repeat(120)}`);
    console.log('TRADE LOG');
    console.log(`${'─'.repeat(120)}`);
    console.log(`  Leg 1 (taker): BUY ${asset}-${easyRec}-Up    @ EasyAsk price`);
    console.log(`  Leg 2 (maker): BUY ${asset}-${hardRec}-Down  @ (1 − HardUpBid) price`);
    const s = sim.settlement;
    if (s.payoffPerUnit !== null && s.payoffPerUnit !== 1) {
      const label = s.payoffPerUnit === 0 ? 'DEATH ZONE' : s.payoffPerUnit === 2 ? 'WINDFALL' : `$${s.payoffPerUnit}`;
      console.log(`  Payoff at settlement: $${s.payoffPerUnit.toFixed(2)} per pair (${label}!)`);
    } else {
      console.log(`  Payoff at settlement: $1.00 per pair`);
    }
    console.log();
    console.log(
      `${'#'.padStart(3)} | ${'Time'.padStart(8)} | ` +
      `${'BUY Up@'.padStart(8)} | ${'BUY Dn@'.padStart(8)} | ` +
      `${'Cost/u'.padStart(7)} | ${'Fee/u'.padStart(6)} | ${'PnL/u'.padStart(7)} | ` +
      `${'Size'.padStart(7)} | ${'TotalCost'.padStart(10)} | ${'TotalPnL'.padStart(10)} | ${'Dpth'.padStart(4)}`
    );
    console.log('-'.repeat(120));

    for (const t of sim.trades) {
      console.log(
        `${String(t.tradeNumber).padStart(3)} | ` +
        `${fmtTime(t.entryTimestampMs).padStart(8)} | ` +
        `${t.easyUpAskPrice.toFixed(4).padStart(8)} | ` +
        `${t.hardDownAskPrice.toFixed(4).padStart(8)} | ` +
        `${t.costPerUnit.toFixed(4).padStart(7)} | ` +
        `${t.feePerUnit.toFixed(4).padStart(6)} | ` +
        `${t.pnlPerUnit.toFixed(4).padStart(7)} | ` +
        `${t.size.toFixed(0).padStart(7)} | ` +
        `$${t.totalCost.toFixed(2).padStart(9)} | ` +
        `$${t.totalPnl.toFixed(2).padStart(9)} | ` +
        `${String(t.depth).padStart(4)}`
      );
    }
  }

  // ── Итог ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(100)}`);
  console.log('SETTLEMENT');
  console.log(`${'─'.repeat(100)}`);

  const stl = sim.settlement;
  if (stl.easyStrike !== null && stl.hardStrike !== null) {
    const gap = Math.abs(stl.easyStrike - stl.hardStrike);
    const safeLabel = stl.strikesSafe ? 'SAFE (windfall zone)' : 'UNSAFE (death zone risk)';
    console.log(`  Easy strike (${easyRec}):    ${stl.easyStrike.toFixed(2)}`);
    console.log(`  Hard strike (${hardRec}):     ${stl.hardStrike.toFixed(2)}`);
    console.log(`  Strike gap:             ${gap.toFixed(2)} (${(gap / stl.easyStrike * 100).toFixed(3)}%)`);
    console.log(`  Strike filter:          ${safeLabel}`);
    if (stl.settlementPrice !== null) {
      console.log(`  Settlement price:       ${stl.settlementPrice.toFixed(2)}`);
      const easyLabel = stl.easyUpWon ? 'WIN' : 'LOSE';
      const hardLabel = stl.hardUpWon ? 'WIN (Down LOSE)' : 'LOSE (Down WIN)';
      console.log(`  Easy Up:                ${easyLabel} (price ${stl.easyUpWon ? '>=' : '<'} ${stl.easyStrike.toFixed(2)})`);
      console.log(`  Hard Up:                ${hardLabel} (price ${stl.hardUpWon ? '>=' : '<'} ${stl.hardStrike.toFixed(2)})`);
      const payoff = stl.payoffPerUnit ?? 1;
      const tag = payoff === 0 ? '  *** DEATH ZONE — TOTAL LOSS ***'
        : payoff === 2 ? '  *** WINDFALL — DOUBLE PAYOFF ***'
        : '';
      console.log(`  Payoff per unit:        $${payoff.toFixed(2)}${tag}`);
    }
  }

  console.log();
  console.log(`  Total units bought:     ${sim.totalUnits.toFixed(0)}`);
  console.log(`  Total cost of entry:    $${sim.totalCost.toFixed(2)}`);
  const payoffLabel = stl.payoffPerUnit !== null ? `$${stl.payoffPerUnit}` : '$1';
  console.log(`  Settlement payoff:      $${sim.settlementPayoff.toFixed(2)}  (${sim.totalUnits.toFixed(0)} units × ${payoffLabel})`);
  console.log(`  Cash remaining:         $${(sim.initialBalance - sim.totalCost).toFixed(2)}`);
  console.log();
  console.log(`  Initial balance:        $${sim.initialBalance.toFixed(2)}`);
  console.log(`  Final balance:          $${sim.finalBalance.toFixed(2)}`);
  console.log(`  P&L:                    $${sim.totalPnl.toFixed(2)}`);
  console.log(`  ROI:                    ${sim.roi.toFixed(2)}%`);
  console.log(`  Duration:               ${(sim.durationMs / 1000).toFixed(1)}s`);
}

// ── Форматирование batch-симуляции ───────────────────────────────────────────

/**
 * Печатает сводку по batch-симуляции (все пары директории).
 */
function printSimulationSummary(results: PairSimulationResult[]): void {
  const withTrades = results.filter(r => r.trades.length > 0);
  const withWindows = results.filter(r => r.windows.length > 0);

  // Собираем все окна и сделки
  const allWindows = results.flatMap(r => r.windows);
  const allTrades = results.flatMap(r => r.trades);

  const totalPnl = results.reduce((s, r) => s + r.totalPnl, 0);
  const totalCost = results.reduce((s, r) => s + r.totalCost, 0);
  const totalInitial = results.reduce((s, r) => s + r.initialBalance, 0);

  console.log(`\n${'='.repeat(130)}`);
  console.log('BATCH SIMULATION RESULTS');
  console.log(`${'='.repeat(130)}`);

  const skippedByStrike = results.filter(r => !r.settlement.strikesSafe);

  console.log(`\n  Total pairs:            ${results.length}`);
  console.log(`  Strike-safe pairs:      ${results.length - skippedByStrike.length}  (easy_strike ≤ hard_strike)`);
  console.log(`  Skipped (death risk):   ${skippedByStrike.length}  (easy_strike > hard_strike)`);
  console.log(`  Pairs with windows:     ${withWindows.length}`);
  console.log(`  Pairs with trades:      ${withTrades.length}`);
  console.log(`  Total windows:          ${allWindows.length}`);
  console.log(`  Total trades:           ${allTrades.length}`);

  // Статистика по длительности окон
  if (allWindows.length > 0) {
    const durations = allWindows.map(w => w.durationMs).sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)];
    const p90 = durations[Math.floor(durations.length * 0.9)];
    const longEnough = allWindows.filter(w => w.durationMs >= 150);
    const veryShort = allWindows.filter(w => w.durationMs < 150);

    console.log(`\n${'─'.repeat(130)}`);
    console.log('WINDOW DURATION STATISTICS');
    console.log(`${'─'.repeat(130)}`);
    console.log(`  Total windows:          ${allWindows.length}`);
    console.log(`  < 150ms (too fast):     ${veryShort.length} (${((veryShort.length / allWindows.length) * 100).toFixed(0)}%)`);
    console.log(`  ≥ 150ms (tradeable):    ${longEnough.length} (${((longEnough.length / allWindows.length) * 100).toFixed(0)}%)`);
    console.log(`  Median duration:        ${fmtDuration(median)}`);
    console.log(`  P90 duration:           ${fmtDuration(p90)}`);
    console.log(`  Max duration:           ${fmtDuration(durations[durations.length - 1])}`);

    // Распределение по бакетам
    const buckets = [
      { label: '< 100ms', min: 0, max: 100 },
      { label: '100-500ms', min: 100, max: 500 },
      { label: '0.5-1s', min: 500, max: 1000 },
      { label: '1-5s', min: 1000, max: 5000 },
      { label: '5-30s', min: 5000, max: 30000 },
      { label: '> 30s', min: 30000, max: Infinity },
    ];
    console.log(`\n  Duration distribution:`);
    for (const b of buckets) {
      const count = allWindows.filter(w => w.durationMs >= b.min && w.durationMs < b.max).length;
      const pct = ((count / allWindows.length) * 100).toFixed(0);
      const bar = '█'.repeat(Math.round(count / allWindows.length * 40));
      console.log(`    ${b.label.padEnd(10)} ${String(count).padStart(5)} (${pct.padStart(3)}%) ${bar}`);
    }
  }

  // Таблица по парам (с trades)
  if (withTrades.length > 0) {
    const sorted = [...withTrades].sort((a, b) => b.roi - a.roi);

    console.log(`\n${'─'.repeat(130)}`);
    console.log('PER-PAIR RESULTS (pairs with trades)');
    console.log(`${'─'.repeat(130)}`);
    console.log(
      `${'Asset'.padStart(5)} | ${'EndDate'.padStart(16)} | ${'Pair'.padStart(10)} | ` +
      `${'Windows'.padStart(7)} | ${'Trades'.padStart(6)} | ` +
      `${'Balance'.padStart(10)} | ${'PnL'.padStart(10)} | ${'ROI'.padStart(7)} | ` +
      `${'AvgWinDur'.padStart(9)} | ${'Units'.padStart(7)} | ${'Settle'.padStart(6)}`
    );
    console.log('-'.repeat(140));

    for (const r of sorted) {
      const avgWinDur = r.windows.length > 0
        ? r.windows.reduce((s, w) => s + w.durationMs, 0) / r.windows.length
        : 0;
      const payoff = r.settlement.payoffPerUnit;
      const settleTag = payoff === null ? '  ?'
        : payoff === 0 ? ' $0!'
        : payoff === 2 ? ' $2!'
        : ' $1';
      console.log(
        `${r.pair.easy.asset.padStart(5)} | ` +
        `${r.pair.easy.endDate.slice(0, 16).padStart(16)} | ` +
        `${r.pair.pairType.padStart(10)} | ` +
        `${String(r.windows.length).padStart(7)} | ` +
        `${String(r.trades.length).padStart(6)} | ` +
        `$${r.finalBalance.toFixed(2).padStart(9)} | ` +
        `$${r.totalPnl.toFixed(2).padStart(9)} | ` +
        `${r.roi.toFixed(1).padStart(5)}% | ` +
        `${fmtDuration(avgWinDur).padStart(9)} | ` +
        `${r.totalUnits.toFixed(0).padStart(7)} | ` +
        `${settleTag.padStart(6)}`
      );
    }
  }

  // Settlement statistics
  const deathPairs = withTrades.filter(r => r.settlement.payoffPerUnit === 0);
  const windfallPairs = withTrades.filter(r => r.settlement.payoffPerUnit === 2);
  const safePairs = withTrades.filter(r => r.settlement.payoffPerUnit === 1);
  const unknownPairs = withTrades.filter(r => r.settlement.payoffPerUnit === null);

  if (withTrades.length > 0) {
    console.log(`\n${'─'.repeat(140)}`);
    console.log('SETTLEMENT OUTCOMES');
    console.log(`${'─'.repeat(140)}`);
    console.log(`  SAFE ($1 payoff):       ${safePairs.length} (${((safePairs.length / withTrades.length) * 100).toFixed(0)}%)`);
    console.log(`  WINDFALL ($2 payoff):   ${windfallPairs.length} (${((windfallPairs.length / withTrades.length) * 100).toFixed(0)}%)`);
    console.log(`  DEATH ZONE ($0):        ${deathPairs.length} (${((deathPairs.length / withTrades.length) * 100).toFixed(0)}%)`);
    if (unknownPairs.length > 0) {
      console.log(`  Unknown:                ${unknownPairs.length}`);
    }
    if (deathPairs.length > 0) {
      const deathLoss = deathPairs.reduce((s, r) => s + r.totalCost, 0);
      console.log(`  Death zone total loss:  $${deathLoss.toFixed(2)}`);
    }
  }

  // Итого
  console.log(`\n${'─'.repeat(140)}`);
  console.log('AGGREGATE');
  console.log(`${'─'.repeat(140)}`);
  console.log(`  Total capital deployed:   $${totalInitial.toFixed(2)}`);
  console.log(`  Total cost of entries:    $${totalCost.toFixed(2)}`);
  console.log(`  Total P&L:               $${totalPnl.toFixed(2)}`);
  console.log(`  Avg ROI per pair:         ${totalInitial > 0 ? ((totalPnl / totalInitial) * 100).toFixed(2) : '0'}%`);
}

/**
 * Печатает сводку по shared balance симуляции.
 *
 * @remarks
 * В отличие от printSimulationSummary, показывает реальный ROI от начального баланса,
 * а не «ROI per pair». Один общий капитал, recycled между парами.
 *
 * @param result - Результат simulateAllSharedBalance
 */
function printSharedSimulationSummary(result: SharedBalanceSimulationResult): void {
  const results = result.pairResults as PairSimulationResult[];
  const withTrades = results.filter(r => r.trades.length > 0);
  const withWindows = results.filter(r => r.windows.length > 0);

  const allWindows = results.flatMap(r => r.windows);
  const allTrades = results.flatMap(r => r.trades);
  const totalCost = results.reduce((s, r) => s + r.totalCost, 0);

  const skippedByStrike = results.filter(r => !r.settlement.strikesSafe);

  console.log(`\n${'='.repeat(130)}`);
  console.log('SHARED BALANCE SIMULATION RESULTS');
  console.log(`${'='.repeat(130)}`);

  console.log(`\n  Initial balance:        $${result.initialBalance.toFixed(2)}`);
  console.log(`  Final balance:          $${result.finalBalance.toFixed(2)}`);
  console.log(`  P&L:                    $${result.totalPnl.toFixed(2)}`);
  console.log(`  ROI:                    ${result.roi.toFixed(2)}%`);
  console.log(`  Peak capital used:      $${result.peakCapitalUsed.toFixed(2)}`);

  console.log(`\n  Total pairs:            ${results.length}`);
  console.log(`  Strike-safe pairs:      ${results.length - skippedByStrike.length}  (easy_strike ≤ hard_strike)`);
  console.log(`  Skipped (death risk):   ${skippedByStrike.length}  (easy_strike > hard_strike)`);
  console.log(`  Pairs with windows:     ${withWindows.length}`);
  console.log(`  Pairs with trades:      ${withTrades.length}`);
  console.log(`  Total windows:          ${allWindows.length}`);
  console.log(`  Total trades:           ${allTrades.length}`);

  // Статистика по длительности окон
  if (allWindows.length > 0) {
    const durations = allWindows.map(w => w.durationMs).sort((a, b) => a - b);
    const median = durations[Math.floor(durations.length / 2)];
    const p90 = durations[Math.floor(durations.length * 0.9)];
    const longEnough = allWindows.filter(w => w.durationMs >= 150);
    const veryShort = allWindows.filter(w => w.durationMs < 150);

    console.log(`\n${'─'.repeat(130)}`);
    console.log('WINDOW DURATION STATISTICS');
    console.log(`${'─'.repeat(130)}`);
    console.log(`  Total windows:          ${allWindows.length}`);
    console.log(`  < 150ms (too fast):     ${veryShort.length} (${((veryShort.length / allWindows.length) * 100).toFixed(0)}%)`);
    console.log(`  ≥ 150ms (tradeable):    ${longEnough.length} (${((longEnough.length / allWindows.length) * 100).toFixed(0)}%)`);
    console.log(`  Median duration:        ${fmtDuration(median)}`);
    console.log(`  P90 duration:           ${fmtDuration(p90)}`);
    console.log(`  Max duration:           ${fmtDuration(durations[durations.length - 1])}`);

    const buckets = [
      { label: '< 100ms', min: 0, max: 100 },
      { label: '100-500ms', min: 100, max: 500 },
      { label: '0.5-1s', min: 500, max: 1000 },
      { label: '1-5s', min: 1000, max: 5000 },
      { label: '5-30s', min: 5000, max: 30000 },
      { label: '> 30s', min: 30000, max: Infinity },
    ];
    console.log(`\n  Duration distribution:`);
    for (const b of buckets) {
      const count = allWindows.filter(w => w.durationMs >= b.min && w.durationMs < b.max).length;
      const pct = ((count / allWindows.length) * 100).toFixed(0);
      const bar = '█'.repeat(Math.round(count / allWindows.length * 40));
      console.log(`    ${b.label.padEnd(10)} ${String(count).padStart(5)} (${pct.padStart(3)}%) ${bar}`);
    }
  }

  // Таблица по парам (с trades)
  if (withTrades.length > 0) {
    const sorted = [...withTrades].sort((a, b) => b.totalPnl - a.totalPnl);

    console.log(`\n${'─'.repeat(130)}`);
    console.log('PER-PAIR RESULTS (pairs with trades)');
    console.log(`${'─'.repeat(130)}`);
    console.log(
      `${'Asset'.padStart(5)} | ${'EndDate'.padStart(16)} | ${'Pair'.padStart(10)} | ` +
      `${'Trades'.padStart(6)} | ` +
      `${'Cost'.padStart(10)} | ${'Payoff'.padStart(10)} | ${'PnL'.padStart(10)} | ` +
      `${'Units'.padStart(7)} | ${'Settle'.padStart(6)}`
    );
    console.log('-'.repeat(130));

    for (const r of sorted) {
      const payoff = r.settlement.payoffPerUnit;
      const settleTag = payoff === null ? '  ?'
        : payoff === 0 ? ' $0!'
        : payoff === 2 ? ' $2!'
        : ' $1';
      console.log(
        `${r.pair.easy.asset.padStart(5)} | ` +
        `${r.pair.easy.endDate.slice(0, 16).padStart(16)} | ` +
        `${r.pair.pairType.padStart(10)} | ` +
        `${String(r.trades.length).padStart(6)} | ` +
        `$${r.totalCost.toFixed(2).padStart(9)} | ` +
        `$${r.settlementPayoff.toFixed(2).padStart(9)} | ` +
        `$${r.totalPnl.toFixed(2).padStart(9)} | ` +
        `${r.totalUnits.toFixed(0).padStart(7)} | ` +
        `${settleTag.padStart(6)}`
      );
    }
  }

  // Settlement statistics
  const deathPairs = withTrades.filter(r => r.settlement.payoffPerUnit === 0);
  const windfallPairs = withTrades.filter(r => r.settlement.payoffPerUnit === 2);
  const safePairs = withTrades.filter(r => r.settlement.payoffPerUnit === 1);
  const unknownPairs = withTrades.filter(r => r.settlement.payoffPerUnit === null);

  if (withTrades.length > 0) {
    console.log(`\n${'─'.repeat(130)}`);
    console.log('SETTLEMENT OUTCOMES');
    console.log(`${'─'.repeat(130)}`);
    console.log(`  SAFE ($1 payoff):       ${safePairs.length} (${((safePairs.length / withTrades.length) * 100).toFixed(0)}%)`);
    console.log(`  WINDFALL ($2 payoff):   ${windfallPairs.length} (${((windfallPairs.length / withTrades.length) * 100).toFixed(0)}%)`);
    console.log(`  DEATH ZONE ($0):        ${deathPairs.length} (${((deathPairs.length / withTrades.length) * 100).toFixed(0)}%)`);
    if (unknownPairs.length > 0) {
      console.log(`  Unknown:                ${unknownPairs.length}`);
    }
  }

  // Итого
  console.log(`\n${'─'.repeat(130)}`);
  console.log('AGGREGATE');
  console.log(`${'─'.repeat(130)}`);
  console.log(`  Initial balance:          $${result.initialBalance.toFixed(2)}`);
  console.log(`  Total cost of entries:    $${totalCost.toFixed(2)}`);
  console.log(`  Settlement payoffs:       $${(totalCost + result.totalPnl).toFixed(2)}`);
  console.log(`  Final balance:            $${result.finalBalance.toFixed(2)}`);
  console.log(`  Total P&L:               $${result.totalPnl.toFixed(2)}`);
  console.log(`  ROI:                      ${result.roi.toFixed(2)}%`);
  console.log(`  Peak capital used:        $${result.peakCapitalUsed.toFixed(2)}`);
  console.log(`  Capital efficiency:       ${result.peakCapitalUsed > 0 ? ((result.totalPnl / result.peakCapitalUsed) * 100).toFixed(2) : '0'}%  (P&L / peak capital)`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { mode, opts } = parseArgs();
  const logger = new ColorConsoleLogger(new LiveClock(), LogLevel.INFO);
  const feeModel = opts.feeModel === 'march30' ? FEE_MODEL_MARCH30 : FEE_MODEL_CURRENT;

  console.log(`\nCross-Market Arbitrage Backtest`);
  console.log(`  Max depth:    ${opts.maxDepth}`);
  console.log(`  Fee model:    ${opts.feeModel}`);
  console.log(`  Min spread:   ${opts.minSpread}`);
  console.log(`  Gap tolerance:${opts.gapTolerance}ms`);
  console.log(`  Latency:      ${opts.latency}ms`);
  console.log(`  Slippage/leg: ${opts.slippage}`);
  if (opts.balance !== undefined) console.log(`  Balance:      $${opts.balance}`);

  if (mode.kind === 'pair') {
    console.log(`  Mode:         pair (two files)`);
    console.log(`  Easy file:    ${mode.easyFile}`);
    console.log(`  Hard file:    ${mode.hardFile}`);
    console.log();

    const engine = new CrossMarketBacktestEngine(
      {
        snapshotDir: '',
        maxDepth: opts.maxDepth,
        feeModel,
        minSpreadAfterFees: opts.minSpread,
        gapToleranceMs: opts.gapTolerance,
        latencyMs: opts.latency,
        slippagePerLeg: opts.slippage,
      },
      { logger },
    );

    if (opts.balance !== undefined) {
      // Режим симуляции с балансом — детальный трейд-лог
      const sim = await engine.simulatePair(mode.easyFile, mode.hardFile, opts.balance);
      printSimulation(sim);
    } else {
      // Простой режим — агрегированная таблица
      const result = await engine.runPair(mode.easyFile, mode.hardFile);
      printResults(result.pairResults);
      console.log(`\nSummary:`);
      console.log(`  Total pairs analyzed: ${result.totalPairs}`);
      console.log(`  Pairs with divergence: ${result.pairsWithDivergence}`);
      console.log(`  Total divergent snapshots: ${result.totalSignals}`);
      console.log(`  Total best PnL: $${result.totalPnl.toFixed(2)}`);
      console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    }
  } else {
    console.log(`  Mode:         directory scan`);
    console.log(`  Snapshot dir: ${mode.dir}`);
    if (mode.date) console.log(`  Date:         ${mode.date}`);
    if (mode.assets) console.log(`  Assets:       ${mode.assets.join(', ')}`);
    if (mode.pairs) console.log(`  Pair types:   ${mode.pairs.join(', ')}`);
    console.log();

    const engine = new CrossMarketBacktestEngine(
      {
        snapshotDir: mode.dir,
        fromDate: mode.date,
        toDate: mode.date,
        maxDepth: opts.maxDepth,
        feeModel,
        minSpreadAfterFees: opts.minSpread,
        gapToleranceMs: opts.gapTolerance,
        latencyMs: opts.latency,
        slippagePerLeg: opts.slippage,
        assets: mode.assets,
        pairTypes: mode.pairs,
      },
      { logger },
    );

    if (opts.balance !== undefined) {
      // Режим симуляции с общим балансом (shared — капитал recycled между парами)
      const result = await engine.simulateAllSharedBalance(opts.balance);
      printSharedSimulationSummary(result);
    } else {
      const result = await engine.run();
      printResults(result.pairResults);
      console.log(`\nSummary:`);
      console.log(`  Total pairs analyzed: ${result.totalPairs}`);
      console.log(`  Pairs with divergence: ${result.pairsWithDivergence}`);
      console.log(`  Total divergent snapshots: ${result.totalSignals}`);
      console.log(`  Total best PnL: $${result.totalPnl.toFixed(2)}`);
      console.log(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
