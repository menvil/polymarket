import { describe, it, expect, afterEach } from '@jest/globals';
import { JsonlSnapshotReader } from '../src/JsonlSnapshotReader.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('JsonlSnapshotReader', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-test-'));
    const filePath = path.join(tmpDir, 'test.jsonl');
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  it('читает все непустые строки', async () => {
    const filePath = writeFile('{"a":1}\n{"b":2}\n{"c":3}\n');
    const reader = new JsonlSnapshotReader(filePath);
    const lines: string[] = [];
    for await (const line of reader.readLines()) lines.push(line);
    await reader.close();
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toEqual({ a: 1 });
    expect(JSON.parse(lines[2])).toEqual({ c: 3 });
  });

  it('пропускает пустые строки', async () => {
    const filePath = writeFile('{"a":1}\n\n\n{"b":2}\n');
    const reader = new JsonlSnapshotReader(filePath);
    const lines: string[] = [];
    for await (const line of reader.readLines()) lines.push(line);
    await reader.close();
    expect(lines).toHaveLength(2);
  });

  it('возвращает пустой генератор для пустого файла', async () => {
    const filePath = writeFile('');
    const reader = new JsonlSnapshotReader(filePath);
    const lines: string[] = [];
    for await (const line of reader.readLines()) lines.push(line);
    await reader.close();
    expect(lines).toHaveLength(0);
  });

  it('getFilePath возвращает путь', () => {
    const filePath = writeFile('{}');
    const reader = new JsonlSnapshotReader(filePath);
    expect(reader.getFilePath()).toBe(filePath);
  });

  it('close безопасен при повторном вызове', async () => {
    const filePath = writeFile('{"a":1}\n');
    const reader = new JsonlSnapshotReader(filePath);
    await reader.close();
    await expect(reader.close()).resolves.toBeUndefined();
  });
});
