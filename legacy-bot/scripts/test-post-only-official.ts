#!/usr/bin/env tsx
/**
 * Smoke-test post-only через официальный @polymarket/clob-client.
 *
 * @remarks
 * Нужен для A/B проверки против нашего кастомного REST path.
 * Сценарий:
 * 1. Берём живую книгу через официальный SDK
 * 2. Строим заведомо crossing BUY-цену
 * 3. Отправляем createAndPostOrder(..., GTC, deferExec=true, postOnly=true)
 * 4. Подтверждаем outcome через getTrades()
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { Wallet } from '@ethersproject/wallet';
import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { DnsOverride } from '@polymarket/exchange/dns';
import { PolymarketMarketDiscoveryAdapter } from '@polymarket/exchange/adapters';
import { PolymarketMarketDataRestClient } from '@polymarket/exchange/rest';
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';
import type { IMarketFilterConfig } from '@polymarket/ports';
import {
  ClobClient,
  OrderType,
  Side,
  SignatureType,
  type TickSize,
} from '@polymarket/clob-client';

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
  // ignore
}

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
  // ignore
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
  console.log('Usage: node_modules/.bin/ts-node-esm apps/bot/scripts/test-post-only-official.ts [options]');
  console.log('  --token=<asset_id>');
  console.log('  --attempts=<n>');
  console.log('  --size=<n>');
  console.log('  --cross-levels=<n>');
  process.exit(0);
}

if (!PRIVATE_KEY || !API_KEY || !API_SECRET || !API_PASSPHRASE) {
  console.error('Missing env vars: PRIVATE_KEY, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE');
  process.exit(1);
}

const logger = new ColorConsoleLogger(new LiveClock(), LogLevel.WARN);

interface DiscoveredToken {
  tokenId: string;
  question: string;
}

function formatPrice(price: number | null | undefined): string {
  if (price === null || price === undefined || !Number.isFinite(price)) return 'n/a';
  return price.toFixed(3);
}

function inferTick(prices: number[]): TickSize {
  const unique = [...new Set(prices.filter((p) => Number.isFinite(p)).map((p) => Number(p.toFixed(6))))].sort((a, b) => a - b);
  let minDiff = Number.POSITIVE_INFINITY;
  for (let i = 1; i < unique.length; i++) {
    const diff = Number((unique[i]! - unique[i - 1]!).toFixed(6));
    if (diff > 0 && diff < minDiff) minDiff = diff;
  }
  if (!Number.isFinite(minDiff) || minDiff >= 0.01) return '0.01';
  if (minDiff >= 0.001) return '0.001';
  if (minDiff >= 0.0001) return '0.0001';
  return '0.0001';
}

function buildCrossingBuy(asks: readonly number[], crossLevels: number): { bestAsk: number | null; referenceAsk: number | null; price: number; tick: TickSize } {
  const bestAsk = asks[0] ?? null;
  const refIndex = Math.min(Math.max(0, crossLevels - 1), Math.max(0, asks.length - 1));
  const referenceAsk = asks[refIndex] ?? bestAsk;
  const tick = inferTick(asks);
  if (referenceAsk === null || !Number.isFinite(referenceAsk)) {
    throw new Error('Orderbook has no asks');
  }
  const tickNum = Number(tick);
  const rawPrice = Math.min(0.99, referenceAsk + tickNum);
  const rounded = Math.ceil(rawPrice / tickNum) * tickNum;
  return {
    bestAsk,
    referenceAsk,
    price: Number(Math.min(0.99, rounded).toFixed(4)),
    tick,
  };
}

function extractTradeOrderIds(trade: {
  taker_order_id?: string;
  maker_orders?: Array<{ order_id: string }>;
}): string[] {
  const ids: string[] = [];
  if (typeof trade.taker_order_id === 'string') ids.push(trade.taker_order_id);
  if (Array.isArray(trade.maker_orders)) {
    for (const entry of trade.maker_orders) {
      if (typeof entry?.order_id === 'string') ids.push(entry.order_id);
    }
  }
  return ids;
}

async function discoverToken(): Promise<DiscoveredToken | null> {
  const explicit = readArg('token');
  if (explicit) return { tokenId: explicit, question: 'explicit --token' };

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

  const marketDataClient = new PolymarketMarketDataRestClient({ baseUrl: GAMMA_URL }, logger);
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
  return {
    tokenId: first.allTokenIds?.[0] ?? String(first.instrumentId),
    question: first.question,
  };
}

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
    console.log(`DNS override skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  const token = await discoverToken();
  if (!token) {
    console.error('No token discovered. Pass --token=<asset_id> explicitly.');
    process.exit(1);
  }

  const signer = new Wallet(PRIVATE_KEY!);
  const signatureType = FUNDER_ADDRESS ? SignatureType.POLY_PROXY : SignatureType.EOA;
  const clobClient = new ClobClient(
    REST_URL,
    137,
    signer as any,
    { key: API_KEY!, secret: API_SECRET!, passphrase: API_PASSPHRASE! },
    signatureType,
    FUNDER_ADDRESS,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );

  console.log(`Token: ${token.tokenId}`);
  console.log(`Source: ${token.question}`);
  console.log(`Maker address: ${FUNDER_ADDRESS ?? signer.address}`);
  console.log('');

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    console.log(`Attempt ${attempt}/${ATTEMPTS}`);

    const book = await clobClient.getOrderBook(token.tokenId);
    const bids = book.bids.map((level) => Number(level.price));
    const asks = book.asks.map((level) => Number(level.price));
    const bestBid = bids[0] ?? null;
    const planned = buildCrossingBuy(asks, CROSS_LEVELS);

    console.log(`  Book: bid=${formatPrice(bestBid)} ask=${formatPrice(planned.bestAsk)} refAsk=${formatPrice(planned.referenceAsk)} tick=${planned.tick}`);
    console.log(`  Order: BUY ${SIZE} @ ${planned.price.toFixed(4)} postOnly=true via official client`);

    try {
      const response = await clobClient.createAndPostOrder(
        {
          tokenID: token.tokenId,
          price: planned.price,
          side: Side.BUY,
          size: SIZE,
        },
        {
          tickSize: book.tick_size as TickSize,
          negRisk: book.neg_risk,
        },
        OrderType.GTC,
        true,
        true,
      );

      const orderId = response?.orderID;
      const status = response?.status;
      console.log(`  Submit: ACCEPTED orderId=${orderId} status=${status}`);

      let matchedTradeSide: string | undefined;
      let confirmed = false;
      if (typeof orderId === 'string' && orderId.length > 0) {
        for (let round = 1; round <= POLL_ROUNDS; round++) {
          if (round > 1) await sleep(POLL_DELAY_MS);
          try {
            const trades = await clobClient.getTrades({ asset_id: token.tokenId }, true);
            const hit = trades.find((trade: any) => extractTradeOrderIds(trade).includes(orderId));
            if (hit) {
              matchedTradeSide = hit.trader_side;
              confirmed = true;
              break;
            }
          } catch {
            // ignore
          }
        }
      }

      if (confirmed) {
        console.log(`  Outcome: FILLED via official getTrades trader_side=${matchedTradeSide ?? 'n/a'}`);
      } else {
        console.log(`  Outcome: ACCEPTED status=${status} (trade confirmation not found immediately)`);
      }
    } catch (error) {
      console.log(`  Submit: REJECTED ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log('');
  }

  dnsOverride.uninstall();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
