/**
 * Shadow-валидация LedgerService (Этап 7 плана миграции) на историческом корпусе.
 *
 * @remarks
 * `LedgerService.recordFill()` (запись) уже реально подключена в проде
 * (`ProcessFillUseCase`) — READ API (`getBalance`/`getAllBalances`/`replay`) до этого
 * этапа не имел ни одного вызывающего. Этот скрипт делает READ API реально
 * вызываемым: реплеит те же `*.journal.jsonl` fill-последовательности, что и
 * `shadow-validate-portfolio-service.ts` (Этап 3), через настоящий `LedgerService`,
 * и сверяет `ledger.getBalance()` с независимо посчитанным референсом.
 *
 * ### Почему здесь ожидается ТОЧНОЕ совпадение (не "экономическая правдоподобность")
 * `FillLedgerAdapter.toLedgerEntries()` (`@polymarket/ledger`) — детерминированная
 * линейная сумма: POSITION_DELTA = ±size, CASH_DELTA = ∓(price×size), без выбора лотов
 * и без averageEntryPrice-подобных производных величин. В отличие от Position
 * (Этап 3, где FIFO vs blended-pool расходятся ПО ДИЗАЙНУ на multi-price partial
 * close — см. `docs/architecture/position-accounting.md`), у Ledger нет структурной
 * причины для расхождения: `ledger.getBalance()` и независимо посчитанная сумма
 * вычисляют ОДНО И ТО ЖЕ, разным кодом. Поэтому здесь — точное совпадение
 * (в пределах EPSILON на Decimal-округление), а не bucketing на "ожидаемое/
 * неожиданное" расхождение.
 *
 * ### Известное упрощение: комиссия не учитывается
 * Тот же корпус и то же ограничение, что в `shadow-validate-portfolio-service.ts`:
 * journal не содержит отдельного поля комиссии — все синтетические `Fill` строятся
 * с `Fee.zero()`. Не точная финансовая реконструкция, а sanity-check структуры
 * ledger-проводки. Ручной прогон, не CI-гейт.
 *
 * @example
 * ```bash
 * cd apps/bot
 * npx tsx scripts/shadow-validate-ledger.ts
 * npx tsx scripts/shadow-validate-ledger.ts --journals data/journals-crowd-dev-tpsl --verbose
 * ```
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Decimal from 'decimal.js';
import { LedgerService } from '@polymarket/use-cases';
import { Price, Quantity, Fee } from '@polymarket/value-objects';
import { Timestamp } from '@polymarket/timestamp';
import { Fill } from '@polymarket/fill';
import {
  AssetIdHelpers,
  parseAccountId,
  asVenueId,
  asMarketId,
  asOrderId,
  asFillId,
  parseAssetId,
} from '@polymarket/ids';
import type { AccountId, VenueId } from '@polymarket/ids';
import type { ILogger } from '@polymarket/logger';

// ── journal record shapes (только поля, которые нужны скрипту) ────────────

interface FillRecord {
  readonly t: 'fill';
  readonly ts: number;
  readonly orderId: string;
  readonly side: 'BUY' | 'SELL';
  readonly price: string;
  readonly size: string;
}

interface MarketFills {
  readonly file: string;
  readonly marketQuestion?: string;
  readonly marketIdRaw: string;
  readonly instrumentIdRaw: string;
  readonly fills: readonly FillRecord[];
}

// ── CLI ─────────────────────────────────────────────────────────────────

interface Config {
  readonly journalDirs: readonly string[];
  readonly verbose: boolean;
}

const DEFAULT_JOURNAL_DIRS = [
  'data/journals-crowd-dev',
  'data/journals-crowd-dev-30',
  'data/journals-crowd-dev-tpsl',
];

function parseArgs(): Config {
  const args = process.argv.slice(2);
  let journalDirs: string[] = [];
  let verbose = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--journals' && next) {
      journalDirs = next.split(',').map((s) => s.trim()).filter(Boolean);
      i++;
    } else if (arg === '--verbose') {
      verbose = true;
    }
  }
  return { journalDirs: journalDirs.length > 0 ? journalDirs : DEFAULT_JOURNAL_DIRS, verbose };
}

// ── Сбор и парсинг journal-файлов (идентично shadow-validate-portfolio-service.ts) ─

function collectJournalFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
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

function loadMarketFills(file: string): MarketFills | undefined {
  const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
  let marketIdRaw: string | undefined;
  let instrumentIdRaw: string | undefined;
  let marketQuestion: string | undefined;
  const fills: FillRecord[] = [];

  for (const line of lines) {
    let record: { t?: string; [key: string]: unknown };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.t === 'session_start') {
      marketIdRaw = record.marketId as string;
      instrumentIdRaw = record.instrumentId as string;
      marketQuestion = record.marketQuestion as string | undefined;
    } else if (record.t === 'fill') {
      fills.push(record as unknown as FillRecord);
    }
  }

  if (!marketIdRaw || !instrumentIdRaw || fills.length === 0) return undefined;
  // journal — append log, но сортируем защитно (Array.sort стабилен в Node/V8).
  const sorted = [...fills].sort((a, b) => a.ts - b.ts);
  return { file, marketQuestion, marketIdRaw, instrumentIdRaw, fills: sorted };
}

// ── Независимый референс: линейная сумма (НЕ импорт FillLedgerAdapter) ─────

interface ReferenceState {
  readonly tokenBalance: Decimal;
  readonly usdcBalance: Decimal;
}

const EMPTY_REFERENCE: ReferenceState = { tokenBalance: new Decimal(0), usdcBalance: new Decimal(0) };

function applyReference(state: ReferenceState, side: 'BUY' | 'SELL', price: Decimal, size: Decimal): ReferenceState {
  const notional = price.times(size);
  return side === 'BUY'
    ? { tokenBalance: state.tokenBalance.plus(size), usdcBalance: state.usdcBalance.minus(notional) }
    : { tokenBalance: state.tokenBalance.minus(size), usdcBalance: state.usdcBalance.plus(notional) };
}

// ── Прогон одного market-файла ─────────────────────────────────────────────

interface FileReport {
  readonly file: string;
  readonly marketQuestion?: string;
  readonly buyCount: number;
  readonly sellCount: number;
  readonly tokenBalanceLedger: Decimal;
  readonly tokenBalanceReference: Decimal;
  readonly tokenBalanceMismatch: boolean;
  readonly usdcBalanceLedger: Decimal;
  readonly usdcBalanceReference: Decimal;
  readonly usdcBalanceMismatch: boolean;
  readonly errors: readonly string[];
}

const ACCOUNT_ID_RAW = 'wallet:0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead';
const VENUE_ID_RAW = 'POLYMARKET';
const EPSILON = new Decimal('1e-8');

function emptyReport(mf: MarketFills, errors: string[]): FileReport {
  return {
    file: mf.file,
    marketQuestion: mf.marketQuestion,
    buyCount: 0,
    sellCount: 0,
    tokenBalanceLedger: new Decimal(0),
    tokenBalanceReference: new Decimal(0),
    tokenBalanceMismatch: false,
    usdcBalanceLedger: new Decimal(0),
    usdcBalanceReference: new Decimal(0),
    usdcBalanceMismatch: false,
    errors,
  };
}

function makeSilentLogger(): ILogger {
  const noop = () => {};
  const logger = {
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => logger,
  } as unknown as ILogger;
  return logger;
}

function processFile(mf: MarketFills, accountId: AccountId, venueId: VenueId): FileReport {
  const errors: string[] = [];

  const tokenId = parseAssetId(mf.instrumentIdRaw);
  const marketId = asMarketId(mf.marketIdRaw);
  if (!tokenId || !marketId) {
    errors.push(`Cannot parse market/token IDs (marketId=${mf.marketIdRaw}, instrumentId=${mf.instrumentIdRaw})`);
    return emptyReport(mf, errors);
  }

  const service = new LedgerService(makeSilentLogger());

  let reference: ReferenceState = EMPTY_REFERENCE;
  let buyCount = 0;
  let sellCount = 0;

  for (let index = 0; index < mf.fills.length; index++) {
    const record = mf.fills[index];
    const price = new Decimal(record.price);
    const size = new Decimal(record.size);
    const orderId = asOrderId(record.orderId);
    const fillId = asFillId(`${record.orderId}_${record.ts}_${index}`);
    if (!orderId || !fillId) {
      errors.push(`Cannot parse orderId/fillId for fill #${index} (orderId=${record.orderId})`);
      break;
    }

    const fillResult = Fill.create({
      id: fillId,
      orderId,
      accountId,
      venueId,
      marketId,
      tokenId,
      settlementAssetId: AssetIdHelpers.USDC,
      price: Price.of(price),
      size: Quantity.of(size),
      side: record.side,
      timestamp: Timestamp.of(new Decimal(record.ts)),
      fee: Fee.zero(AssetIdHelpers.USDC),
    });
    if (!fillResult.ok) {
      errors.push(`Fill.create failed for fill #${index}: ${fillResult.error.message}`);
      break;
    }

    if (record.side === 'BUY') buyCount++; else sellCount++;
    reference = applyReference(reference, record.side, price, size);

    try {
      service.recordFill(fillResult.value);
    } catch (err) {
      errors.push(`recordFill threw for fill #${index}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  const tokenBalanceLedger = service.ledger.getBalance(accountId, tokenId);
  const usdcBalanceLedger = service.ledger.getBalance(accountId, AssetIdHelpers.USDC);

  return {
    file: mf.file,
    marketQuestion: mf.marketQuestion,
    buyCount,
    sellCount,
    tokenBalanceLedger,
    tokenBalanceReference: reference.tokenBalance,
    tokenBalanceMismatch: tokenBalanceLedger.minus(reference.tokenBalance).abs().greaterThan(EPSILON),
    usdcBalanceLedger,
    usdcBalanceReference: reference.usdcBalance,
    usdcBalanceMismatch: usdcBalanceLedger.minus(reference.usdcBalance).abs().greaterThan(EPSILON),
    errors,
  };
}

// ── main ────────────────────────────────────────────────────────────────

function requireAccountId(): AccountId {
  const id = parseAccountId(ACCOUNT_ID_RAW);
  if (!id) throw new Error(`Invalid synthetic AccountId: ${ACCOUNT_ID_RAW}`);
  return id;
}

function requireVenueId(): VenueId {
  const id = asVenueId(VENUE_ID_RAW);
  if (!id) throw new Error(`Invalid synthetic VenueId: ${VENUE_ID_RAW}`);
  return id;
}

function main(): void {
  const cfg = parseArgs();
  const accountId = requireAccountId();
  const venueId = requireVenueId();

  const scriptDir = new URL('.', import.meta.url).pathname;
  const botRoot = resolve(scriptDir, '..');
  const files = cfg.journalDirs.flatMap((dir) => collectJournalFiles(resolve(botRoot, dir)));

  console.log(`Shadow-валидация LedgerService — найдено ${files.length} journal-файлов в [${cfg.journalDirs.join(', ')}]`);

  let filesProcessed = 0;
  let filesSkipped = 0;
  let totalBuys = 0;
  let totalSells = 0;
  const tokenAnomalies: FileReport[] = [];
  const usdcAnomalies: FileReport[] = [];
  const executionErrorReports: FileReport[] = [];

  for (const file of files) {
    const mf = loadMarketFills(file);
    if (!mf) {
      filesSkipped++;
      continue;
    }
    const report = processFile(mf, accountId, venueId);
    filesProcessed++;
    totalBuys += report.buyCount;
    totalSells += report.sellCount;

    if (report.tokenBalanceMismatch) tokenAnomalies.push(report);
    if (report.usdcBalanceMismatch) usdcAnomalies.push(report);
    if (report.errors.length > 0) executionErrorReports.push(report);

    if (cfg.verbose) {
      console.log(`\n${file}`);
      if (report.marketQuestion) console.log(`  ${report.marketQuestion}`);
      console.log(`  buys=${report.buyCount} sells=${report.sellCount}`);
      console.log(`  token: ledger=${report.tokenBalanceLedger.toString()} reference=${report.tokenBalanceReference.toString()} mismatch=${report.tokenBalanceMismatch}`);
      console.log(`  usdc:  ledger=${report.usdcBalanceLedger.toString()} reference=${report.usdcBalanceReference.toString()} mismatch=${report.usdcBalanceMismatch}`);
      if (report.errors.length > 0) console.log(`  ERRORS: ${report.errors.join(' | ')}`);
    }
  }

  console.log('\n=== Итог ===');
  console.log(`Файлов с fill-ами: ${filesProcessed} (пропущено без session_start/fill: ${filesSkipped})`);
  console.log(`Всего fill: ${totalBuys + totalSells} (BUY=${totalBuys}, SELL=${totalSells})`);

  console.log('\ntoken-баланс АНОМАЛИИ (ledger vs независимая сумма, обязаны совпадать точно):', tokenAnomalies.length);
  for (const r of tokenAnomalies) console.log(`  ${r.file}: ledger=${r.tokenBalanceLedger} reference=${r.tokenBalanceReference}`);

  console.log('USDC-баланс АНОМАЛИИ (ledger vs независимая сумма, обязаны совпадать точно):', usdcAnomalies.length);
  for (const r of usdcAnomalies) console.log(`  ${r.file}: ledger=${r.usdcBalanceLedger} reference=${r.usdcBalanceReference}`);

  console.log('Файлов с ошибками выполнения (parse/recordFill Err):', executionErrorReports.length);
  for (const r of executionErrorReports.slice(0, 20)) {
    console.log(`  ${r.file}:`);
    for (const e of r.errors) console.log(`    ${e}`);
  }

  const hardAnomalyCount = tokenAnomalies.length + usdcAnomalies.length + executionErrorReports.length;
  console.log('');
  console.log(
    hardAnomalyCount === 0
      ? 'OK: аномалий не найдено.'
      : `НАЙДЕНЫ АНОМАЛИИ: ${hardAnomalyCount} (см. подробности выше) — требуется разбор.`,
  );

  process.exitCode = hardAnomalyCount === 0 ? 0 : 1;
}

main();
