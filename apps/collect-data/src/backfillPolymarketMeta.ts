import * as fs from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { parseCryptoMeta } from '@polymarket/exchange/adapters';
import { DnsOverride } from '@polymarket/exchange/dns';
import { PolymarketMarketDataRestClient } from '@polymarket/exchange/rest';
import { ArchivedMarketMetaRewriter } from '../../../packages/infrastructure/persistence/data-collection/src/ArchivedMarketMetaRewriter.js';
import { loadConfig } from './config.js';

interface CliOptions {
  readonly outputDir: string;
  readonly sourceSubDir: string;
  readonly fromDate?: string;
  readonly toDate?: string;
  readonly marketId?: string;
  readonly slug?: string;
  readonly filePaths: readonly string[];
  readonly dryRun: boolean;
  readonly onlyIncomplete: boolean;
  readonly concurrency: number;
  readonly graceHours: number;
  readonly reportPath?: string;
  readonly maxFiles?: number;
}

interface SnapshotMetaRecord {
  readonly t: 'meta';
  readonly ts: number;
  readonly marketId: string;
  readonly question: string;
  readonly tokenIds: readonly string[];
  readonly m?: Record<string, unknown>;
}

interface CandidateFile {
  readonly filePath: string;
  readonly meta: SnapshotMetaRecord;
  readonly rawMarket: Record<string, unknown>;
  readonly gammaMarketId: string;
  readonly slug?: string;
  readonly conditionId: string;
}

interface BackfillResult {
  checked: number;
  updated: number;
  skipped: number;
  failed: number;
  dryRunUpdates: number;
}

function printHelp(): void {
  process.stdout.write([
    'Usage: node src/backfillPolymarketMeta.ts [options]',
    '',
    'Options:',
    '  --from-date YYYY-MM-DD      Lower date bound inclusive',
    '  --to-date YYYY-MM-DD        Upper date bound inclusive',
    '  --month YYYY-MM             Shortcut for a whole month',
    '  --market-id VALUE           Filter by marketId substring',
    '  --slug VALUE                Filter by slug substring',
    '  --file PATH                 Process a specific snapshot file (repeatable)',
    '  --output-dir PATH           Snapshot root override',
    '  --source-subdir NAME        Source folder inside date dir (default: polymarket)',
    '  --grace-hours N             Skip markets ended less than N hours ago',
    '  --concurrency N             Parallel API requests (default: 4)',
    '  --max-files N               Limit number of files after filtering',
    '  --report PATH               Write JSON summary report',
    '  --dry-run                   Do not modify files',
    '  --include-complete          Recheck even already complete crypto markets',
    '  --help                      Show this help',
    '',
    'Examples:',
    '  npm run backfill:polymarket -- --month 2026-04 --dry-run',
    '  npm run backfill:polymarket -- --from-date 2026-04-01 --to-date 2026-04-07 --concurrency 6',
    '  npm run backfill:polymarket -- --market-id 0x26793c',
  ].join('\n'));
}

function parseCliArgs(argv: readonly string[], defaults: { outputDir: string; sourceSubDir: string }): CliOptions {
  let fromDate: string | undefined;
  let toDate: string | undefined;
  let month: string | undefined;
  let marketId: string | undefined;
  let slug: string | undefined;
  const filePaths: string[] = [];
  let outputDir = defaults.outputDir;
  let sourceSubDir = defaults.sourceSubDir;
  let dryRun = false;
  let onlyIncomplete = true;
  let concurrency = 4;
  let graceHours = 6;
  let reportPath: string | undefined;
  let maxFiles: number | undefined;

  const readValue = (args: readonly string[], index: number, flag: string): string => {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    switch (arg) {
      case '--from-date':
        fromDate = readValue(argv, i, arg);
        i++;
        break;
      case '--to-date':
        toDate = readValue(argv, i, arg);
        i++;
        break;
      case '--month':
        month = readValue(argv, i, arg);
        i++;
        break;
      case '--market-id':
        marketId = readValue(argv, i, arg);
        i++;
        break;
      case '--slug':
        slug = readValue(argv, i, arg);
        i++;
        break;
      case '--file':
        filePaths.push(resolveCliPath(readValue(argv, i, arg)));
        i++;
        break;
      case '--output-dir':
        outputDir = path.resolve(process.cwd(), readValue(argv, i, arg));
        i++;
        break;
      case '--source-subdir':
        sourceSubDir = readValue(argv, i, arg);
        i++;
        break;
      case '--grace-hours':
        graceHours = parsePositiveNumber(readValue(argv, i, arg), arg);
        i++;
        break;
      case '--concurrency':
        concurrency = parsePositiveNumber(readValue(argv, i, arg), arg);
        i++;
        break;
      case '--max-files':
        maxFiles = parsePositiveNumber(readValue(argv, i, arg), arg);
        i++;
        break;
      case '--report':
        reportPath = path.resolve(process.cwd(), readValue(argv, i, arg));
        i++;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--include-complete':
        onlyIncomplete = false;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (month) {
    const monthRange = monthToRange(month);
    fromDate = monthRange.fromDate;
    toDate = monthRange.toDate;
  }

  if (!fromDate && !toDate && filePaths.length === 0) {
    throw new Error('Provide --month, --from-date/--to-date, or at least one --file');
  }

  if (fromDate) validateDateString(fromDate, '--from-date');
  if (toDate) validateDateString(toDate, '--to-date');
  if (fromDate && toDate && fromDate > toDate) {
    throw new Error('--from-date cannot be greater than --to-date');
  }

  return {
    outputDir,
    sourceSubDir,
    fromDate,
    toDate,
    marketId,
    slug,
    filePaths,
    dryRun,
    onlyIncomplete,
    concurrency,
    graceHours,
    reportPath,
    maxFiles,
  };
}

function resolveCliPath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  const candidates = [
    path.resolve(process.cwd(), inputPath),
    ...(process.env['INIT_CWD'] ? [path.resolve(process.env['INIT_CWD'], inputPath)] : []),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0]!;
}

function parsePositiveNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive number, got: ${value}`);
  }
  return parsed;
}

function validateDateString(value: string, flag: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${flag} must be YYYY-MM-DD, got: ${value}`);
  }
}

function monthToRange(month: string): { fromDate: string; toDate: string } {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error(`--month must be YYYY-MM, got: ${month}`);
  }

  const [yearRaw, monthRaw] = month.split('-');
  const year = Number(yearRaw);
  const monthIndex = Number(monthRaw);
  if (monthIndex < 1 || monthIndex > 12) {
    throw new Error(`--month must use month 01-12, got: ${month}`);
  }

  const fromDate = `${yearRaw}-${monthRaw}-01`;
  const lastDay = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  const toDate = `${yearRaw}-${monthRaw}-${String(lastDay).padStart(2, '0')}`;
  return { fromDate, toDate };
}

async function listSnapshotFiles(options: CliOptions): Promise<string[]> {
  if (options.filePaths.length > 0) {
    return [...new Set(options.filePaths)];
  }

  const entries = await fs.promises.readdir(options.outputDir, { withFileTypes: true });
  const dateFolders = entries
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((date) => {
      if (options.fromDate && date < options.fromDate) return false;
      if (options.toDate && date > options.toDate) return false;
      return true;
    })
    .sort();

  const files: string[] = [];
  for (const date of dateFolders) {
    const sourceDir = path.join(options.outputDir, date, options.sourceSubDir);
    if (!fs.existsSync(sourceDir)) continue;

    const sourceEntries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
    for (const entry of sourceEntries) {
      if (!entry.isFile()) continue;

      const filePath = path.join(sourceDir, entry.name);
      if (!filePath.endsWith('.jsonl') && !filePath.endsWith('.jsonl.gz')) continue;
      if (options.marketId && !entry.name.includes(options.marketId)) continue;
      files.push(filePath);
    }
  }

  return options.maxFiles ? files.slice(0, options.maxFiles) : files;
}

async function readFirstNonEmptyLine(filePath: string): Promise<string | null> {
  const source = fs.createReadStream(filePath);
  const input = filePath.endsWith('.gz') ? source.pipe(createGunzip()) : source;
  const rl = createInterface({
    input,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      if (line.trim().length > 0) {
        rl.close();
        source.destroy();
        return line;
      }
    }
  } finally {
    rl.close();
    source.destroy();
  }

  return null;
}

function isMetaRecord(value: unknown): value is SnapshotMetaRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record['t'] === 'meta'
    && typeof record['marketId'] === 'string'
    && typeof record['question'] === 'string'
    && Array.isArray(record['tokenIds']);
}

function isStaleEnough(rawMarket: Record<string, unknown>, graceHours: number): boolean {
  const endDate = rawMarket['endDate'];
  if (typeof endDate !== 'string') return false;

  const endMs = Date.parse(endDate);
  if (Number.isNaN(endMs)) return false;

  return endMs <= Date.now() - graceHours * 60 * 60 * 1000;
}

function shouldProcessCandidate(meta: SnapshotMetaRecord, options: CliOptions): CandidateFile | null {
  if (!meta.m) return null;

  const rawMarket = meta.m;
  const gammaMarketId = typeof rawMarket['id'] === 'string' ? rawMarket['id'] : undefined;
  const slug = typeof rawMarket['slug'] === 'string' ? rawMarket['slug'] : undefined;
  if (!gammaMarketId) return null;

  if (options.slug && (!slug || !slug.includes(options.slug))) return null;
  if (options.marketId && !meta.marketId.includes(options.marketId)) return null;
  if (!isStaleEnough(rawMarket, options.graceHours)) return null;

  const cryptoMeta = parseCryptoMeta(rawMarket);
  if (!cryptoMeta) return null;

  if (options.onlyIncomplete && cryptoMeta.priceToBeat !== undefined && cryptoMeta.finalPrice !== undefined) {
    return null;
  }

  return {
    filePath: '',
    meta,
    rawMarket,
    gammaMarketId,
    slug,
    conditionId: meta.marketId,
  };
}

async function buildCandidates(files: readonly string[], options: CliOptions, logger: ColorConsoleLogger): Promise<CandidateFile[]> {
  const candidates: CandidateFile[] = [];

  for (const filePath of files) {
    try {
      const firstLine = await readFirstNonEmptyLine(filePath);
      if (!firstLine) continue;

      const parsed = JSON.parse(firstLine) as unknown;
      if (!isMetaRecord(parsed)) continue;

      const candidate = shouldProcessCandidate(parsed, options);
      if (!candidate) continue;

      candidates.push({ ...candidate, filePath });
    } catch (error) {
      logger.warn('Failed to inspect snapshot meta, skipping file', {
        filePath,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return candidates;
}

function buildUpdatedMetaRecord(meta: SnapshotMetaRecord, updatedRawMarket: Record<string, unknown>): SnapshotMetaRecord {
  return {
    ...meta,
    ts: Date.now(),
    m: updatedRawMarket,
  };
}

function hasCompleteCryptoMeta(rawMarket: Record<string, unknown>): boolean {
  const cryptoMeta = parseCryptoMeta(rawMarket);
  return !!cryptoMeta && cryptoMeta.priceToBeat !== undefined && cryptoMeta.finalPrice !== undefined;
}

async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const currentIndex = index;
      index++;
      if (currentIndex >= items.length) return;
      await worker(items[currentIndex]!);
    }
  });

  await Promise.all(runners);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logLevelMap: Record<string, LogLevel> = {
    TRACE: LogLevel.TRACE,
    DEBUG: LogLevel.DEBUG,
    INFO: LogLevel.INFO,
    WARN: LogLevel.WARN,
    ERROR: LogLevel.ERROR,
    FATAL: LogLevel.FATAL,
  };
  const logLevel = logLevelMap[process.env['LOG_LEVEL'] ?? 'INFO'] ?? LogLevel.INFO;
  const logger = new ColorConsoleLogger(new LiveClock(), logLevel);
  const dnsOverride = new DnsOverride(logger);
  const options = parseCliArgs(process.argv.slice(2), {
    outputDir: path.resolve(process.cwd(), config.outputDir),
    sourceSubDir: config.sourceSubDir,
  });

  try {
    try {
      await dnsOverride.install([
        'gamma-api.polymarket.com',
        'clob.polymarket.com',
        'data-api.polymarket.com',
        'ws-subscriptions-clob.polymarket.com',
        'ws-live-data.polymarket.com',
      ]);
    } catch (error) {
      logger.warn('DNS override install failed, continuing with system DNS', {
        err: error instanceof Error ? error.message : String(error),
      });
    }

    const files = await listSnapshotFiles(options);
    logger.info('Snapshot file selection complete', {
      outputDir: options.outputDir,
      sourceSubDir: options.sourceSubDir,
      selectedFiles: files.length,
      fromDate: options.fromDate,
      toDate: options.toDate,
      dryRun: options.dryRun,
    });

    const candidates = await buildCandidates(files, options, logger);
    logger.info('Backfill candidate scan complete', {
      candidates: candidates.length,
      onlyIncomplete: options.onlyIncomplete,
      graceHours: options.graceHours,
    });

    const marketDataClient = new PolymarketMarketDataRestClient(
      { baseUrl: config.gammaApiBaseUrl },
      logger,
    );
    const rewriter = new ArchivedMarketMetaRewriter(logger);
    const results: BackfillResult = {
      checked: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      dryRunUpdates: 0,
    };

    await runWithConcurrency(candidates, options.concurrency, async (candidate) => {
      results.checked++;

      try {
        const updatedMarket = await marketDataClient.getMarketInfoById(candidate.gammaMarketId);
        const updatedRawMarket = updatedMarket as unknown as Record<string, unknown>;
        const updatedMeta = buildUpdatedMetaRecord(candidate.meta, updatedRawMarket);

        if (!hasCompleteCryptoMeta(updatedRawMarket)) {
          results.skipped++;
          logger.debug('Market still incomplete after refetch', {
            filePath: candidate.filePath,
            gammaMarketId: candidate.gammaMarketId,
          });
          return;
        }

        if (options.dryRun) {
          results.dryRunUpdates++;
          logger.info('Dry-run update candidate found', {
            filePath: candidate.filePath,
            gammaMarketId: candidate.gammaMarketId,
          });
          return;
        }

        await rewriter.rewrite(candidate.filePath, updatedMeta as unknown as Record<string, unknown>);
        results.updated++;
        logger.info('Snapshot meta backfilled', {
          filePath: candidate.filePath,
          gammaMarketId: candidate.gammaMarketId,
        });
      } catch (error) {
        results.failed++;
        logger.warn('Backfill failed for snapshot file', {
          filePath: candidate.filePath,
          gammaMarketId: candidate.gammaMarketId,
          conditionId: candidate.conditionId,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    });

    if (options.reportPath) {
      await fs.promises.mkdir(path.dirname(options.reportPath), { recursive: true });
      await fs.promises.writeFile(
        options.reportPath,
        JSON.stringify({
          generatedAt: new Date().toISOString(),
          options,
          results,
          candidates: candidates.map((candidate) => ({
            filePath: candidate.filePath,
            marketId: candidate.meta.marketId,
            gammaMarketId: candidate.gammaMarketId,
            slug: candidate.slug,
            question: candidate.meta.question,
          })),
        }, null, 2),
        'utf8',
      );
    }

    logger.info('Polymarket archive backfill finished', { ...results });
  } finally {
    dnsOverride.uninstall();
  }
}

await main();
