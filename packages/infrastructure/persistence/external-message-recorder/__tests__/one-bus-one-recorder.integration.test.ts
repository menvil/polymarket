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
import { decodeDetachedArchiveLine, decodeRawArchive } from '@polymarket/raw-archive-format';
import { ExternalMessageRecorder } from '../src/index.js';
import { CapturingLogger } from './helpers/fakes.js';
import {
  MARKET_CONDITION_ID,
  createBinanceEvent,
  createBookEvent,
  createChainlinkEvent,
} from './helpers/sdkFixtures.js';

type ContourMessage = PolymarketExternalMessage | CexExternalMessage;

/**
 * Короткое ТЕСТОВОЕ окно CEX-политики (production default 5 минут не
 * меняется). Запас в 2s существенен: publish/flush/ассерты первой фазы
 * обязаны уложиться ВНУТРИ одного окна даже под нагрузкой параллельных
 * suite-ов — иначе boundary-sweep начнёт ротацию прямо во время чтения
 * незавершённого `.jsonl` (источник flake при 600ms).
 */
const WINDOW_MS = 2_000;

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

    // ── Polymarket market-session файл: V2-наблюдение SDK-события ──
    const marketFiles = listTree(polymarketDir).filter((f) => f.endsWith('.jsonl'));
    expect(marketFiles).toHaveLength(1);
    expect(marketFiles[0]).toContain(`${path.sep}polymarket${path.sep}`);
    const marketLines = fs.readFileSync(marketFiles[0]!, 'utf8').trimEnd().split('\n');
    expect(marketLines).toHaveLength(2); // header + наблюдение
    const marketObservation = decodeDetachedArchiveLine(marketLines[1]!);
    expect(marketObservation?.timingQuality).toBe('EXACT_INGRESS');
    expect(marketObservation?.type).toBe('POLYMARKET_MARKET');
    expect(marketObservation?.ingress?.runId).toBe(generator.runId);
    expect(marketObservation?.payload).toEqual(JSON.parse(JSON.stringify(sdkEvent)));
    // CEX-данные в market-файл не утекли
    expect(marketLines[1]).not.toContain('exchangeId');

    // ── CEX оконные партиции: orderbook и trades раздельно (TEST D/E) ──
    const cexFiles = listTree(cexDir).filter((f) => f.endsWith('.jsonl'));
    expect(cexFiles).toHaveLength(2);
    const obFile = cexFiles.find((f) => f.includes('_orderbook_'))!;
    const tradeFile = cexFiles.find((f) => f.includes('_trades_'))!;
    expect(obFile).toContain(`${path.sep}binance${path.sep}binance_BTC-USDT-USDT_swap_orderbook_`);

    const obLines = fs.readFileSync(obFile, 'utf8').trimEnd().split('\n');
    const tradeLines = fs.readFileSync(tradeFile, 'utf8').trimEnd().split('\n');
    const obArchive = decodeRawArchive(obLines);
    const tradeArchive = decodeRawArchive(tradeLines);
    // TEST H: каждая партиция объявляет формат и routing identity в LINE 1
    expect(obArchive.format.formatVersion).toBe(2);
    expect(obArchive.format.header).toMatchObject({
      t: 'meta',
      source: 'CEX',
      exchangeId: 'binance',
      marketType: 'swap',
      symbol: 'BTC/USDT:USDT',
      stream: 'orderbook',
    });
    expect(tradeArchive.format.header).toMatchObject({ stream: 'trades' });
    // TEST D/E: наблюдение = type + ingress + НЕТРОНУТЫЙ payload
    expect(obArchive.observations).toHaveLength(1);
    expect(obArchive.observations[0]!.type).toBe('CEX_ORDERBOOK');
    expect(obArchive.observations[0]!.payload).toEqual(JSON.parse(JSON.stringify(OB_PAYLOAD)));
    expect(tradeArchive.observations[0]!.type).toBe('CEX_TRADE');
    expect(tradeArchive.observations[0]!.payload).toEqual(
      JSON.parse(JSON.stringify(TRADE_PAYLOAD)),
    );
    // Live-only metadata в строки не утекла
    for (const line of [obLines[1]!, tradeLines[1]!]) {
      expect(line).not.toContain('messageId');
      expect(line).not.toContain('correlationId');
      expect(line).not.toContain('"metadata"');
    }
    // Polymarket-данные в CEX-партиции не утекли
    expect(obLines[1]).not.toContain('"topic":"market"');

    // ── Разные lifecycle-политики одного сервиса ──
    // Polymarket: finalize EXPIRED → архив market-датасета
    await recorder.finalizeMarket(unsafeMarketId(MARKET_CONDITION_ID), 'EXPIRED');
    const marketArchives = listTree(polymarketDir).filter((f) => f.endsWith('.jsonl.gz'));
    expect(marketArchives).toHaveLength(1);

    // CEX: партиция завершается ГРАНИЦЕЙ ОКНА (никакого finalize)
    await waitFor(
      () => listTree(cexDir).filter((f) => f.endsWith('.jsonl.gz')).length === 2,
      3 * WINDOW_MS,
    );
    const cexArchives = listTree(cexDir).filter((f) => f.endsWith('.jsonl.gz'));
    const obGz = cexArchives.find((f) => f.includes('_orderbook_'))!;
    const gzLines = zlib
      .gunzipSync(fs.readFileSync(obGz))
      .toString('utf8')
      .trimEnd()
      .split('\n');
    const gzArchive = decodeRawArchive(gzLines);
    expect(gzArchive.format.formatVersion).toBe(2);
    expect(gzArchive.observations.map((observation) => observation.payload)).toEqual([
      JSON.parse(JSON.stringify(OB_PAYLOAD)),
    ]);

    // ── Счётчики обеих политик одного сервиса ──
    expect(recorder.getStats().marketMessagesRouted).toBe(1);
    expect(recorder.getStats().recordsWritten).toBe(1);
    expect(recorder.getCexStats().cexMessagesRouted).toBe(2);
    expect(recorder.getCexStats().cexRecordsAccepted).toBe(2);

    // ── Один shutdown закрывает обе политики ──
    await recorder.close();
    expect(cexStorage.isClosed).toBe(true);
    // Незавершённых .jsonl не осталось ни в одном storage
    expect(listTree(polymarketDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(0);
    expect(listTree(cexDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(0);
  });

  it('RTDS коэкзистирует с CEX-политикой: fan-out в market-файлы, без утечки в партиции', async () => {
    // CHECKPOINT #1 gap-тест (§24): существующая coexistence-интеграция
    // покрывала PM market + CEX, но НЕ RTDS-фиды на той же композиции.
    const SECOND_MARKET_ID = '0x00000000000000000000000000000000000000000000000000000000000000b2';
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID),
      rtdsFeeds: [
        { topic: 'prices.crypto.binance', symbol: 'btcusdt' },
        { topic: 'prices.crypto.chainlink', symbol: 'btc/usd' },
      ],
    });
    recorder.registerMarket({
      marketMeta: makeMeta(SECOND_MARKET_ID),
      rtdsFeeds: [{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }],
    });

    const firstBoundary = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS + WINDOW_MS;
    await waitFor(() => Date.now() >= firstBoundary + 30);

    const marketEvent = createBookEvent();
    const binanceEvent = createBinanceEvent(); // btcusdt → оба рынка (fan-out)
    const chainlinkEvent = createChainlinkEvent(); // btc/usd → только первый рынок
    const unroutedEvent = createBinanceEvent({ symbol: 'ethusdt' }); // фид не зарегистрирован
    expect(
      (
        await bus.publish({
          type: 'POLYMARKET_MARKET',
          payload: marketEvent,
          metadata: generator.nextRoot(),
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await bus.publish({
          type: 'POLYMARKET_CRYPTO_BINANCE',
          payload: binanceEvent,
          metadata: generator.nextRoot(),
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await bus.publish({
          type: 'POLYMARKET_CRYPTO_CHAINLINK',
          payload: chainlinkEvent,
          metadata: generator.nextRoot(),
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await bus.publish({
          type: 'POLYMARKET_CRYPTO_BINANCE',
          payload: unroutedEvent,
          metadata: generator.nextRoot(),
        })
      ).ok,
    ).toBe(true);
    await bus.publish({ type: 'CEX_ORDERBOOK', payload: OB_PAYLOAD, metadata: generator.nextRoot() });
    await marketStorage.flush();
    await cexStorage.flush();

    // ── Market-файлы: у каждого рынка свой набор RTDS-строк, payload-only ──
    const marketFiles = listTree(polymarketDir).filter((f) => f.endsWith('.jsonl'));
    expect(marketFiles).toHaveLength(2);
    const byMarket = new Map<string, string[]>();
    for (const file of marketFiles) {
      const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
      const header = JSON.parse(lines[0]!) as { marketId?: string };
      byMarket.set(header.marketId ?? '', lines.slice(1));
    }
    const firstLines = byMarket.get(MARKET_CONDITION_ID)!;
    const secondLines = byMarket.get(SECOND_MARKET_ID)!;
    // Первый рынок: market event + оба RTDS-фида (нетронутые payload-ы)
    const payloadsOf = (lines: readonly string[]): unknown[] =>
      lines.map((line) => decodeDetachedArchiveLine(line)?.payload);
    expect(payloadsOf(firstLines)).toEqual([
      JSON.parse(JSON.stringify(marketEvent)),
      JSON.parse(JSON.stringify(binanceEvent)),
      JSON.parse(JSON.stringify(chainlinkEvent)),
    ]);
    // Второй рынок: ТОЛЬКО общий binance-фид (fan-out одной строкой)
    expect(payloadsOf(secondLines)).toEqual([JSON.parse(JSON.stringify(binanceEvent))]);
    for (const line of [...firstLines, ...secondLines]) {
      expect(line).not.toContain('exchangeId');
      expect(line).not.toContain('messageId');
    }

    // ── RTDS не утёк в CEX-партиции; CEX-политика жива в той же композиции ──
    const cexFiles = listTree(cexDir).filter((f) => f.endsWith('.jsonl'));
    expect(cexFiles).toHaveLength(1);
    const cexContent = fs.readFileSync(cexFiles[0]!, 'utf8');
    expect(cexContent).not.toContain('prices.crypto');
    expect(cexContent).toContain('"exchangeId":"binance"');

    // ── Счётчики: 2 routed RTDS-сообщения, 1 unrouted, fan-out по файлам ──
    const stats = recorder.getStats();
    expect(stats.marketMessagesRouted).toBe(1);
    expect(stats.rtdsMessagesRouted).toBe(2);
    expect(stats.unroutedRtdsMessages).toBe(1);
    // recordsWritten: market(1) + binance fan-out(2 файла) + chainlink(1)
    expect(stats.recordsWritten).toBe(4);
    expect(recorder.getCexStats().cexMessagesRouted).toBe(1);

    // ── Finalize первого рынка не трогает второй (общий фид сохраняется) ──
    await recorder.finalizeMarket(unsafeMarketId(MARKET_CONDITION_ID), 'EXPIRED');
    const lateBinanceEvent = createBinanceEvent({ value: '64999.99' });
    await bus.publish({
      type: 'POLYMARKET_CRYPTO_BINANCE',
      payload: lateBinanceEvent,
      metadata: generator.nextRoot(),
    });
    await marketStorage.flush();
    // Первый рынок заархивирован; второй остаётся активным .jsonl и получил
    // позднее RTDS-событие общего фида (routing первого снят per-feed)
    expect(listTree(polymarketDir).filter((f) => f.endsWith('.jsonl.gz'))).toHaveLength(1);
    const activeFiles = listTree(polymarketDir).filter((f) => f.endsWith('.jsonl'));
    expect(activeFiles).toHaveLength(1);
    const activeLines = fs.readFileSync(activeFiles[0]!, 'utf8').trimEnd().split('\n');
    expect((JSON.parse(activeLines[0]!) as { marketId?: string }).marketId).toBe(SECOND_MARKET_ID);
    expect(
      activeLines.slice(1).map((line) => decodeDetachedArchiveLine(line)?.payload),
    ).toEqual([
      JSON.parse(JSON.stringify(binanceEvent)),
      JSON.parse(JSON.stringify(lateBinanceEvent)),
    ]);
    expect(recorder.getStats().rtdsMessagesRouted).toBe(3);
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
