import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DataRecorder } from '../src/DataRecorder.js';
import { NDJSONFormatter } from '../src/formatters/NDJSONFormatter.js';
import type { DataRecorderConfig } from '../src/config/DataRecorderConfig.js';
import type { GzipCompressor } from '../src/compression/GzipCompressor.js';
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

/**
 * Poll-ожидание наблюдаемого условия с дедлайном (вместо фиксированных sleep):
 * медленные CI-раннеры получают время на таймеры/I/O, быстрые не ждут зря.
 */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Проверяет, что mock-логгер получил error с данным сообщением. */
function loggedError(logger: ILogger, message: string): boolean {
  const calls = (logger.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.some((call) => call[0] === message);
}

/** Проверяет, что mock-логгер получил info с данным сообщением. */
function loggedInfo(logger: ILogger, message: string): boolean {
  const calls = (logger.info as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.some((call) => call[0] === message);
}

/**
 * Внутренний writer рынка — ТОЛЬКО для fault-injection: реальному fs нельзя
 * приказать упасть, поэтому I/O-отказ эмулируется прямым воздействием на
 * stream writer-а (destroy/end «из-под» рекордера).
 */
function writerInternals(
  rec: DataRecorder,
  marketId: string,
): { stream: fs.WriteStream | null; buffer: string[]; failed: boolean } {
  const writers = (
    rec as unknown as {
      _writers: Map<string, { stream: fs.WriteStream | null; buffer: string[]; failed: boolean }>;
    }
  )._writers;
  const writer = writers.get(marketId);
  if (!writer) throw new Error(`writerInternals: no writer for ${marketId}`);
  return writer;
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

// ── V2 storage (N-002): recordMarketEvent / formatVersion / arrival order ────

describe('DataRecorder V2 storage (N-002)', () => {
  let tmpDir: string;
  let logger: ILogger;
  let recorder: DataRecorder;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-v2-test-'));
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

  function marketFilePath(): string {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(tmpDir, today);
    return path.join(dir, fs.readdirSync(dir)[0]);
  }

  it('recordMarketEvent маршрутизирует по marketId и возвращает recorded', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);

    const outcome = recorder.recordMarketEvent(meta.marketId, {
      topic: 'market',
      type: 'book',
      payload: { market: 'mkt-001', tokenId: 'tok-yes', bids: [], asks: [] },
    });
    expect(outcome).toBe('recorded');
    await recorder.flush();

    const lines = fs.readFileSync(marketFilePath(), 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    const event = JSON.parse(lines[1]);
    expect(event.topic).toBe('market');
    expect(event.type).toBe('book');
  });

  it('recordMarketEvent для незарегистрированного рынка возвращает unregistered и не создаёт файл', () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);

    const outcome = recorder.recordMarketEvent('unknown-mkt' as unknown as MarketId, { type: 'book' });

    expect(outcome).toBe('unregistered');
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('recordMarketEvent до startsAt возвращает inactive и не пишет', () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta: MarketMeta = {
      ...makeMeta(),
      startsAt: { toNumber: () => Date.now() + 60_000 } as never,
    };
    recorder.registerMarket(meta);

    const outcome = recorder.recordMarketEvent(meta.marketId, { type: 'book' });

    expect(outcome).toBe('inactive');
    // Файл создаётся только при активации — до startsAt его нет
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it('recordMarketEvent при ошибке сериализации возвращает failed и логирует', () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);

    // BigInt не сериализуется JSON.stringify — TypeError внутри formatter
    const outcome = recorder.recordMarketEvent(meta.marketId, { value: BigInt(1) });

    expect(outcome).toBe('failed');
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to serialize market event for recording',
      expect.any(Object),
    );
  });

  it('recordMarketEvent после finalizeMarket возвращает unregistered', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);
    await recorder.finalizeMarket(meta.marketId, 'EXPIRED');

    expect(recorder.recordMarketEvent(meta.marketId, { type: 'book' })).toBe('unregistered');
  });

  it('formatVersion из config попадает в первую строку', async () => {
    recorder = new DataRecorder(
      makeConfig(tmpDir, { formatVersion: 2 }),
      new NDJSONFormatter(),
      null,
      logger,
    );
    recorder.registerMarket(makeMeta());
    await recorder.flush();

    const firstLine = JSON.parse(fs.readFileSync(marketFilePath(), 'utf-8').split('\n')[0]);
    expect(firstLine.t).toBe('meta');
    expect(firstLine.formatVersion).toBe(2);
  });

  it('без formatVersion в config первая строка не содержит поля (legacy-совместимость)', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    recorder.registerMarket(makeMeta());
    await recorder.flush();

    const firstLine = JSON.parse(fs.readFileSync(marketFilePath(), 'utf-8').split('\n')[0]);
    expect(firstLine.t).toBe('meta');
    expect('formatVersion' in firstLine).toBe(false);
  });

  it('updateMarketMeta сохраняет formatVersion в перезаписанной первой строке', async () => {
    recorder = new DataRecorder(
      makeConfig(tmpDir, { formatVersion: 2 }),
      new NDJSONFormatter(),
      null,
      logger,
    );
    const meta = makeMeta();
    recorder.registerMarket(meta);
    await recorder.flush();

    await recorder.updateMarketMeta(meta.marketId, { finalPrice: 123 });

    const firstLine = JSON.parse(fs.readFileSync(marketFilePath(), 'utf-8').split('\n')[0]);
    expect(firstLine.formatVersion).toBe(2);
    expect(firstLine.m).toEqual({ finalPrice: 123 });
  });

  it('строки пишутся в порядке прихода, а не по timestamp события', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);

    // Порядок прихода намеренно противоречит source-timestamp
    recorder.recordMarketEvent(meta.marketId, { seq: 'first',  timestamp: 3000 });
    recorder.recordMarketEvent(meta.marketId, { seq: 'second', timestamp: 1000 });
    recorder.recordMarketEvent(meta.marketId, { seq: 'third',  timestamp: 2000 });
    await recorder.flush();

    const lines = fs.readFileSync(marketFilePath(), 'utf-8').trim().split('\n');
    const order = lines.slice(1).map((line) => (JSON.parse(line) as { seq: string }).seq);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('ошибка disk-записи при таймерном flush наблюдаема и не даёт unhandled rejection', async () => {
    recorder = new DataRecorder(
      makeConfig(tmpDir, { flushIntervalMs: 30 }),
      new NDJSONFormatter(),
      null,
      logger,
    );
    const meta = makeMeta();
    recorder.registerMarket(meta);

    // Событие уходит в буфер при живом stream
    expect(recorder.recordMarketEvent(meta.marketId, { seq: 1 })).toBe('recorded');

    // Ломаем stream с непустым буфером: таймерный flush упрётся в разрушенный поток
    const writers = (recorder as unknown as {
      _writers: Map<string, { stream: fs.WriteStream | null }>;
    })._writers;
    writers.get('mkt-001')!.stream!.destroy();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // Ждём таймерный flush по наблюдаемому условию (лог ошибки записи)
      await waitFor(() => loggedError(logger, 'Stream write error'));

      expect(unhandled).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith('Stream write error', expect.any(Object));
      // Запись на разрушенный stream наблюдаемо отказывает, а не копится в буфере
      expect(recorder.recordMarketEvent(meta.marketId, { seq: 2 })).toBe('failed');
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  it('registerMarket возвращает false при упавшей немедленной активации и остаётся retryable', () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();

    // Блокируем создание date-директории: файл на её месте → mkdir падает
    const today = new Date().toISOString().slice(0, 10);
    const blockingFile = path.join(tmpDir, today);
    fs.writeFileSync(blockingFile, 'block');

    expect(recorder.registerMarket(meta)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to activate market recording',
      expect.any(Object),
    );
    // Routing-состояние НЕ создано — записи адресуют незарегистрированный рынок
    expect(recorder.recordMarketEvent(meta.marketId, { seq: 1 })).toBe('unregistered');

    // Причина устранена → повторная регистрация успешна (retryable)
    fs.unlinkSync(blockingFile);
    expect(recorder.registerMarket(meta)).toBe(true);
    expect(recorder.recordMarketEvent(meta.marketId, { seq: 2 })).toBe('recorded');
  });

  it('registerMarket идемпотентен и возвращает true для уже зарегистрированного рынка', () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();

    expect(recorder.registerMarket(meta)).toBe(true);
    expect(recorder.registerMarket(meta)).toBe(true);
  });

  it('упавшая отложенная активация освобождает регистрацию; retry активирует и пишет (TEST 1/2/5)', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    // startsAt фиксирован: к моменту retry он уже в прошлом → немедленная активация
    const startsAtMs = Date.now() + 40;
    const meta: MarketMeta = {
      ...makeMeta(),
      startsAt: { toNumber: () => startsAtMs } as never,
    };

    // Блокируем date-директорию ДО срабатывания таймера активации
    const today = new Date().toISOString().slice(0, 10);
    const blockingFile = path.join(tmpDir, today);
    fs.writeFileSync(blockingFile, 'block');

    const failures: string[] = [];
    expect(
      recorder.registerMarket(meta, (marketId) => failures.push(String(marketId))),
    ).toBe(true);
    expect(recorder.recordMarketEvent(meta.marketId, { seq: 1 })).toBe('inactive');

    // TEST 1: отказ таймерной активации ОСВОБОЖДАЕТ регистрацию (не failed-зомби)
    await waitFor(() =>
      loggedError(logger, 'Market registration released after failed delayed activation'),
    );
    expect(failures).toEqual(['mkt-001']);
    expect(recorder.recordMarketEvent(meta.marketId, { seq: 2 })).toBe('unregistered');
    // TEST 5: legacy token-index не находит старый failed writer (тихий no-op)
    expect(() => {
      recorder.recordEvent(unsafeInstrumentId('tok-yes'), { seq: 3 });
    }).not.toThrow();

    // TEST 2: причина устранена → retry = НАСТОЯЩАЯ регистрация с активацией
    fs.unlinkSync(blockingFile);
    expect(recorder.registerMarket(meta)).toBe(true); // startsAt уже в прошлом → immediate
    expect(logger.info).toHaveBeenCalledWith('Market recording activated', expect.any(Object));

    expect(
      recorder.recordMarketEvent(meta.marketId, { topic: 'market', type: 'book' }),
    ).toBe('recorded');
    // Legacy token-index указывает на НОВЫЙ writer
    recorder.recordEvent(unsafeInstrumentId('tok-yes'), { legacy: true });
    await recorder.flush();

    const lines = fs.readFileSync(marketFilePath(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect((JSON.parse(lines[1]!) as { type: string }).type).toBe('book');
    expect((JSON.parse(lines[2]!) as { legacy: boolean }).legacy).toBe(true);
  });

  it('finalizeMarket до startsAt отменяет таймер — release не срабатывает (TEST 6)', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const startsAtMs = Date.now() + 40;
    const meta: MarketMeta = {
      ...makeMeta(),
      startsAt: { toNumber: () => startsAtMs } as never,
    };

    const failures: string[] = [];
    expect(recorder.registerMarket(meta, () => failures.push('release'))).toBe(true);
    await recorder.finalizeMarket(meta.marketId, 'SHUTDOWN');

    // Ждём мимо startsAt: отменённый таймер не должен ни активировать, ни release-ить
    await waitFor(() => Date.now() > startsAtMs + 60);
    expect(failures).toEqual([]);
    expect(
      loggedError(logger, 'Market registration released after failed delayed activation'),
    ).toBe(false);

    // close идемпотентен и не спотыкается о финализированный рынок
    await recorder.close();
    await recorder.close();
  });

  it('finalizeMarket после отказа отложенной активации — no-op без исключений (TEST 6)', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta: MarketMeta = {
      ...makeMeta(),
      startsAt: { toNumber: () => Date.now() + 40 } as never,
    };
    const today = new Date().toISOString().slice(0, 10);
    const blockingFile = path.join(tmpDir, today);
    fs.writeFileSync(blockingFile, 'block');

    expect(recorder.registerMarket(meta)).toBe(true);
    await waitFor(() =>
      loggedError(logger, 'Market registration released after failed delayed activation'),
    );

    // Регистрация уже освобождена — финализация не находит рынок и не бросает
    await expect(recorder.finalizeMarket(meta.marketId, 'EXPIRED')).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith('finalizeMarket: market not found', expect.any(Object));
    fs.unlinkSync(blockingFile);
  });

  it('finalizeMarket(SHUTDOWN) удаляет незавершённый файл и не создаёт архив', async () => {
    recorder = new DataRecorder(
      makeConfig(tmpDir, { compression: 'gzip' }),
      new NDJSONFormatter(),
      new (await import('../src/compression/GzipCompressor.js')).GzipCompressor(),
      logger,
    );
    const meta = makeMeta();
    recorder.registerMarket(meta);
    recorder.recordMarketEvent(meta.marketId, { seq: 1 });

    await recorder.finalizeMarket(meta.marketId, 'SHUTDOWN');

    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(tmpDir, today);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(files).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      'Market finalized (shutdown), incomplete file removed',
      expect.any(Object),
    );
    // Рынок снят с регистрации
    expect(recorder.recordMarketEvent(meta.marketId, { seq: 2 })).toBe('unregistered');
  });
});

describe('DataRecorder sealed markets (N-004)', () => {
  let tmpDir: string;
  let logger: ILogger;
  let recorder: DataRecorder;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-seal-test-'));
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

  function marketFilePath(): string {
    const today = new Date().toISOString().slice(0, 10);
    const dir = path.join(tmpDir, today);
    return path.join(dir, fs.readdirSync(dir)[0]);
  }

  it('seal замораживает payload: A,B записаны, D после seal отвергнут со sealed', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);
    expect(recorder.recordMarketEvent(meta.marketId, { seq: 'A' })).toBe('recorded');
    expect(recorder.recordMarketEvent(meta.marketId, { seq: 'B' })).toBe('recorded');

    expect(await recorder.sealMarket(meta.marketId)).toBe(true);

    // Новые записи отвергаются обоими путями маршрутизации
    expect(recorder.recordMarketEvent(meta.marketId, { seq: 'D' })).toBe('sealed');
    recorder.recordEvent(unsafeInstrumentId('tok-yes'), { seq: 'D-legacy' });

    // Буфер сброшен seal-ом: датасет уже на диске и заморожен
    const lines = fs.readFileSync(marketFilePath(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3); // header + A + B
    expect(JSON.parse(lines[1]).seq).toBe('A');
    expect(JSON.parse(lines[2]).seq).toBe('B');
    expect(lines.some((line) => line.includes('D'))).toBe(false);
  });

  it('seal идемпотентен; для незарегистрированного рынка возвращает false', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);

    expect(await recorder.sealMarket(meta.marketId)).toBe(true);
    expect(await recorder.sealMarket(meta.marketId)).toBe(true);
    expect(await recorder.sealMarket('unknown-mkt' as unknown as MarketId)).toBe(false);
  });

  it('header остаётся writable после seal: updateMarketMeta возвращает true и переписывает LINE 1', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);
    recorder.recordMarketEvent(meta.marketId, { seq: 'A' });
    await recorder.sealMarket(meta.marketId);

    const updated = await recorder.updateMarketMeta(meta.marketId, { finalization: 'done' });

    expect(updated).toBe(true);
    const lines = fs.readFileSync(marketFilePath(), 'utf-8').trim().split('\n');
    const header = JSON.parse(lines[0]);
    expect(header.m).toEqual({ finalization: 'done' });
    // Payload не пострадал от перезаписи header-а
    expect(JSON.parse(lines[1]).seq).toBe('A');
  });

  it('updateMarketMeta наблюдаем: false для неизвестного рынка и oversized meta', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);

    expect(await recorder.updateMarketMeta('unknown' as unknown as MarketId, { a: 1 })).toBe(false);
    expect(
      await recorder.updateMarketMeta(meta.marketId, { blob: 'x'.repeat(17 * 1024) }),
    ).toBe(false);
    expect(await recorder.updateMarketMeta(meta.marketId, { ok: true })).toBe(true);
  });

  it('finalize EXPIRED из SEALED: gzip-архив содержит замороженный датасет без потерь', async () => {
    const { GzipCompressor } = await import('../src/compression/GzipCompressor.js');
    recorder = new DataRecorder(
      makeConfig(tmpDir, { compression: 'gzip' }),
      new NDJSONFormatter(),
      new GzipCompressor(),
      logger,
    );
    const meta = makeMeta();
    recorder.registerMarket(meta);
    recorder.recordMarketEvent(meta.marketId, { seq: 'A' });
    recorder.recordMarketEvent(meta.marketId, { seq: 'B' });
    await recorder.sealMarket(meta.marketId);
    const sealedPath = marketFilePath();

    await recorder.finalizeMarket(meta.marketId, 'EXPIRED');

    const zlib = await import('node:zlib');
    const gzPath = `${sealedPath}.gz`;
    expect(fs.existsSync(gzPath)).toBe(true);
    const lines = zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1]).seq).toBe('A');
    expect(JSON.parse(lines[2]).seq).toBe('B');
  });

  it('seal с упавшим flush: строки сохранены в буфере, EXPIRED-архив отклонён', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);
    expect(recorder.recordMarketEvent(meta.marketId, { seq: 'A' })).toBe('recorded');

    // Fault injection: стрим закрывается «из-под» writer-а — flush внутри
    // seal получает write-after-end от реального fs.WriteStream
    const writer = writerInternals(recorder, 'mkt-001');
    await new Promise<void>((resolve) => writer.stream!.end(() => resolve()));

    // Freeze наступает в любом случае (cutoff), но отказ flush наблюдаем
    expect(await recorder.sealMarket(meta.marketId)).toBe(true);
    expect(loggedError(logger, 'Failed to flush buffer while sealing market')).toBe(true);
    // Непопавшие на диск строки НЕ потеряны молча — возвращены в буфер
    expect(writer.buffer.length).toBeGreaterThan(0);

    // Неполный датасет не может стать завершённым архивом
    await expect(recorder.finalizeMarket(meta.marketId, 'EXPIRED')).rejects.toThrow('incomplete');
    expect(loggedError(logger, 'Failed to finalize expired market archive')).toBe(true);
    expect(loggedInfo(logger, 'Market finalized (expired)')).toBe(false);
  });

  it('finalize EXPIRED отклоняется для writer-а с терминальным отказом stream', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);
    expect(recorder.recordMarketEvent(meta.marketId, { seq: 'A' })).toBe('recorded');
    await recorder.flush();

    // Fault injection: терминальная I/O-ошибка стрима посреди записи
    const writer = writerInternals(recorder, 'mkt-001');
    writer.stream!.destroy(new Error('disk failure'));
    await waitFor(() => writer.failed);

    await recorder.sealMarket(meta.marketId);

    await expect(recorder.finalizeMarket(meta.marketId, 'EXPIRED')).rejects.toThrow('incomplete');
    expect(loggedInfo(logger, 'Market finalized (expired)')).toBe(false);
  });

  it('finalize EXPIRED: отказ gzip логируется error и пробрасывается — false success запрещён', async () => {
    const failingCompressor = {
      compressFile: async (): Promise<string> => {
        throw new Error('gzip pipeline failed');
      },
    } as unknown as GzipCompressor;
    recorder = new DataRecorder(
      makeConfig(tmpDir, { compression: 'gzip' }),
      new NDJSONFormatter(),
      failingCompressor,
      logger,
    );
    const meta = makeMeta();
    recorder.registerMarket(meta);
    recorder.recordMarketEvent(meta.marketId, { seq: 'A' });
    await recorder.sealMarket(meta.marketId);
    const sealedPath = marketFilePath();

    await expect(recorder.finalizeMarket(meta.marketId, 'EXPIRED')).rejects.toThrow(
      'gzip pipeline failed',
    );

    // Завершённый архив НЕ создан; отказ — error, success-лог отсутствует
    expect(fs.existsSync(`${sealedPath}.gz`)).toBe(false);
    expect(loggedError(logger, 'Failed to finalize expired market archive')).toBe(true);
    expect(loggedInfo(logger, 'Market finalized (expired)')).toBe(false);
  });

  it('SHUTDOWN-семантика для SEALED не меняется: incomplete-файл удаляется', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);
    recorder.recordMarketEvent(meta.marketId, { seq: 'A' });
    await recorder.sealMarket(meta.marketId);
    const sealedPath = marketFilePath();

    await recorder.finalizeMarket(meta.marketId, 'SHUTDOWN');

    expect(fs.existsSync(sealedPath)).toBe(false);
  });

  it('readSealedPayloadLines: отфильтрованные payload-строки без header-а', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);
    recorder.recordMarketEvent(meta.marketId, { topic: 'prices.crypto.chainlink', v: 1 });
    recorder.recordMarketEvent(meta.marketId, { topic: 'market', v: 2 });
    recorder.recordMarketEvent(meta.marketId, { topic: 'prices.crypto.chainlink', v: 3 });
    await recorder.sealMarket(meta.marketId);

    const lines = await recorder.readSealedPayloadLines(meta.marketId, (line) =>
      line.includes('prices.crypto.chainlink'),
    );

    expect(lines).toHaveLength(2);
    expect(lines!.map((line) => (JSON.parse(line) as { v: number }).v)).toEqual([1, 3]);
    // Meta-header (LINE 1) не попадает в выдачу даже при пропускающем фильтре
    const all = await recorder.readSealedPayloadLines(meta.marketId, () => true);
    expect(all).toHaveLength(3);
    expect(all!.some((line) => line.includes('"t":"meta"'))).toBe(false);
  });

  it('readSealedPayloadLines: maxMatches ограничивает выдачу', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);
    for (let index = 0; index < 5; index++) {
      recorder.recordMarketEvent(meta.marketId, { v: index });
    }
    await recorder.sealMarket(meta.marketId);

    const lines = await recorder.readSealedPayloadLines(meta.marketId, () => true, 2);

    expect(lines).toHaveLength(2);
  });

  it('readSealedPayloadLines: undefined для НЕ sealed, неизвестного и failed writer-а', async () => {
    recorder = new DataRecorder(makeConfig(tmpDir), new NDJSONFormatter(), null, logger);
    const meta = makeMeta();
    recorder.registerMarket(meta);
    recorder.recordMarketEvent(meta.marketId, { v: 1 });

    // ACTIVE writer: payload ещё не заморожен — чтение запрещено
    expect(await recorder.readSealedPayloadLines(meta.marketId, () => true)).toBeUndefined();
    expect(
      await recorder.readSealedPayloadLines('unknown' as unknown as MarketId, () => true),
    ).toBeUndefined();

    // FAILED writer: датасет заведомо неполон — деривация из него запрещена
    await recorder.flush();
    const writer = writerInternals(recorder, 'mkt-001');
    writer.stream!.destroy(new Error('disk failure'));
    await waitFor(() => writer.failed);
    await recorder.sealMarket(meta.marketId);

    expect(await recorder.readSealedPayloadLines(meta.marketId, () => true)).toBeUndefined();
  });
});
