import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { GzipJsonlSnapshotReader } from '../src/GzipJsonlSnapshotReader.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
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

describe('GzipJsonlSnapshotReader', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function writeGzFile(content: string): Promise<string> {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gzip-test-'));
    const gzPath = path.join(tmpDir, 'test.jsonl.gz');
    await pipeline(
      Readable.from([content]),
      createGzip(),
      fs.createWriteStream(gzPath),
    );
    return gzPath;
  }

  it('читает строки из .jsonl.gz файла', async () => {
    const gzPath = await writeGzFile('{"a":1}\n{"b":2}\n');
    const reader = new GzipJsonlSnapshotReader(gzPath, makeLogger());
    const lines: string[] = [];
    try {
      for await (const line of reader.readLines()) lines.push(line);
    } finally {
      await reader.close();
    }
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ a: 1 });
  });

  it('не создаёт временный распакованный файл', async () => {
    const gzPath = await writeGzFile('{"x":1}\n');
    const reader = new GzipJsonlSnapshotReader(gzPath, makeLogger());
    const lines: string[] = [];
    for await (const line of reader.readLines()) lines.push(line);
    await reader.close();

    const decompressedPath = gzPath.replace(/\.gz$/, '') + `.decompressed.${process.pid}.tmp`;
    expect(fs.existsSync(decompressedPath)).toBe(false);
  });

  it('getFilePath возвращает оригинальный .gz путь', async () => {
    const gzPath = await writeGzFile('{}');
    const reader = new GzipJsonlSnapshotReader(gzPath, makeLogger());
    expect(reader.getFilePath()).toBe(gzPath);
    await reader.close();
  });

  it('close безопасен без предварительного readLines()', async () => {
    const gzPath = await writeGzFile('{}');
    const reader = new GzipJsonlSnapshotReader(gzPath, makeLogger());
    await expect(reader.close()).resolves.toBeUndefined();
  });
});
