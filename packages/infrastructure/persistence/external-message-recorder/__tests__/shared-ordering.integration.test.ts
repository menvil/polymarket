/**
 * Исторический порядок наблюдений переживает запись на диск (MR: raw V2).
 *
 * @remarks
 * Главная причина, по которой формат перестал быть payload-only: Polymarket
 * и каждый CEX-поток физически лежат в РАЗНЫХ файлах, а vendor-timestamp-ы у
 * них из разных часов и разной точности. Единственный достоверный ключ
 * порядка — `(runId, sequence)` наблюдения, и он обязан быть на диске.
 *
 * Здесь всё по-настоящему: общий bus, один recorder, реальные `DataRecorder`
 * и `CexWindowRecorder`, реальные файлы.
 *
 * Закрепляет:
 * - TEST B: первое сообщение, лениво создавшее сессию, становится ПЕРВЫМ
 *   наблюдением её файла;
 * - TEST F: 100 PM / 101 CEX / 102 CEX / 103 PM восстанавливаются в том же
 *   порядке при чтении РАЗНЫХ файлов.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { LiveClock } from '@polymarket/time';
import { asRunId, unsafeMarketId } from '@polymarket/ids';
import { CexWindowRecorder, DataRecorder, NDJSONFormatter } from '@polymarket/data-collection';
import { decodeRawArchive } from '@polymarket/raw-archive-format';
import type { DecodedObservation } from '@polymarket/raw-archive-format';
import type { MarketMeta } from '@polymarket/ports';
import type { CexExternalMessage, CexOrderbookPayload } from '@polymarket/cex-v2';
import type { PolymarketExternalMessage, StandardMarketEvent } from '@polymarket/polymarket-v2';
import { ExternalMessageRecorder } from '../src/index.js';
import { CapturingLogger } from './helpers/fakes.js';
import { MARKET_CONDITION_ID, createBookEvent } from './helpers/sdkFixtures.js';

type ContourMessage = PolymarketExternalMessage | CexExternalMessage;

const RUN_ID = 'aaaaaaaa';

let tmpDir: string;
let bus: ExternalMessageBus<ContourMessage>;
let marketStorage: DataRecorder;
let cexStorage: CexWindowRecorder;
let logger: CapturingLogger;
let recorder: ExternalMessageRecorder;
let generator: MessageMetadataGenerator;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-v2-ordering-'));
  logger = new CapturingLogger();
  bus = new ExternalMessageBus<ContourMessage>();
  generator = new MessageMetadataGenerator({ clock: new LiveClock(), runId: asRunId(RUN_ID)! });

  marketStorage = new DataRecorder(
    {
      outputDir: tmpDir,
      sourceSubDir: 'polymarket',
      bufferSize: 100,
      flushIntervalMs: 60_000,
      compression: 'none',
      formatVersion: 2,
    },
    new NDJSONFormatter(),
    null,
    logger,
  );
  // Короткое окно + отсутствие сжатия: партиция остаётся читаемым .jsonl
  cexStorage = new CexWindowRecorder(
    { outputDir: path.join(tmpDir, 'cex'), compression: 'none', windowMinutes: 60, flushIntervalMs: 60_000 },
    logger,
    // Выравнивание уже пройдено: приём начинается немедленно
    () => Date.now() - 60 * 60_000,
  );
});

afterEach(async () => {
  try {
    await recorder?.close();
  } catch {
    // already closed
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeMeta(marketId: string): MarketMeta {
  return {
    marketId: unsafeMarketId(marketId),
    question: 'Will BTC go up?',
    tokenIds: ['tok-up', 'tok-down'],
    expiresAt: { toNumber: () => 9_999_999_999_999 } as never,
  };
}

function orderbookPayload(overrides: Partial<CexOrderbookPayload> = {}): CexOrderbookPayload {
  return {
    exchangeId: 'binance',
    marketType: 'swap',
    symbol: 'BTC/USDT:USDT',
    orderBook: { symbol: 'BTC/USDT:USDT', bids: [[64_000, 1]], asks: [[64_001, 2]], timestamp: 1 },
    ...overrides,
  };
}

async function publishMarket(event: StandardMarketEvent): Promise<void> {
  const result = await bus.publish({
    type: 'POLYMARKET_MARKET',
    payload: event,
    metadata: generator.nextRoot(),
  });
  expect(result.ok).toBe(true);
}

async function publishOrderbook(payload: CexOrderbookPayload): Promise<void> {
  const result = await bus.publish({
    type: 'CEX_ORDERBOOK',
    payload,
    metadata: generator.nextRoot(),
  });
  expect(result.ok).toBe(true);
}

/** Рекурсивный листинг файлов дерева. */
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

/** Наблюдения файла архива (header снят декодером). */
function observationsOf(filePath: string): DecodedObservation[] {
  const lines = fs.readFileSync(filePath, 'utf8').trimEnd().split('\n');
  return [...decodeRawArchive(lines).observations];
}

describe('TEST B: первое наблюдение lazy-сессии — первая строка её файла', () => {
  it('сообщение, создавшее сессию через провайдера, записано как observation #1', async () => {
    recorder = new ExternalMessageRecorder({
      bus,
      storage: marketStorage,
      logger,
      sessionProvider: (sourceMarketId) =>
        sourceMarketId === MARKET_CONDITION_ID
          ? { marketMeta: makeMeta(sourceMarketId) }
          : undefined,
    });
    recorder.start();

    // ПЕРВОЕ сообщение рынка: сессии ещё нет — её создаёт провайдер
    await publishMarket(createBookEvent({ hash: '0xfirst' }));
    await publishMarket(createBookEvent({ hash: '0xsecond' }));
    await marketStorage.flush();

    const marketFile = listTree(tmpDir).find((file) => file.endsWith('.jsonl'))!;
    const observations = observationsOf(marketFile);

    expect(recorder.getStats().marketSessionsAdmitted).toBe(1);
    // Именно ПЕРВОЕ сообщение, а не «начали со следующего»
    expect(observations).toHaveLength(2);
    expect((observations[0]!.payload as { payload: { hash: string } }).payload.hash).toBe('0xfirst');
    expect(observations[0]!.ingress?.sequence).toBe(1);
    expect((observations[1]!.payload as { payload: { hash: string } }).payload.hash).toBe(
      '0xsecond',
    );
  });
});

describe('TEST F: общий порядок наблюдений переживает разные файлы', () => {
  it('100 PM / 101 CEX / 102 CEX / 103 PM читаются в исходном порядке', async () => {
    recorder = new ExternalMessageRecorder({
      bus,
      storage: marketStorage,
      logger,
      cex: { bus, storage: cexStorage },
      sessionProvider: (sourceMarketId) => ({ marketMeta: makeMeta(sourceMarketId) }),
    });
    recorder.start();
    cexStorage.start();

    // Сдвигаем нумерацию так, чтобы наблюдения получили sequence 100..103
    for (let index = 0; index < 99; index++) {
      generator.nextRoot();
    }

    await publishMarket(createBookEvent({ hash: '0xpm-100' }));
    await publishOrderbook(orderbookPayload({ orderBook: { tag: 'cex-101' } as never }));
    await publishOrderbook(orderbookPayload({ orderBook: { tag: 'cex-102' } as never }));
    await publishMarket(createBookEvent({ hash: '0xpm-103' }));

    await marketStorage.flush();
    await cexStorage.flush();

    const files = listTree(tmpDir).filter((file) => file.endsWith('.jsonl'));
    // Данные ФИЗИЧЕСКИ разложены по разным файлам — сводить их в один не нужно
    expect(files.length).toBeGreaterThanOrEqual(2);

    const collected = files.flatMap((file) => observationsOf(file));
    expect(collected).toHaveLength(4);
    for (const observation of collected) {
      expect(observation.timingQuality).toBe('EXACT_INGRESS');
      expect(observation.ingress?.runId).toBe(RUN_ID);
    }

    // Один runId → sequence восстанавливает исходную последовательность
    const merged = collected.sort(
      (left, right) => left.ingress!.sequence - right.ingress!.sequence,
    );
    expect(merged.map((observation) => observation.ingress!.sequence)).toEqual([100, 101, 102, 103]);
    expect(merged.map((observation) => observation.type)).toEqual([
      'POLYMARKET_MARKET',
      'CEX_ORDERBOOK',
      'CEX_ORDERBOOK',
      'POLYMARKET_MARKET',
    ]);
    expect(
      merged.map((observation) => {
        const payload = observation.payload as {
          payload?: { hash?: string };
          orderBook?: { tag?: string };
        };
        return payload.payload?.hash ?? payload.orderBook?.tag;
      }),
    ).toEqual(['0xpm-100', 'cex-101', 'cex-102', '0xpm-103']);
  });
});
