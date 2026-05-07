import { describe, expect, it, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseConfig } from '../../src/config/parseConfig.js';

describe('parseConfig', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function writeConfig(config: Record<string, unknown>): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-config-test-'));
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8');
    return configPath;
  }

  it('парсит новые numeric selective-entry параметры как number', () => {
    const configPath = writeConfig({
      strategy: 'selective-entry',
      strategyParams: {
        orderSize: 5,
        minDeltaAccel: 0.02,
        vetoRiseBelowCents: -3,
        vetoCompDiscrepancyAboveCents: 3,
        makerRepriceAfterSec: 3,
      },
      market: {
        source: 'snapshots',
        paths: ['snapshots/*.jsonl.gz'],
        outcomeIndex: 0,
      },
    });

    const result = parseConfig({ MODE: 'backtest', CONFIG: configPath }, configPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const params = result.value.config.strategyParams as unknown as Record<string, unknown>;
    expect(params['minDeltaAccel']).toBe(0.02);
    expect(params['vetoRiseBelowCents']).toBe(-3);
    expect(params['vetoCompDiscrepancyAboveCents']).toBe(3);
    expect(params['makerRepriceAfterSec']).toBe(3);
  });

  it('сохраняет bidirectional=true для discovery market', () => {
    const configPath = writeConfig({
      strategy: 'dumb',
      strategyParams: {
        orderSize: 5,
        buyOffsetPct: 0.01,
        profitMarginPct: 0.02,
        repriceThreshold: 0.01,
      },
      market: {
        source: 'discovery',
        filter: {
          requiredKeywords: ['bitcoin', 'up or down'],
          minDurationMinutes: 4,
          maxDurationMinutes: 6,
        },
        scanPauseMs: 30_000,
        outcomeIndex: 0,
        bidirectional: true,
      },
    });

    const result = parseConfig({ MODE: 'live', CONFIG: configPath }, configPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.config.market).toMatchObject({
      source: 'discovery',
      outcomeIndex: 0,
      bidirectional: true,
    });
  });
});
