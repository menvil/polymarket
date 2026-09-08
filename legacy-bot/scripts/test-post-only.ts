#!/usr/bin/env tsx
/**
 * Smoke-test для post-only поведения на live CLOB.
 *
 * @remarks
 * Делает несколько попыток:
 * 1. Берёт свежий стакан по токену
 * 2. Считает заведомо marketable BUY-цену выше нескольких ask-уровней
 * 3. Отправляет ордер с `postOnly: true`
 * 4. Классифицирует результат:
 *    - REJECTED: ожидаемое поведение post-only
 *    - LIVE/OPEN: не доказывает баг, книга могла измениться между snapshot и submit
 *    - MATCHED/FILLED: сильный сигнал, что post-only не сработал как ожидалось
 *
 * Accepted != bug:
 * если ask исчез до обработки запроса биржей, ордер может законно стать пассивным.
 *
 * @example
 * ```bash
 * cd apps/bot
 * npx tsx scripts/test-post-only.ts
 * npx tsx scripts/test-post-only.ts --token=123... --size=5 --attempts=3
 * npx tsx scripts/test-post-only.ts --config=configs/sel-live.json
 * ```
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { DnsOverride } from '@polymarket/exchange/dns';
import { PolymarketMarketDiscoveryAdapter } from '@polymarket/exchange/adapters';
import {
  PolymarketMarketDataRestClient,
  PolymarketRestClient,
  PolymarketOrderbookRestClient,
  PolymarketOrderRestClient,
  PolymarketOrderBuilder,
  PolymarketUserTradesRestClient,
  SignatureType,
} from '@polymarket/exchange/rest';
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';
import type { IMarketFilterConfig } from '@polymarket/ports';

// ── .env ────────────────────────────────────────────────────────────────────

try {
  const envPath = resolve(import.meta.dirname ?? '.', '..', '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1]!.trim()]) {
      process.env[match[1]!.trim()] = match[2]!.trim().replace(/^["']|["']$/g, '');
    }
  }
} catch {
  // ignore missing .env
}

// ── Args/config ─────────────────────────────────────────────────────────────

const REST_URL = 'https://clob.polymarket.com';
const GAMMA_URL = 'https://gamma-api.polymarket.com';

function readArg(name: string): string | undefined {
  return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
}

function readNumArg(name: string, fallback: number): number {
  const raw = readArg(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const ATTEMPTS = Math.max(1, Math.floor(readNumArg('attempts', 3)));
const SIZE = Math.max(1, readNumArg('size', 5));
const CROSS_LEVELS = Math.max(1, Math.floor(readNumArg('cross-levels', 3)));
const POLL_ROUNDS = Math.max(1, Math.floor(readNumArg('poll-rounds', 4)));
const POLL_DELAY_MS = Math.max(200, Math.floor(readNumArg('poll-delay-ms', 750)));
const SHOW_HELP = process.argv.includes('--help') || process.argv.includes('-h');

const configArg = readArg('config');
const configPath = configArg ?? process.env['CONFIG'] ?? 'configs/sel-paper-5min.json';
let botConfigRaw: Record<string, unknown> = {};
try {
  botConfigRaw = JSON.parse(readFileSync(resolve(import.meta.dirname ?? '.', '..', configPath), 'utf-8'));
} catch {
  // ignore missing config
}
const marketFilter = (botConfigRaw['market'] as Record<string, unknown>)?.['filter'] as
  | Record<string, unknown>
  | undefined;

const PRIVATE_KEY = process.env['PRIVATE_KEY'];
const API_KEY = process.env['POLYMARKET_API_KEY'];
const API_SECRET = process.env['POLYMARKET_API_SECRET'];
const API_PASSPHRASE = process.env['POLYMARKET_API_PASSPHRASE'];
const FUNDER_ADDRESS = process.env['FUNDER_ADDRESS'];

if (SHOW_HELP) {
  console.log('Usage: npx tsx scripts/test-post-only.ts [options]');
  console.log('');
  console.log('Options:');
  console.log('  --token=<asset_id>         Explicit tokenId instead of discovery');
  console.log('  --config=<path>            Bot config for market discovery filter');
  console.log('  --attempts=<n>             Number of attempts (default: 3)');
  console.log('  --size=<n>                 Order size in shares (default: 5)');
  console.log('  --cross-levels=<n>         Cross at least N ask levels on snapshot (default: 3)');
  console.log('  --poll-rounds=<n>          Status/fill polling rounds after submit (default: 4)');
  console.log('  --poll-delay-ms=<n>        Delay between polls (default: 750)');
  process.exit(0);
}

if (!PRIVATE_KEY || !API_KEY || !API_SECRET || !API_PASSPHRASE) {
  console.error('Missing env vars: PRIVATE_KEY, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE');
  process.exit(1);
}

const logger = new ColorConsoleLogger(new LiveClock(), LogLevel.WARN);

// ── Types ───────────────────────────────────────────────────────────────────

interface DiscoveredToken {
  tokenId: string;
  question: string;
}

interface ProbeAttemptResult {
  attempt: number;
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  referenceAsk: number | null;
  price: number;
  size: number;
  classification:
    | 'REJECTED'
    | 'LIVE'
    | 'MATCHED'
    | 'FILLED'
    | 'LIVE_THEN_CANCELLED'
    | 'UNKNOWN';
  orderId?: string;
  restStatus?: string;
  rejectMessage?: string;
  matchedTradeSide?: string;
  matchedVia?: 'order_status' | 'matched_orders' | 'user_fills';
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatPrice(price: number | null | undefined): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return 'n/a';
  return price.toFixed(3);
}

function inferTick(prices: number[]): number {
  const unique = [...new Set(prices.filter((p) => Number.isFinite(p)).map((p) => Number(p.toFixed(6))))].sort((a, b) => a - b);
  let minDiff = Number.POSITIVE_INFINITY;

  for (let i = 1; i < unique.length; i++) {
    const diff = Number((unique[i]! - unique[i - 1]!).toFixed(6));
    if (diff > 0 && diff < minDiff) minDiff = diff;
  }

  if (!Number.isFinite(minDiff)) return 0.01;
  if (minDiff >= 0.01) return 0.01;
  if (minDiff >= 0.001) return 0.001;
  return 0.001;
}

function priceFromBook(asks: readonly number[], crossLevels: number): { bestAsk: number | null; referenceAsk: number | null; price: number; tick: number } {
  const bestAsk = asks[0] ?? null;
  const refIndex = Math.min(Math.max(0, crossLevels - 1), Math.max(0, asks.length - 1));
  const referenceAsk = asks[refIndex] ?? bestAsk;
  const tick = inferTick(asks);

  if (referenceAsk === null || !Number.isFinite(referenceAsk)) {
    throw new Error('Orderbook has no asks, cannot build guaranteed-crossing BUY');
  }

  const rawPrice = Math.min(0.99, referenceAsk + tick);
  const rounded = Math.ceil(rawPrice / tick) * tick;
  const price = Number(Math.min(0.99, rounded).toFixed(3));

  return { bestAsk, referenceAsk, price, tick };
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function extractOrderIdFromUserFill(fill: {
  taker_order_id?: string;
  maker_order_id?: string;
  maker_orders?: Array<{ order_id: string }>;
}): string[] {
  const ids: string[] = [];
  if (typeof fill.taker_order_id === 'string') ids.push(fill.taker_order_id);
  if (typeof fill.maker_order_id === 'string') ids.push(fill.maker_order_id);
  if (Array.isArray(fill.maker_orders)) {
    for (const order of fill.maker_orders) {
      if (typeof order?.order_id === 'string') ids.push(order.order_id);
    }
  }
  return ids;
}

async function discoverToken(): Promise<DiscoveredToken | null> {
  const explicit = readArg('token');
  if (explicit) {
    return { tokenId: explicit, question: 'explicit --token' };
  }

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
  const minExpiryMs = Date.now() + 2 * 60 * 1000;
  const valid = candidates.filter((candidate) => candidate.expiresAt.toNumber() > minExpiryMs);
  if (valid.length === 0) return null;

  const first = valid[0]!;
  const tokenId = first.allTokenIds?.[0] ?? String(first.instrumentId);
  return { tokenId, question: first.question };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Config: ${configPath}`);
  console.log(`Attempts: ${ATTEMPTS} | size=${SIZE} | cross-levels=${CROSS_LEVELS}`);

  const dnsOverride = new DnsOverride(logger);
  try {
    await dnsOverride.install([
      'gamma-api.polymarket.com',
      'clob.polymarket.com',
      'data-api.polymarket.com',
      'ws-subscriptions-clob.polymarket.com',
    ]);
    console.log('DNS override installed');
  } catch (error) {
    console.log(`DNS override skipped: ${normalizeErrorMessage(error)}`);
  }

  const token = await discoverToken();
  if (!token) {
    console.error('No token discovered. Pass --token=<asset_id> explicitly.');
    process.exit(1);
  }

  console.log(`Token: ${token.tokenId}`);
  console.log(`Source: ${token.question}`);

  const signatureType = FUNDER_ADDRESS ? SignatureType.POLY_PROXY : SignatureType.EOA;
  const restClient = new PolymarketRestClient({
    baseUrl: REST_URL,
    privateKey: PRIVATE_KEY!,
    chainId: 137,
    timeout: 15_000,
    maxRetries: 1,
    signatureType,
    funderAddress: FUNDER_ADDRESS,
    l2Credentials: {
      apiKey: API_KEY!,
      secret: API_SECRET!,
      passphrase: API_PASSPHRASE!,
    },
  }, logger);

  const signer = restClient.getSigner();
  const makerAddress = FUNDER_ADDRESS ?? signer.getAddress();
  console.log(`Maker address: ${makerAddress}`);

  const orderBuilder = new PolymarketOrderBuilder(
    signer.getWallet(),
    137,
    makerAddress,
    signatureType,
    logger,
  );

  const orderbookClient = new PolymarketOrderbookRestClient(restClient, logger);
  const orderClient = new PolymarketOrderRestClient(restClient, orderBuilder, logger, makerAddress);
  const userTradesClient = new PolymarketUserTradesRestClient(restClient, logger);
  console.log('');

  const results: ProbeAttemptResult[] = [];

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    console.log(`Attempt ${attempt}/${ATTEMPTS}`);

    const book = await orderbookClient.getOrderbook(token.tokenId, Math.max(5, CROSS_LEVELS));
    const bids = book.bids.map((level) => Number(level.price));
    const asks = book.asks.map((level) => Number(level.price));
    const bestBid = bids[0] ?? null;

    let planned;
    try {
      planned = priceFromBook(asks, CROSS_LEVELS);
    } catch (error) {
      const message = normalizeErrorMessage(error);
      console.log(`  BOOK ERROR: ${message}`);
      results.push({
        attempt,
        tokenId: token.tokenId,
        bestBid,
        bestAsk: asks[0] ?? null,
        referenceAsk: null,
        price: NaN,
        size: SIZE,
        classification: 'UNKNOWN',
        rejectMessage: message,
      });
      console.log('');
      continue;
    }

    console.log(`  Book: bid=${formatPrice(bestBid)} ask=${formatPrice(planned.bestAsk)} refAsk=${formatPrice(planned.referenceAsk)} tick=${planned.tick.toFixed(3)}`);
    console.log(`  Order: BUY ${SIZE} @ ${planned.price.toFixed(3)} postOnly=true`);

    try {
      const response = await orderClient.createOrder({
        tokenId: token.tokenId,
        side: 'BUY',
        price: planned.price,
        size: SIZE,
        postOnly: true,
        priceTick: planned.tick,
      });

      console.log(`  Submit: ACCEPTED orderId=${response.orderID} status=${response.status}`);

      let classification: ProbeAttemptResult['classification'] =
        response.status === 'filled' ? 'FILLED' : 'UNKNOWN';
      let matchedVia: ProbeAttemptResult['matchedVia'];
      let matchedTradeSide: string | undefined;

      for (let round = 1; round <= POLL_ROUNDS; round++) {
        if (round > 1) await sleep(POLL_DELAY_MS);

        try {
          const order = await orderClient.getOrderById(response.orderID);
          if (order.status === 'filled') {
            classification = 'FILLED';
            matchedVia = 'order_status';
            break;
          }
          if (order.status === 'pending' || order.status === 'live') {
            classification = 'LIVE';
          }
        } catch {
          // ignore and continue with other evidence sources
        }

        try {
          const matchedOrders = await orderClient.getMatchedOrders(token.tokenId, 20);
          if (matchedOrders.some((order) => order.id === response.orderID)) {
            classification = 'MATCHED';
            matchedVia = 'matched_orders';
            break;
          }
        } catch {
          // best effort
        }

        try {
          const fills = await userTradesClient.getUserFills({
            asset_id: token.tokenId,
            limit: 20,
            only_first_page: true,
          });
          const hit = fills.find((fill) => extractOrderIdFromUserFill(fill).includes(response.orderID));
          if (hit) {
            classification = 'FILLED';
            matchedVia = 'user_fills';
            matchedTradeSide = hit.trader_side;
            break;
          }
        } catch {
          // best effort
        }
      }

      if (classification === 'LIVE' || classification === 'UNKNOWN') {
        try {
          await orderClient.cancelOrder(response.orderID);
          console.log('  Cancel: OK');
          classification = 'LIVE_THEN_CANCELLED';
        } catch (error) {
          console.log(`  Cancel: ${normalizeErrorMessage(error)}`);
        }
      }

      results.push({
        attempt,
        tokenId: token.tokenId,
        bestBid,
        bestAsk: planned.bestAsk,
        referenceAsk: planned.referenceAsk,
        price: planned.price,
        size: SIZE,
        classification,
        orderId: response.orderID,
        restStatus: response.status,
        matchedTradeSide,
        matchedVia,
      });

      if (classification === 'FILLED' || classification === 'MATCHED') {
        console.log(`  Outcome: ${classification}${matchedVia ? ` via ${matchedVia}` : ''}${matchedTradeSide ? ` trader_side=${matchedTradeSide}` : ''}`);
      } else {
        console.log(`  Outcome: ${classification}`);
      }
    } catch (error) {
      const message = normalizeErrorMessage(error);
      console.log(`  Submit: REJECTED ${message}`);
      results.push({
        attempt,
        tokenId: token.tokenId,
        bestBid,
        bestAsk: planned.bestAsk,
        referenceAsk: planned.referenceAsk,
        price: planned.price,
        size: SIZE,
        classification: 'REJECTED',
        rejectMessage: message,
      });
    }

    console.log('');
  }

  console.log('Summary:');
  for (const result of results) {
    const tail = result.rejectMessage
      ? ` | reason=${result.rejectMessage}`
      : result.orderId
        ? ` | orderId=${result.orderId}`
        : '';
    const matchInfo = result.matchedVia
      ? ` | via=${result.matchedVia}${result.matchedTradeSide ? ` trader_side=${result.matchedTradeSide}` : ''}`
      : '';
    console.log(
      `  #${result.attempt} ${result.classification}`
      + ` | bid=${formatPrice(result.bestBid)} ask=${formatPrice(result.bestAsk)}`
      + ` refAsk=${formatPrice(result.referenceAsk)} price=${formatPrice(result.price)}`
      + tail
      + matchInfo,
    );
  }

  const strongViolation = results.some((result) => result.classification === 'FILLED' || result.classification === 'MATCHED');
  const anyReject = results.some((result) => result.classification === 'REJECTED');

  console.log('');
  if (strongViolation) {
    console.log('Verdict: STRONG SIGNAL OF PROBLEM. postOnly attempt resulted in matched/filled outcome.');
  } else if (anyReject) {
    console.log('Verdict: postOnly protection observed. Crossing attempt was rejected at least once.');
  } else {
    console.log('Verdict: INCONCLUSIVE. Orders were accepted live/cancelled; book may have moved before matching logic ran.');
  }

  dnsOverride.uninstall();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
