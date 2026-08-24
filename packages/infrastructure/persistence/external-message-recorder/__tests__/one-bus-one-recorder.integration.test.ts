/**
 * Coexistence-интеграция N-005 PART 25: Polymarket + CEX на ОДНОМ
 * ExternalMessageBus через ОДИН ExternalMessageRecorder.
 *
 * @remarks
 * Реальный pipeline без fake-ов и кастов:
 *
 * ```text
 * publish(POLYMARKET_MARKET | CEX_ORDERBOOK | CEX_TRADE)
 *        → ExternalMessageBus<PolymarketExternalMessage | CexExternalMessage>
 *        → ExternalMessageRecorder (один сервис, обе политики)
 *            ↙ DataRecorder (market-session)     ↘ CexWindowRecorder (окна)
 *        market JSONL(.gz)                        оконные JSONL.gz
 * ```
 *
 * Доказывается: корректная маршрутизация обеих семей сообщений, отсутствие
 * cross-routing, payload-only строки в обоих storage, независимые
 * lifecycle-политики (finalize EXPIRED против оконной ротации), один
 * shutdown всего сервиса.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { LiveClock } from '@polymarket/time';
import { unsafeMarketId } from '@polymarket/ids';
import {
  CexWindowRecorder,
  DataRecorder,
  GzipCompressor,
  NDJSONFormatter,
} from '@polymarket/data-collection';
import type { MarketMeta } from '@polymarket/ports';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import type { CexExternalMessage, CexOrderbookPayload, CexTradePayload } from '@polymarket/cex-v2';
import { ExternalMessageRecorder } from '../src/index.js';
import { CapturingLogger } from './helpers/fakes.js';
import { MARKET_CONDITION_ID, createBookEvent } from './helpers/sdkFixtures.js';

type ContourMessage = PolymarketExternalMessage | CexExternalMessage;

/** Короткое ТЕСТОВОЕ окно CEX-политики (production default 5 минут не меняется). */
const WINDOW_MS = 600;

let polymarketDir: string;
let cexDir: string;
let bus: ExternalMessageBus<ContourMessage>;
let logger: CapturingLogger;
let generator: MessageMetadataGenerator;
let marketStorage: DataRecorder;
let cexStorage: CexWindowRecorder;
let recorder: ExternalMessageRecorder;

beforeEach(() => {
  polymarketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n005-poly-'));
  cexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n005-cex-'));
  logger = new CapturingLogger();
  bus = new ExternalMessageBus<ContourMessage>();
  generator = new MessageMetadataGenerator({ clock: new LiveClock() });

  marketStorage = new DataRecorder(
    {
      outputDir: polymarketDir,
      sourceSubDir: 'polymarket',
      bufferSize: 100,
      flushIntervalMs: 60_000,
      compression: 'gzip',
      formatVersion: 2,
    },
    new NDJSONFormatter(),
    new GzipCompressor(),
    logger,
  );
  cexStorage = new CexWindowRecorder(
    {
      outputDir: cexDir,
      compression: 'gzip',
      windowMinutes: WINDOW_MS / 60_000,
      flushIntervalMs: 50,
    },
    logger,
  );

  // ОДИН bus и ОДИН recorder: CEX-порты указывают на тот же объект bus —
  // никаких кастов, второй bus/recorder не создаются
  recorder = new ExternalMessageRecorder({
    bus,
    storage: marketStorage,
    logger,
    cex: { bus, storage: cexStorage },
  });
});

afterEach(async () => {
  await recorder.close();
  fs.rmSync(polymarketDir, { recursive: true, force: true });
  fs.rmSync(cexDir, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function listTree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function makeMeta(marketId: string): MarketMeta {
  return {
    marketId: unsafeMarketId(marketId),
    question: 'Will BTC go up?',
    tokenIds: ['tok-up', 'tok-down'],
    expiresAt: { toNumber: () => 9999999999999 } as never,
  };
}

const OB_PAYLOAD: CexOrderbookPayload = {
  exchangeId: 'binance',
  marketType: 'swap',
  symbol: 'BTC/USDT:USDT',
  orderBook: {
    symbol: 'BTC/USDT:USDT',
    timestamp: 1_756_000_000_000,
    bids: [[64_000, 1.5]],
    asks: [[64_001, 2]],
  },
};

const TRADE_PAYLOAD: CexTradePayload = {
  exchangeId: 'binance',
  marketType: 'swap',
  symbol: 'BTC/USDT:USDT',
  trade: {
    id: 'trade-1',
    symbol: 'BTC/USDT:USDT',
    price: 64_000.5,
    amount: 0.25,
    side: 'sell',
    info: { vendor: true },
  },
};

describe('one bus / one recorder (PART 25)', () => {
  it('Polymarket → market-session storage; CEX → оконный storage; без cross-routing', async () => {
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID) });

    // Оконная политика принимает записи с первой границы окна
    const firstBoundary = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS + WINDOW_MS;
    await waitFor(() => Date.now() >= firstBoundary + 30);

    const sdkEvent = createBookEvent();
    expect((await bus.publish({
      type: 'POLYMARKET_MARKET',
      payload: sdkEvent,
      metadata: generator.nextRoot(),
    })).ok).toBe(true);
    expect((await bus.publish({
      type: 'CEX_ORDERBOOK',
      payload: OB_PAYLOAD,
      metadata: generator.nextRoot(),
    })).ok).toBe(true);
    expect((await bus.publish({
      type: 'CEX_TRADE',
      payload: TRADE_PAYLOAD,
      metadata: generator.nextRoot(),
    })).ok).toBe(true);

    await marketStorage.flush();
    await cexStorage.flush();

    // ── Polymarket market-session файл: только SDK payload ──
    const marketFiles = listTree(polymarketDir).filter((f) => f.endsWith('.jsonl'));
    expect(marketFiles).toHaveLength(1);
    expect(marketFiles[0]).toContain(`${path.sep}polymarket${path.sep}`);
    const marketLines = fs.readFileSync(marketFiles[0]!, 'utf8').trimEnd().split('\n');
    expect(marketLines).toHaveLength(2); // header + событие
    expect(JSON.parse(marketLines[1]!)).toEqual(JSON.parse(JSON.stringify(sdkEvent)));
    // CEX-данные в market-файл не утекли
    expect(marketLines[1]).not.toContain('exchangeId');

    // ── CEX оконные партиции: orderbook и trades раздельно, payload-only ──
    const cexFiles = listTree(cexDir).filter((f) => f.endsWith('.jsonl'));
    expect(cexFiles).toHaveLength(2);
    const obFile = cexFiles.find((f) => f.includes('_orderbook_'))!;
    const tradeFile = cexFiles.find((f) => f.includes('_trades_'))!;
    expect(obFile).toContain(`${path.sep}binance${path.sep}binance_BTC-USDT-USDT_swap_orderbook_`);

    const obLine = fs.readFileSync(obFile, 'utf8').trimEnd();
    expect(obLine).toBe(JSON.stringify(OB_PAYLOAD));
    const tradeLine = fs.readFileSync(tradeFile, 'utf8').trimEnd();
    expect(tradeLine).toBe(JSON.stringify(TRADE_PAYLOAD));
    // Runtime metadata/envelope в строки не утекли
    for (const line of [obLine, tradeLine]) {
      expect(line).not.toContain('messageId');
      expect(line).not.toContain('CEX_ORDERBOOK');
      expect(line).not.toContain('metadata');
    }
    // Polymarket-данные в CEX-партиции не утекли
    expect(obLine).not.toContain('"topic":"market"');

    // ── Разные lifecycle-политики одного сервиса ──
    // Polymarket: finalize EXPIRED → архив market-датасета
    await recorder.finalizeMarket(unsafeMarketId(MARKET_CONDITION_ID), 'EXPIRED');
    const marketArchives = listTree(polymarketDir).filter((f) => f.endsWith('.jsonl.gz'));
    expect(marketArchives).toHaveLength(1);

    // CEX: партиция завершается ГРАНИЦЕЙ ОКНА (никакого finalize)
    await waitFor(() => listTree(cexDir).filter((f) => f.endsWith('.jsonl.gz')).length === 2);
    const cexArchives = listTree(cexDir).filter((f) => f.endsWith('.jsonl.gz'));
    const obGz = cexArchives.find((f) => f.includes('_orderbook_'))!;
    const gzLines = zlib
      .gunzipSync(fs.readFileSync(obGz))
      .toString('utf8')
      .trimEnd()
      .split('\n');
    expect(gzLines).toEqual([JSON.stringify(OB_PAYLOAD)]);

    // ── Счётчики обеих политик одного сервиса ──
    expect(recorder.getStats().marketMessagesRouted).toBe(1);
    expect(recorder.getStats().recordsWritten).toBe(1);
    expect(recorder.getCexStats().cexMessagesRouted).toBe(2);
    expect(recorder.getCexStats().cexRecordsWritten).toBe(2);

    // ── Один shutdown закрывает обе политики ──
    await recorder.close();
    expect(cexStorage.isClosed).toBe(true);
    // Незавершённых .jsonl не осталось ни в одном storage
    expect(listTree(polymarketDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(0);
    expect(listTree(cexDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(0);
  });

  it('мульти-биржа: routing identity payload разводит партиции бирж', async () => {
    recorder.start();
    const firstBoundary = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS + WINDOW_MS;
    await waitFor(() => Date.now() >= firstBoundary + 30);

    await bus.publish({
      type: 'CEX_ORDERBOOK',
      payload: OB_PAYLOAD,
      metadata: generator.nextRoot(),
    });
    await bus.publish({
      type: 'CEX_ORDERBOOK',
      payload: { ...OB_PAYLOAD, exchangeId: 'bybit', marketType: 'spot', symbol: 'BTC/USDT' },
      metadata: generator.nextRoot(),
    });
    await cexStorage.flush();

    const files = listTree(cexDir).filter((f) => f.endsWith('.jsonl'));
    expect(files).toHaveLength(2);
    const binanceFile = files.find((f) => f.includes(`${path.sep}binance${path.sep}`))!;
    const bybitFile = files.find((f) => f.includes(`${path.sep}bybit${path.sep}`))!;
    expect(fs.readFileSync(binanceFile, 'utf8')).toContain('"exchangeId":"binance"');
    expect(fs.readFileSync(bybitFile, 'utf8')).toContain('"exchangeId":"bybit"');
    expect(fs.readFileSync(bybitFile, 'utf8')).not.toContain('"exchangeId":"binance"');
  });
});
