import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DataRecorder } from '../src/DataRecorder.js';
import { NDJSONFormatter } from '../src/formatters/NDJSONFormatter.js';
import type { DataRecorderConfig } from '../src/config/DataRecorderConfig.js';
import type { ILogger } from '@polymarket/logger';
import { unsafeInstrumentId } from '@polymarket/ids';
import type { MarketId } from '@polymarket/ids';
import type { MarketMeta } from '@polymarket/ports';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info:  jest.fn() as ILogger['info'],
    warn:  jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn<ILogger['child']>().mockReturnThis() as ILogger['child'],
  };
}

function makeConfig(outputDir: string, overrides: Partial<DataRecorderConfig> = {}): DataRecorderConfig {
  return {
    outputDir,
    bufferSize: 100,
    flushIntervalMs: 60_000,  // большой интервал — не триггерит в тестах
    compression: 'none',
    ...overrides,
  };
}

function makeMeta(marketId = 'mkt-001', tokenIds = ['tok-yes', 'tok-no']): MarketMeta {
  return {
    marketId: marketId as unknown as MarketId,
    question: 'Will BTC reach $100k?',
    tokenIds,
    expiresAt: { toNumber: () => 9999999999, toISO: () => '2099-01-01T00:00:00.000Z' } as never,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DataRecorder', () => {
  let tmpDir: string;
  let logger: ILogger;
  let recorder: DataRecorder;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-test-'));
    logger = makeLogger();
  });

  afterEach(async () => {
    try {
      await recorder?.close();
    } catch {
      // already closed
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('isEnabled() возвращает true', () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    expect(recorder.isEnabled()).toBe(true);
  });

  it('registerMarket создаёт файл с meta-событием', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    recorder.registerMarket(makeMeta());
    await recorder.flush();

    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(tmpDir, today);
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain('.jsonl');

    const content = fs.readFileSync(path.join(dir, files[0]), 'utf-8');
    const firstLine = JSON.parse(content.split('\n')[0]);
    expect(firstLine.t).toBe('meta');
    expect(firstLine.marketId).toBe('mkt-001');
    expect(firstLine.tokenIds).toEqual(['tok-yes', 'tok-no']);
  });

  it('registerMarket идемпотентен', () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    recorder.registerMarket(makeMeta());
    recorder.registerMarket(makeMeta()); // второй вызов — no-op

    expect(logger.debug).toHaveBeenCalledWith(
      'Market already registered, skipping',
      expect.any(Object),
    );
  });

  it('recordEvent записывает событие в файл после flush', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    recorder.registerMarket(makeMeta());
    recorder.recordEvent(unsafeInstrumentId('tok-yes'), { event_type: 'book', ts: 1234, bids: [], asks: [] });
    await recorder.flush();

    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(tmpDir, today);
    const filePath = path.join(dir, fs.readdirSync(dir)[0]);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');

    // Первая строка — meta, вторая — событие
    expect(lines.length).toBe(2);
    const event = JSON.parse(lines[1]);
    expect(event.event_type).toBe('book');
  });

  it('recordEvent пропускает незарегистрированный tokenId', () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    recorder.registerMarket(makeMeta());
    // Не должно бросать
    expect(() => {
      recorder.recordEvent(unsafeInstrumentId('unknown-token'), { event_type: 'book' });
    }).not.toThrow();
  });

  it('finalizeMarket сбрасывает буфер и закрывает поток', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);
    recorder.recordEvent(unsafeInstrumentId('tok-yes'), { ts: 1 });
    recorder.recordEvent(unsafeInstrumentId('tok-no'), { ts: 2 });

    await recorder.finalizeMarket(meta.marketId, 'EXPIRED');

    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(tmpDir, today);
    const filePath = path.join(dir, fs.readdirSync(dir)[0]);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');

    // meta + 2 события
    expect(lines.length).toBe(3);
  });

  it('finalizeMarket для незарегистрированного marketId — no-op', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    // Не должно бросать
    await expect(
      recorder.finalizeMarket('unknown-market' as unknown as MarketId, 'EXPIRED')
    ).resolves.toBeUndefined();
  });

  it('recordEvent не записывает после finalizeMarket', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);
    await recorder.finalizeMarket(meta.marketId, 'EXPIRED');

    // После финализации — молча игнорирует
    recorder.recordEvent(unsafeInstrumentId('tok-yes'), { event_type: 'book' });

    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(tmpDir, today);
    const filePath = path.join(dir, fs.readdirSync(dir)[0]);
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    // Только meta-строка
    expect(lines.length).toBe(1);
  });

  it('close завершает все активные рынки', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    recorder.registerMarket(makeMeta('mkt-001', ['t1', 't2']));
    recorder.registerMarket(makeMeta('mkt-002', ['t3', 't4']));
    recorder.recordEvent(unsafeInstrumentId('t1'), { ts: 1 });
    recorder.recordEvent(unsafeInstrumentId('t3'), { ts: 2 });

    await recorder.close();

    expect(logger.info).toHaveBeenCalledWith('DataRecorder closed');
  });

  it('авто-flush по bufferSize', async () => {
    recorder = new DataRecorder(
      makeConfig(tmpDir, { bufferSize: 3 }),
      new NDJSONFormatter(),
      null,
      logger,
    );
    recorder.registerMarket(makeMeta());

    // Записываем 3 события — должен триггернуть flush
    recorder.recordEvent(unsafeInstrumentId('tok-yes'), { ts: 1 });
    recorder.recordEvent(unsafeInstrumentId('tok-yes'), { ts: 2 });
    recorder.recordEvent(unsafeInstrumentId('tok-yes'), { ts: 3 });

    // Даём время на async flush
    await new Promise((r) => setTimeout(r, 50));

    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(tmpDir, today);
    const filePath = path.join(dir, fs.readdirSync(dir)[0]);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    // meta + 3 события
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });
});
