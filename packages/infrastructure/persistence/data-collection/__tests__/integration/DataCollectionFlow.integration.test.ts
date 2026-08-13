/**
 * DataCollectionFlow — интеграционные тесты цикла записи и чтения рыночных данных
 *
 * @remarks
 * Проверяет end-to-end поток от регистрации рынка до чтения снапшота с диска.
 *
 * ### Реальные компоненты (без моков):
 * - `DataRecorder` + `NDJSONFormatter` + реальный filesystem (tmpdir)
 * - `GzipCompressor` (для GZIP-сценария)
 * - `SnapshotReaderFactory` из `@polymarket/snapshot-readers`
 *
 * ### Сценарии:
 * 1. JSONL: register → record × 5 → finalize(EXPIRED) → read back (1 meta + 5 events)
 * 2. GZIP: то же со сжатием → .jsonl.gz файл, читается GzipJsonlSnapshotReader
 * 3. Shutdown: close() с reason=SHUTDOWN удаляет незаписанные файлы
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { DataRecorder, NDJSONFormatter, GzipCompressor } from '../../src/index.js';
import type { DataRecorderConfig } from '../../src/index.js';
import { NoOpLogger } from '@polymarket/logger';
import { asMarketId, unsafeInstrumentId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/value-objects';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SnapshotReaderFactory } from '../../../snapshot-readers/src/SnapshotReaderFactory.js';

// ── Утилиты ───────────────────────────────────────────────────────────────────

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/**
 * Рекурсивно ищет первый файл с заданным суффиксом в директории.
 *
 * @param dir - Директория для поиска
 * @param suffix - Суффикс файла (например '.jsonl' или '.jsonl.gz')
 */
function findFirstFile(dir: string, suffix: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFirstFile(fullPath, suffix);
      if (found) return found;
    } else if (entry.name.endsWith(suffix)) {
      return fullPath;
    }
  }
  return undefined;
}

// ── Константы тестов ──────────────────────────────────────────────────────────

const LOGGER = new NoOpLogger();
const MARKET_ID = asMarketId('market-dc-integration-001')!;
const TOKEN_YES = unsafeInstrumentId('token-dc-yes');
const TOKEN_NO = unsafeInstrumentId('token-dc-no');
const MARKET_META = {
  marketId: MARKET_ID,
  question: 'Integration test market question',
  tokenIds: [TOKEN_YES, TOKEN_NO],
  expiresAt: unwrap(TimestampService.create(Date.now() + 86_400_000)), // +1 день
};

// ── Тесты ─────────────────────────────────────────────────────────────────────

describe('DataCollectionFlow (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polymarket-dc-test-'));
  });

  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Сценарий 1: JSONL round-trip ───────────────────────────────────────────

  it('JSONL: register → record × 5 → finalize(EXPIRED) → read back (1 meta + 5 events)', async () => {
    // Arrange
    const config: DataRecorderConfig = {
      outputDir: tmpDir,
      bufferSize: 100,
      flushIntervalMs: 60_000,
      compression: 'none',
    };

    const recorder = new DataRecorder(config, new NDJSONFormatter(), null, LOGGER);

    // Act: регистрируем рынок и записываем 5 событий
    recorder.registerMarket(MARKET_META);

    for (let i = 0; i < 5; i++) {
      recorder.recordEvent(TOKEN_YES, {
        event_type: 'book',
        token_id: TOKEN_YES,
        sequence: i + 1,
        ts: Date.now() + i,
      });
    }

    // Финализируем с reason=EXPIRED (без сжатия — файл остаётся .jsonl)
    await recorder.finalizeMarket(MARKET_ID, 'EXPIRED');

    // Assert: файл .jsonl создан — проверяем ДО close() т.к. close() запускает
    // тот же disk-scan что и при старте и удалит все .jsonl (включая EXPIRED с compression='none')
    const filePath = findFirstFile(tmpDir, '.jsonl');
    expect(filePath).toBeDefined();
    expect(filePath).not.toMatch(/\.gz$/);

    // Assert: читаем назад через SnapshotReaderFactory
    const readerFactory = new SnapshotReaderFactory(LOGGER);
    expect(readerFactory.isSupported(filePath!)).toBe(true);

    const reader = readerFactory.create(filePath!);
    const lines: string[] = [];
    try {
      for await (const line of reader.readLines()) {
        lines.push(line);
      }
    } finally {
      await reader.close();
    }

    // Assert: 1 meta-строка + 5 event-строк = 6 строк
    expect(lines).toHaveLength(6);

    // Assert: первая строка — meta-событие
    const meta = JSON.parse(lines[0]);
    expect(meta.t).toBe('meta');
    expect(meta.marketId).toBe(String(MARKET_ID));

    // Assert: последующие — event-строки с нашими данными
    const events = lines.slice(1).map(l => JSON.parse(l));
    expect(events).toHaveLength(5);
    expect(events[0].event_type).toBe('book');
    expect(events[4].sequence).toBe(5);

    // close() удалит все .jsonl (disk-scan = тот же код что при старте)
    await recorder.close();
  });

  // ── Сценарий 2: GZIP round-trip ────────────────────────────────────────────

  it('GZIP: register → record × 3 → finalize(EXPIRED) → .jsonl.gz читается обратно', async () => {
    // Arrange
    const config: DataRecorderConfig = {
      outputDir: tmpDir,
      bufferSize: 100,
      flushIntervalMs: 60_000,
      compression: 'gzip',
    };

    const recorder = new DataRecorder(
      config,
      new NDJSONFormatter(),
      new GzipCompressor(),
      LOGGER,
    );

    // Act: регистрируем рынок и записываем 3 события
    recorder.registerMarket(MARKET_META);

    recorder.recordEvent(TOKEN_YES, { event_type: 'book', n: 1 });
    recorder.recordEvent(TOKEN_YES, { event_type: 'trade', n: 2 });
    recorder.recordEvent(TOKEN_NO, { event_type: 'book', n: 3 });

    // Финализируем с reason=EXPIRED → создаётся .jsonl.gz
    await recorder.finalizeMarket(MARKET_ID, 'EXPIRED');
    await recorder.close();

    // Assert: файл .jsonl.gz создан, .jsonl не существует
    const gzPath = findFirstFile(tmpDir, '.jsonl.gz');
    expect(gzPath).toBeDefined();

    const jsonlPath = findFirstFile(tmpDir, '.jsonl');
    expect(jsonlPath).toBeUndefined(); // Оригинал удалён после сжатия

    // Assert: читаем назад через SnapshotReaderFactory
    const readerFactory = new SnapshotReaderFactory(LOGGER);
    expect(readerFactory.isSupported(gzPath!)).toBe(true);

    const reader = readerFactory.create(gzPath!);
    const lines: string[] = [];
    try {
      for await (const line of reader.readLines()) {
        lines.push(line);
      }
    } finally {
      await reader.close();
    }

    // Assert: 1 meta + 3 events = 4 строки
    expect(lines).toHaveLength(4);

    const meta = JSON.parse(lines[0]);
    expect(meta.t).toBe('meta');

    const events = lines.slice(1).map(l => JSON.parse(l));
    expect(events[0].n).toBe(1);
    expect(events[1].n).toBe(2);
    expect(events[2].n).toBe(3);
  });

  // ── Сценарий 3: Shutdown удаляет незавершённые файлы ──────────────────────

  it('Shutdown: close() удаляет незавершённые .jsonl файлы (reason=SHUTDOWN)', async () => {
    // Arrange
    const config: DataRecorderConfig = {
      outputDir: tmpDir,
      bufferSize: 100,
      flushIntervalMs: 60_000,
      compression: 'none',
    };

    const recorder = new DataRecorder(config, new NDJSONFormatter(), null, LOGGER);

    // Регистрируем рынок и записываем данные
    recorder.registerMarket(MARKET_META);
    recorder.recordEvent(TOKEN_YES, { event_type: 'book', partial: true });

    // Assert до: незавершённый .jsonl файл существует
    await recorder.flush();
    expect(findFirstFile(tmpDir, '.jsonl')).toBeDefined();

    // Act: завершаем работу (SHUTDOWN path удаляет незавершённые файлы)
    await recorder.close();

    // Assert: файл удалён (shutdown clean-up)
    const remainingJsonl = findFirstFile(tmpDir, '.jsonl');
    expect(remainingJsonl).toBeUndefined();
  });
});
