#!/usr/bin/env tsx
/**
 * Compare Paper vs Live — сравнение paper и live журналов за одну сессию.
 *
 * @remarks
 * Находит одинаковые рынки по marketQuestion, сравнивает:
 * - Решения (BUY/SKIP совпадают?)
 * - Fill quality (price, latency, fill rate)
 * - PnL (paper vs live)
 *
 * @example
 * ```bash
 * npx tsx scripts/compare-paper-live.ts data/journals/2026-04-02/ data/live-journals/2026-04-02/
 * ```
 */
import * as fs from 'fs';
import * as path from 'path';

// ── Типы ─────────────────────────────────────────────────────────────────────

interface JournalRecord { t: string; ts: number; [key: string]: unknown }

interface MarketSummary {
  question: string;
  decision: string;       // BUY@67 или NO_ENTRY
  orderPrice: string | null;
  orderTs: number | null;
  fillPrice: string | null;
  fillTs: number | null;
  fillLatencyMs: number | null;
  slippage: number | null; // fill price - order price (cents)
  resolution: string;
  pnl: string;
  diagnosticCount: number;
}

// ── Парсинг ──────────────────────────────────────────────────────────────────

function parseJournalFile(filePath: string): MarketSummary {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  let question = '?';
  let decision = 'NO_ENTRY';
  let orderPrice: string | null = null;
  let orderTs: number | null = null;
  let fillPrice: string | null = null;
  let fillTs: number | null = null;
  let resolution = 'UNKNOWN';
  let pnl = '0';
  let diagnosticCount = 0;

  for (const line of lines) {
    try {
      const r = JSON.parse(line) as JournalRecord;
      switch (r.t) {
        case 'session_start':
          question = (r['marketQuestion'] as string) ?? '?';
          break;
        case 'decision': {
          const action = r['action'] as string;
          if (action === 'HOLD') {
            diagnosticCount++;
          } else if (action === 'BUY' || action === 'BUY_COMP') {
            decision = `${action}@${r['bidPrice'] ?? '?'}`;
          }
          break;
        }
        case 'order':
          orderPrice = r['price'] as string;
          orderTs = r['ts'] as number;
          break;
        case 'fill':
          fillPrice = r['price'] as string;
          fillTs = r['ts'] as number;
          break;
        case 'resolution':
          resolution = r['resolution'] as string;
          pnl = r['pnl'] as string;
          break;
      }
    } catch { /* skip */ }
  }

  const fillLatencyMs = (fillTs && orderTs) ? fillTs - orderTs : null;
  const slippage = (fillPrice && orderPrice)
    ? Math.round((parseFloat(fillPrice) - parseFloat(orderPrice)) * 10000) / 100
    : null;

  return { question, decision, orderPrice, orderTs, fillPrice, fillTs, fillLatencyMs, slippage, resolution, pnl, diagnosticCount };
}

// ── Matching ─────────────────────────────────────────────────────────────────

function extractMarketKey(question: string): string {
  // "Bitcoin Up or Down - April 2, 1:05PM-1:10PM ET" → "1:05PM-1:10PM"
  const match = question.match(/(\d+:\d+[AP]M-\d+:\d+[AP]M)/);
  return match ? match[1]! : question;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const paperDir = process.argv[2];
  const liveDir = process.argv[3];

  if (!paperDir || !liveDir) {
    console.error('Usage: npx tsx scripts/compare-paper-live.ts <paper-journals-dir> <live-journals-dir>');
    process.exit(1);
  }

  // Parse all journals
  const parseDir = (dir: string): Map<string, MarketSummary> => {
    const map = new Map<string, MarketSummary>();
    if (!fs.existsSync(dir)) return map;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.journal.jsonl'));
    for (const f of files) {
      const summary = parseJournalFile(path.join(dir, f));
      const key = extractMarketKey(summary.question);
      map.set(key, summary);
    }
    return map;
  };

  const paperMarkets = parseDir(paperDir);
  const liveMarkets = parseDir(liveDir);

  // Find common markets
  const allKeys = new Set([...paperMarkets.keys(), ...liveMarkets.keys()]);
  const sortedKeys = [...allKeys].sort();

  console.log(`\n=== PAPER vs LIVE COMPARISON ===`);
  console.log(`Paper: ${paperMarkets.size} markets | Live: ${liveMarkets.size} markets | Common: ${sortedKeys.filter(k => paperMarkets.has(k) && liveMarkets.has(k)).length}\n`);

  let matchCount = 0;
  let divergeCount = 0;
  let paperOnlyCount = 0;
  let liveOnlyCount = 0;
  let paperTotalPnl = 0;
  let liveTotalPnl = 0;
  let totalSlippage = 0;
  let slippageCount = 0;
  let totalLatency = 0;
  let latencyCount = 0;
  let paperFills = 0;
  let liveFills = 0;
  let paperEntries = 0;
  let liveEntries = 0;

  for (const key of sortedKeys) {
    const p = paperMarkets.get(key);
    const l = liveMarkets.get(key);

    if (!p && !l) continue;

    if (p && !l) {
      paperOnlyCount++;
      console.log(`  ${key}: PAPER_ONLY ${p.decision} → ${p.resolution} pnl=${p.pnl}`);
      paperTotalPnl += parseFloat(p.pnl) || 0;
      if (p.decision !== 'NO_ENTRY') paperEntries++;
      if (p.fillPrice) paperFills++;
      continue;
    }

    if (!p && l) {
      liveOnlyCount++;
      console.log(`  ${key}: LIVE_ONLY ${l.decision} → ${l.resolution} pnl=${l.pnl}`);
      liveTotalPnl += parseFloat(l.pnl) || 0;
      if (l.decision !== 'NO_ENTRY') liveEntries++;
      if (l.fillPrice) liveFills++;
      continue;
    }

    // Both exist
    const pp = p!;
    const ll = l!;
    paperTotalPnl += parseFloat(pp.pnl) || 0;
    liveTotalPnl += parseFloat(ll.pnl) || 0;
    if (pp.decision !== 'NO_ENTRY') paperEntries++;
    if (ll.decision !== 'NO_ENTRY') liveEntries++;
    if (pp.fillPrice) paperFills++;
    if (ll.fillPrice) liveFills++;

    const decisionMatch = pp.decision === ll.decision;
    const bothNoEntry = pp.decision === 'NO_ENTRY' && ll.decision === 'NO_ENTRY';

    if (bothNoEntry) {
      matchCount++;
      // Don't print no-entry matches (too noisy)
      continue;
    }

    const pPnl = (parseFloat(pp.pnl) || 0).toFixed(2);
    const lPnl = (parseFloat(ll.pnl) || 0).toFixed(2);
    const pnlDiff = ((parseFloat(ll.pnl) || 0) - (parseFloat(pp.pnl) || 0)).toFixed(2);

    if (decisionMatch) {
      matchCount++;
      // Fill comparison
      const pFill = pp.fillPrice ? `fill@${pp.fillPrice}/${pp.fillLatencyMs ?? 0}ms` : 'NO_FILL';
      const lFill = ll.fillPrice ? `fill@${ll.fillPrice}/${ll.fillLatencyMs ?? '?'}ms` : 'NO_FILL';

      if (ll.slippage !== null) { totalSlippage += ll.slippage; slippageCount++; }
      if (ll.fillLatencyMs !== null) { totalLatency += ll.fillLatencyMs; latencyCount++; }

      const fillMatch = pp.fillPrice === ll.fillPrice ? '✓' : (ll.fillPrice ? 'SLIP' : 'NO_FILL');
      console.log(`  ${key}: ${pp.decision} MATCH | paper=${pFill} live=${lFill} [${fillMatch}] | ${pp.resolution} paper=${pPnl} live=${lPnl} Δ=${pnlDiff}`);
    } else {
      divergeCount++;
      console.log(`  ${key}: DIVERGE | paper=${pp.decision} live=${ll.decision} | ${pp.resolution}/${ll.resolution} paper=${pPnl} live=${lPnl} Δ=${pnlDiff}`);
    }
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log(`  Markets compared: ${sortedKeys.length}`);
  console.log(`  Decision match:   ${matchCount}/${matchCount + divergeCount} (${matchCount + divergeCount > 0 ? (100 * matchCount / (matchCount + divergeCount)).toFixed(0) : 0}%)`);
  console.log(`  Divergences:      ${divergeCount}`);
  console.log(`  Paper-only:       ${paperOnlyCount}`);
  console.log(`  Live-only:        ${liveOnlyCount}`);
  console.log('');
  console.log(`  Paper: ${paperEntries} entries, ${paperFills} fills, PnL=${paperTotalPnl >= 0 ? '+' : ''}${paperTotalPnl.toFixed(2)}`);
  console.log(`  Live:  ${liveEntries} entries, ${liveFills} fills, PnL=${liveTotalPnl >= 0 ? '+' : ''}${liveTotalPnl.toFixed(2)}`);
  console.log(`  Δ PnL: ${(liveTotalPnl - paperTotalPnl) >= 0 ? '+' : ''}${(liveTotalPnl - paperTotalPnl).toFixed(2)}`);

  if (liveEntries > 0) {
    console.log(`  Live fill rate:   ${liveFills}/${liveEntries} (${(100 * liveFills / liveEntries).toFixed(0)}%)`);
  }
  if (slippageCount > 0) {
    console.log(`  Avg slippage:     ${(totalSlippage / slippageCount).toFixed(2)}¢`);
  }
  if (latencyCount > 0) {
    console.log(`  Avg fill latency: ${(totalLatency / latencyCount).toFixed(0)}ms`);
  }
  console.log('');
}

main();
