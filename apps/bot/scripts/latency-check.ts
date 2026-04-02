#!/usr/bin/env tsx
/**
 * Latency Check — диагностика задержек к Polymarket.
 *
 * @remarks
 * Использует DnsOverride (как main.ts), PolymarketMarketDataRestClient для discovery.
 * Автоматически находит активный рынок и измеряет latency.
 *
 * @example
 * ```bash
 * cd apps/bot
 * npx tsx scripts/latency-check.ts
 * npx tsx scripts/latency-check.ts --rounds=20
 * ```
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { performance } from 'perf_hooks';
import WebSocket from 'ws';
import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { DnsOverride } from '@polymarket/exchange/dns';

// ── .env загрузка ────────────────────────────────────────────────────────────
try {
  const envPath = resolve(import.meta.dirname ?? '.', '..', '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1]!.trim()]) {
      process.env[match[1]!.trim()] = match[2]!.trim().replace(/^["']|["']$/g, '');
    }
  }
} catch { /* .env not found */ }

// ── Конфигурация ─────────────────────────────────────────────────────────────

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const REST_URL = 'https://clob.polymarket.com';
const GAMMA_URL = 'https://gamma-api.polymarket.com';
const ROUNDS = parseInt(process.argv.find(a => a.startsWith('--rounds='))?.split('=')[1] ?? '10');

const logger = new ColorConsoleLogger(new LiveClock(), LogLevel.WARN);

// ── Утилиты ──────────────────────────────────────────────────────────────────

function stats(values: number[]): { min: number; avg: number; p95: number; max: number } {
  if (values.length === 0) return { min: 0, avg: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const p95idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
  return {
    min: sorted[0]!,
    avg: sum / sorted.length,
    p95: sorted[p95idx]!,
    max: sorted[sorted.length - 1]!,
  };
}

function fmt(ms: number): string {
  return ms < 1 ? '<1ms' : `${ms.toFixed(0)}ms`;
}

function fmtStats(s: ReturnType<typeof stats>): string {
  return `min=${fmt(s.min)} avg=${fmt(s.avg)} p95=${fmt(s.p95)} max=${fmt(s.max)}`;
}

// ── WS PING/PONG ────────────────────────────────────────────────────────────

async function measureWsPing(rounds: number): Promise<{ connectMs: number; pings: number[] }> {
  return new Promise((resolve, reject) => {
    const connectStart = performance.now();
    const ws = new WebSocket(WS_URL);
    let connectMs = 0;
    const pings: number[] = [];
    let pingStart = 0;
    let round = 0;

    ws.on('open', () => {
      connectMs = performance.now() - connectStart;
      pingStart = performance.now();
      ws.send('PING');
    });

    ws.on('message', (data) => {
      const msg = data.toString();
      if (msg === 'PONG') {
        pings.push(performance.now() - pingStart);
        round++;
        if (round >= rounds) {
          ws.close();
          resolve({ connectMs, pings });
        } else {
          pingStart = performance.now();
          ws.send('PING');
        }
      }
    });

    ws.on('error', (err) => reject(err));
    setTimeout(() => {
      ws.close();
      if (pings.length > 0) resolve({ connectMs, pings });
      else reject(new Error('WS ping timeout'));
    }, 30_000);
  });
}

// ── Market Data Staleness ────────────────────────────────────────────────────

async function measureStaleness(tokenId: string, rounds: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const staleness: number[] = [];

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'market', assets_ids: [tokenId] }));
    });

    ws.on('message', (data) => {
      const msg = data.toString();
      if (msg === 'PONG' || msg.startsWith('[')) return;

      try {
        const events: unknown[] = JSON.parse(msg);
        if (!Array.isArray(events)) return;
        for (const evt of events) {
          const e = evt as Record<string, unknown>;
          if (e['event_type'] === 'book' && e['timestamp']) {
            const serverTs = Number(e['timestamp']);
            const localTs = Date.now();
            const diff = localTs - serverTs;
            if (diff >= 0 && diff < 60_000) {
              staleness.push(diff);
            }
          }
        }
      } catch { /* not JSON */ }

      if (staleness.length >= rounds) {
        ws.close();
        resolve(staleness);
      }
    });

    ws.on('error', (err) => reject(err));
    setTimeout(() => { ws.close(); resolve(staleness); }, 60_000);
  });
}

// ── REST API RTT ─────────────────────────────────────────────────────────────

async function measureRestLatency(rounds: number): Promise<number[]> {
  const latencies: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    try {
      const resp = await fetch(`${REST_URL}/time`, { method: 'GET', signal: AbortSignal.timeout(10_000) });
      await resp.text();
      latencies.push(performance.now() - start);
    } catch {
      try {
        const start2 = performance.now();
        const resp = await fetch(REST_URL, { method: 'GET', signal: AbortSignal.timeout(10_000) });
        await resp.text();
        latencies.push(performance.now() - start2);
      } catch { /* skip */ }
    }
  }
  return latencies;
}

// ── Gamma API RTT ────────────────────────────────────────────────────────────

async function measureGammaLatency(rounds: number): Promise<number[]> {
  const latencies: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    try {
      const resp = await fetch(`${GAMMA_URL}/markets?limit=1`, { method: 'GET', signal: AbortSignal.timeout(10_000) });
      await resp.text();
      latencies.push(performance.now() - start);
    } catch { /* skip */ }
  }
  return latencies;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // DNS Override (как в main.ts)
  console.log('Installing DNS override...');
  const dnsOverride = new DnsOverride(logger);
  try {
    await dnsOverride.install([
      'gamma-api.polymarket.com',
      'clob.polymarket.com',
      'data-api.polymarket.com',
      'ws-subscriptions-clob.polymarket.com',
      'ws-live-data.polymarket.com',
    ]);
    console.log('DNS override installed\n');
  } catch (err) {
    console.log(`DNS override failed (using system DNS): ${err instanceof Error ? err.message : String(err)}\n`);
  }

  console.log(`=== POLYMARKET LATENCY CHECK (${ROUNDS} rounds) ===\n`);

  // 1. WS Ping
  console.log('WS Connection:');
  try {
    const ws = await measureWsPing(ROUNDS);
    const pingStats = stats(ws.pings);
    console.log(`  Connect time:     ${fmt(ws.connectMs)}`);
    console.log(`  PING/PONG (${ws.pings.length}x):  ${fmtStats(pingStats)}`);
  } catch (err) {
    console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. REST API
  console.log('\nREST API (clob.polymarket.com):');
  const restLatencies = await measureRestLatency(ROUNDS);
  if (restLatencies.length > 0) {
    console.log(`  GET /time (${restLatencies.length}x):  ${fmtStats(stats(restLatencies))}`);
  } else {
    console.log('  ERROR: no successful requests');
  }

  // 3. Gamma API
  console.log('\nGamma API (gamma-api.polymarket.com):');
  const gammaLatencies = await measureGammaLatency(Math.min(ROUNDS, 5));
  if (gammaLatencies.length > 0) {
    console.log(`  GET /markets (${gammaLatencies.length}x): ${fmtStats(stats(gammaLatencies))}`);
  } else {
    console.log('  ERROR: no successful requests');
  }

  // 4. Auto-discover active token (один запрос к Gamma API, limit=5)
  console.log('\nMarket Data Staleness:');
  let tokenId: string | null = null;
  try {
    console.log('  Discovering active market...');
    const resp = await fetch(`${GAMMA_URL}/markets?closed=false&limit=5&order=volume&ascending=false`, {
      signal: AbortSignal.timeout(10_000),
    });
    const markets = await resp.json() as Array<Record<string, unknown>>;
    for (const m of markets) {
      const raw = m['clobTokenIds'] as string | undefined;
      if (raw) {
        try {
          const ids = JSON.parse(raw) as string[];
          if (ids.length > 0 && ids[0]) {
            tokenId = ids[0];
            const question = (m['question'] as string ?? '?').slice(0, 50);
            console.log(`  Found: ${question} (token: ${tokenId.slice(0, 16)}...)`);
            break;
          }
        } catch { /* not JSON array */ }
      }
    }
  } catch (err) {
    console.log(`  Discovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (tokenId) {
    try {
      const stale = await measureStaleness(tokenId, Math.min(ROUNDS, 20));
      if (stale.length > 0) {
        console.log(`  Book updates (${stale.length}x): ${fmtStats(stats(stale))}`);
      } else {
        console.log('  No book events received (market may be inactive)');
      }
    } catch (err) {
      console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log('  SKIPPED (no active market found)');
  }

  // Verdict
  const allLatencies = [...restLatencies, ...gammaLatencies];
  const overall = stats(allLatencies);
  console.log('\n---');
  if (overall.p95 < 100) {
    console.log(`VERDICT: GOOD (REST p95=${fmt(overall.p95)})`);
  } else if (overall.p95 < 300) {
    console.log(`VERDICT: OK (REST p95=${fmt(overall.p95)}, may affect 5-min markets)`);
  } else {
    console.log(`VERDICT: SLOW (REST p95=${fmt(overall.p95)}, consider closer server)`);
  }
  console.log('');

  dnsOverride.uninstall();
}

main().catch(console.error);
