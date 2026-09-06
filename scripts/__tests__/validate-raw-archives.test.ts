/**
 * Правила quality-gate датасета реального прогона.
 *
 * @remarks
 * Фикстуры пишутся на диск в изолированный temp-корень и проверяются ТЕМ ЖЕ
 * модулем, который запускается в квалификации: копия правил в тесте однажды
 * разошлась бы с копией в инструменте.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { validateDatasetRoot } from '../validate-raw-archives.mts';

/** Границы фикстурного рынка (5 минут). */
const STARTS_AT_MS = Date.parse('2026-09-01T18:00:00.000Z');
const EXPIRES_AT_MS = STARTS_AT_MS + 5 * 60_000;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Создаёт изолированный корень датасетов.
 *
 * @returns Абсолютный путь корня (удаляется после теста)
 */
function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'raw-archive-validate-'));
  roots.push(root);
  return root;
}

/** Canonical V2 meta-строка market-архива. */
function metaLine(overrides: Record<string, unknown> = {}): string {
  const header: Record<string, unknown> = {
    headerVersion: 2,
    source: 'polymarket',
    conditionId: 'btc-5m-1',
    question: 'Bitcoin Up or Down?',
    outcomes: [
      { index: 0, label: 'Up', instrumentId: 'btc-5m-1-up' },
      { index: 1, label: 'Down', instrumentId: 'btc-5m-1-down' },
    ],
    family: 'CRYPTO_UP_DOWN',
    timing: { startsAt: STARTS_AT_MS, expiresAt: EXPIRES_AT_MS },
    crypto: { asset: 'btc', duration: 5 * 60_000 },
    finalization: {
      status: 'complete',
      startedAtMs: EXPIRES_AT_MS,
      finalizedAtMs: EXPIRES_AT_MS + 60_000,
      attempts: 1,
      winning: {
        label: 'Up',
        instrumentId: 'btc-5m-1-up',
        outcomeIndex: 0,
        source: 'resolution',
        exact: true,
      },
      provenance: { resolution: 'official' },
    },
    ...overrides,
  };
  return JSON.stringify({
    t: 'meta',
    formatVersion: 2,
    ts: STARTS_AT_MS,
    marketId: 'btc-5m-1',
    question: 'Bitcoin Up or Down?',
    tokenIds: ['btc-5m-1-up', 'btc-5m-1-down'],
    m: header,
  });
}

/** V2-наблюдение с точным ingress в заданный момент. */
function observation(type: string, atMs: number, sequence: number, payload: unknown): string {
  return JSON.stringify({
    type,
    ingress: {
      runId: 'run-1',
      sequence,
      createdAtUnixSeconds: Math.floor(atMs / 1000),
      millisecondOfSecond: atMs % 1000,
      microsecondOfMillisecond: 0,
      nanosecondOfMicrosecond: 0,
    },
    payload,
  });
}

/** Опорный book-снапшот CLOB (без него датасет непригоден к реконструкции). */
function bookLine(atMs: number, sequence: number): string {
  return observation('POLYMARKET_MARKET', atMs, sequence, {
    topic: 'market',
    type: 'book',
    payload: { market: 'btc-5m-1' },
  });
}

/** Spot-наблюдение обычного RTDS-фида. */
function spotLine(type: string, atMs: number, sequence: number): string {
  return observation(type, atMs, sequence, { symbol: 'btcusdt', value: '65000' });
}

/** Наблюдение официального settlement-потока. */
function twapLine(atMs: number, sequence: number): string {
  return observation('POLYMARKET_CRYPTO_CHAINLINK_TWAP', atMs, sequence, {
    symbol: 'btc/usd',
    windowSeconds: 60,
    value: '65000',
  });
}

/**
 * Пишет завершённый market-архив и возвращает нарушения его файла.
 *
 * @param lines - Строки архива (LINE 1 — meta)
 * @param options - Допуск settlement-потока
 * @returns Нарушения единственного файла корня
 */
function violationsFor(
  lines: readonly string[],
  options: { readonly settlementGraceMs?: number } = {},
): readonly string[] {
  const root = makeRoot();
  const dir = path.join(root, '2026-09-01', 'polymarket');
  fs.mkdirSync(dir, { recursive: true });
  // Завершённый архив (`.jsonl.gz`) — только для него работают проверки
  // finalization/winner; сжатие настоящее, как у storage.
  fs.writeFileSync(
    path.join(dir, 'btc-5m-1.jsonl.gz'),
    zlib.gzipSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')),
  );
  const report = validateDatasetRoot(root, options);
  expect(report.files).toHaveLength(1);
  return report.files[0]!.violations;
}

/** Базовый корректный датасет: book до истечения + граничный TWAP. */
function healthyLines(overrides: Record<string, unknown> = {}): string[] {
  return [
    metaLine(overrides),
    bookLine(STARTS_AT_MS + 1_000, 1),
    spotLine('POLYMARKET_CRYPTO_BINANCE', STARTS_AT_MS + 2_000, 2),
    twapLine(EXPIRES_AT_MS + 1_500, 3),
  ];
}

describe('граница датасета: что разрешено после expiresAt', () => {
  it('корректный датасет нарушений не даёт', () => {
    expect(violationsFor(healthyLines())).toEqual([]);
  });

  it('CLOB после истечения → FAIL', () => {
    const violations = violationsFor([...healthyLines(), bookLine(EXPIRES_AT_MS + 1_000, 4)]);
    expect(violations).toContain(
      '1 POLYMARKET_MARKET observation(s) recorded after the market expiry boundary',
    );
  });

  it('Binance spot после истечения → FAIL', () => {
    const violations = violationsFor([
      ...healthyLines(),
      spotLine('POLYMARKET_CRYPTO_BINANCE', EXPIRES_AT_MS + 1_000, 4),
    ]);
    expect(violations).toContain(
      '1 POLYMARKET_CRYPTO_BINANCE observation(s) recorded after the market expiry boundary',
    );
  });

  it('Chainlink spot после истечения → FAIL', () => {
    const violations = violationsFor([
      ...healthyLines(),
      spotLine('POLYMARKET_CRYPTO_CHAINLINK', EXPIRES_AT_MS + 1_000, 4),
    ]);
    expect(violations).toContain(
      '1 POLYMARKET_CRYPTO_CHAINLINK observation(s) recorded after the market expiry boundary',
    );
  });

  it('settlement TWAP в пределах grace нарушением НЕ является', () => {
    // Ровно ради него граница и не совпадает с expiresAt.
    const violations = violationsFor([...healthyLines(), twapLine(EXPIRES_AT_MS + 4_000, 4)]);
    expect(violations).toEqual([]);
  });

  it('settlement TWAP ЗА пределами grace → FAIL', () => {
    const violations = violationsFor([...healthyLines(), twapLine(EXPIRES_AT_MS + 90_000, 4)], {
      settlementGraceMs: 5_000,
    });
    expect(violations).toEqual(['1 settlement TWAP observation(s) beyond the 5000ms settlement grace']);
  });

  it('нарушения разных типов считаются раздельно', () => {
    const violations = violationsFor([
      ...healthyLines(),
      bookLine(EXPIRES_AT_MS + 1_000, 4),
      spotLine('POLYMARKET_CRYPTO_BINANCE', EXPIRES_AT_MS + 1_100, 5),
      spotLine('POLYMARKET_CRYPTO_BINANCE', EXPIRES_AT_MS + 1_200, 6),
    ]);
    expect(violations).toEqual([
      '2 POLYMARKET_CRYPTO_BINANCE observation(s) recorded after the market expiry boundary',
      '1 POLYMARKET_MARKET observation(s) recorded after the market expiry boundary',
    ]);
  });
});

describe('повреждённый header даёт нарушение файла, а не падение процесса', () => {
  it('finalization: null', () => {
    const violations = violationsFor(healthyLines({ finalization: null }));
    expect(violations).toContain(
      'completed archive has a malformed finalization section (not an object)',
    );
  });

  it('finalization: []', () => {
    const violations = violationsFor(healthyLines({ finalization: [] }));
    expect(violations).toContain(
      'completed archive has a malformed finalization section (not an object)',
    );
  });

  it('winning: null → «испорчено», а не «отсутствует»', () => {
    // Различие существенно: отсутствующий победитель у не-крипто рынка
    // законен, а `null` на его месте — повреждённый header.
    const violations = violationsFor(
      healthyLines({ finalization: { status: 'complete', startedAtMs: 0, attempts: 1, winning: null } }),
    );
    expect(violations).toContain('winning outcome is malformed (not an object)');
  });

  it('winning отсутствует у крипто-рынка → FAIL', () => {
    const violations = violationsFor(
      healthyLines({ finalization: { status: 'complete', startedAtMs: 0, attempts: 1 } }),
    );
    expect(violations).toContain('completed crypto archive has no winning outcome');
  });

  it('winning: []', () => {
    const violations = violationsFor(
      healthyLines({ finalization: { status: 'complete', startedAtMs: 0, attempts: 1, winning: [] } }),
    );
    expect(violations).toContain('winning outcome is malformed (not an object)');
  });

  it('provenance: null', () => {
    const violations = violationsFor(
      healthyLines({
        finalization: {
          status: 'complete',
          startedAtMs: 0,
          attempts: 1,
          winning: { label: 'Up', instrumentId: 'btc-5m-1-up', outcomeIndex: 0, source: 'resolution', exact: true },
          provenance: null,
        },
      }),
    );
    expect(violations).toContain('resolution provenance is malformed (not an object)');
  });

  it('timing: null → отсутствие границы, а не исключение', () => {
    const violations = violationsFor(healthyLines({ timing: null }));
    expect(violations).toContain('header timing has no expiresAt');
  });

  it('m: null → нарушение файла', () => {
    const root = makeRoot();
    const dir = path.join(root, '2026-09-01', 'polymarket');
    fs.mkdirSync(dir, { recursive: true });
    const meta = JSON.stringify({ t: 'meta', formatVersion: 2, ts: 0, marketId: 'x', m: null });
    fs.writeFileSync(path.join(dir, 'x.jsonl'), `${meta}\n`, 'utf8');

    const report = validateDatasetRoot(root);

    expect(report.verdict).toBe('FAIL');
    expect(report.files[0]?.violations).toContain(
      'meta line has no market header object (key "m")',
    );
  });

  it('один повреждённый файл не лишает отчёта остальные', () => {
    const root = makeRoot();
    const dir = path.join(root, '2026-09-01', 'polymarket');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.jsonl'), 'not json at all\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'healthy.jsonl'), `${healthyLines().join('\n')}\n`, 'utf8');

    const report = validateDatasetRoot(root);

    expect(report.files).toHaveLength(2);
    expect(report.files.find((f) => f.file.endsWith('healthy.jsonl'))?.violations).toEqual([]);
    expect(report.files.find((f) => f.file.endsWith('broken.jsonl'))?.violations.length).toBeGreaterThan(0);
  });
});

describe('обязательное содержимое датасета', () => {
  it('нет опорного book-снапшота → FAIL', () => {
    const violations = violationsFor([metaLine(), twapLine(EXPIRES_AT_MS + 1_000, 1)]);
    expect(violations).toContain('no initial CLOB book snapshot in dataset');
  });

  it('наблюдение без ingress → FAIL (порядок replay потерян)', () => {
    const lines = [metaLine(), JSON.stringify({ topic: 'market', type: 'book' })];
    expect(violationsFor(lines).join(' ')).toContain('malformed line');
  });

  it('sequence не возрастает внутри одного прогона → FAIL', () => {
    const violations = violationsFor([
      metaLine(),
      bookLine(STARTS_AT_MS + 1_000, 5),
      bookLine(STARTS_AT_MS + 2_000, 5),
    ]);
    expect(violations).toContain(
      'observation sequence is not increasing within run run-1: 5 → 5',
    );
  });
});
