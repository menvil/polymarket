import { describe, it, expect, afterEach } from '@jest/globals';
import { GzipCompressor } from '../src/compression/GzipCompressor.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('GzipCompressor', () => {
  const compressor = new GzipCompressor();
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function createTmpFile(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gz-test-'));
    const filePath = path.join(tmpDir, 'test.jsonl');
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  it('создаёт .gz файл', async () => {
    const filePath = createTmpFile('{"a":1}\n{"b":2}\n');
    const gzPath = await compressor.compressFile(filePath);
    expect(fs.existsSync(gzPath)).toBe(true);
    expect(gzPath).toBe(filePath + '.gz');
  });

  it('удаляет оригинал по умолчанию', async () => {
    const filePath = createTmpFile('{"x":1}\n');
    await compressor.compressFile(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('сохраняет оригинал при deleteOriginal=false', async () => {
    const filePath = createTmpFile('{"x":1}\n');
    await compressor.compressFile(filePath, false);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('.gz файл меньше оригинала для больших данных', async () => {
    const content = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({ event_type: 'book', ts: i, bids: [], asks: [] }) + '\n'
    ).join('');
    const filePath = createTmpFile(content);
    const gzPath = await compressor.compressFile(filePath, false);
    const origSize = fs.statSync(filePath).size;
    const gzSize = fs.statSync(gzPath).size;
    expect(gzSize).toBeLessThan(origSize);
  });

  it('getCompressedPath добавляет .gz', () => {
    expect(compressor.getCompressedPath('/data/file.jsonl')).toBe('/data/file.jsonl.gz');
  });
});
