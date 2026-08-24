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
    await waitFor(() => listFiles(dir).some((file) => file.endsWith('.jsonl.gz')));
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
    await waitFor(() => listFiles(dir).filter((f) => f.endsWith('.jsonl.gz')).length === 1);
    await recorder.flush();

    const files = listFiles(dir);
    expect(files).toHaveLength(2);
    const names = files.map((file) => path.basename(file).replace(/\.gz$/, ''));
    expect(new Set(names).size).toBe(2);
    // Секунды присутствуют в метках: HHMMSS{AM|PM}-HHMMSS{AM|PM}
    expect(names[0]).toMatch(/_\d{5,6}[AP]M-\d{5,6}[AP]M_ET\.jsonl$/);
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
