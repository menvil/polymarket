import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as zlib from 'node:zlib';

type RecordType = 'ob' | 'trade';

type PriceLevel = [number, number];

interface BaseRecord {
  readonly t: RecordType;
  readonly ts: number;
}

interface OrderbookRecord extends BaseRecord {
  readonly t: 'ob';
  readonly bids: PriceLevel[];
  readonly asks: PriceLevel[];
}

interface TradeRecord extends BaseRecord {
  readonly t: 'trade';
  readonly p: number;
  readonly sz: number;
  readonly side: 'buy' | 'sell' | string | null;
}

interface PendingTrade {
  readonly lineNo: number;
  readonly trade: TradeRecord;
}

interface OrderbookEnvelope {
  readonly lineNo: number;
  readonly ts: number;
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly minVisibleBid: number;
  readonly maxVisibleAsk: number;
}

interface ValidationIssue {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly lineNo?: number;
  readonly ts?: number;
  readonly message: string;
}

interface GapEpisode {
  readonly fromLine: number;
  readonly toLine: number;
  readonly fromTs: number;
  readonly toTs: number;
  readonly gapMs: number;
}

interface RunEpisode {
  readonly startLine: number;
  readonly endLine: number;
  readonly startTs: number;
  readonly endTs: number;
  readonly snapshots: number;
  readonly durationMs: number;
}

interface Stats {
  totalRecords: number;
  obCount: number;
  tradeCount: number;
  parseErrors: number;
  obGapsMs: number[];
  spreadBps: number[];
  lineTypes: Map<string, number>;
  maxDepthBid: number;
  maxDepthAsk: number;
}

interface RunState {
  startLine: number;
  endLine: number;
  startTs: number;
  endTs: number;
  snapshots: number;
}

interface AllEpisodes {
  obGaps: GapEpisode[];
  staleFullRuns: RunEpisode[];
}

interface CliOptions {
  readonly targetPath: string;
  readonly json: boolean;
  readonly outputPath?: string;
}

interface FileReport {
  readonly filePath: string;
  readonly stats: {
    totalRecords: number;
    orderbooks: number;
    trades: number;
    parseErrors: number;
    firstTs?: number;
    lastTs?: number;
    durationMs?: number;
    obGapMs?: DistributionSummary;
    spreadBps?: DistributionSummary;
    maxDepth: {
      bids: number;
      asks: number;
    };
    recordTypes: Record<string, number>;
  };
  readonly thresholds: {
    gapWarningMs?: number;
    fullBookFreezeWarningMs: number;
    tradeLagWarningMs: number;
  };
  readonly issues: ValidationIssue[];
  readonly suspiciousEpisodes: {
    largeObGaps: GapEpisode[];
    longFullBookFreezes: RunEpisode[];
  };
}

interface DirectoryFileSummary {
  readonly filePath: string;
  readonly relativePath: string;
  readonly orderbooks: number;
  readonly trades: number;
  readonly totalRecords: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly maxGapMs?: number;
  readonly issueCodes: string[];
}

interface DirectoryReport {
  readonly directoryPath: string;
  readonly stats: {
    filesScanned: number;
    filesWithErrors: number;
    filesWithWarnings: number;
    filesWithZeroTrades: number;
    totalRecords: number;
    totalOrderbooks: number;
    totalTrades: number;
  };
  readonly issueCounts: Record<string, number>;
  readonly suspiciousFiles: DirectoryFileSummary[];
  readonly zeroTradeFiles: DirectoryFileSummary[];
}

interface DistributionSummary {
  readonly min: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

function usage(): string {
  return [
    'Usage:',
    '  node src/checkCexSnapshot.ts <path-to-file-or-directory> [--json] [--output <file>]',
    '',
    'Examples:',
    '  node src/checkCexSnapshot.ts snapshots/2026-04-08/binance/file.jsonl.gz',
    '  node src/checkCexSnapshot.ts snapshots/2026-04-08/binance',
    '  npm run check:snapshot -- snapshots/2026-04-08/binance/file.jsonl.gz --json',
  ].join('\n');
}

function parseCli(argv: string[]): CliOptions {
  let targetPath = '';
  let json = false;
  let outputPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
      continue;
    }

    if (arg === '--output') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`Missing value for --output\n\n${usage()}`);
      }
      outputPath = path.resolve(process.cwd(), value);
      i++;
      continue;
    }

    if (!targetPath) {
      targetPath = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}\n\n${usage()}`);
  }

  if (!targetPath) {
    throw new Error(usage());
  }

  return {
    targetPath: path.resolve(process.cwd(), targetPath),
    json,
    outputPath,
  };
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) {
    throw new Error('Cannot compute quantile for an empty array');
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

function summarizeDistribution(values: number[]): DistributionSummary | undefined {
  if (values.length === 0) return undefined;

  return {
    min: quantile(values, 0),
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: quantile(values, 1),
  };
}

function safeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPriceLevelArray(value: unknown): value is PriceLevel[] {
  if (!Array.isArray(value)) return false;
  return value.every((level) =>
    Array.isArray(level)
    && level.length === 2
    && safeNumber(level[0])
    && safeNumber(level[1])
  );
}

function isOrderbookRecord(value: unknown): value is OrderbookRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<OrderbookRecord>;
  return record.t === 'ob'
    && safeNumber(record.ts)
    && isPriceLevelArray(record.bids)
    && isPriceLevelArray(record.asks);
}

function isTradeRecord(value: unknown): value is TradeRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<TradeRecord>;
  return record.t === 'trade'
    && safeNumber(record.ts)
    && safeNumber(record.p)
    && safeNumber(record.sz)
    && (typeof record.side === 'string' || record.side === null || typeof record.side === 'undefined');
}

function pushIssue(
  issues: ValidationIssue[],
  severity: ValidationIssue['severity'],
  code: string,
  message: string,
  lineNo?: number,
  ts?: number,
): void {
  issues.push({ severity, code, message, lineNo, ts });
}

function formatTs(ts?: number): string {
  if (!safeNumber(ts)) return 'n/a';
  return new Date(ts).toISOString();
}

function formatIssue(issue: ValidationIssue): string {
  const linePart = issue.lineNo ? `line ${issue.lineNo}` : 'line ?';
  const tsPart = issue.ts ? `ts=${formatTs(issue.ts)}` : 'ts=n/a';
  return `[${issue.severity.toUpperCase()}] ${issue.code} ${linePart} ${tsPart} ${issue.message}`;
}

function serializeOrderbook(record: OrderbookRecord): string {
  return JSON.stringify({
    bids: record.bids,
    asks: record.asks,
  });
}

function finalizeRun(
  episodes: RunEpisode[],
  run: RunState | null,
): void {
  if (!run) return;

  episodes.push({
    startLine: run.startLine,
    endLine: run.endLine,
    startTs: run.startTs,
    endTs: run.endTs,
    snapshots: run.snapshots,
    durationMs: run.endTs - run.startTs,
  });
}

function startRun(lineNo: number, ts: number): RunState {
  return {
    startLine: lineNo,
    endLine: lineNo,
    startTs: ts,
    endTs: ts,
    snapshots: 1,
  };
}

function extendRun(run: RunState, lineNo: number, ts: number): RunState {
  return {
    ...run,
    endLine: lineNo,
    endTs: ts,
    snapshots: run.snapshots + 1,
  };
}

function detectGapThreshold(obGapSummary: DistributionSummary | undefined): number | undefined {
  if (!obGapSummary) return undefined;
  return Math.max(3_000, obGapSummary.median * 10, obGapSummary.p95 * 2);
}

function sameVisibleBook(a: OrderbookEnvelope | null, b: OrderbookEnvelope | null): boolean {
  if (!a || !b) return false;
  return a.bestBid === b.bestBid
    && a.bestAsk === b.bestAsk
    && a.minVisibleBid === b.minVisibleBid
    && a.maxVisibleAsk === b.maxVisibleAsk;
}

function evaluateTradeVsBooks(
  trade: TradeRecord,
  prevOb: OrderbookEnvelope | null,
  nextOb: OrderbookEnvelope | null,
  issues: ValidationIssue[],
  lineNo: number,
  tradeLagWarningMs: number,
): void {
  if (!prevOb) {
    pushIssue(
      issues,
      'warning',
      'trade_before_first_orderbook',
      'Trade arrived before first orderbook snapshot in file',
      lineNo,
      trade.ts,
    );
    return;
  }

  const lagMs = trade.ts - prevOb.ts;
  if (lagMs > tradeLagWarningMs) {
    pushIssue(
      issues,
      'warning',
      'trade_far_from_prev_orderbook',
      `Nearest previous orderbook is ${lagMs}ms older than trade`,
      lineNo,
      trade.ts,
    );
  }

  const upperAsk = nextOb
    ? Math.max(prevOb.maxVisibleAsk, nextOb.maxVisibleAsk)
    : prevOb.maxVisibleAsk;
  const lowerBid = nextOb
    ? Math.min(prevOb.minVisibleBid, nextOb.minVisibleBid)
    : prevOb.minVisibleBid;
  const bookUnchangedAroundTrade = sameVisibleBook(prevOb, nextOb);
  const freezeWindowMs = bookUnchangedAroundTrade && nextOb ? nextOb.ts - prevOb.ts : 0;

  if (trade.side === 'buy' && trade.p > upperAsk) {
    pushIssue(
      issues,
      'warning',
      bookUnchangedAroundTrade ? 'trade_conflicts_with_unchanged_orderbook' : 'trade_buy_above_book_envelope',
      bookUnchangedAroundTrade
        ? `Buy trade price ${trade.p} is above unchanged orderbook envelope ${upperAsk} during ${freezeWindowMs}ms freeze`
        : `Buy trade price ${trade.p} is above orderbook ask envelope ${upperAsk}`,
      lineNo,
      trade.ts,
    );
    return;
  }

  if (trade.side === 'sell' && trade.p < lowerBid) {
    pushIssue(
      issues,
      'warning',
      bookUnchangedAroundTrade ? 'trade_conflicts_with_unchanged_orderbook' : 'trade_sell_below_book_envelope',
      bookUnchangedAroundTrade
        ? `Sell trade price ${trade.p} is below unchanged orderbook envelope ${lowerBid} during ${freezeWindowMs}ms freeze`
        : `Sell trade price ${trade.p} is below orderbook bid envelope ${lowerBid}`,
      lineNo,
      trade.ts,
    );
    return;
  }

  if (trade.side !== 'buy' && trade.side !== 'sell') {
    const outsideEnvelope = trade.p < lowerBid || trade.p > upperAsk;
    if (outsideEnvelope) {
      pushIssue(
        issues,
        'warning',
        'trade_outside_book_envelope',
        `Trade price ${trade.p} is outside book envelope [${lowerBid}, ${upperAsk}]`,
        lineNo,
        trade.ts,
      );
    }
  }
}

function renderTextReport(report: FileReport): string {
  const errorCount = report.issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = report.issues.filter((issue) => issue.severity === 'warning').length;
  const lines: string[] = [];

  lines.push(`File: ${report.filePath}`);
  lines.push(
    `Records: ${report.stats.totalRecords} total, ${report.stats.orderbooks} orderbooks, `
    + `${report.stats.trades} trades, ${report.stats.parseErrors} parse errors`,
  );

  if (report.stats.firstTs && report.stats.lastTs && report.stats.durationMs !== undefined) {
    lines.push(
      `Window: ${formatTs(report.stats.firstTs)} .. ${formatTs(report.stats.lastTs)} `
      + `(${report.stats.durationMs}ms)`,
    );
  }

  if (report.stats.obGapMs) {
    lines.push(
      `OB gaps ms: min=${report.stats.obGapMs.min}, median=${report.stats.obGapMs.median}, `
      + `p95=${report.stats.obGapMs.p95}, max=${report.stats.obGapMs.max}`,
    );
  }

  if (report.stats.spreadBps) {
    lines.push(
      `Spread bps: min=${report.stats.spreadBps.min.toFixed(3)}, `
      + `median=${report.stats.spreadBps.median.toFixed(3)}, `
      + `p95=${report.stats.spreadBps.p95.toFixed(3)}, `
      + `max=${report.stats.spreadBps.max.toFixed(3)}`,
    );
  }

  lines.push(
    `Depth: max bids=${report.stats.maxDepth.bids}, max asks=${report.stats.maxDepth.asks}`,
  );
  lines.push(`Issues: ${errorCount} errors, ${warningCount} warnings`);

  if (report.thresholds.gapWarningMs !== undefined) {
    lines.push(`Gap warning threshold: ${report.thresholds.gapWarningMs}ms`);
  }
  lines.push(`Full-book freeze warning threshold: ${report.thresholds.fullBookFreezeWarningMs}ms`);
  lines.push(`Trade lag warning threshold: ${report.thresholds.tradeLagWarningMs}ms`);

  if (report.suspiciousEpisodes.largeObGaps.length > 0) {
    lines.push('Large OB gaps:');
    for (const gap of report.suspiciousEpisodes.largeObGaps) {
      lines.push(
        `  lines ${gap.fromLine}->${gap.toLine}, gap=${gap.gapMs}ms, `
        + `${formatTs(gap.fromTs)} -> ${formatTs(gap.toTs)}`,
      );
    }
  }

  if (report.suspiciousEpisodes.longFullBookFreezes.length > 0) {
    lines.push('Long full-book freezes:');
    for (const run of report.suspiciousEpisodes.longFullBookFreezes) {
      lines.push(
        `  lines ${run.startLine}-${run.endLine}, duration=${run.durationMs}ms, `
        + `snapshots=${run.snapshots}`,
      );
    }
  }

  if (report.issues.length > 0) {
    lines.push('Issues detail:');
    for (const issue of report.issues) {
      lines.push(`  ${formatIssue(issue)}`);
    }
  }

  return lines.join('\n');
}

function countIssues(issues: ValidationIssue[]): { errors: number; warnings: number } {
  return {
    errors: issues.filter((issue) => issue.severity === 'error').length,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
  };
}

function issueCountsByCode(reports: FileReport[]): Record<string, number> {
  const counts = new Map<string, number>();

  for (const report of reports) {
    for (const issue of report.issues) {
      counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
    }
  }

  return Object.fromEntries(
    [...counts.entries()].sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    }),
  );
}

function summarizeFileForDirectory(report: FileReport, rootDir: string): DirectoryFileSummary {
  const issueCount = countIssues(report.issues);
  const issueCodes = [...new Set(report.issues.map((issue) => issue.code))].sort();

  return {
    filePath: report.filePath,
    relativePath: path.relative(rootDir, report.filePath),
    orderbooks: report.stats.orderbooks,
    trades: report.stats.trades,
    totalRecords: report.stats.totalRecords,
    errorCount: issueCount.errors,
    warningCount: issueCount.warnings,
    maxGapMs: report.stats.obGapMs?.max,
    issueCodes,
  };
}

function renderDirectoryReport(report: DirectoryReport): string {
  const lines: string[] = [];

  lines.push(`Directory: ${report.directoryPath}`);
  lines.push(
    `Files: ${report.stats.filesScanned}, with warnings=${report.stats.filesWithWarnings}, `
    + `with errors=${report.stats.filesWithErrors}, zero-trade files=${report.stats.filesWithZeroTrades}`,
  );
  lines.push(
    `Records: ${report.stats.totalRecords} total, ${report.stats.totalOrderbooks} orderbooks, `
    + `${report.stats.totalTrades} trades`,
  );

  const issueEntries = Object.entries(report.issueCounts);
  if (issueEntries.length > 0) {
    lines.push('Issue counts:');
    for (const [code, count] of issueEntries) {
      lines.push(`  ${code}: ${count}`);
    }
  }

  if (report.zeroTradeFiles.length > 0) {
    lines.push('Zero-trade files:');
    for (const file of report.zeroTradeFiles.slice(0, 20)) {
      lines.push(
        `  ${file.relativePath} records=${file.totalRecords} orderbooks=${file.orderbooks} trades=${file.trades}`,
      );
    }
    if (report.zeroTradeFiles.length > 20) {
      lines.push(`  ... and ${report.zeroTradeFiles.length - 20} more`);
    }
  }

  if (report.suspiciousFiles.length > 0) {
    lines.push('Suspicious files:');
    for (const file of report.suspiciousFiles.slice(0, 30)) {
      const maxGapPart = file.maxGapMs !== undefined ? ` maxGapMs=${file.maxGapMs}` : '';
      const codesPart = file.issueCodes.length > 0 ? ` issues=${file.issueCodes.join(',')}` : '';
      lines.push(
        `  ${file.relativePath} errors=${file.errorCount} warnings=${file.warningCount}`
        + ` orderbooks=${file.orderbooks} trades=${file.trades}${maxGapPart}${codesPart}`,
      );
    }
    if (report.suspiciousFiles.length > 30) {
      lines.push(`  ... and ${report.suspiciousFiles.length - 30} more`);
    }
  }

  return lines.join('\n');
}

async function analyzeFile(filePath: string): Promise<FileReport> {
  const stats: Stats = {
    totalRecords: 0,
    obCount: 0,
    tradeCount: 0,
    parseErrors: 0,
    obGapsMs: [],
    spreadBps: [],
    lineTypes: new Map<string, number>(),
    maxDepthBid: 0,
    maxDepthAsk: 0,
  };

  const issues: ValidationIssue[] = [];
  const episodes: AllEpisodes = {
    obGaps: [],
    staleFullRuns: [],
  };

  let firstTs: number | undefined;
  let lastTs: number | undefined;
  let previousRecordTs: number | null = null;
  let previousRecordLine: number | null = null;
  let prevOb: OrderbookRecord | null = null;
  let prevObEnvelope: OrderbookEnvelope | null = null;
  let prevObLine: number | null = null;
  let pendingTrades: PendingTrade[] = [];
  let staleFullRun: RunState | null = null;

  const tradeLagWarningMs = 1_500;
  const fullBookFreezeWarningMs = 60_000;

  const fileStream = fs.createReadStream(filePath);
  const input = filePath.endsWith('.gz')
    ? fileStream.pipe(zlib.createGunzip())
    : fileStream;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  let lineNo = 0;
  for await (const rawLine of rl) {
    lineNo++;
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      stats.parseErrors++;
      pushIssue(
        issues,
        'error',
        'json_parse_error',
        `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        lineNo,
      );
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null || !('t' in parsed)) {
      pushIssue(issues, 'error', 'invalid_record_shape', 'Record is not an object with type field', lineNo);
      continue;
    }

    const rawType = String((parsed as { t?: unknown }).t);
    stats.lineTypes.set(rawType, (stats.lineTypes.get(rawType) ?? 0) + 1);
    stats.totalRecords++;

    if (!('ts' in parsed) || !safeNumber((parsed as { ts?: unknown }).ts)) {
      pushIssue(issues, 'error', 'invalid_timestamp', 'Record is missing a numeric ts', lineNo);
      continue;
    }

    const ts = (parsed as { ts: number }).ts;
    firstTs ??= ts;
    lastTs = ts;

    if (previousRecordTs !== null && ts < previousRecordTs) {
      pushIssue(
        issues,
        'warning',
        'non_monotonic_timestamp',
        `Timestamp moved backwards by ${previousRecordTs - ts}ms relative to line ${previousRecordLine}`,
        lineNo,
        ts,
      );
    }
    previousRecordTs = ts;
    previousRecordLine = lineNo;

    if (isOrderbookRecord(parsed)) {
      stats.obCount++;
      stats.maxDepthBid = Math.max(stats.maxDepthBid, parsed.bids.length);
      stats.maxDepthAsk = Math.max(stats.maxDepthAsk, parsed.asks.length);

      if (parsed.bids.length === 0 || parsed.asks.length === 0) {
        pushIssue(issues, 'error', 'empty_orderbook_side', 'Orderbook has empty bids or asks', lineNo, parsed.ts);
      } else {
        const bestBid = parsed.bids[0][0];
        const bestAsk = parsed.asks[0][0];

        if (bestBid >= bestAsk) {
          pushIssue(
            issues,
            'error',
            'crossed_orderbook',
            `Best bid ${bestBid} is not below best ask ${bestAsk}`,
            lineNo,
            parsed.ts,
          );
        }

        for (let i = 0; i < parsed.bids.length; i++) {
          const [price, size] = parsed.bids[i];
          if (price <= 0 || size <= 0) {
            pushIssue(
              issues,
              'error',
              'invalid_bid_level',
              `Bid level ${i} has non-positive price/size: [${price}, ${size}]`,
              lineNo,
              parsed.ts,
            );
          }
          if (i > 0 && parsed.bids[i - 1][0] < price) {
            pushIssue(
              issues,
              'error',
              'bid_sort_violation',
              `Bid level ${i - 1} price ${parsed.bids[i - 1][0]} is below level ${i} price ${price}`,
              lineNo,
              parsed.ts,
            );
          }
        }

        for (let i = 0; i < parsed.asks.length; i++) {
          const [price, size] = parsed.asks[i];
          if (price <= 0 || size <= 0) {
            pushIssue(
              issues,
              'error',
              'invalid_ask_level',
              `Ask level ${i} has non-positive price/size: [${price}, ${size}]`,
              lineNo,
              parsed.ts,
            );
          }
          if (i > 0 && parsed.asks[i - 1][0] > price) {
            pushIssue(
              issues,
              'error',
              'ask_sort_violation',
              `Ask level ${i - 1} price ${parsed.asks[i - 1][0]} is above level ${i} price ${price}`,
              lineNo,
              parsed.ts,
            );
          }
        }

        const spread = bestAsk - bestBid;
        const mid = (bestAsk + bestBid) / 2;
        stats.spreadBps.push((spread / mid) * 10_000);

        if (prevOb && prevObLine !== null) {
          const gapMs = parsed.ts - prevOb.ts;
          if (gapMs < 0) {
            pushIssue(
              issues,
              'warning',
              'orderbook_timestamp_regression',
              `Orderbook timestamp moved backwards by ${Math.abs(gapMs)}ms`,
              lineNo,
              parsed.ts,
            );
          } else {
            stats.obGapsMs.push(gapMs);
            episodes.obGaps.push({
              fromLine: prevObLine,
              toLine: lineNo,
              fromTs: prevOb.ts,
              toTs: parsed.ts,
              gapMs,
            });
          }

          if (serializeOrderbook(prevOb) === serializeOrderbook(parsed)) {
            staleFullRun = staleFullRun
              ? extendRun(staleFullRun, lineNo, parsed.ts)
              : extendRun(startRun(prevObLine, prevOb.ts), lineNo, parsed.ts);
          } else if (staleFullRun) {
            finalizeRun(episodes.staleFullRuns, staleFullRun);
            staleFullRun = null;
          }
        }

        const currentEnvelope: OrderbookEnvelope = {
          lineNo,
          ts: parsed.ts,
          bestBid,
          bestAsk,
          minVisibleBid: parsed.bids[parsed.bids.length - 1][0],
          maxVisibleAsk: parsed.asks[parsed.asks.length - 1][0],
        };

        for (const pendingTrade of pendingTrades) {
          evaluateTradeVsBooks(
            pendingTrade.trade,
            prevObEnvelope,
            currentEnvelope,
            issues,
            pendingTrade.lineNo,
            tradeLagWarningMs,
          );
        }
        pendingTrades = [];

        prevOb = parsed;
        prevObLine = lineNo;
        prevObEnvelope = currentEnvelope;
      }

      continue;
    }

    if (isTradeRecord(parsed)) {
      stats.tradeCount++;

      if (parsed.p <= 0 || parsed.sz <= 0) {
        pushIssue(
          issues,
          'error',
          'invalid_trade_values',
          `Trade has non-positive price/size: p=${parsed.p}, sz=${parsed.sz}`,
          lineNo,
          parsed.ts,
        );
      }

      if (parsed.side !== 'buy' && parsed.side !== 'sell') {
        pushIssue(
          issues,
          'warning',
          'unexpected_trade_side',
          `Trade side is '${String(parsed.side)}' instead of buy/sell`,
          lineNo,
          parsed.ts,
        );
      }

      pendingTrades.push({
        lineNo,
        trade: parsed,
      });
      continue;
    }

    pushIssue(
      issues,
      'error',
      'unknown_record_type',
      `Unsupported record type '${rawType}'`,
      lineNo,
      ts,
    );
  }

  for (const pendingTrade of pendingTrades) {
    evaluateTradeVsBooks(
      pendingTrade.trade,
      prevObEnvelope,
      null,
      issues,
      pendingTrade.lineNo,
      tradeLagWarningMs,
    );
  }

  const obGapSummary = summarizeDistribution(stats.obGapsMs);
  const spreadSummary = summarizeDistribution(stats.spreadBps);
  const gapWarningMs = detectGapThreshold(obGapSummary);

  if (staleFullRun) {
    finalizeRun(episodes.staleFullRuns, staleFullRun);
  }

  const largeObGaps = gapWarningMs === undefined
    ? []
    : episodes.obGaps.filter((episode) => episode.gapMs >= gapWarningMs);
  const longFullBookFreezes = episodes.staleFullRuns.filter(
    (episode) => episode.durationMs >= fullBookFreezeWarningMs,
  );

  for (const gap of largeObGaps) {
    pushIssue(
      issues,
      'warning',
      'large_orderbook_gap',
      `Gap between consecutive orderbooks is ${gap.gapMs}ms`,
      gap.toLine,
      gap.toTs,
    );
  }

  for (const episode of longFullBookFreezes) {
    pushIssue(
      issues,
      'warning',
      'long_full_book_freeze',
      `Entire visible orderbook stayed unchanged for ${episode.durationMs}ms across ${episode.snapshots} snapshots`,
      episode.endLine,
      episode.endTs,
    );
  }

  if (stats.obCount >= 50 && stats.tradeCount === 0) {
    pushIssue(
      issues,
      'warning',
      'zero_trades_with_active_orderbook',
      `File has ${stats.obCount} orderbooks but zero trades`,
    );
  }

  const report: FileReport = {
    filePath,
    stats: {
      totalRecords: stats.totalRecords,
      orderbooks: stats.obCount,
      trades: stats.tradeCount,
      parseErrors: stats.parseErrors,
      firstTs,
      lastTs,
      durationMs: firstTs !== undefined && lastTs !== undefined ? lastTs - firstTs : undefined,
      obGapMs: obGapSummary,
      spreadBps: spreadSummary,
      maxDepth: {
        bids: stats.maxDepthBid,
        asks: stats.maxDepthAsk,
      },
      recordTypes: Object.fromEntries(stats.lineTypes.entries()),
    },
    thresholds: {
      gapWarningMs,
      fullBookFreezeWarningMs,
      tradeLagWarningMs,
    },
    issues,
    suspiciousEpisodes: {
      largeObGaps,
      longFullBookFreezes,
    },
  };

  return report;
}

async function collectSnapshotFiles(targetPath: string): Promise<string[]> {
  const entries = await fs.promises.readdir(targetPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...await collectSnapshotFiles(fullPath));
      continue;
    }

    if (entry.isFile() && (fullPath.endsWith('.jsonl') || fullPath.endsWith('.jsonl.gz'))) {
      files.push(fullPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

function buildDirectoryReport(directoryPath: string, reports: FileReport[]): DirectoryReport {
  const fileSummaries = reports.map((report) => summarizeFileForDirectory(report, directoryPath));
  const suspiciousFiles = fileSummaries
    .filter((file) => file.errorCount > 0 || file.warningCount > 0)
    .sort((a, b) => {
      if (b.errorCount !== a.errorCount) return b.errorCount - a.errorCount;
      if (b.warningCount !== a.warningCount) return b.warningCount - a.warningCount;
      return a.relativePath.localeCompare(b.relativePath);
    });
  const zeroTradeFiles = fileSummaries
    .filter((file) => file.orderbooks > 0 && file.trades === 0)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    directoryPath,
    stats: {
      filesScanned: reports.length,
      filesWithErrors: fileSummaries.filter((file) => file.errorCount > 0).length,
      filesWithWarnings: fileSummaries.filter((file) => file.warningCount > 0).length,
      filesWithZeroTrades: zeroTradeFiles.length,
      totalRecords: reports.reduce((sum, report) => sum + report.stats.totalRecords, 0),
      totalOrderbooks: reports.reduce((sum, report) => sum + report.stats.orderbooks, 0),
      totalTrades: reports.reduce((sum, report) => sum + report.stats.trades, 0),
    },
    issueCounts: issueCountsByCode(reports),
    suspiciousFiles,
    zeroTradeFiles,
  };
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const stat = await fs.promises.stat(options.targetPath);

  let rendered = '';
  let hasErrors = false;

  if (stat.isDirectory()) {
    const files = await collectSnapshotFiles(options.targetPath);
    const reports: FileReport[] = [];

    for (const filePath of files) {
      reports.push(await analyzeFile(filePath));
    }

    const directoryReport = buildDirectoryReport(options.targetPath, reports);
    hasErrors = directoryReport.stats.filesWithErrors > 0;
    rendered = options.json
      ? JSON.stringify(directoryReport, null, 2)
      : renderDirectoryReport(directoryReport);
  } else {
    const report = await analyzeFile(options.targetPath);
    hasErrors = report.issues.some((issue) => issue.severity === 'error');
    rendered = options.json
      ? JSON.stringify(report, null, 2)
      : renderTextReport(report);
  }

  console.log(rendered);

  if (options.outputPath) {
    await fs.promises.mkdir(path.dirname(options.outputPath), { recursive: true });
    await fs.promises.writeFile(options.outputPath, rendered + '\n', 'utf8');
  }

  process.exitCode = hasErrors ? 1 : 0;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
