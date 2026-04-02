#!/usr/bin/env tsx
/**
 * Latency Check — диагностика задержек к Polymarket.
 *
 * @remarks
 * Использует DnsOverride, читает конфиг бота для discovery keywords,
 * находит активный рынок, измеряет WS/REST/order latency.
 *
 * @example
 * ```bash
 * cd apps/bot
 * CONFIG=configs/sel-paper-5min.json npx tsx scripts/latency-check.ts
 * npx tsx scripts/latency-check.ts --config=configs/sel-paper-5min.json
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
import { PolymarketMarketDiscoveryAdapter } from '@polymarket/exchange/adapters';
import { PolymarketMarketDataRestClient } from '@polymarket/exchange/rest';
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';
import type { IMarketFilterConfig } from '@polymarket/ports';

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

// Конфиг бота: --config > CONFIG env > default
const configArg = process.argv.find(a => a.startsWith('--config='))?.split('=')[1];
const configPath = configArg ?? process.env['CONFIG'] ?? 'configs/sel-paper-5min.json';
let botConfigRaw: Record<string, unknown> = {};
try {
  botConfigRaw = JSON.parse(readFileSync(resolve(import.meta.dirname ?? '.', '..', configPath), 'utf-8'));
} catch { /* config not found */ }
const marketFilter = (botConfigRaw['market'] as Record<string, unknown>)?.['filter'] as Record<string, unknown> | undefined;

const logger = new ColorConsoleLogger(new LiveClock(), LogLevel.WARN);

// Credentials для order test
const PRIVATE_KEY = process.env['PRIVATE_KEY'];
const API_KEY = process.env['POLYMARKET_API_KEY'];
const API_SECRET = process.env['POLYMARKET_API_SECRET'];
const API_PASSPHRASE = process.env['POLYMARKET_API_PASSPHRASE'];
const hasCredentials = !!(PRIVATE_KEY && API_KEY && API_SECRET && API_PASSPHRASE);

// ── Утилиты ──────────────────────────────────────────────────────────────────

function stats(values: number[]): { min: number; avg: number; p95: number; max: number } {
  if (values.length === 0) return { min: 0, avg: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  const p95idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
  return { min: sorted[0]!, avg: sum / sorted.length, p95: sorted[p95idx]!, max: sorted[sorted.length - 1]! };
}

function fmt(ms: number): string { return ms < 1 ? '<1ms' : `${ms.toFixed(0)}ms`; }
function fmtStats(s: ReturnType<typeof stats>): string {
  return `min=${fmt(s.min)} avg=${fmt(s.avg)} p95=${fmt(s.p95)} max=${fmt(s.max)}`;
}

// ── Discover active market (тот же код что в main.ts runPaper/runLive) ────────

interface DiscoveredToken {
  tokenId: string;
  question: string;
}

async function discoverToken(): Promise<DiscoveredToken | null> {
  const clock = new LiveClock();
  const mc = marketFilter ?? {};

  const filterConfig: IMarketFilterConfig = {
    minTimeToExpiryHours: (mc['minTimeToExpiryHours'] as number) ?? 0,
    minSpread: 0,
    minLiquidity: (mc['minLiquidity'] as number) ?? 0,
    maxMarketsToReturn: 5,
    anyOfKeywords: mc['anyOfKeywords'] as string[] | undefined,
    requiredKeywords: mc['requiredKeywords'] as string[] | undefined,
    excludedKeywords: mc['excludedKeywords'] as string[] | undefined,
    minDurationMinutes: mc['minDurationMinutes'] as number | undefined,
    maxDurationMinutes: mc['maxDurationMinutes'] as number | undefined,
  };

  console.log(`  Filter: ${JSON.stringify(filterConfig)}`);

  const marketDataClient = new PolymarketMarketDataRestClient(
    { baseUrl: GAMMA_URL },
    logger,
  );
  const discoveryAdapter = new PolymarketMarketDiscoveryAdapter(
    marketDataClient,
    new MarketFilter(),
    new MarketScorer(clock),
    filterConfig,
    logger,
  );

  await discoveryAdapter.refresh();
  const candidates = await discoveryAdapter.findCandidates();
  // Берём только рынки которые истекают минимум через 2 минуты (чтобы были book updates и ордера)
  const minExpiryMs = Date.now() + 2 * 60 * 1000;
  const valid = candidates.filter(c => c.expiresAt.toNumber() > minExpiryMs);
  console.log(`  Candidates: ${candidates.length} total, ${valid.length} expiring in >2min`);

  if (valid.length === 0) return null;

  const first = valid[0]!;
  const tokenId = first.allTokenIds?.[0] ?? String(first.instrumentId);
  return { tokenId, question: first.question };
}

// ── WS: connect + subscribe + measure staleness ──────────────────────────────

interface WsResult {
  connectMs: number;
  subscribeMs: number;
  pings: number[];
  staleness: number[];
}

async function measureWs(tokenId: string, rounds: number): Promise<WsResult> {
  return new Promise((resolve, reject) => {
    const connectStart = performance.now();
    const ws = new WebSocket(WS_URL);
    let connectMs = 0;
    let subscribeMs = 0;
    let subscribeStart = 0;
    let subscribed = false;
    const pings: number[] = [];
    const staleness: number[] = [];
    let pingStart = 0;
    let pingRound = 0;
    let phase: 'connecting' | 'subscribing' | 'staleness' | 'pinging' | 'done' = 'connecting';

    ws.on('open', () => {
      connectMs = performance.now() - connectStart;
      phase = 'subscribing';
      subscribeStart = performance.now();
      // Подписываемся на токен
      ws.send(JSON.stringify({ type: 'market', assets_ids: [tokenId] }));
    });

    ws.on('message', (data) => {
      const msg = data.toString().trim();

      // Subscription ack (массив с подтверждением)
      if (!subscribed && (msg.startsWith('[') || msg === 'OK')) {
        subscribeMs = performance.now() - subscribeStart;
        subscribed = true;
        phase = 'staleness';
        return;
      }

      if (msg === 'PONG') {
        if (phase === 'pinging') {
          pings.push(performance.now() - pingStart);
          pingRound++;
          if (pingRound >= rounds) {
            phase = 'done';
            ws.close();
            resolve({ connectMs, subscribeMs, pings, staleness });
          } else {
            pingStart = performance.now();
            ws.send('PING');
          }
        }
        return;
      }

      // Market events — measure staleness (price_changes, book, или любое с timestamp)
      if (phase === 'staleness') {
        try {
          const parsed = JSON.parse(msg);
          // Извлекаем timestamp из любого формата
          let ts: number | null = null;
          if (Array.isArray(parsed)) {
            // Массив событий: [{ event_type: 'book', timestamp: ... }]
            for (const evt of parsed as Record<string, unknown>[]) {
              if (evt['timestamp']) { ts = Number(evt['timestamp']); break; }
            }
          } else if (typeof parsed === 'object' && parsed !== null) {
            // Единичный объект: { market, price_changes, timestamp } или { market, asset_id, ... }
            const obj = parsed as Record<string, unknown>;
            if (obj['timestamp']) ts = Number(obj['timestamp']);
            // price_changes содержат timestamp внутри
            const changes = obj['price_changes'] as Array<Record<string, unknown>> | undefined;
            if (!ts && changes?.[0]?.['timestamp']) ts = Number(changes[0]!['timestamp']);
          }
          if (ts && ts > 1_000_000_000_000) { // sanity: must be epoch ms
            const diff = Date.now() - ts;
            if (diff >= 0 && diff < 60_000) staleness.push(diff);
          }
        } catch { /* skip non-JSON */ }

        // После получения достаточно staleness readings — переходим к пингам
        if (staleness.length >= rounds) {
          phase = 'pinging';
          pingStart = performance.now();
          ws.send('PING');
        }
      }
    });

    ws.on('error', (err) => {
      if (phase === 'connecting') reject(new Error(`WS connect failed: ${err.message}`));
    });

    ws.on('close', () => {
      if (phase !== 'done' && (staleness.length > 0 || pings.length > 0)) {
        resolve({ connectMs, subscribeMs, pings, staleness });
      }
    });

    setTimeout(() => {
      ws.close();
      if (staleness.length > 0 || pings.length > 0) {
        resolve({ connectMs, subscribeMs, pings, staleness });
      } else {
        reject(new Error(`WS timeout (phase: ${phase})`));
      }
    }, 60_000);
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
        await fetch(REST_URL, { method: 'GET', signal: AbortSignal.timeout(10_000) });
        latencies.push(performance.now() - start2);
      } catch { /* skip */ }
    }
  }
  return latencies;
}

// ── Order placement test ─────────────────────────────────────────────────────

async function measureOrderLatency(tokenId: string, rounds: number): Promise<{ place: number[]; cancel: number[] }> {
  const { PolymarketRestClient, PolymarketOrderRestClient, PolymarketOrderBuilder, SignatureType } =
    await import('@polymarket/exchange/rest');

  const sigType = process.env['FUNDER_ADDRESS'] ? SignatureType.POLY_PROXY : SignatureType.EOA;
  const restClient = new PolymarketRestClient({
    baseUrl: REST_URL,
    privateKey: PRIVATE_KEY!,
    chainId: 137,
    timeout: 15_000,
    maxRetries: 1,
    signatureType: sigType,
    funderAddress: process.env['FUNDER_ADDRESS'],
    l2Credentials: { apiKey: API_KEY!, secret: API_SECRET!, passphrase: API_PASSPHRASE! },
  }, logger);

  const signer = restClient.getSigner();
  const makerAddress = process.env['FUNDER_ADDRESS'] ?? signer.getAddress();
  const orderBuilder = new PolymarketOrderBuilder(signer.getWallet(), 137, makerAddress, sigType, logger);
  const orderClient = new PolymarketOrderRestClient(restClient, orderBuilder, logger);

  const placeLat: number[] = [];
  const cancelLat: number[] = [];

  for (let i = 0; i < rounds; i++) {
    try {
      // Place: BUY 1 token @ $0.01 (далеко от рынка, не заполнится)
      const start = performance.now();
      const result = await orderClient.createOrder({
        tokenId,
        side: 'BUY',
        price: 0.01,
        size: 5,
        nonce: 0,
        feeRateBps: 1000,
      });
      placeLat.push(performance.now() - start);

      // Cancel immediately
      if (result?.orderID) {
        const cancelStart = performance.now();
        await orderClient.cancelOrder(result.orderID);
        cancelLat.push(performance.now() - cancelStart);
      }
    } catch (err) {
      console.log(`    Order test #${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { place: placeLat, cancel: cancelLat };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\nConfig: ${configPath}`);
  console.log(`Credentials: ${hasCredentials ? 'YES (order test enabled)' : 'NO (order test skipped)'}`);

  // DNS Override
  console.log('\nInstalling DNS override...');
  const dnsOverride = new DnsOverride(logger);
  try {
    await dnsOverride.install([
      'gamma-api.polymarket.com', 'clob.polymarket.com',
      'data-api.polymarket.com', 'ws-subscriptions-clob.polymarket.com',
    ]);
    console.log('DNS override installed');
  } catch (err) {
    console.log(`DNS override failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`\n=== POLYMARKET LATENCY CHECK (${ROUNDS} rounds) ===\n`);

  // 1. REST API
  console.log('REST API (clob.polymarket.com):');
  const restLatencies = await measureRestLatency(ROUNDS);
  if (restLatencies.length > 0) {
    console.log(`  GET /time (${restLatencies.length}x):  ${fmtStats(stats(restLatencies))}`);
  } else {
    console.log('  ERROR: no successful requests');
  }

  // 2. Gamma API + discovery
  console.log('\nGamma API (market discovery):');
  let token: DiscoveredToken | null = null;
  const gammaStart = performance.now();
  try {
    token = await discoverToken();
    const gammaMs = performance.now() - gammaStart;
    if (token) {
      console.log(`  Discovery (${gammaMs.toFixed(0)}ms): ${token.question.slice(0, 55)}`);
      console.log(`  Token: ${token.tokenId.slice(0, 20)}...`);
    } else {
      console.log('  No market found matching config filter');
    }
  } catch (err) {
    console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. WS: connect + subscribe + staleness + ping
  if (token) {
    console.log('\nWebSocket:');
    try {
      const wsResult = await measureWs(token.tokenId, ROUNDS);
      console.log(`  Connect:          ${fmt(wsResult.connectMs)}`);
      console.log(`  Subscribe ack:    ${fmt(wsResult.subscribeMs)}`);
      if (wsResult.staleness.length > 0) {
        console.log(`  Staleness (${wsResult.staleness.length}x):  ${fmtStats(stats(wsResult.staleness))}`);
      }
      if (wsResult.pings.length > 0) {
        console.log(`  PING/PONG (${wsResult.pings.length}x):  ${fmtStats(stats(wsResult.pings))}`);
      }
    } catch (err) {
      console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. Order placement test (if credentials present)
  if (hasCredentials && token) {
    console.log('\nOrder Lifecycle:');
    const orderRounds = Math.min(ROUNDS, 3); // max 3 to avoid rate limits
    try {
      const orderResult = await measureOrderLatency(token.tokenId, orderRounds);
      if (orderResult.place.length > 0) {
        console.log(`  Place (${orderResult.place.length}x):   ${fmtStats(stats(orderResult.place))}`);
      }
      if (orderResult.cancel.length > 0) {
        console.log(`  Cancel (${orderResult.cancel.length}x):  ${fmtStats(stats(orderResult.cancel))}`);
      }
      if (orderResult.place.length === 0) {
        console.log('  No successful orders (check credentials/balance)');
      }
    } catch (err) {
      console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Verdict
  const allLatencies = [...restLatencies];
  const overall = stats(allLatencies);
  console.log('\n---');
  if (overall.p95 < 100) {
    console.log(`VERDICT: GOOD (REST p95=${fmt(overall.p95)})`);
  } else if (overall.p95 < 300) {
    console.log(`VERDICT: OK (REST p95=${fmt(overall.p95)})`);
  } else {
    console.log(`VERDICT: SLOW (REST p95=${fmt(overall.p95)})`);
  }
  console.log('');

  dnsOverride.uninstall();
}

main().catch(console.error);
