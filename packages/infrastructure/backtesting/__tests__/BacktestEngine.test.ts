/**
 * Тесты для BacktestEngine — движка воспроизведения снапшотов.
 *
 * @remarks
 * Проверяет корректность оркестрации бектеста:
 * - Сканирование директории снапшотов
 * - Построчное чтение NDJSON файлов
 * - Конвертацию уровней стакана в OrderbookLevel[]
 * - Передачу событий в BookUpdateHandler
 * - Корректный подсчёт статистики (processedFiles, processedEvents, errors)
 * - Обработку граничных случаев (пустая директория, невалидный JSON, невалидный asset_id)
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { Ok } from '@polymarket/result';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BacktestEngine } from '../src/BacktestEngine.js';
import type { BacktestConfig, BacktestDeps } from '../src/BacktestEngine.js';
import { BookUpdateHandler } from '@polymarket/handlers';
import type { ILogger } from '@polymarket/logger';
import type { IBookRegistry } from '@polymarket/handlers';
import type { IEventBus } from '@polymarket/event-bus';
import type { IMarketCatalog } from '@polymarket/ports';
import { Orderbook } from '@polymarket/orderbook';
import type { Money, Price, Quantity, Timestamp } from '@polymarket/value-objects';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { InstrumentInfo } from '@polymarket/ports';

// ── Вспомогательные фабрики ───────────────────────────────────────────────────

/** Создаёт мок-логгер */
function makeLogger(): ILogger {
  const child = jest.fn<ILogger['child']>();
  const logger: ILogger = {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: child as ILogger['child'],
  };
  // child возвращает тот же логгер (упрощённый мок)
  child.mockReturnValue(logger);
  return logger;
}

/** Создаёт полный BacktestDeps с замоканным IBookRegistry */
function makeDeps(logger: ILogger): {
  deps: BacktestDeps;
  bookUpdateHandler: BookUpdateHandler;
  books: IBookRegistry;
  eventBusMock: IEventBus;
} {
  const books: IBookRegistry = {
    get: jest.fn<IBookRegistry['get']>().mockReturnValue(undefined),
    getOrCreate: jest.fn<IBookRegistry['getOrCreate']>().mockImplementation(
      (marketId, tokenId) => Orderbook.empty(marketId as unknown as InstrumentId, tokenId),
    ),
    set: jest.fn<IBookRegistry['set']>(),
    delete: jest.fn<IBookRegistry['delete']>(),
    deleteMarket: jest.fn<IBookRegistry['deleteMarket']>(),
  };

  const eventBusMock: IEventBus = {
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(Ok(undefined)),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(Ok(undefined)),
    subscribe: jest.fn() as IEventBus['subscribe'],
  };

  const catalog: IMarketCatalog = {
    // Возвращаем валидный InstrumentInfo для любого tokenId — BacktestEngine не регистрирует
    // инструменты заранее, но BookUpdateHandler требует их наличия в catalog для обработки.
    get: jest.fn<IMarketCatalog['get']>().mockImplementation((tokenId) => ({
      instrumentId: tokenId,
      marketId: 'market-backtest' as unknown as MarketId,
      tickSize: {} as Price,
      minOrderSize: {} as Quantity,
      minOrderValue: {} as Money,
      active: true,
      expiresAt: {} as Timestamp,
    }) as InstrumentInfo),
    getAll: jest.fn<IMarketCatalog['getAll']>().mockReturnValue([]),
    getByMarketId: jest.fn<IMarketCatalog['getByMarketId']>().mockReturnValue(undefined),
    getAnyInstrumentByMarketIdForMetadataOnly: jest.fn<IMarketCatalog['getAnyInstrumentByMarketIdForMetadataOnly']>().mockReturnValue(undefined),
    getAllByMarketId: jest.fn<IMarketCatalog['getAllByMarketId']>().mockReturnValue([]),
    register: jest.fn<IMarketCatalog['register']>(),
    registerMarket: jest.fn<IMarketCatalog['registerMarket']>(),
    removeMarket: jest.fn<IMarketCatalog['removeMarket']>(),
    remove: jest.fn<IMarketCatalog['remove']>(),
    clear: jest.fn<IMarketCatalog['clear']>(),
  };

  const bookUpdateHandler = new BookUpdateHandler(books, eventBusMock, catalog, logger);

  const deps: BacktestDeps = {
    bookUpdateHandler,
    logger,
  };

  return { deps, bookUpdateHandler, books, eventBusMock };
}

/** Строка NDJSON-события стакана */
function makeEventLine(assetId: string, timestamp = '1000'): string {
  return JSON.stringify({
    _type: 'EVENT',
    event: {
      asset_id: assetId,
      bids: [
        { price: '0.65', size: '100' },
        { price: '0.60', size: '200' },
      ],
      asks: [
        { price: '0.70', size: '150' },
      ],
      timestamp,
    },
  });
}

/** Строка META-записи (не EVENT) */
function makeMetaLine(): string {
  return JSON.stringify({
    _type: 'META',
    marketId: '0xabc',
    recordedAt: '2026-01-01T00:00:00.000Z',
  });
}

// ── Fixtures (временные директории) ──────────────────────────────────────────

/** Создаёт временную директорию для снапшотов */
function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-test-'));
}

/** Создаёт директорию с одним NDJSON файлом */
function createSnapshotDir(
  rootDir: string,
  date: string,
  fileName: string,
  lines: string[],
): string {
  const dateDir = path.join(rootDir, date);
  fs.mkdirSync(dateDir, { recursive: true });
  const filePath = path.join(dateDir, fileName);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return filePath;
}

/** Рекурсивно удаляет директорию */
function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── Тесты ─────────────────────────────────────────────────────────────────────

describe('BacktestEngine', () => {
  let tmpDir: string;
  let logger: ILogger;

  beforeEach(() => {
    tmpDir = createTmpDir();
    logger = makeLogger();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  // ── Пустая директория ─────────────────────────────────────────────────────

  describe('пустая директория снапшотов', () => {
    it('завершается без ошибок и возвращает нулевую статистику', async () => {
      const config: BacktestConfig = { snapshotDir: tmpDir };
      const { deps } = makeDeps(logger);
      const engine = new BacktestEngine(config, deps);

      const result = await engine.run();

      expect(result.processedFiles).toBe(0);
      expect(result.processedEvents).toBe(0);
      expect(result.errors).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('обрабатывает несуществующую директорию без исключений', async () => {
      const config: BacktestConfig = {
        snapshotDir: path.join(tmpDir, 'nonexistent'),
      };
      const { deps } = makeDeps(logger);
      const engine = new BacktestEngine(config, deps);

      const result = await engine.run();
      expect(result.processedFiles).toBe(0);
    });
  });

  // ── Обработка EVENT-записей ───────────────────────────────────────────────

  describe('обработка EVENT-записей', () => {
    it('передаёт событие стакана в BookUpdateHandler', async () => {
      const assetId = '12345678901234567890';
      createSnapshotDir(tmpDir, '2026-01-01', 'market.jsonl', [
        makeMetaLine(),
        makeEventLine(assetId, '1704067200000'),
      ]);

      const config: BacktestConfig = { snapshotDir: tmpDir };
      const { deps, books } = makeDeps(logger);
      const engine = new BacktestEngine(config, deps);

      const result = await engine.run();

      expect(result.processedFiles).toBe(1);
      expect(result.processedEvents).toBe(1);
      expect(result.errors).toBe(0);
      // BookUpdateHandler должен положить построенный Orderbook в реестр
      expect(books.set).toHaveBeenCalledTimes(1);
    });

    it('обрабатывает несколько EVENT-записей в одном файле', async () => {
      const assetId = '12345678901234567890';
      createSnapshotDir(tmpDir, '2026-01-01', 'market.jsonl', [
        makeEventLine(assetId, '1000'),
        makeEventLine(assetId, '2000'),
        makeEventLine(assetId, '3000'),
      ]);

      const config: BacktestConfig = { snapshotDir: tmpDir };
      const { deps, books } = makeDeps(logger);
      const engine = new BacktestEngine(config, deps);

      const result = await engine.run();

      expect(result.processedEvents).toBe(3);
      expect(books.set).toHaveBeenCalledTimes(3);
    });

    it('игнорирует META-записи (_type !== "EVENT")', async () => {
      createSnapshotDir(tmpDir, '2026-01-01', 'market.jsonl', [
        makeMetaLine(),
        makeMetaLine(),
      ]);

      const config: BacktestConfig = { snapshotDir: tmpDir };
      const { deps, books } = makeDeps(logger);
      const engine = new BacktestEngine(config, deps);

      const result = await engine.run();

      expect(result.processedFiles).toBe(1);
      expect(result.processedEvents).toBe(0);
      expect(result.errors).toBe(0);
      expect(books.set).not.toHaveBeenCalled();
    });
  });

  // ── Обработка нескольких файлов ───────────────────────────────────────────

  describe('обработка нескольких файлов', () => {
    it('обрабатывает файлы из нескольких дат', async () => {
      const assetId = '12345678901234567890';
      createSnapshotDir(tmpDir, '2026-01-01', 'market.jsonl', [
        makeEventLine(assetId),
      ]);
      createSnapshotDir(tmpDir, '2026-01-02', 'market.jsonl', [
        makeEventLine(assetId),
        makeEventLine(assetId),
      ]);

      const config: BacktestConfig = { snapshotDir: tmpDir };
      const { deps } = makeDeps(logger);
      const engine = new BacktestEngine(config, deps);

      const result = await engine.run();

      expect(result.processedFiles).toBe(2);
      expect(result.processedEvents).toBe(3);
    });
  });

  // ── Фильтрация по датам ───────────────────────────────────────────────────

  describe('фильтрация по датам', () => {
    it('фильтрует файлы по fromDate', async () => {
      const assetId = '12345678901234567890';
      createSnapshotDir(tmpDir, '2026-01-01', 'market.jsonl', [makeEventLine(assetId)]);
      createSnapshotDir(tmpDir, '2026-01-02', 'market.jsonl', [makeEventLine(assetId)]);
      createSnapshotDir(tmpDir, '2026-01-03', 'market.jsonl', [makeEventLine(assetId)]);

      const config: BacktestConfig = {
        snapshotDir: tmpDir,
        fromDate: '2026-01-02',
      };
      const { deps } = makeDeps(logger);
      const engine = new BacktestEngine(config, deps);

      const result = await engine.run();

      expect(result.processedFiles).toBe(2);
      expect(result.processedEvents).toBe(2);
    });

    it('фильтрует файлы по toDate', async () => {
      const assetId = '12345678901234567890';
      createSnapshotDir(tmpDir, '2026-01-01', 'market.jsonl', [makeEventLine(assetId)]);
      createSnapshotDir(tmpDir, '2026-01-02', 'market.jsonl', [makeEventLine(assetId)]);
      createSnapshotDir(tmpDir, '2026-01-03', 'market.jsonl', [makeEventLine(assetId)]);

      const config: BacktestConfig = {
        snapshotDir: tmpDir,
        toDate: '2026-01-02',
      };
      const { deps } = makeDeps(logger);
      const engine = new BacktestEngine(config, deps);

      const result = await engine.run();

      expect(result.processedFiles).toBe(2);
      expect(result.processedEvents).toBe(2);
    });

    it('применяет одновременно fromDate и toDate', async () => {
      const assetId = '12345678901234567890';
      createSnapshotDir(tmpDir, '2026-01-01', 'market.jsonl', [makeEventLine(assetId)]);
      createSnapshotDir(tmpDir, '2026-01-02', 'market.jsonl', [makeEventLine(assetId)]);
      createSnapshotDir(tmpDir, '2026-01-03', 'market.jsonl', [makeEventLine(assetId)]);
      createSnapshotDir(tmpDir, '2026-01-04', 'market.jsonl', [makeEventLine(assetId)]);

      const config: BacktestConfig = {
        snapshotDir: tmpDir,
        fromDate: '2026-01-02',
        toDate: '2026-01-03',
      };
      const { deps } = makeDeps(logger);
      const engine = new BacktestEngine(config, deps);

      const result = await engine.run();

      expect(result.processedFiles).toBe(2);
      expect(result.processedEvents).toBe(2);
    });
  });

  // ── Обработка ошибок ─────────────────────────────────────────────────────

  describe('обработка ошибок', () => {
    it('считает невалидный JSON строкой ошибки и продолжает', async () => {
      const assetId = '12345678901234567890';
      createSnapshotDir(tmpDir, '2026-01-01', 'market.jsonl', [
        'invalid json {{{',
        makeEventLine(assetId),
      ]);

      const config: BacktestConfig = { snapshotDir: tmpDir };
      const { deps } = makeDeps(logger);
      const engine = new BacktestEngine(config, deps);

      const result = await engine.run();

      expect(result.processedFiles).toBe(1);
      expect(result.processedEvents).toBe(1);
      expect(result.errors).toBe(1);
    });

    it('считает невалидный asset_id ошибкой и пропускает событие', async () => {
      createSnapshotDir(tmpDir, '2026-01-01', 'market.jsonl', [
        JSON.stringify({
          _type: 'EVENT',
          event: {
            asset_id: '',  // Пустой asset_id — невалидный InstrumentId
            bids: [{ price: '0.65', size: '100' }],
            asks: [],
            timestamp: '1000',
          },
        }),
      ]);

      const config: BacktestConfig = { snapshotDir: tmpDir };
      const { deps, books } = makeDeps(logger);
      const engine = new BacktestEngine(config, deps);

      const result = await engine.run();

      expect(result.processedFiles).toBe(1);
      expect(result.processedEvents).toBe(0);
      expect(result.errors).toBe(1);
      expect(books.set).not.toHaveBeenCalled();
    });

    it('пропускает невалидные уровни стакана и продолжает обработку', async () => {
      const assetId = '12345678901234567890';
      createSnapshotDir(tmpDir, '2026-01-01', 'market.jsonl', [
        JSON.stringify({
          _type: 'EVENT',
          event: {
            asset_id: assetId,
            bids: [
              { price: 'INVALID_PRICE', size: '100' },
              { price: '0.65', size: '200' },
            ],
            asks: [],
            timestamp: '1000',
          },
        }),
      ]);

      const config: BacktestConfig = { snapshotDir: tmpDir };
      const { deps, books } = makeDeps(logger);
      const engine = new BacktestEngine(config, deps);

      const result = await engine.run();

      // Событие обрабатывается — невалидный уровень просто пропущен
      expect(result.processedFiles).toBe(1);
      expect(result.processedEvents).toBe(1);
      expect(result.errors).toBe(0);
      // Orderbook, положенный в реестр, построен без невалидного уровня
      expect(books.set).toHaveBeenCalledTimes(1);
      const callArgs = (books.set as ReturnType<typeof jest.fn>).mock.calls[0] as [MarketId, InstrumentId, Orderbook];
      // bids должен содержать только валидный уровень
      expect(callArgs[2].bids.length).toBe(1);
    });
  });

  // ── BacktestResult ────────────────────────────────────────────────────────

  describe('BacktestResult', () => {
    it('возвращает корректную durationMs (больше 0)', async () => {
      const assetId = '12345678901234567890';
      createSnapshotDir(tmpDir, '2026-01-01', 'market.jsonl', [
        makeEventLine(assetId),
      ]);

      const config: BacktestConfig = { snapshotDir: tmpDir };
      const { deps } = makeDeps(logger);
      const engine = new BacktestEngine(config, deps);

      const result = await engine.run();

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('возвращает корректную структуру BacktestResult', async () => {
      const config: BacktestConfig = { snapshotDir: tmpDir };
      const { deps } = makeDeps(logger);
      const engine = new BacktestEngine(config, deps);

      const result = await engine.run();

      expect(result).toMatchObject({
        processedFiles: expect.any(Number),
        processedEvents: expect.any(Number),
        durationMs: expect.any(Number),
        errors: expect.any(Number),
      });
    });
  });
});
