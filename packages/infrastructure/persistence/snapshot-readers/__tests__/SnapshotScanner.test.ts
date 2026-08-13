import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { SnapshotScanner } from '../src/SnapshotScanner.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ILogger } from '@polymarket/logger';

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

describe('SnapshotScanner', () => {
  let tmpDir: string;
  let scanner: SnapshotScanner;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
    scanner = new SnapshotScanner(tmpDir, makeLogger());
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createFile(date: string, name: string, content = '{"t":"meta"}\n'): void {
    const dir = path.join(tmpDir, date);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content, 'utf-8');
  }

  it('возвращает пустой результат для несуществующей директории', async () => {
    const s = new SnapshotScanner('/nonexistent/path', makeLogger());
    const result = await s.scan();
    expect(result.totalFiles).toBe(0);
    expect(result.files).toHaveLength(0);
    expect(result.dateRange).toBeNull();
  });

  it('возвращает пустой результат для пустой директории', async () => {
    const result = await scanner.scan();
    expect(result.totalFiles).toBe(0);
  });

  it('находит .jsonl файлы', async () => {
    createFile('2026-01-01', 'Market_One___0xabc.jsonl');
    const result = await scanner.scan();
    expect(result.totalFiles).toBe(1);
    expect(result.files[0].fileName).toBe('Market_One___0xabc.jsonl');
    expect(result.files[0].isGzipped).toBe(false);
    expect(result.files[0].date).toBe('2026-01-01');
  });

  it('находит .jsonl.gz файлы', async () => {
    createFile('2026-01-01', 'Market___0xabc.jsonl.gz');
    const result = await scanner.scan();
    expect(result.totalFiles).toBe(1);
    expect(result.files[0].isGzipped).toBe(true);
  });

  it('фильтрует по fromDate', async () => {
    createFile('2026-01-01', 'A___1.jsonl');
    createFile('2026-01-02', 'B___2.jsonl');
    createFile('2026-01-03', 'C___3.jsonl');
    const result = await scanner.scan({ fromDate: '2026-01-02' });
    expect(result.totalFiles).toBe(2);
    expect(result.files.map((f) => f.date)).toEqual(['2026-01-02', '2026-01-03']);
  });

  it('фильтрует по toDate', async () => {
    createFile('2026-01-01', 'A___1.jsonl');
    createFile('2026-01-02', 'B___2.jsonl');
    createFile('2026-01-03', 'C___3.jsonl');
    const result = await scanner.scan({ toDate: '2026-01-02' });
    expect(result.totalFiles).toBe(2);
  });

  it('фильтрует по fromDate и toDate', async () => {
    createFile('2026-01-01', 'A___1.jsonl');
    createFile('2026-01-02', 'B___2.jsonl');
    createFile('2026-01-03', 'C___3.jsonl');
    const result = await scanner.scan({ fromDate: '2026-01-02', toDate: '2026-01-02' });
    expect(result.totalFiles).toBe(1);
  });

  it('фильтрует по marketId', async () => {
    createFile('2026-01-01', 'Market_A___0xaaa.jsonl');
    createFile('2026-01-01', 'Market_B___0xbbb.jsonl');
    const result = await scanner.scan({ marketId: '0xaaa' });
    expect(result.totalFiles).toBe(1);
    expect(result.files[0].fileName).toContain('0xaaa');
  });

  it('правильно вычисляет dateRange', async () => {
    createFile('2026-01-01', 'A___1.jsonl');
    createFile('2026-01-05', 'B___2.jsonl');
    const result = await scanner.scan();
    expect(result.dateRange).toEqual({ from: '2026-01-01', to: '2026-01-05' });
  });

  it('сортирует файлы по дате и имени', async () => {
    createFile('2026-01-02', 'B___2.jsonl');
    createFile('2026-01-01', 'A___1.jsonl');
    createFile('2026-01-01', 'C___3.jsonl');
    const result = await scanner.scan();
    expect(result.files[0].date).toBe('2026-01-01');
    expect(result.files[0].fileName).toBe('A___1.jsonl');
    expect(result.files[1].fileName).toBe('C___3.jsonl');
    expect(result.files[2].date).toBe('2026-01-02');
  });

  it('игнорирует файлы с неподдерживаемым расширением', async () => {
    createFile('2026-01-01', 'data.parquet');
    createFile('2026-01-01', 'valid.jsonl');
    const result = await scanner.scan();
    expect(result.totalFiles).toBe(1);
  });

  it('вычисляет totalSizeBytes', async () => {
    createFile('2026-01-01', 'A___1.jsonl', '{"t":"meta"}\n');
    const result = await scanner.scan();
    expect(result.totalSizeBytes).toBeGreaterThan(0);
  });
});
