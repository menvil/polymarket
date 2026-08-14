/**
 * Shadow-валидация PortfolioService (Этап 3 плана миграции) на историческом корпусе.
 *
 * @remarks
 * Прогоняет реальные последовательности fill'ов из `*.journal.jsonl` (paper/live
 * crowd-стратегии) через настоящий `PortfolioService` (lot-based `Position`, FIFO close)
 * и параллельно — через независимый blended-pool расчёт (тот же алгоритм, что был у
 * `SimplePosition` до Этапа 3, реализованный здесь заново, а не импортом старого
 * класса — сравнение должно быть независимым, а не "код сравнивает себя с собой").
 *
 * Для каждого market-файла (один journal = одна пара BUY/SELL по одному инструменту)
 * проверяются три инварианта из `docs/architecture/position-accounting.md`:
 * - **quantity** — обязано совпадать точно всегда. Комиссия здесь всегда 0 (см. ниже),
 *   поэтому расхождение — это структурный баг проводки BUY/SELL, а не ожидаемое поведение.
 * - **averageEntryPrice** — точное совпадение только пока ВСЕ BUY в файле были по одной
 *   цене (`uniformBuyPrice`). При нескольких ценах входа + partial close расхождение
 *   FIFO vs blended-pool ОЖИДАЕМО и не репортится как аномалия.
 * - **realizedPnL** (из lot-based FIFO close, захватывается перехватом лог-сообщения
 *   `'Position lots closed (FIFO) — realized PnL'`, которое `PortfolioService` пишет
 *   при каждом close — публичная сигнатура `applyFill` не расширялась) — структурная
 *   граница `|realizedPnL| <= fillQty` (цена всегда строго в (0,1), значит абсолютная
 *   разница цен меньше 1) плюс sanity-сумма против blended-pool референса.
 *
 * ### Известное упрощение: комиссия не учитывается
 * `fill`-записи в journal не содержат отдельного поля комиссии (только цена/размер/
 * notional по цене исполнения) — реальная on-chain комиссия здесь недоступна. Все
 * синтетические `Fill` строятся с `Fee.zero()`. Это НЕ точная финансовая реконструкция —
 * это sanity-check структуры/знака/порядка величины позиционного учёта. Ручной прогон,
 * не CI-гейт (план, Этап 3, п. 3е).
 *
 * @example
 * ```bash
 * cd apps/bot
 * npx tsx scripts/shadow-validate-portfolio-service.ts
 * npx tsx scripts/shadow-validate-portfolio-service.ts --journals data/journals-crowd-dev-tpsl --verbose
 * ```
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Decimal from 'decimal.js';
import { PortfolioService } from '@polymarket/use-cases';
import { InMemoryPortfolioStore } from '@polymarket/in-memory';
import { Portfolio, asPortfolioId } from '@polymarket/portfolio';
import { Balance } from '@polymarket/value-objects/balance';
import { Money, Price, Quantity, Fee } from '@polymarket/value-objects';
import { Timestamp } from '@polymarket/timestamp';
import { Fill } from '@polymarket/fill';
import {
  AssetIdHelpers,
  parseAccountId,
  asVenueId,
  asMarketId,
  asOrderId,
  asFillId,
  assetIdToInstrumentId,
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

// ── Сбор и парсинг journal-файлов ──────────────────────────────────────────

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

// ── Blended-pool референс (независимая реализация — НЕ импорт SimplePosition) ─

interface BlendedState {
  readonly qty: Decimal;
  readonly avgPrice: Decimal;
}

const EMPTY_BLENDED: BlendedState = { qty: new Decimal(0), avgPrice: new Decimal(0) };

function blendedBuy(state: BlendedState, price: Decimal, size: Decimal): BlendedState {
  const newQty = state.qty.plus(size);
  const newAvg = state.qty.isZero()
    ? price
    : state.qty.times(state.avgPrice).plus(size.times(price)).div(newQty);
  return { qty: newQty, avgPrice: newAvg };
}

function blendedSell(
  state: BlendedState,
  price: Decimal,
  size: Decimal,
): { state: BlendedState; referencePnL: Decimal } {
  const referencePnL = price.minus(state.avgPrice).times(size);
  return { state: { qty: state.qty.minus(size), avgPrice: state.avgPrice }, referencePnL };
}

// ── Логгер, перехватывающий realized-PnL сообщение PortfolioService ────────

interface RealizedPnLLogEntry {
  readonly realizedPnL: Decimal;
  readonly closedLotsCount: number;
}

function makeCapturingLogger(sink: RealizedPnLLogEntry[]): ILogger {
  const noop = () => {};
  const logger = {
    trace: noop,
    debug: noop,
    info: (message: string, context?: Record<string, unknown>) => {
      if (message === 'Position lots closed (FIFO) — realized PnL' && context) {
        sink.push({
          realizedPnL: new Decimal(String(context.realizedPnL)),
          closedLotsCount: Number(context.closedLotsCount),
        });
      }
    },
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  } as unknown as ILogger;
  return logger;
}

// ── Прогон одного market-файла ─────────────────────────────────────────────

interface FileReport {
  readonly file: string;
  readonly marketQuestion?: string;
  readonly buyCount: number;
  readonly sellCount: number;
  readonly uniformBuyPrice: boolean;
  readonly finalQtyReal: Decimal;
  readonly finalQtyBlended: Decimal;
  readonly quantityMismatch: boolean;
  readonly finalAvgReal: Decimal | undefined;
  readonly finalAvgBlended: Decimal | undefined;
  readonly avgPriceUnexpectedMismatch: boolean;
  readonly avgPriceExpectedDivergence: boolean;
  readonly realizedPnLEntries: readonly RealizedPnLLogEntry[];
  readonly referencePnLSum: Decimal;
  readonly pnlBoundViolations: number;
  readonly errors: readonly string[];
}

const ACCOUNT_ID_RAW = 'wallet:0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead';
const VENUE_ID_RAW = 'POLYMARKET';
const INITIAL_BALANCE = new Decimal(1_000_000);
const EPSILON = new Decimal('1e-8');

function emptyReport(mf: MarketFills, errors: string[]): FileReport {
  return {
    file: mf.file,
    marketQuestion: mf.marketQuestion,
    buyCount: 0,
    sellCount: 0,
    uniformBuyPrice: true,
    finalQtyReal: new Decimal(0),
    finalQtyBlended: new Decimal(0),
    quantityMismatch: false,
    finalAvgReal: undefined,
    finalAvgBlended: undefined,
    avgPriceUnexpectedMismatch: false,
    avgPriceExpectedDivergence: false,
    realizedPnLEntries: [],
    referencePnLSum: new Decimal(0),
    pnlBoundViolations: 0,
    errors,
  };
}

function processFile(mf: MarketFills, accountId: AccountId, venueId: VenueId): FileReport {
  const errors: string[] = [];

  const tokenId = parseAssetId(mf.instrumentIdRaw);
  const marketId = asMarketId(mf.marketIdRaw);
  const instrumentId = tokenId ? assetIdToInstrumentId(tokenId) : undefined;
  if (!tokenId || !marketId || !instrumentId) {
    errors.push(`Cannot parse market/token IDs (marketId=${mf.marketIdRaw}, instrumentId=${mf.instrumentIdRaw})`);
    return emptyReport(mf, errors);
  }

  const balance = Balance.withZeroReserved(Money.of(INITIAL_BALANCE, 'USDC'), accountId, venueId);
  const portfolioResult = Portfolio.create({
    id: asPortfolioId(`shadow_${mf.file}`),
    accountId,
    balance,
  });
  if (!portfolioResult.ok) {
    errors.push(`Portfolio.create failed: ${portfolioResult.error.message}`);
    return emptyReport(mf, errors);
  }

  const store = new InMemoryPortfolioStore();
  store.save(portfolioResult.value, 0);

  const pnlLog: RealizedPnLLogEntry[] = [];
  const service = new PortfolioService(store, makeCapturingLogger(pnlLog));

  let blended: BlendedState = EMPTY_BLENDED;
  let buyCount = 0;
  let sellCount = 0;
  let referencePnLSum = new Decimal(0);
  let pnlBoundViolations = 0;
  const buyPrices = new Set<string>();

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

    if (record.side === 'BUY') {
      buyCount++;
      buyPrices.add(price.toString());
      const reserveResult = service.reserveForOrder(accountId, Money.of(price.times(size), 'USDC'));
      if (!reserveResult.ok) {
        errors.push(`reserveForOrder failed for fill #${index}: ${reserveResult.error.message}`);
        break;
      }
      blended = blendedBuy(blended, price, size);
    } else {
      sellCount++;
      const reserveResult = service.reserveTokensForOrder(accountId, instrumentId, Quantity.of(size));
      if (!reserveResult.ok) {
        errors.push(`reserveTokensForOrder failed for fill #${index}: ${reserveResult.error.message}`);
        break;
      }
      const sellResult = blendedSell(blended, price, size);
      blended = sellResult.state;
      referencePnLSum = referencePnLSum.plus(sellResult.referencePnL);
    }

    const pnlCountBefore = pnlLog.length;
    const applyResult = service.applyFill(fillResult.value);
    if (!applyResult.ok) {
      errors.push(
        `applyFill failed for fill #${index} (${record.side} ${record.price}@${record.size}): ${applyResult.error.message}`,
      );
      break;
    }
    if (record.side === 'SELL' && pnlLog.length > pnlCountBefore) {
      const last = pnlLog[pnlLog.length - 1];
      // Структурная граница: цена всегда строго в (0,1) ⇒ |exitPrice - entryPrice| < 1 ⇒ |pnl| < fillQty.
      if (last.realizedPnL.abs().greaterThan(size)) {
        pnlBoundViolations++;
      }
    }
  }

  const finalPortfolio = store.get(accountId);
  const finalPosition = finalPortfolio?.getPosition(instrumentId);
  const finalQtyReal = finalPosition?.quantity.value() ?? new Decimal(0);
  const finalAvgReal = finalPosition ? finalPosition.averageEntryPrice.value() : undefined;

  const finalQtyBlended = blended.qty;
  const finalAvgBlended = blended.qty.greaterThan(0) ? blended.avgPrice : undefined;

  const quantityMismatch = finalQtyReal.minus(finalQtyBlended).abs().greaterThan(EPSILON);
  const uniformBuyPrice = buyPrices.size <= 1;

  let avgPriceUnexpectedMismatch = false;
  let avgPriceExpectedDivergence = false;
  if (finalAvgReal !== undefined && finalAvgBlended !== undefined) {
    const diverged = finalAvgReal.minus(finalAvgBlended).abs().greaterThan(EPSILON);
    if (diverged) {
      if (uniformBuyPrice) {
        avgPriceUnexpectedMismatch = true;
      } else {
        avgPriceExpectedDivergence = true;
      }
    }
  }

  return {
    file: mf.file,
    marketQuestion: mf.marketQuestion,
    buyCount,
    sellCount,
    uniformBuyPrice,
    finalQtyReal,
    finalQtyBlended,
    quantityMismatch,
    finalAvgReal,
    finalAvgBlended,
    avgPriceUnexpectedMismatch,
    avgPriceExpectedDivergence,
    realizedPnLEntries: pnlLog,
    referencePnLSum,
    pnlBoundViolations,
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

  console.log(`Shadow-валидация PortfolioService — найдено ${files.length} journal-файлов в [${cfg.journalDirs.join(', ')}]`);

  let filesProcessed = 0;
  let filesSkipped = 0;
  let totalBuys = 0;
  let totalSells = 0;
  let realizedPnLCount = 0;
  let realizedPnLSum = new Decimal(0);
  let referencePnLSum = new Decimal(0);
  let avgPriceExpectedDivergences = 0;
  const quantityAnomalies: FileReport[] = [];
  const avgPriceAnomalies: FileReport[] = [];
  const pnlBoundViolationReports: FileReport[] = [];
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
    referencePnLSum = referencePnLSum.plus(report.referencePnLSum);
    for (const entry of report.realizedPnLEntries) {
      realizedPnLCount++;
      realizedPnLSum = realizedPnLSum.plus(entry.realizedPnL);
    }

    if (report.quantityMismatch) quantityAnomalies.push(report);
    if (report.avgPriceUnexpectedMismatch) avgPriceAnomalies.push(report);
    if (report.avgPriceExpectedDivergence) avgPriceExpectedDivergences++;
    if (report.pnlBoundViolations > 0) pnlBoundViolationReports.push(report);
    if (report.errors.length > 0) executionErrorReports.push(report);

    if (cfg.verbose) {
      console.log(`\n${file}`);
      if (report.marketQuestion) console.log(`  ${report.marketQuestion}`);
      console.log(`  buys=${report.buyCount} sells=${report.sellCount} uniformBuyPrice=${report.uniformBuyPrice}`);
      console.log(`  qty: real=${report.finalQtyReal.toString()} blended=${report.finalQtyBlended.toString()} mismatch=${report.quantityMismatch}`);
      console.log(
        `  avgPrice: real=${report.finalAvgReal?.toString() ?? 'n/a'} blended=${report.finalAvgBlended?.toString() ?? 'n/a'} `
        + `unexpectedMismatch=${report.avgPriceUnexpectedMismatch} expectedDivergence=${report.avgPriceExpectedDivergence}`,
      );
      if (report.realizedPnLEntries.length > 0) {
        console.log(
          `  realizedPnL: [${report.realizedPnLEntries.map((e) => e.realizedPnL.toString()).join(', ')}] `
          + `(референс-сумма blended=${report.referencePnLSum.toString()})`,
        );
      }
      if (report.errors.length > 0) console.log(`  ERRORS: ${report.errors.join(' | ')}`);
    }
  }

  console.log('\n=== Итог ===');
  console.log(`Файлов с fill-ами: ${filesProcessed} (пропущено без session_start/fill: ${filesSkipped})`);
  console.log(`Всего fill: ${totalBuys + totalSells} (BUY=${totalBuys}, SELL=${totalSells})`);
  console.log(
    `realizedPnL: ${realizedPnLCount} close-событий, сумма=${realizedPnLSum.toFixed(4)} `
    + `(blended-референс сумма=${referencePnLSum.toFixed(4)})`,
  );
  console.log(`averageEntryPrice: ожидаемых расхождений (multi-price partial close) = ${avgPriceExpectedDivergences}`);

  console.log('\nquantity-АНОМАЛИИ (обязаны совпадать всегда):', quantityAnomalies.length);
  for (const r of quantityAnomalies) console.log(`  ${r.file}: real=${r.finalQtyReal} blended=${r.finalQtyBlended}`);

  console.log('averageEntryPrice-АНОМАЛИИ (single-price BUY, но всё равно разошлось):', avgPriceAnomalies.length);
  for (const r of avgPriceAnomalies) console.log(`  ${r.file}: real=${r.finalAvgReal} blended=${r.finalAvgBlended}`);

  console.log('realizedPnL bound-нарушения (|pnl| > fillQty — структурно невозможно):', pnlBoundViolationReports.length);
  for (const r of pnlBoundViolationReports) console.log(`  ${r.file}`);

  console.log('Файлов с ошибками выполнения (parse/reserve/applyFill Err):', executionErrorReports.length);
  for (const r of executionErrorReports.slice(0, 20)) {
    console.log(`  ${r.file}:`);
    for (const e of r.errors) console.log(`    ${e}`);
  }

  const hardAnomalyCount = quantityAnomalies.length + avgPriceAnomalies.length
    + pnlBoundViolationReports.length + executionErrorReports.length;
  console.log('');
  console.log(
    hardAnomalyCount === 0
      ? 'OK: аномалий не найдено.'
      : `НАЙДЕНЫ АНОМАЛИИ: ${hardAnomalyCount} (см. подробности выше) — требуется разбор.`,
  );

  process.exitCode = hardAnomalyCount === 0 ? 0 : 1;
}

main();
