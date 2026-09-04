/**
 * File-level reader raw-архивов: формат из header-а, legacy без переписывания.
 *
 * @remarks
 * Проверяется на РЕАЛЬНЫХ файлах (`.jsonl` и `.jsonl.gz`), потому что именно
 * файловая граница отвечает за то, чтобы формат определялся по LINE 1, а не
 * по имени файла или форме первой data-строки.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { ILogger } from '@polymarket/logger';
import type { DecodedObservation } from '@polymarket/raw-archive-format';
import { RawArchiveObservationReader } from '../src/RawArchiveObservationReader.js';
import { SnapshotReaderFactory } from '../src/SnapshotReaderFactory.js';

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn<ILogger['child']>().mockReturnThis() as ILogger['child'],
  };
}

let dir: string;
let factory: SnapshotReaderFactory;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-archive-reader-'));
  factory = new SnapshotReaderFactory(makeLogger());
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Записывает файл архива и возвращает путь. */
function writeArchive(name: string, lines: readonly string[], gzip = false): string {
  const content = `${lines.join('\n')}\n`;
  const filePath = path.join(dir, gzip ? `${name}.jsonl.gz` : `${name}.jsonl`);
  fs.writeFileSync(filePath, gzip ? zlib.gzipSync(content) : content);
  return filePath;
}

/** V2-наблюдение с заданным ключом порядка. */
function observation(type: string, sequence: number, payload: unknown, runId = 'k8f3pz7q'): string {
  return JSON.stringify({
    type,
    ingress: {
      runId,
      sequence,
      createdAtUnixSeconds: 1_786_668_087,
      millisecondOfSecond: sequence,
      microsecondOfMillisecond: 0,
      nanosecondOfMicrosecond: 0,
    },
    payload,
  });
}

/** Собирает все наблюдения файла через reader. */
async function readAll(filePath: string): Promise<{
  reader: RawArchiveObservationReader;
  observations: DecodedObservation[];
}> {
  const reader = new RawArchiveObservationReader(factory.create(filePath));
  const observations: DecodedObservation[] = [];
  for await (const item of reader.readObservations()) {
    observations.push(item);
  }
  return { reader, observations };
}

describe('V2-архив: формат объявлен header-ом', () => {
  it('CEX-партиция: header прочитан, наблюдения отданы с EXACT_INGRESS', async () => {
    const header = {
      t: 'meta',
      formatVersion: 2,
      source: 'CEX',
      exchangeId: 'binance',
      marketType: 'swap',
      symbol: 'BTC/USDT:USDT',
      stream: 'orderbook',
      windowStartMs: 1_786_668_000_000,
      windowEndMs: 1_786_668_300_000,
      windowStartUTC: new Date(1_786_668_000_000).toISOString(),
      windowEndUTC: new Date(1_786_668_300_000).toISOString(),
    };
    const filePath = writeArchive('partition', [
      JSON.stringify(header),
      observation('CEX_ORDERBOOK', 1, { exchangeId: 'binance', orderBook: { bids: [[1, 2]] } }),
      observation('CEX_ORDERBOOK', 2, { exchangeId: 'binance', orderBook: { bids: [[3, 4]] } }),
    ]);

    const reader = new RawArchiveObservationReader(factory.create(filePath));
    try {
      expect(await reader.readHeader()).toEqual(header);
      const observations: DecodedObservation[] = [];
      for await (const item of reader.readObservations()) {
        observations.push(item);
      }

      expect(observations).toHaveLength(2);
      expect(observations.every((item) => item.timingQuality === 'EXACT_INGRESS')).toBe(true);
      expect(observations.map((item) => item.ingress?.sequence)).toEqual([1, 2]);
      expect(observations[0]!.payload).toEqual({
        exchangeId: 'binance',
        orderBook: { bids: [[1, 2]] },
      });
    } finally {
      await reader.close();
    }
  });

  it('gzip-архив читается тем же путём', async () => {
    const filePath = writeArchive(
      'archived',
      [
        JSON.stringify({ t: 'meta', formatVersion: 2, marketId: '0xabc' }),
        observation('POLYMARKET_MARKET', 7, { topic: 'market' }),
      ],
      true,
    );

    const { reader, observations } = await readAll(filePath);
    try {
      expect(observations).toHaveLength(1);
      expect(observations[0]!.type).toBe('POLYMARKET_MARKET');
      expect(observations[0]!.ingress?.sequence).toBe(7);
    } finally {
      await reader.close();
    }
  });

  it('повреждённая строка не обрывает чтение и видна в malformedLines', async () => {
    const filePath = writeArchive('broken', [
      JSON.stringify({ t: 'meta', formatVersion: 2, marketId: '0xabc' }),
      observation('POLYMARKET_MARKET', 1, { n: 1 }),
      '{ broken',
      observation('POLYMARKET_MARKET', 2, { n: 2 }),
    ]);

    const { reader, observations } = await readAll(filePath);
    try {
      expect(observations.map((item) => item.payload)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(reader.malformedLines).toBe(1);
    } finally {
      await reader.close();
    }
  });
});

describe('неизвестная версия: fail closed, а не legacy', () => {
  it('readObservations отвергает архив с чужим formatVersion', async () => {
    const filePath = writeArchive('future', [
      JSON.stringify({ t: 'meta', formatVersion: 3, marketId: '0xabc' }),
      JSON.stringify({ someV3Shape: true }),
    ]);

    const reader = new RawArchiveObservationReader(factory.create(filePath));
    try {
      // Формат прочитать МОЖНО — исключение бросает только чтение наблюдений
      const format = await reader.readFormat();
      expect(format.kind).toBe('UNSUPPORTED');
      expect(format.formatVersion).toBe(3);
      expect(await reader.readHeader()).toMatchObject({ formatVersion: 3 });

      await expect(async () => {
        for await (const _ of reader.readObservations()) {
          // недостижимо: генератор обязан бросить до первой выдачи
        }
      }).rejects.toThrow('Unsupported raw archive formatVersion 3');
    } finally {
      await reader.close();
    }
  });

  it('строки чужого формата НЕ выдаются как legacy-наблюдения', async () => {
    const filePath = writeArchive('future-silent', [
      JSON.stringify({ t: 'meta', formatVersion: 99 }),
      JSON.stringify({ v99: 'payload' }),
    ]);

    const reader = new RawArchiveObservationReader(factory.create(filePath));
    try {
      const collected: DecodedObservation[] = [];
      await expect(async () => {
        for await (const item of reader.readObservations()) {
          collected.push(item);
        }
      }).rejects.toThrow(/Unsupported raw archive formatVersion/);
      // Ни одного наблюдения не выдано — молчаливой пустоты тоже нет
      expect(collected).toHaveLength(0);
    } finally {
      await reader.close();
    }
  });
});

describe('TEST J: legacy-архивы читаются как есть', () => {
  it('legacy market-файл: LEGACY_APPROXIMATE, header пропущен, порядок строк сохранён', async () => {
    const lines = [
      JSON.stringify({ t: 'meta', ts: 1, marketId: '0xabc', tokenIds: ['a'] }),
      JSON.stringify({ event_type: 'book', asset_id: 'a', timestamp: '3000' }),
      JSON.stringify({ event_type: 'price_change', asset_id: 'a', timestamp: '1000' }),
      JSON.stringify({ event_type: 'book', asset_id: 'a', timestamp: '2000' }),
    ];
    const filePath = writeArchive('legacy-market', lines);
    const bytesBefore = fs.readFileSync(filePath);

    const { reader, observations } = await readAll(filePath);
    try {
      const format = await reader.readFormat();
      expect(format.formatVersion).toBeUndefined();
      expect(format.timingQuality).toBe('LEGACY_APPROXIMATE');

      // Порядок строк файла, а НЕ порядок vendor-timestamp
      expect(
        observations.map((item) => (item.payload as { timestamp: string }).timestamp),
      ).toEqual(['3000', '1000', '2000']);
      for (const item of observations) {
        expect(item.timingQuality).toBe('LEGACY_APPROXIMATE');
        expect(item.ingress).toBeUndefined();
      }
    } finally {
      await reader.close();
    }

    // Файл не переписан и не мигрирован
    expect(fs.readFileSync(filePath).equals(bytesBefore)).toBe(true);
  });

  it('legacy CEX-партиция БЕЗ header-а: первая строка — данные, а не meta', async () => {
    const lines = [
      JSON.stringify({ t: 'ob', ts: 3_000, bids: [[64_000, 1]] }),
      JSON.stringify({ t: 'trade', ts: 1_000, p: 64_000.5, sz: 0.1 }),
    ];
    const filePath = writeArchive('legacy-cex', lines);

    const { reader, observations } = await readAll(filePath);
    try {
      expect((await reader.readFormat()).headerConsumedFirstLine).toBe(false);
      // Первая строка НЕ потеряна
      expect(observations).toHaveLength(2);
      expect(observations[0]!.payload).toEqual({ t: 'ob', ts: 3_000, bids: [[64_000, 1]] });
      expect(observations[1]!.payload).toEqual({ t: 'trade', ts: 1_000, p: 64_000.5, sz: 0.1 });
    } finally {
      await reader.close();
    }
  });
});

describe('TEST F/G: исторический порядок восстанавливается по разным файлам', () => {
  it('PM и CEX разных файлов одного runId склеиваются по (runId, sequence)', async () => {
    const runId = 'k8f3pz7q';
    const marketFile = writeArchive('market', [
      JSON.stringify({ t: 'meta', formatVersion: 2, marketId: '0xabc' }),
      observation('POLYMARKET_MARKET', 100, { topic: 'market', n: 'pm-100' }, runId),
      observation('POLYMARKET_MARKET', 103, { topic: 'market', n: 'pm-103' }, runId),
    ]);
    const cexFile = writeArchive('cex', [
      JSON.stringify({
        t: 'meta',
        formatVersion: 2,
        source: 'CEX',
        exchangeId: 'binance',
        marketType: 'swap',
        symbol: 'BTC/USDT:USDT',
        stream: 'orderbook',
        windowStartMs: 1_786_668_000_000,
        windowEndMs: 1_786_668_300_000,
      }),
      observation('CEX_ORDERBOOK', 101, { n: 'cex-101' }, runId),
      observation('CEX_ORDERBOOK', 102, { n: 'cex-102' }, runId),
    ]);

    const collected: DecodedObservation[] = [];
    for (const filePath of [marketFile, cexFile]) {
      const { reader, observations } = await readAll(filePath);
      collected.push(...observations);
      await reader.close();
    }

    // Файлы физически разные, но ключ порядка один — восстанавливаем поток
    const merged = collected
      .filter((item) => item.timingQuality === 'EXACT_INGRESS')
      .sort((left, right) => left.ingress!.sequence - right.ingress!.sequence);

    expect(merged.map((item) => item.ingress!.sequence)).toEqual([100, 101, 102, 103]);
    expect(merged.map((item) => item.type)).toEqual([
      'POLYMARKET_MARKET',
      'CEX_ORDERBOOK',
      'CEX_ORDERBOOK',
      'POLYMARKET_MARKET',
    ]);
    expect(merged.every((item) => item.ingress!.runId === runId)).toBe(true);
  });

  it('TEST G: наблюдения РАЗНЫХ run-ов не образуют одну sequence space', async () => {
    const fileA = writeArchive('run-a', [
      JSON.stringify({ t: 'meta', formatVersion: 2, marketId: '0xabc' }),
      observation('POLYMARKET_MARKET', 100, { n: 'a-100' }, 'aaaaaaaa'),
    ]);
    const fileB = writeArchive('run-b', [
      JSON.stringify({ t: 'meta', formatVersion: 2, marketId: '0xabc' }),
      observation('POLYMARKET_MARKET', 1, { n: 'b-1' }, 'bbbbbbbb'),
    ]);

    const collected: DecodedObservation[] = [];
    for (const filePath of [fileA, fileB]) {
      const { reader, observations } = await readAll(filePath);
      collected.push(...observations);
      await reader.close();
    }

    const runIds = new Set(collected.map((item) => item.ingress!.runId));
    expect(runIds.size).toBe(2);
    // Наивная сортировка по sequence поставила бы run-B ПЕРЕД run-A —
    // именно поэтому runId обязателен в ключе порядка
    const naive = [...collected].sort(
      (left, right) => left.ingress!.sequence - right.ingress!.sequence,
    );
    expect((naive[0]!.payload as { n: string }).n).toBe('b-1');
    expect(collected.map((item) => (item.payload as { n: string }).n)).toEqual(['a-100', 'b-1']);
  });
});
