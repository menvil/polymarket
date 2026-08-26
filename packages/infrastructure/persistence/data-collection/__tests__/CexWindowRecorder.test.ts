/**
 * Тесты оконной CEX storage-policy (N-005 PART 24).
 *
 * @remarks
 * Детерминированные тесты используют инъецированный источник времени
 * (окно назначается в момент записи), реальный диск и реальный gzip.
 * Sweep «тихих» окон проверяется на реальном времени с коротким окном.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { ILogger } from '@polymarket/logger';
import { CexWindowRecorder } from '../src/CexWindowRecorder.js';
import type { CexWindowRecorderConfig } from '../src/CexWindowRecorder.js';
import { GzipCompressor } from '../src/compression/GzipCompressor.js';

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

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Все файлы дерева outputDir (относительные пути). */
function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Ждёт ЗАВЕРШЁННЫХ партиций: `.jsonl.gz` появился И исходный `.jsonl` удалён.
 *
 * @remarks
 * Это ДВА разных события: `GzipCompressor` сначала переименовывает временный
 * файл в `.gz` и только потом удаляет исходник. Ожидание одного лишь `.gz`
 * ловит середину ротации, и в листинге оказываются оба файла сразу — под
 * параллельной нагрузкой (полный прогон монорепы) это давало флейк.
 */
async function waitForCompletedPartitions(
  root: string,
  count: number,
  timeoutMs = 3_000,
): Promise<void> {
  await waitFor(() => {
    const files = listFiles(root);
    const archives = files.filter((file) => file.endsWith('.jsonl.gz'));
    if (archives.length !== count) return false;
    return archives.every((archive) => !files.includes(archive.replace(/\.gz$/, '')));
  }, timeoutMs);
}

function gunzipLines(filePath: string): string[] {
  const raw = zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8');
  return raw.split('\n').filter((line) => line.length > 0);
}

const WINDOW_MS = 5 * 60_000;
/** 2026-08-25 13:55:00 UTC = 09:55 AM ET (EDT) — выровнено по 5-мин окну. */
const ALIGNED_T0 = Date.UTC(2026, 7, 25, 13, 55, 0, 0);

describe('CexWindowRecorder (инъецированное время)', () => {
  let dir: string;
  let now: number;
  let recorder: CexWindowRecorder;

  const makeRecorder = (overrides: Partial<CexWindowRecorderConfig> = {}): CexWindowRecorder =>
    new CexWindowRecorder(
      {
        outputDir: dir,
        compression: 'gzip',
        windowMinutes: 5,
        bufferSize: 200,
        flushIntervalMs: 60_000,
        ...overrides,
      },
      makeLogger(),
      () => now,
    );

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cex-window-'));
    // Старт в середине окна: первая граница = ALIGNED_T0 + WINDOW_MS
    now = ALIGNED_T0 + 90_000;
    recorder = makeRecorder();
  });

  afterEach(async () => {
    await recorder.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('записи до первой границы окна отбрасываются (aligned start)', async () => {
    recorder.start();

    expect(recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { a: 1 })).toBe('inactive');

    // Первая граница достигнута — приём начался
    now = ALIGNED_T0 + WINDOW_MS + 1_000;
    expect(recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { a: 2 })).toBe('recorded');
    await recorder.flush();

    const files = listFiles(dir);
    expect(files).toHaveLength(1);
    const content = fs.readFileSync(path.join(dir, files[0]!), 'utf8');
    expect(content.trim().split('\n')).toEqual([JSON.stringify({ a: 2 })]);
  });

  it('write до start() и после close() → inactive', async () => {
    expect(recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { a: 1 })).toBe('inactive');
    recorder.start();
    await recorder.close();
    expect(recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { a: 1 })).toBe('inactive');
  });

  it('одно окно → одна партиция; строки payload-only', async () => {
    recorder.start();
    now = ALIGNED_T0 + WINDOW_MS + 1_000;

    const payloadA = { exchangeId: 'binance', symbol: 'BTC/USDT', orderBook: { bids: [[1, 2]] } };
    const payloadB = { exchangeId: 'binance', symbol: 'BTC/USDT', orderBook: { bids: [[3, 4]] } };
    recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', payloadA);
    now += 60_000; // то же окно
    recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', payloadB);
    await recorder.flush();

    const files = listFiles(dir);
    expect(files).toHaveLength(1);
    const lines = fs
      .readFileSync(path.join(dir, files[0]!), 'utf8')
      .trim()
      .split('\n');
    // Payload-only инвариант: строка === JSON.stringify(payload), без envelope
    expect(lines).toEqual([JSON.stringify(payloadA), JSON.stringify(payloadB)]);
  });

  it('пересечение границы: старая партиция закрывается и сжимается, новая открывается', async () => {
    recorder.start();
    const window1 = ALIGNED_T0 + WINDOW_MS;
    now = window1 + 1_000;
    recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { w: 1 });

    // Следующее окно: запись немедленно принимается в НОВУЮ партицию
    now = window1 + WINDOW_MS + 1_000;
    expect(recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { w: 2 })).toBe('recorded');

    // Старая партиция завершена: .jsonl.gz появился, .jsonl удалён
    await waitForCompletedPartitions(dir, 1);
    const files = listFiles(dir);
    const gz = files.find((file) => file.endsWith('.jsonl.gz'))!;
    const open = files.filter((file) => file.endsWith('.jsonl') && !file.endsWith('.jsonl.gz'));
    expect(open).toHaveLength(1);
    expect(gz).not.toBe(open[0]);

    expect(gunzipLines(path.join(dir, gz))).toEqual([JSON.stringify({ w: 1 })]);

    await recorder.flush();
    const openContent = fs.readFileSync(path.join(dir, open[0]!), 'utf8').trim();
    expect(openContent).toBe(JSON.stringify({ w: 2 }));
  });

  it('routing: биржа/символ/тип рынка/поток не смешиваются', async () => {
    recorder.start();
    now = ALIGNED_T0 + WINDOW_MS + 1_000;

    recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { id: 'binance-ob' });
    recorder.write('bybit', 'BTC/USDT', 'spot', 'orderbook', { id: 'bybit-ob' });
    recorder.write('binance', 'ETH/USDT', 'spot', 'orderbook', { id: 'eth-ob' });
    recorder.write('binance', 'BTC/USDT', 'swap', 'orderbook', { id: 'swap-ob' });
    recorder.write('binance', 'BTC/USDT', 'spot', 'trades', { id: 'binance-trade' });
    await recorder.flush();

    const files = listFiles(dir);
    expect(files).toHaveLength(5);

    const contentByFile = new Map(
      files.map((file) => [
        file,
        fs.readFileSync(path.join(dir, file), 'utf8').trim(),
      ]),
    );
    const fileWith = (needle: string): string => {
      const found = files.filter((file) => contentByFile.get(file)!.includes(needle));
      expect(found).toHaveLength(1);
      return found[0]!;
    };

    const binanceOb = fileWith('binance-ob');
    expect(binanceOb).toContain(`binance${path.sep}binance_BTC-USDT_spot_orderbook_`);
    const bybitOb = fileWith('bybit-ob');
    expect(bybitOb).toContain(`bybit${path.sep}bybit_`);
    const ethOb = fileWith('eth-ob');
    expect(ethOb).toContain('ETH-USDT');
    const swapOb = fileWith('swap-ob');
    expect(swapOb).toContain('_swap_orderbook_');
    const binanceTrade = fileWith('binance-trade');
    expect(binanceTrade).toContain('_spot_trades_');
  });

  it('детерминированное naming: UTC-директория, ET-метки окна, санитизация символа', async () => {
    recorder.start();
    now = ALIGNED_T0 + WINDOW_MS + 1_000; // окно 14:00–14:05 UTC = 1000AM–1005AM ET

    recorder.write('binance', 'BTC/USDT:USDT', 'swap', 'trades', { x: 1 });
    await recorder.flush();

    const files = listFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(
      path.join(
        '2026-08-25',
        'binance',
        'binance_BTC-USDT-USDT_swap_trades_2026-August-25_1000AM-1005AM_ET.jsonl',
      ),
    );
  });

  it('суб-минутные окна получают секунды в метке: разные окна → разные имена', async () => {
    // Тестовое окно 15s: два соседних окна внутри одной минуты обязаны
    // получить РАЗНЫЕ имена (production-окна кратны минуте и не задеты)
    recorder = makeRecorder({ windowMinutes: 0.25 });
    recorder.start();
    const windowMs = 15_000;
    const firstWindow = Math.floor(now / windowMs) * windowMs + windowMs;

    now = firstWindow + 1_000;
    recorder.write('binance', 'BTC/USDT', 'spot', 'trades', { w: 1 });
    now = firstWindow + windowMs + 1_000;
    recorder.write('binance', 'BTC/USDT', 'spot', 'trades', { w: 2 });
    await waitForCompletedPartitions(dir, 1);
    await recorder.flush();

    const files = listFiles(dir);
    expect(files).toHaveLength(2);
    const names = files.map((file) => path.basename(file).replace(/\.gz$/, ''));
    expect(new Set(names).size).toBe(2);
    // Секунды присутствуют в метках: HHMMSS{AM|PM}-HHMMSS{AM|PM} (час двузначный)
    expect(names[0]).toMatch(/_\d{6}[AP]M-\d{6}[AP]M_ET\.jsonl$/);
  });

  it('однозначный час ET дополняется нулём: формат HHMM (0835AM)', async () => {
    // 12:30 UTC = 08:30 AM ET (EDT); первая граница = 12:35 UTC.
    // Отдельный recorder: точка выравнивания фиксируется в start()
    const morning = Date.UTC(2026, 7, 25, 12, 30, 0, 0);
    now = morning + 1_000;
    const morningRecorder = makeRecorder();
    morningRecorder.start();
    now = morning + 5 * 60_000 + 1_000; // внутри окна 12:35–12:40 UTC
    expect(
      morningRecorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { h: 1 }),
    ).toBe('recorded');
    await morningRecorder.flush();

    const files = listFiles(dir).filter((file) => file.includes('_orderbook_'));
    expect(files.some((file) => file.includes('_0835AM-0840AM_ET.jsonl'))).toBe(true);
    await morningRecorder.close();
  });

  it('threshold flush: буфер сбрасывается без явного flush()', async () => {
    recorder = makeRecorder({ bufferSize: 2 });
    recorder.start();
    now = ALIGNED_T0 + WINDOW_MS + 1_000;

    recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { n: 1 });
    recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { n: 2 });

    await waitFor(() => {
      const files = listFiles(dir);
      if (files.length !== 1) return false;
      return fs.readFileSync(path.join(dir, files[0]!), 'utf8').includes('"n":2');
    });
  });

  it('интервальный flush: буфер сбрасывается по таймеру', async () => {
    recorder = makeRecorder({ flushIntervalMs: 50 });
    recorder.start();
    now = ALIGNED_T0 + WINDOW_MS + 1_000;

    recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { timer: true });

    await waitFor(() => {
      const files = listFiles(dir);
      if (files.length !== 1) return false;
      return fs.readFileSync(path.join(dir, files[0]!), 'utf8').includes('"timer":true');
    });
  });

  it('close: незавершённое окно удаляется, завершённый .gz остаётся', async () => {
    recorder.start();
    const window1 = ALIGNED_T0 + WINDOW_MS;
    now = window1 + 1_000;
    recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { done: 1 });

    now = window1 + WINDOW_MS + 1_000;
    recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { incomplete: 1 });
    await waitFor(() => listFiles(dir).some((file) => file.endsWith('.jsonl.gz')));

    await recorder.close();

    const files = listFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0]!.endsWith('.jsonl.gz')).toBe(true);
    expect(gunzipLines(path.join(dir, files[0]!))).toEqual([JSON.stringify({ done: 1 })]);
  });

  it('несериализуемый payload → failed, остальные записи не страдают', async () => {
    recorder.start();
    now = ALIGNED_T0 + WINDOW_MS + 1_000;

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', circular)).toBe('failed');
    expect(recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { ok: 1 })).toBe('recorded');
    await recorder.flush();

    const files = listFiles(dir);
    const lines = fs.readFileSync(path.join(dir, files[0]!), 'utf8').trim().split('\n');
    expect(lines).toEqual([JSON.stringify({ ok: 1 })]);
  });

  it('cleanup: удаляет незавершённые .jsonl, не трогая .jsonl.gz', async () => {
    const strayDir = path.join(dir, '2026-08-24', 'binance');
    fs.mkdirSync(strayDir, { recursive: true });
    fs.writeFileSync(path.join(strayDir, 'stray_incomplete.jsonl'), '{"stale":1}\n');
    fs.writeFileSync(path.join(strayDir, 'completed.jsonl.gz'), zlib.gzipSync('{"ok":1}\n'));
    // Файл вне датированной структуры не трогается
    fs.writeFileSync(path.join(dir, 'unrelated.jsonl'), '{}\n');

    await recorder.cleanup();

    expect(fs.existsSync(path.join(strayDir, 'stray_incomplete.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(strayDir, 'completed.jsonl.gz'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'unrelated.jsonl'))).toBe(true);
  });
});

/**
 * Управляемый fake writable stream: детерминированно воспроизводит
 * hang/error пути write/end без реального FS и без ожидания production
 * таймаутов (test hook `createStream` + `streamCloseTimeoutMs`).
 */
class FakeWriteStream {
  public destroyCalls = 0;
  public written = '';
  /** Отложенные write-подтверждения режима `write-manual`. */
  public readonly pendingWrites: Array<() => void> = [];
  private readonly _errorListeners: Array<(error: Error) => void> = [];
  private readonly _closeListeners: Array<() => void> = [];

  constructor(
    private readonly _mode:
      | 'ok'
      | 'write-error'
      | 'write-hang'
      | 'write-manual'
      | 'end-hang'
      | 'end-error',
  ) {}

  public write(data: string, callback?: (error?: Error | null) => void): boolean {
    if (this._mode === 'write-error') {
      callback?.(new Error('injected write failure'));
      return true;
    }
    if (this._mode === 'write-hang') {
      return true; // подтверждение никогда не приходит
    }
    if (this._mode === 'write-manual') {
      // Подтверждение придёт только когда тест освободит его явно
      this.pendingWrites.push(() => {
        this.written += data;
        callback?.(null);
      });
      return true;
    }
    this.written += data;
    callback?.(null);
    return true;
  }

  public end(callback?: (error?: Error | null) => void): void {
    if (this._mode === 'end-hang') {
      return; // finish никогда не приходит
    }
    if (this._mode === 'end-error') {
      callback?.(new Error('injected close failure'));
      return;
    }
    callback?.(null);
  }

  public on(event: string, listener: (...args: never[]) => void): this {
    if (event === 'error') this._errorListeners.push(listener as (error: Error) => void);
    return this;
  }

  public once(event: string, listener: (...args: never[]) => void): this {
    if (event === 'error') this._errorListeners.push(listener as (error: Error) => void);
    if (event === 'close') this._closeListeners.push(listener as () => void);
    return this;
  }

  public destroy(): void {
    this.destroyCalls++;
    for (const listener of this._closeListeners.splice(0)) {
      listener();
    }
  }
}

/** Stream, чей write бросает СИНХРОННО (не через callback). */
class ThrowingWriteStream {
  public write(): boolean {
    throw new Error('injected synchronous write throw');
  }

  public end(callback?: (error?: Error | null) => void): void {
    callback?.(null);
  }

  public on(): this {
    return this;
  }

  public once(event: string, listener: () => void): this {
    if (event === 'close') listener();
    return this;
  }

  public destroy(): void {
    // no-op
  }
}

describe('CexWindowRecorder: строгая completion-семантика (failure paths)', () => {
  let dir: string;
  let now: number;
  let logger: ILogger;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cex-window-fail-'));
    now = ALIGNED_T0 + 90_000;
    logger = makeLogger();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Recorder с fake-stream фабрикой и коротким подтверждающим таймаутом. */
  function makeFailingRecorder(mode: ConstructorParameters<typeof FakeWriteStream>[0]): {
    recorder: CexWindowRecorder;
    streams: FakeWriteStream[];
  } {
    const streams: FakeWriteStream[] = [];
    const recorder = new CexWindowRecorder(
      {
        outputDir: dir,
        compression: 'gzip',
        windowMinutes: 5,
        flushIntervalMs: 60_000,
        streamCloseTimeoutMs: 30,
      },
      logger,
      () => now,
      (filePath) => {
        void filePath;
        const stream = new FakeWriteStream(mode);
        streams.push(stream);
        return stream as unknown as fs.WriteStream;
      },
    );
    return { recorder, streams };
  }

  /** Записывает строку в первое окно и пересекает границу (триггер ротации). */
  async function writeAndRotate(recorder: CexWindowRecorder): Promise<void> {
    recorder.start();
    const window1 = ALIGNED_T0 + WINDOW_MS;
    now = window1 + 1_000;
    expect(recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { w: 1 })).toBe('recorded');
    now = window1 + WINDOW_MS + 1_000;
    recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { w: 2 });
    // Ротация первого writer-а начата write-ом выше; дожидаемся её исхода
    await waitFor(() => recorder.getStats().rotationFailures + recorder.getStats().partitionsCompleted > 0);
  }

  /** Совокупные ассерты «партиция НЕ объявлена completed». */
  function expectNotCompleted(recorder: CexWindowRecorder): void {
    const stats = recorder.getStats();
    expect(stats.partitionsCompleted).toBe(0);
    expect(stats.rotationFailures).toBe(1);
    // Ни одного .jsonl.gz не появилось
    expect(listFiles(dir).some((file) => file.endsWith('.jsonl.gz'))).toBe(false);
    // «Partition completed» не логировался
    const infoCalls = jest.mocked(logger.info).mock.calls.map((call) => String(call[0]));
    expect(infoCalls.some((message) => message.includes('partition completed'))).toBe(false);
  }

  it('write/flush error → writer failed, без gzip, партиция не completed (4.4)', async () => {
    const { recorder } = makeFailingRecorder('write-error');
    await writeAndRotate(recorder);

    expectNotCompleted(recorder);
    expect(recorder.getStats().streamCloseFailures).toBeGreaterThanOrEqual(1);
    await recorder.close();
  });

  it('flush confirmation timeout → отказ, без gzip (4.4/13)', async () => {
    const { recorder } = makeFailingRecorder('write-hang');
    await writeAndRotate(recorder);

    expectNotCompleted(recorder);
    expect(recorder.getStats().streamCloseFailures).toBeGreaterThanOrEqual(1);
    await recorder.close();
  });

  it('stream close error → без gzip, партиция не completed (4.3)', async () => {
    const { recorder } = makeFailingRecorder('end-error');
    await writeAndRotate(recorder);

    expectNotCompleted(recorder);
    expect(recorder.getStats().streamCloseFailures).toBe(1);
    await recorder.close();
  });

  it('stream close timeout → отказ (НЕ успех), stream разрушен, без gzip (4.2)', async () => {
    const { recorder, streams } = makeFailingRecorder('end-hang');
    await writeAndRotate(recorder);

    expectNotCompleted(recorder);
    expect(recorder.getStats().streamCloseFailures).toBe(1);
    // Dangling writable stream не остаётся — разрушен best-effort
    expect(streams[0]!.destroyCalls).toBeGreaterThanOrEqual(1);

    // Failed rotation не подвешивает shutdown
    const closeStart = Date.now();
    await recorder.close();
    expect(Date.now() - closeStart).toBeLessThan(1_000);
  });

  it('gzip failure → .jsonl остаётся, НЕ completed, без false-success (4.5)', async () => {
    jest
      .spyOn(GzipCompressor.prototype, 'compressFile')
      .mockRejectedValue(new Error('injected gzip failure'));

    // Реальные streams: до gzip-этапа цепочка успешна
    const recorder = new CexWindowRecorder(
      {
        outputDir: dir,
        compression: 'gzip',
        windowMinutes: 5,
        flushIntervalMs: 60_000,
      },
      logger,
      () => now,
    );
    await writeAndRotate(recorder);

    const stats = recorder.getStats();
    expect(stats.compressionFailures).toBe(1);
    expect(stats.rotationFailures).toBe(1);
    expect(stats.partitionsCompleted).toBe(0);
    // Исходный .jsonl НЕ уничтожен и данные читаемы
    const leftover = listFiles(dir).filter(
      (file) => file.endsWith('.jsonl') && file.includes('_orderbook_') && !file.includes('.gz'),
    );
    const failedPartition = leftover.find((file) =>
      fs.readFileSync(path.join(dir, file), 'utf8').includes('"w":1'),
    );
    expect(failedPartition).toBeDefined();
    expect(listFiles(dir).some((file) => file.endsWith('.jsonl.gz'))).toBe(false);
    const infoCalls = jest.mocked(logger.info).mock.calls.map((call) => String(call[0]));
    expect(infoCalls.some((message) => message.includes('partition completed'))).toBe(false);

    await recorder.close();
  });

  it('конкурентные flush сериализуются: второй не резолвится до чужого подтверждения', async () => {
    // Большой подтверждающий таймаут: гонка проверяется до его истечения
    const streams: FakeWriteStream[] = [];
    const recorder = new CexWindowRecorder(
      {
        outputDir: dir,
        compression: 'gzip',
        windowMinutes: 5,
        flushIntervalMs: 60_000,
        streamCloseTimeoutMs: 5_000,
      },
      logger,
      () => now,
      (filePath) => {
        void filePath;
        const stream = new FakeWriteStream('write-manual');
        streams.push(stream);
        return stream as unknown as fs.WriteStream;
      },
    );
    recorder.start();
    now = ALIGNED_T0 + WINDOW_MS + 1_000;
    expect(recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { race: 1 })).toBe(
      'recorded',
    );

    // Первый flush дренирует буфер, его write-подтверждение задержано
    const first = recorder.flush();
    await waitFor(() => streams[0]!.pendingWrites.length === 1);

    // Второй flush видит ПУСТОЙ буфер, но обязан ждать чужое подтверждение
    let secondSettled = false;
    const second = recorder.flush().then(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondSettled).toBe(false);

    // Освобождаем подтверждение — обе цепочки завершаются, данные «на диске»
    streams[0]!.pendingWrites.shift()!();
    await Promise.all([first, second]);
    expect(secondSettled).toBe(true);
    expect(streams[0]!.written).toBe(`${JSON.stringify({ race: 1 })}\n`);

    await recorder.close();
  });

  it('синхронный throw stream.write не даёт unhandled rejection (hot path + ротация)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const recorder = new CexWindowRecorder(
        {
          outputDir: dir,
          compression: 'gzip',
          windowMinutes: 5,
          bufferSize: 1, // threshold-flush через void прямо из write()
          flushIntervalMs: 60_000,
          streamCloseTimeoutMs: 30,
        },
        logger,
        () => now,
        () => new ThrowingWriteStream() as unknown as fs.WriteStream,
      );
      recorder.start();
      const window1 = ALIGNED_T0 + WINDOW_MS;
      now = window1 + 1_000;

      // Hot path: threshold-flush падает синхронным throw → поглощён
      expect(recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { t: 1 })).toBe('recorded');
      await waitFor(() => recorder.getStats().streamCloseFailures >= 1);
      // Writer помечен failed — последующие записи отклоняются наблюдаемо
      expect(recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { t: 2 })).toBe('failed');

      // Ротация failed-writer-а тоже не оставляет невыловленных отказов
      now = window1 + WINDOW_MS + 1_000;
      recorder.write('binance', 'BTC/USDT', 'spot', 'orderbook', { t: 3 });
      await waitFor(() => recorder.getStats().rotationFailures >= 1);
      await recorder.close();

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(recorder.getStats().partitionsCompleted).toBe(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('успешная цепочка flush → close → gzip учитывается в partitionsCompleted (4.1)', async () => {
    const recorder = new CexWindowRecorder(
      { outputDir: dir, compression: 'gzip', windowMinutes: 5, flushIntervalMs: 60_000 },
      logger,
      () => now,
    );
    await writeAndRotate(recorder);

    const stats = recorder.getStats();
    expect(stats).toEqual({
      partitionsCompleted: 1,
      rotationFailures: 0,
      streamCloseFailures: 0,
      compressionFailures: 0,
    });
    const gz = listFiles(dir).find((file) => file.endsWith('.jsonl.gz'));
    expect(gz).toBeDefined();
    expect(gunzipLines(path.join(dir, gz!))).toEqual([JSON.stringify({ w: 1 })]);
    await recorder.close();
  });

  it('compression=none: подтверждённые flush+close достаточны для completed (2.4)', async () => {
    const recorder = new CexWindowRecorder(
      { outputDir: dir, compression: 'none', windowMinutes: 5, flushIntervalMs: 60_000 },
      logger,
      () => now,
    );
    await writeAndRotate(recorder);

    expect(recorder.getStats().partitionsCompleted).toBe(1);
    expect(recorder.getStats().rotationFailures).toBe(0);
    // Политика без архива: .jsonl завершённого окна остаётся как есть
    expect(listFiles(dir).some((file) => file.endsWith('.jsonl.gz'))).toBe(false);
    await recorder.close();
  });
});

describe('CexWindowRecorder (реальное время, короткое окно)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cex-window-rt-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('тихое окно завершается boundary-sweep-ом без новых записей', async () => {
    const windowMs = 500;
    const recorder = new CexWindowRecorder(
      {
        outputDir: dir,
        compression: 'gzip',
        windowMinutes: windowMs / 60_000, // тестовое короткое окно
        flushIntervalMs: 50,
      },
      makeLogger(),
    );
    recorder.start();

    try {
      // Дожидаемся первой границы и пишем одну строку в текущее окно
      const firstBoundary = Math.floor(Date.now() / windowMs) * windowMs + windowMs;
      await waitFor(() => Date.now() >= firstBoundary + 20, 2_000);
      expect(recorder.write('binance', 'BTC/USDT', 'spot', 'trades', { sweep: 1 })).toBe(
        'recorded',
      );

      // Без единой новой записи партиция должна завершиться по границе
      await waitFor(() => listFiles(dir).some((file) => file.endsWith('.jsonl.gz')), 4_000);
      const gz = listFiles(dir).find((file) => file.endsWith('.jsonl.gz'))!;
      expect(gunzipLines(path.join(dir, gz))).toEqual([JSON.stringify({ sweep: 1 })]);
    } finally {
      await recorder.close();
    }
  });
});
