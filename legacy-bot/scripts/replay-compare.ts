#!/usr/bin/env tsx
/**
 * Replay Compare — сверка live/paper журнала решений с бектестом на тех же данных.
 *
 * @remarks
 * Читает .journal.jsonl, находит соответствующий .jsonl.gz с рыночными данными,
 * прогоняет бектест с тем же конфигом стратегии и сравнивает fills.
 *
 * ### Использование:
 * ```bash
 * npx tsx scripts/replay-compare.ts ./data/journals/2026-04-02/Bitcoin_Up___0xabc.journal.jsonl
 * ```
 *
 * ### Или сравнить все журналы за дату:
 * ```bash
 * npx tsx scripts/replay-compare.ts ./data/journals/2026-04-02/
 * ```
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ── Типы записей журнала ─────────────────────────────────────────────────────

interface JournalRecord {
  t: string;
  ts: number;
  marketId?: string;
  [key: string]: unknown;
}

interface SessionStartRecord extends JournalRecord {
  t: 'session_start';
  mode: string;
  strategyType: string;
  strategyConfig: Record<string, unknown>;
  marketQuestion: string;
  instrumentId: string;
  expiresAtMs: number;
  eventStartMs?: number;
}

interface DecisionRecord extends JournalRecord {
  t: 'decision';
  action: string;
  state: Record<string, unknown>;
  bidPrice?: number;
  orderSize?: string;
  effectiveSide?: string;
  rejectReason?: string;
}

interface FillRecord extends JournalRecord {
  t: 'fill';
  orderId: string;
  side: string;
  price: string;
  size: string;
  notional: string;
}

interface ResolutionRecord extends JournalRecord {
  t: 'resolution';
  resolution: string;
  pnl: string;
}

// ── Парсинг журнала ──────────────────────────────────────────────────────────

interface JournalData {
  session: SessionStartRecord | null;
  decisions: DecisionRecord[];
  fills: FillRecord[];
  resolution: ResolutionRecord | null;
}

async function parseJournal(journalPath: string): Promise<JournalData> {
  const result: JournalData = { session: null, decisions: [], fills: [], resolution: null };
  const rl = readline.createInterface({ input: fs.createReadStream(journalPath) });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as JournalRecord;
      switch (record.t) {
        case 'session_start': result.session = record as SessionStartRecord; break;
        case 'decision': result.decisions.push(record as DecisionRecord); break;
        case 'fill': result.fills.push(record as FillRecord); break;
        case 'resolution': result.resolution = record as ResolutionRecord; break;
      }
    } catch { /* skip malformed lines */ }
  }

  return result;
}

// ── Поиск market data файла ──────────────────────────────────────────────────

function findMarketDataFile(journalPath: string, recordingsDir: string): string | null {
  // journal: journals/2026-04-02/Bitcoin_Up___0xabc.journal.jsonl
  // data:    recordings/2026-04-02/Bitcoin_Up___0xabc.jsonl.gz
  const basename = path.basename(journalPath).replace('.journal.jsonl', '');
  const dateDir = path.basename(path.dirname(journalPath));

  // Ищем в recordings dir с той же датой
  const candidates = [
    path.join(recordingsDir, dateDir, `${basename}.jsonl.gz`),
    path.join(recordingsDir, dateDir, `${basename}.jsonl`),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Fallback: ищем по префиксу (имя файла может немного отличаться)
  const datePath = path.join(recordingsDir, dateDir);
  if (fs.existsSync(datePath)) {
    const files = fs.readdirSync(datePath);
    const prefix = basename.slice(0, 30);
    const match = files.find(f => f.startsWith(prefix) && (f.endsWith('.jsonl.gz') || f.endsWith('.jsonl')));
    if (match) return path.join(datePath, match);
  }

  return null;
}

// ── Сравнение ────────────────────────────────────────────────────────────────

interface ComparisonResult {
  journalPath: string;
  marketQuestion: string;
  mode: string;
  strategyType: string;

  // Решения
  liveDecision: string;    // BUY / BUY_COMP / SKIP / NO_ENTRY
  liveBidPrice: number | null;
  liveSide: string | null;

  // Fills
  liveFills: number;
  liveFillPrice: string | null;

  // Resolution
  resolution: string;
  livePnl: string;

  // Backtest данные (если найден market data файл)
  backtestAvailable: boolean;
  backtestDataFile: string | null;

  // Diagnostics
  totalDiagnostics: number;
  lastState: Record<string, unknown> | null;
}

function analyzeJournal(journalPath: string, recordingsDir: string): ComparisonResult {
  // Синхронно парсим (для простоты CLI)
  const content = fs.readFileSync(journalPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  let session: SessionStartRecord | null = null;
  const decisions: DecisionRecord[] = [];
  const fills: FillRecord[] = [];
  let resolution: ResolutionRecord | null = null;

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as JournalRecord;
      switch (record.t) {
        case 'session_start': session = record as SessionStartRecord; break;
        case 'decision': decisions.push(record as DecisionRecord); break;
        case 'fill': fills.push(record as FillRecord); break;
        case 'resolution': resolution = record as ResolutionRecord; break;
      }
    } catch { /* skip */ }
  }

  // Находим ключевое решение (BUY/BUY_COMP/SKIP, не HOLD)
  const keyDecision = decisions.find(d => d.action !== 'HOLD');

  const dataFile = findMarketDataFile(journalPath, recordingsDir);

  return {
    journalPath,
    marketQuestion: session?.marketQuestion ?? '?',
    mode: session?.mode ?? '?',
    strategyType: session?.strategyType ?? '?',
    liveDecision: keyDecision?.action ?? 'NO_ENTRY',
    liveBidPrice: keyDecision?.bidPrice ?? null,
    liveSide: keyDecision?.effectiveSide ?? null,
    liveFills: fills.length,
    liveFillPrice: fills[0]?.price ?? null,
    resolution: resolution?.resolution ?? 'UNKNOWN',
    livePnl: resolution?.pnl ?? '0',
    backtestAvailable: dataFile !== null,
    backtestDataFile: dataFile,
    totalDiagnostics: decisions.filter(d => d.action === 'HOLD').length,
    lastState: decisions.length > 0 ? decisions[decisions.length - 1]!.state : null,
  };
}

// ── Форматирование отчёта ────────────────────────────────────────────────────

function formatReport(results: ComparisonResult[]): void {
  console.log('\n=== REPLAY COMPARISON REPORT ===\n');

  let totalFills = 0;
  let totalPnl = 0;
  let withData = 0;
  let withoutData = 0;

  for (const r of results) {
    const shortQuestion = r.marketQuestion.slice(0, 60);
    const pnl = parseFloat(r.livePnl) || 0;
    totalPnl += pnl;
    totalFills += r.liveFills;

    if (r.backtestAvailable) withData++; else withoutData++;

    const pnlStr = pnl >= 0 ? `+${pnl.toFixed(4)}` : pnl.toFixed(4);
    const decisionStr = r.liveDecision === 'NO_ENTRY' ? 'NO_ENTRY'
      : `${r.liveDecision} @ ${r.liveBidPrice}¢ (${r.liveSide})`;
    const fillStr = r.liveFills > 0 ? `${r.liveFills} fill @ ${r.liveFillPrice}` : 'no fill';
    const resStr = r.resolution;
    const dataStr = r.backtestAvailable ? 'DATA_OK' : 'NO_DATA';

    console.log(`  ${shortQuestion}`);
    console.log(`    Decision: ${decisionStr} | ${fillStr} | ${resStr} | PnL: ${pnlStr} | ${dataStr}`);
    console.log(`    Diagnostics: ${r.totalDiagnostics} ticks`);
    if (r.backtestAvailable) {
      console.log(`    Backtest data: ${r.backtestDataFile}`);
    }
    console.log('');
  }

  // Summary
  console.log('=== SUMMARY ===');
  console.log(`  Markets:     ${results.length}`);
  console.log(`  Fills:       ${totalFills}`);
  console.log(`  Total PnL:   ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} USDC`);
  console.log(`  With data:   ${withData} (can replay)`);
  console.log(`  Without data: ${withoutData} (journal only)`);

  const entries = results.filter(r => r.liveDecision !== 'NO_ENTRY');
  const filled = results.filter(r => r.liveFills > 0);
  const wins = results.filter(r => (parseFloat(r.livePnl) || 0) > 0);
  const losses = results.filter(r => (parseFloat(r.livePnl) || 0) < 0);
  console.log(`  Entries:     ${entries.length} (${filled.length} filled)`);
  console.log(`  W/L:         ${wins.length}/${losses.length}`);
  if (wins.length + losses.length > 0) {
    console.log(`  WR:          ${(100 * wins.length / (wins.length + losses.length)).toFixed(1)}%`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: npx tsx scripts/replay-compare.ts <journal-file-or-dir> [recordings-dir]');
    console.error('  journal-file-or-dir: path to .journal.jsonl file or directory with journals');
    console.error('  recordings-dir:     path to recordings directory (default: ./data/recordings)');
    process.exit(1);
  }

  const recordingsDir = process.argv[3] ?? './data/recordings';
  let journalFiles: string[] = [];

  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    // Все .journal.jsonl файлы в директории
    const files = fs.readdirSync(input).filter(f => f.endsWith('.journal.jsonl'));
    journalFiles = files.map(f => path.join(input, f));
  } else if (input.endsWith('.journal.jsonl')) {
    journalFiles = [input];
  } else {
    console.error(`Error: ${input} is not a .journal.jsonl file or directory`);
    process.exit(1);
  }

  if (journalFiles.length === 0) {
    console.error('No journal files found');
    process.exit(1);
  }

  console.log(`Found ${journalFiles.length} journal file(s)`);

  const results = journalFiles.map(f => analyzeJournal(f, recordingsDir));
  formatReport(results);
}

main();
