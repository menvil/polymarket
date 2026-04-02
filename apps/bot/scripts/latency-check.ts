#!/usr/bin/env tsx
/**
 * Latency Check — диагностика задержек к Polymarket.
 *
 * @remarks
 * Измеряет:
 * - WS PING/PONG RTT (текстовый heartbeat)
 * - REST API RTT (GET запросы к CLOB API)
 * - Market data staleness (разница server timestamp vs local time)
 *
 * @example
 * ```bash
 * npx tsx scripts/latency-check.ts
 * npx tsx scripts/latency-check.ts --rounds 20
 * ```
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { performance } from 'perf_hooks';
import WebSocket from 'ws';

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
const ROUNDS = parseInt(process.argv.find(a => a.startsWith('--rounds='))?.split('=')[1] ?? '10');

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
      // Начинаем пинги
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
          // Следующий ping без паузы
          pingStart = performance.now();
          ws.send('PING');
        }
      }
    });

    ws.on('error', (err) => reject(err));

    // Таймаут
    setTimeout(() => {
      ws.close();
      if (pings.length > 0) resolve({ connectMs, pings });
      else reject(new Error('WS ping timeout'));
    }, 30_000);
  });
}

// ── Market Data Staleness ────────────────────────────────────────────────────

async function measureStaleness(rounds: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const staleness: number[] = [];

    ws.on('open', () => {
      // Подписываемся на любой активный токен (нужен хотя бы один)
      // Используем market channel — он отправляет book snapshots для подписанных токенов
      // Для теста подписка не нужна — просто слушаем heartbeat и book updates
      // Но без подписки не будет book events. Пропускаем этот тест если нет tokenId.
      const tokenId = process.env['TEST_TOKEN_ID'];
      if (!tokenId) {
        ws.close();
        resolve([]);
        return;
      }
      ws.send(JSON.stringify({ type: 'market', assets_ids: [tokenId] }));
    });

    ws.on('message', (data) => {
      const msg = data.toString();
      if (msg === 'PONG' || msg.startsWith('[')) return; // skip pong and ack arrays

      try {
        const events: unknown[] = JSON.parse(msg);
        if (!Array.isArray(events)) return;
        for (const evt of events) {
          const e = evt as Record<string, unknown>;
          if (e['event_type'] === 'book' && e['timestamp']) {
            const serverTs = Number(e['timestamp']);
            const localTs = Date.now();
            const diff = localTs - serverTs;
            if (diff >= 0 && diff < 60_000) { // sanity: < 60s
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
      // Lightweight endpoint — server time
      const resp = await fetch(`${REST_URL}/time`, { method: 'GET', signal: AbortSignal.timeout(10_000) });
      await resp.text();
      latencies.push(performance.now() - start);
    } catch {
      // Fallback: try root
      try {
        const start2 = performance.now();
        const resp = await fetch(REST_URL, { method: 'GET', signal: AbortSignal.timeout(10_000) });
        await resp.text();
        latencies.push(performance.now() - start2);
      } catch {
        // Network error — skip
      }
    }
  }
  return latencies;
}

// ── Gamma API RTT (market discovery) ─────────────────────────────────────────

async function measureGammaLatency(rounds: number): Promise<number[]> {
  const latencies: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    try {
      const resp = await fetch('https://gamma-api.polymarket.com/markets?limit=1', {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      });
      await resp.text();
      latencies.push(performance.now() - start);
    } catch { /* skip */ }
  }
  return latencies;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n=== POLYMARKET LATENCY CHECK (${ROUNDS} rounds) ===\n`);

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

  // 4. Market data staleness
  if (process.env['TEST_TOKEN_ID']) {
    console.log('\nMarket Data Staleness:');
    try {
      const stale = await measureStaleness(Math.min(ROUNDS, 20));
      if (stale.length > 0) {
        console.log(`  Book updates (${stale.length}x): ${fmtStats(stats(stale))}`);
      } else {
        console.log('  No book events received (market may be inactive)');
      }
    } catch (err) {
      console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log('\nMarket Data Staleness: SKIPPED (set TEST_TOKEN_ID env to enable)');
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
}

main().catch(console.error);
