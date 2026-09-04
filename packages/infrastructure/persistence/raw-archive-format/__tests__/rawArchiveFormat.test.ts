/**
 * Контракт Replayable Raw Format V2: encode, header, decode, legacy.
 *
 * @remarks
 * Закрепляет ровно те инварианты, ради которых формат менялся:
 * - конверт добавляется ВОКРУГ payload и не трогает его (TEST C);
 * - ingress копируется из metadata, а не пересчитывается;
 * - `(runId, sequence)` — ключ порядка, а `sequence` без `runId` не является
 *   глобальной identity (TEST G);
 * - legacy читается тем же decoder-ом и честно помечается приблизительным
 *   (TEST J).
 */
import { describe, it, expect } from '@jest/globals';
import {
  RAW_ARCHIVE_FORMAT_VERSION,
  buildCexPartitionHeader,
  compareIngress,
  decodeDetachedArchiveLine,
  decodeRawArchive,
  decodeRawArchiveLine,
  detectRawArchiveFormat,
  ingressEpochMilliseconds,
  ingressEpochNanoseconds,
  isSameRun,
  readCexPartitionHeader,
  toRecordedObservation,
} from '../src/index.js';
import type { RecordedIngress } from '../src/index.js';

/** Metadata сообщения с заранее известными значениями. */
function metadata(overrides: Partial<RecordedIngress> = {}): RecordedIngress & {
  messageId: string;
  correlationId: string;
} {
  return {
    messageId: 'k8f3pz7q-1786668087-123-456-789-000000100',
    runId: 'k8f3pz7q',
    sequence: 100,
    createdAtUnixSeconds: 1_786_668_087,
    millisecondOfSecond: 123,
    microsecondOfMillisecond: 456,
    nanosecondOfMicrosecond: 789,
    correlationId: 'k8f3pz7q-1786668087-123-456-789-000000100',
    ...overrides,
  };
}

describe('toRecordedObservation: конверт ВОКРУГ payload', () => {
  it('копирует ingress из metadata сообщения без пересчёта времени', () => {
    const meta = metadata();
    const observation = toRecordedObservation({
      type: 'POLYMARKET_MARKET',
      payload: { topic: 'market' },
      metadata: meta,
    });

    expect(observation.type).toBe('POLYMARKET_MARKET');
    expect(observation.ingress).toEqual({
      runId: meta.runId,
      sequence: meta.sequence,
      createdAtUnixSeconds: meta.createdAtUnixSeconds,
      millisecondOfSecond: meta.millisecondOfSecond,
      microsecondOfMillisecond: meta.microsecondOfMillisecond,
      nanosecondOfMicrosecond: meta.nanosecondOfMicrosecond,
    });
  });

  it('TEST C: payload уходит ТОЙ ЖЕ ссылкой, без нормализации', () => {
    const payload = { topic: 'market', payload: { bids: [{ price: '0.50', size: '10' }] } };
    const observation = toRecordedObservation({
      type: 'POLYMARKET_MARKET',
      payload,
      metadata: metadata(),
    });

    expect(observation.payload).toBe(payload);
    // Round-trip через диск не меняет ни одного поля payload
    const decoded = decodeDetachedArchiveLine(JSON.stringify(observation));
    expect(decoded?.payload).toEqual(payload);
  });

  it('live-only поля metadata в конверт не попадают', () => {
    const observation = toRecordedObservation({
      type: 'CEX_TRADE',
      payload: {},
      metadata: metadata(),
    });

    const line = JSON.stringify(observation);
    expect(line).not.toContain('messageId');
    expect(line).not.toContain('correlationId');
    expect(line).not.toContain('causationId');
    expect(line).not.toContain('createdAt"');
    expect(Object.keys(observation).sort()).toEqual(['ingress', 'payload', 'type']);
  });
});

describe('ingress: момент и ключ порядка', () => {
  it('epoch-миллисекунды складываются из записанных целых полей', () => {
    expect(ingressEpochMilliseconds(metadata())).toBe(1_786_668_087_123);
  });

  it('epoch-наносекунды сохраняют sub-ms точность (bigint)', () => {
    expect(ingressEpochNanoseconds(metadata())).toBe(1_786_668_087_123_456_789n);
  });

  it('внутри одного runId порядок задаёт sequence', () => {
    const first = metadata({ sequence: 100 });
    const second = metadata({ sequence: 101 });

    expect(isSameRun(first, second)).toBe(true);
    expect(compareIngress(first, second)).toBeLessThan(0);
    expect(compareIngress(second, first)).toBeGreaterThan(0);
  });

  it('TEST G: run-A#100 и run-B#1 НЕ лежат в одном пространстве sequence', () => {
    const runA = metadata({ runId: 'aaaaaaaa', sequence: 100 });
    const runB = metadata({ runId: 'bbbbbbbb', sequence: 1 });

    expect(isSameRun(runA, runB)).toBe(false);
    // Несравнимы: после рестарта нумерация начинается заново
    expect(compareIngress(runA, runB)).toBeUndefined();
    expect(compareIngress(runB, runA)).toBeUndefined();
    // И «меньший sequence» НЕ означает «раньше»
    expect(runB.sequence).toBeLessThan(runA.sequence);
  });
});

describe('header: формат объявлен, а не угадан', () => {
  it('CEX-header несёт версию, источник и полную routing identity', () => {
    const header = buildCexPartitionHeader({
      exchangeId: 'binance',
      marketType: 'swap',
      symbol: 'BTC/USDT:USDT',
      stream: 'orderbook',
      windowStartMs: 1_786_668_000_000,
      windowEndMs: 1_786_668_300_000,
    });

    expect(header).toEqual({
      t: 'meta',
      formatVersion: RAW_ARCHIVE_FORMAT_VERSION,
      source: 'CEX',
      exchangeId: 'binance',
      marketType: 'swap',
      symbol: 'BTC/USDT:USDT',
      stream: 'orderbook',
      windowStartMs: 1_786_668_000_000,
      windowEndMs: 1_786_668_300_000,
      windowStartUTC: new Date(1_786_668_000_000).toISOString(),
      windowEndUTC: new Date(1_786_668_300_000).toISOString(),
    });

    const format = detectRawArchiveFormat(JSON.stringify(header));
    expect(format.formatVersion).toBe(2);
    expect(format.headerConsumedFirstLine).toBe(true);
    expect(format.timingQuality).toBe('EXACT_INGRESS');
    expect(readCexPartitionHeader(format)).toEqual(header);
  });

  it('market-header Polymarket распознаётся как V2, но не как CEX-партиция', () => {
    const format = detectRawArchiveFormat(
      JSON.stringify({ t: 'meta', formatVersion: 2, marketId: '0xabc', tokenIds: [] }),
    );

    expect(format.formatVersion).toBe(2);
    expect(readCexPartitionHeader(format)).toBeUndefined();
  });

  it('meta БЕЗ formatVersion — legacy-архив старого коллектора', () => {
    const format = detectRawArchiveFormat(
      JSON.stringify({ t: 'meta', ts: 1, marketId: '0xabc', tokenIds: [] }),
    );

    expect(format.formatVersion).toBeUndefined();
    expect(format.headerConsumedFirstLine).toBe(true);
    expect(format.timingQuality).toBe('LEGACY_APPROXIMATE');
  });

  it('первая строка НЕ meta — legacy без header-а: строка 1 является данными', () => {
    const format = detectRawArchiveFormat(JSON.stringify({ t: 'ob', ts: 1, bids: [] }));

    expect(format.formatVersion).toBeUndefined();
    expect(format.headerConsumedFirstLine).toBe(false);
    expect(format.header).toBeUndefined();
  });
});

describe('decode: строгий формат по header-у', () => {
  it('V2-архив: строка без валидного конверта — повреждение, а не legacy', () => {
    const format = detectRawArchiveFormat(
      JSON.stringify({ t: 'meta', formatVersion: 2, marketId: '0xabc' }),
    );

    expect(decodeRawArchiveLine(JSON.stringify({ topic: 'market' }), format)).toBeUndefined();
    expect(decodeRawArchiveLine('{ not json', format)).toBeUndefined();
    // Неполный ingress не даёт обещания EXACT_INGRESS
    expect(
      decodeRawArchiveLine(
        JSON.stringify({ type: 'X', ingress: { runId: 'r', sequence: 1 }, payload: {} }),
        format,
      ),
    ).toBeUndefined();
  });

  it('V2-архив читается целиком: формат, порядок строк, счётчик повреждений', () => {
    const header = { t: 'meta', formatVersion: 2, marketId: '0xabc' };
    const lines = [
      JSON.stringify(header),
      JSON.stringify(
        toRecordedObservation({ type: 'A', payload: { n: 1 }, metadata: metadata({ sequence: 1 }) }),
      ),
      '{ broken',
      JSON.stringify(
        toRecordedObservation({ type: 'B', payload: { n: 2 }, metadata: metadata({ sequence: 2 }) }),
      ),
    ];

    const archive = decodeRawArchive(lines);

    expect(archive.format.formatVersion).toBe(2);
    expect(archive.malformedLines).toBe(1);
    expect(archive.observations.map((observation) => observation.payload)).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
    expect(archive.observations.map((observation) => observation.type)).toEqual(['A', 'B']);
  });
});

describe('TEST J: legacy читается без переписывания и без выдуманного тайминга', () => {
  /** Строки legacy CEX-партиции старого коллектора (header-а нет). */
  const legacyPartition = [
    JSON.stringify({ t: 'ob', ts: 3_000, bids: [[64_000, 1]], asks: [[64_001, 2]] }),
    JSON.stringify({ t: 'trade', ts: 1_000, p: 64_000.5, sz: 0.1, side: 'buy' }),
    JSON.stringify({ t: 'ob', ts: 2_000, bids: [[63_999, 1]], asks: [[64_002, 2]] }),
  ];

  it('порядок строк файла сохраняется строго, без сортировки по vendor ts', () => {
    const archive = decodeRawArchive(legacyPartition);

    expect(archive.format.timingQuality).toBe('LEGACY_APPROXIMATE');
    // Именно файловый порядок (3000, 1000, 2000), а не отсортированный
    expect(archive.observations.map((observation) => (observation.payload as { ts: number }).ts)).toEqual([
      3_000, 1_000, 2_000,
    ]);
  });

  it('у legacy-наблюдения НЕТ ingress и НЕТ type — фикция не выдумывается', () => {
    const archive = decodeRawArchive(legacyPartition);

    for (const observation of archive.observations) {
      expect(observation.timingQuality).toBe('LEGACY_APPROXIMATE');
      expect(observation.ingress).toBeUndefined();
      expect(observation.type).toBeUndefined();
    }
  });

  it('legacy market-файл: header пропущен, payload-строки отданы как есть', () => {
    const lines = [
      JSON.stringify({ t: 'meta', ts: 1, marketId: '0xabc', tokenIds: ['a'] }),
      JSON.stringify({ event_type: 'book', asset_id: 'a', bids: [] }),
      JSON.stringify({ event_type: 'price_change', asset_id: 'a' }),
    ];

    const archive = decodeRawArchive(lines);

    expect(archive.format.timingQuality).toBe('LEGACY_APPROXIMATE');
    expect(archive.format.headerConsumedFirstLine).toBe(true);
    expect(archive.observations).toHaveLength(2);
    expect(archive.observations[0]!.payload).toEqual({
      event_type: 'book',
      asset_id: 'a',
      bids: [],
    });
  });
});

describe('decodeDetachedArchiveLine: строки, отделённые от своего header-а', () => {
  it('валидный конверт → EXACT_INGRESS; чужая строка → LEGACY_APPROXIMATE', () => {
    const v2 = JSON.stringify(
      toRecordedObservation({ type: 'A', payload: { n: 1 }, metadata: metadata() }),
    );

    expect(decodeDetachedArchiveLine(v2)?.timingQuality).toBe('EXACT_INGRESS');
    expect(decodeDetachedArchiveLine(JSON.stringify({ n: 1 }))?.timingQuality).toBe(
      'LEGACY_APPROXIMATE',
    );
    expect(decodeDetachedArchiveLine('{ broken')).toBeUndefined();
  });
});
