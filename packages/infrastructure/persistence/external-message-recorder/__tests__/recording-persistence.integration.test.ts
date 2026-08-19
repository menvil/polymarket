/**
 * Интеграционные persistence-тесты: РЕАЛЬНЫЙ pipeline
 * ExternalMessageBus → ExternalMessageRecorder → DataRecorder → диск.
 *
 * @remarks
 * Главные регрессии N-002:
 * - PART 31 exact payload parity: строка файла deepEqual
 *   `JSON.parse(JSON.stringify(sdkEvent))` — source-native representation;
 * - PART 14: строки 2+ НЕ содержат outer envelope
 *   (`POLYMARKET_MARKET`/messageId/runId/sequence/correlationId/causationId);
 * - PART 15 arrival order: порядок строк = порядок публикации, не timestamp;
 * - PART 24 RTDS duplication: одно событие → по одной строке в каждый файл;
 * - PART 32 header update: in-place без изменения payload-строк;
 * - PART 19/TEST E finalize: буфер флашится до gzip, данные не теряются;
 * - PART 20: EXPIRED → архив остаётся, незавершённые файлы удаляются при close.
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
import { DataRecorder, NDJSONFormatter, GzipCompressor } from '@polymarket/data-collection';
import type { DataRecorderConfig } from '@polymarket/data-collection';
import type { MarketMeta } from '@polymarket/ports';
import type {
  PolymarketExternalMessage,
  StandardMarketEvent,
  CryptoPricesBinanceEvent,
  CryptoPricesChainlinkEvent,
} from '@polymarket/polymarket-v2';
import { ExternalMessageRecorder } from '../src/index.js';
import { CapturingLogger } from './helpers/fakes.js';
import {
  MARKET_CONDITION_ID,
  MARKET_CONDITION_ID_B,
  createBookEvent,
  createPriceChangeEvent,
  createBinanceEvent,
  createChainlinkEvent,
} from './helpers/sdkFixtures.js';

const META_RESERVED_BYTES = 16 * 1024;

let tmpDir: string;
let bus: ExternalMessageBus<PolymarketExternalMessage>;
let storage: DataRecorder;
let logger: CapturingLogger;
let recorder: ExternalMessageRecorder;
let generator: MessageMetadataGenerator;

beforeEach(() => {
  // Сбрасываем привязки прошлого теста: afterEach не должен закрывать/
  // переиспользовать экземпляры предыдущего кейса, если текущий упал до создания
  recorder = undefined as unknown as ExternalMessageRecorder;
  storage = undefined as unknown as DataRecorder;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n002-recording-'));
  logger = new CapturingLogger();
  bus = new ExternalMessageBus<PolymarketExternalMessage>();
  generator = new MessageMetadataGenerator({ clock: new LiveClock() });
});

afterEach(async () => {
  try {
    await recorder?.close();
  } catch {
    // already closed
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeStorage(overrides: Partial<DataRecorderConfig> = {}): DataRecorder {
  const config: DataRecorderConfig = {
    outputDir: tmpDir,
    bufferSize: 100,
    flushIntervalMs: 60_000,
    compression: 'none',
    formatVersion: 2,
    ...overrides,
  };
  storage = new DataRecorder(config, new NDJSONFormatter(), new GzipCompressor(), logger);
  return storage;
}

function makeMeta(marketId: string, question: string, rawMarket?: Record<string, unknown>): MarketMeta {
  return {
    marketId: unsafeMarketId(marketId),
    question,
    tokenIds: ['tok-up', 'tok-down'],
    expiresAt: { toNumber: () => 9999999999999 } as never,
    ...(rawMarket !== undefined ? { rawMarket } : {}),
  };
}

async function publish(message: PolymarketExternalMessage): Promise<void> {
  const result = await bus.publish(message);
  expect(result.ok).toBe(true);
}

function marketMessage(event: StandardMarketEvent): PolymarketExternalMessage {
  return { type: 'POLYMARKET_MARKET', payload: event, metadata: generator.nextRoot() };
}

function rtdsMessage(
  event: CryptoPricesBinanceEvent | CryptoPricesChainlinkEvent,
): PolymarketExternalMessage {
  return event.topic === 'prices.crypto.binance'
    ? { type: 'POLYMARKET_CRYPTO_BINANCE', payload: event, metadata: generator.nextRoot() }
    : { type: 'POLYMARKET_CRYPTO_CHAINLINK', payload: event, metadata: generator.nextRoot() };
}

/** Файлы date-директории текущего дня. */
function listFiles(): string[] {
  const today = new Date().toISOString().slice(0, 10);
  const dir = path.join(tmpDir, today);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => path.join(dir, name));
}

/** Строки .jsonl-файла рынка (по подстроке marketId в имени). */
function readLines(marketIdPart: string): string[] {
  const file = listFiles().find((f) => f.includes(marketIdPart.slice(0, 40)) && f.endsWith('.jsonl'));
  expect(file).toBeDefined();
  return fs.readFileSync(file!, 'utf-8').trimEnd().split('\n');
}

// ── PART 31 + PART 14: exact payload parity, no outer envelope ──────────────

describe('exact payload parity (PART 31)', () => {
  it('записанная строка deepEqual source-native SDK payload; identity в памяти сохранена', async () => {
    recorder = new ExternalMessageRecorder({ bus, storage: makeStorage(), logger });
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID, 'Will BTC go up?') });

    const sdkEvent = createBookEvent();
    const message = marketMessage(sdkEvent);
    // In-memory identity: payload сообщения — ТОТ ЖЕ объект SDK-события
    expect(message.payload).toBe(sdkEvent);
    await publish(message);
    await storage.flush();

    const lines = readLines(MARKET_CONDITION_ID);
    expect(lines).toHaveLength(2);
    // Именно source-native representation, не "semantically similar"
    expect(JSON.parse(lines[1]!)).toEqual(JSON.parse(JSON.stringify(sdkEvent)));
  });

  it('строки 2+ не содержат outer envelope: type/metadata остаются runtime-only (PART 14)', async () => {
    recorder = new ExternalMessageRecorder({ bus, storage: makeStorage(), logger });
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID, 'Will BTC go up?') });

    const message = marketMessage(createBookEvent());
    await publish(message);
    await storage.flush();

    const rawLine = readLines(MARKET_CONDITION_ID)[1]!;
    // Outer routing discriminator НЕ записан
    expect(rawLine).not.toContain('POLYMARKET_MARKET');
    // Canonical runtime metadata НЕ записана (ни ключи, ни значения)
    for (const forbiddenKey of [
      '"messageId"',
      '"runId"',
      '"sequence"',
      '"createdAt"',
      '"correlationId"',
      '"causationId"',
      '"metadata"',
    ]) {
      expect(rawLine).not.toContain(forbiddenKey);
    }
    expect(rawLine).not.toContain(String(message.metadata.messageId));

    // Vendor discriminators payload-а при этом СОХРАНЕНЫ
    const parsed = JSON.parse(rawLine) as { topic: string; type: string };
    expect(parsed.topic).toBe('market');
    expect(parsed.type).toBe('book');
    expect(Object.keys(parsed).sort()).toEqual(['payload', 'topic', 'type']);
  });
});

// ── Header (PART 9/10/32) ───────────────────────────────────────────────────

describe('first-line header (PART 32)', () => {
  it('header V2: formatVersion=2, market identity, reserved 16KiB block', async () => {
    recorder = new ExternalMessageRecorder({ bus, storage: makeStorage(), logger });
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID, 'Will BTC go up?', { slug: 'btc-up' }),
    });
    await storage.flush();

    const file = listFiles().find((f) => f.endsWith('.jsonl'))!;
    const buf = fs.readFileSync(file);
    // Reserved fixed-width block: '\n' ровно на последнем байте блока
    expect(buf.indexOf(0x0a)).toBe(META_RESERVED_BYTES - 1);

    const header = JSON.parse(buf.subarray(0, META_RESERVED_BYTES).toString('utf-8')) as Record<string, unknown>;
    expect(header['t']).toBe('meta');
    expect(header['formatVersion']).toBe(2);
    expect(header['marketId']).toBe(MARKET_CONDITION_ID);
    expect(header['question']).toBe('Will BTC go up?');
    expect(header['tokenIds']).toEqual(['tok-up', 'tok-down']);
    expect(header['m']).toEqual({ slug: 'btc-up' });
  });

  it('updateMarketMeta переписывает header in-place, payload-строки байт-в-байт неизменны', async () => {
    recorder = new ExternalMessageRecorder({ bus, storage: makeStorage(), logger });
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID, 'Will BTC go up?', { priceToBeat: null }),
    });
    await publish(marketMessage(createBookEvent()));
    await publish(marketMessage(createPriceChangeEvent()));
    await storage.flush();

    const file = listFiles().find((f) => f.endsWith('.jsonl'))!;
    const before = fs.readFileSync(file);
    const payloadBytesBefore = before.subarray(META_RESERVED_BYTES);

    await recorder.updateMarketMeta(unsafeMarketId(MARKET_CONDITION_ID), {
      priceToBeat: 64000,
      finalPrice: 64123.5,
    });

    const after = fs.readFileSync(file);
    // Header обновлён
    const header = JSON.parse(after.subarray(0, META_RESERVED_BYTES).toString('utf-8')) as Record<string, unknown>;
    expect(header['m']).toEqual({ priceToBeat: 64000, finalPrice: 64123.5 });
    expect(header['formatVersion']).toBe(2);
    // Reserved block contract сохранён
    expect(after.indexOf(0x0a)).toBe(META_RESERVED_BYTES - 1);
    // Payload-строки НЕ переписаны (байт-в-байт)
    expect(after.subarray(META_RESERVED_BYTES).equals(payloadBytesBefore)).toBe(true);

    // Последующие записи по-прежнему читаемы
    await publish(marketMessage(createBookEvent({ hash: '0xafter-update' })));
    await storage.flush();
    const lines = readLines(MARKET_CONDITION_ID);
    expect(lines).toHaveLength(4);
    expect((JSON.parse(lines[3]!) as { payload: { hash: string } }).payload.hash).toBe('0xafter-update');
  });

  it('oversize meta не помещается в reserved block → warn, header не тронут', async () => {
    recorder = new ExternalMessageRecorder({ bus, storage: makeStorage(), logger });
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID, 'Will BTC go up?') });
    await storage.flush();

    const file = listFiles().find((f) => f.endsWith('.jsonl'))!;
    const before = fs.readFileSync(file);

    await recorder.updateMarketMeta(unsafeMarketId(MARKET_CONDITION_ID), {
      blob: 'x'.repeat(META_RESERVED_BYTES),
    });

    expect(
      logger.byLevel('warn').some((e) => e.message.includes('meta exceeds reserved first-line block')),
    ).toBe(true);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});

// ── Arrival order (PART 15) ─────────────────────────────────────────────────

describe('arrival order (PART 15)', () => {
  it('market и RTDS строки идут в порядке публикации, не по source-timestamp', async () => {
    recorder = new ExternalMessageRecorder({ bus, storage: makeStorage(), logger });
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID, 'Will BTC go up?'),
      rtdsFeeds: [{ topic: 'prices.crypto.binance', symbol: 'btcusdt' }],
    });

    // source-timestamps намеренно в ОБРАТНОМ порядке относительно публикации
    await publish(marketMessage(createBookEvent({ hash: 'h-late', timestamp: 3_000 })));
    await publish(rtdsMessage(createBinanceEvent({ timestamp: 1_000 })));
    await publish(marketMessage(createBookEvent({ hash: 'h-mid', timestamp: 2_000 })));
    await storage.flush();

    const kinds = readLines(MARKET_CONDITION_ID)
      .slice(1)
      .map((line) => {
        const parsed = JSON.parse(line) as { topic: string; payload: { hash?: string } };
        return parsed.topic === 'market' ? `market:${parsed.payload.hash}` : parsed.topic;
      });
    expect(kinds).toEqual(['market:h-late', 'prices.crypto.binance', 'market:h-mid']);
  });
});

// ── RTDS duplication на реальных файлах (PART 24) ───────────────────────────

describe('RTDS duplication (PART 24)', () => {
  it('одно событие → ровно одна строка в каждом из двух market-файлов', async () => {
    recorder = new ExternalMessageRecorder({ bus, storage: makeStorage(), logger });
    recorder.start();
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID, 'Will BTC go up 10AM?'),
      rtdsFeeds: [{ topic: 'prices.crypto.chainlink', symbol: 'btc/usd' }],
    });
    recorder.registerMarket({
      marketMeta: makeMeta(MARKET_CONDITION_ID_B, 'Will BTC go up 11AM?'),
      rtdsFeeds: [{ topic: 'prices.crypto.chainlink', symbol: 'btc/usd' }],
    });

    const event = createChainlinkEvent();
    await publish(rtdsMessage(event));
    await storage.flush();

    for (const marketId of [MARKET_CONDITION_ID, MARKET_CONDITION_ID_B]) {
      const lines = readLines(marketId);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]!)).toEqual(JSON.parse(JSON.stringify(event)));
    }
  });
});

// ── Delayed activation failure: согласованность двух слоёв состояния ────────

describe('delayed activation failure (two-layer consistency)', () => {
  /** Poll-ожидание условия с дедлайном. */
  async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('отказ таймерной активации инвалидирует сессию; retry через recorder пишет реальную строку', async () => {
    recorder = new ExternalMessageRecorder({ bus, storage: makeStorage(), logger });
    recorder.start();

    // Блокируем date-директорию: активация по startsAt упадёт
    const today = new Date().toISOString().slice(0, 10);
    const blockingFile = path.join(tmpDir, today);
    fs.writeFileSync(blockingFile, 'block');

    const startsAtMs = Date.now() + 40;
    const futureMeta: MarketMeta = {
      ...makeMeta(MARKET_CONDITION_ID, 'Will BTC go up?'),
      startsAt: { toNumber: () => startsAtMs } as never,
    };
    expect(recorder.registerMarket({ marketMeta: futureMeta })).toBe(true);

    // Storage освободил регистрацию и уведомил recorder — сессия инвалидирована
    await waitFor(() =>
      logger
        .byLevel('error')
        .some((e) => e.message === 'Recording session invalidated: delayed storage activation failed'),
    );
    expect(recorder.getStats().registrationFailures).toBe(1);
    await publish(marketMessage(createBookEvent()));
    expect(recorder.getStats().unroutedMarketMessages).toBe(1);

    // Причина устранена → retry той же регистрации (startsAt уже в прошлом)
    fs.unlinkSync(blockingFile);
    expect(recorder.registerMarket({ marketMeta: futureMeta })).toBe(true);

    const message = marketMessage(createBookEvent());
    await publish(message);
    await storage.flush();

    const lines = readLines(MARKET_CONDITION_ID);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toEqual(JSON.parse(JSON.stringify(message.payload)));
    expect((JSON.parse(lines[0]!) as { formatVersion: number }).formatVersion).toBe(2);
  });
});

// ── Finalize / gzip / shutdown (PART 19/20, TEST E) ─────────────────────────

describe('finalize and shutdown (PART 19/20)', () => {
  it('finalize с непустым буфером: событие доезжает до gzip-архива (TEST E)', async () => {
    recorder = new ExternalMessageRecorder({
      bus,
      storage: makeStorage({ compression: 'gzip' }),
      logger,
    });
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID, 'Will BTC go up?') });

    const sdkEvent = createBookEvent();
    await publish(marketMessage(sdkEvent));
    // Финализация СРАЗУ после enqueue — flush не вызывается вручную
    await recorder.finalizeMarket(unsafeMarketId(MARKET_CONDITION_ID), 'EXPIRED');

    const files = listFiles();
    const gz = files.find((f) => f.endsWith('.jsonl.gz'));
    expect(gz).toBeDefined();
    expect(files.some((f) => f.endsWith('.jsonl') && !f.endsWith('.jsonl.gz'))).toBe(false);

    // Gzip round-trip: буфер флашнут до сжатия, данные не потеряны
    const lines = zlib.gunzipSync(fs.readFileSync(gz!)).toString('utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]!) as { formatVersion: number }).formatVersion).toBe(2);
    expect(JSON.parse(lines[1]!)).toEqual(JSON.parse(JSON.stringify(sdkEvent)));
  });

  it('finalizeMarket(SHUTDOWN) не создаёт архив: файл удалён, EXPIRED-архив соседа остаётся', async () => {
    recorder = new ExternalMessageRecorder({
      bus,
      storage: makeStorage({ compression: 'gzip' }),
      logger,
    });
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID, 'Will BTC go up 10AM?') });
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID_B, 'Will BTC go up 11AM?') });

    await publish(marketMessage(createBookEvent({ market: MARKET_CONDITION_ID })));
    await publish(marketMessage(createBookEvent({ market: MARKET_CONDITION_ID_B })));

    // Рынок A — завершённый dataset, рынок B — incomplete (shutdown)
    await recorder.finalizeMarket(unsafeMarketId(MARKET_CONDITION_ID), 'EXPIRED');
    await recorder.finalizeMarket(unsafeMarketId(MARKET_CONDITION_ID_B), 'SHUTDOWN');

    const files = listFiles();
    // EXPIRED → ровно один архив (рынок A)
    const archives = files.filter((f) => f.endsWith('.jsonl.gz'));
    expect(archives).toHaveLength(1);
    expect(archives[0]).toContain(MARKET_CONDITION_ID.slice(0, 40));
    // SHUTDOWN → ни архива, ни .jsonl для рынка B
    expect(files.some((f) => f.includes(MARKET_CONDITION_ID_B.slice(0, 40)))).toBe(false);
  });

  it('close: EXPIRED-архив остаётся, незавершённый .jsonl удаляется, новые события не создают файлов', async () => {
    recorder = new ExternalMessageRecorder({
      bus,
      storage: makeStorage({ compression: 'gzip' }),
      logger,
    });
    recorder.start();
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID, 'Will BTC go up 10AM?') });
    recorder.registerMarket({ marketMeta: makeMeta(MARKET_CONDITION_ID_B, 'Will BTC go up 11AM?') });

    await publish(marketMessage(createBookEvent({ market: MARKET_CONDITION_ID })));
    await publish(marketMessage(createBookEvent({ market: MARKET_CONDITION_ID_B })));
    await recorder.finalizeMarket(unsafeMarketId(MARKET_CONDITION_ID), 'EXPIRED');

    await recorder.close();

    const files = listFiles();
    // Завершённый dataset — архив на месте
    expect(files.filter((f) => f.endsWith('.jsonl.gz'))).toHaveLength(1);
    // Незавершённый рынок B — удалён политикой shutdown-cleanup
    expect(files.some((f) => f.endsWith('.jsonl') && !f.endsWith('.jsonl.gz'))).toBe(false);

    // Сообщение после close не создаёт новых файлов (TEST G, persistence-уровень)
    await publish(marketMessage(createBookEvent({ market: MARKET_CONDITION_ID_B })));
    expect(listFiles().filter((f) => f.endsWith('.jsonl'))).toHaveLength(0);
  });
});
