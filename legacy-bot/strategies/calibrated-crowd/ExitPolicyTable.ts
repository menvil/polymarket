/**
 * ExitPolicyTable — lookup таблицы для решений по уже открытой позиции.
 *
 * @remarks
 * В отличие от EdgeTable, эта таблица не отвечает на вопрос "стоит ли входить".
 * Она отвечает на вопрос "если позиция уже есть, выгоднее держать или выйти
 * сейчас по исполнимому bid".
 */
import { readFileSync } from 'fs';
import type { Regime } from './EdgeTable.js';

export type ExitPolicySide = 'up' | 'down';
export type ExitPolicyRecommendation = 'HOLD' | 'EXIT' | 'SKIP';

export interface ExitPolicyKey {
  readonly side: ExitPolicySide;
  readonly entry: number;
  readonly current: number;
  readonly tau: number;
  readonly delta: number;
  readonly regime: Regime;
}

export interface ExitPolicyStats {
  readonly n: number;
  readonly nMarkets?: number;
  readonly winRate: number;
  readonly pLow: number;
  readonly pHigh: number;
  readonly avgEntryCents: number;
  readonly avgCurrentBidCents: number;
  readonly avgHoldPnlCents: number;
  readonly avgExitNowPnlCents: number;
  readonly holdEdgeVsExitCents: number;
  readonly hitPlus5Rate: number;
  readonly hitPlus8Rate: number;
  readonly hitPlus12Rate: number;
  readonly hitStop5Rate: number;
  readonly hitStop8Rate: number;
  readonly hitStop12Rate: number;
}

export interface ExitPolicyZone {
  readonly key: ExitPolicyKey;
  readonly stats: ExitPolicyStats;
  readonly recommendation: ExitPolicyRecommendation;
  readonly reason: string;
}

export interface ExitPolicyTableMeta {
  readonly generatedAt: string;
  readonly duration: string;
  readonly asset: string;
  /** Когда true — таблица не использует delta в ключе (fallback-режим). */
  readonly noDelta?: boolean;
  readonly bucketing: {
    readonly entryStep: number;
    readonly currentStep: number;
    readonly tauStep: number;
    readonly deltaStep: number;
    readonly maxTau: number;
    readonly maxDelta: number;
    readonly regimeThreshold: number;
  };
  readonly gates: {
    readonly minN: number;
    readonly minHoldEdgeCents: number;
    readonly exitEdgeCents: number;
  };
  readonly training?: {
    readonly marketCount: number;
    readonly observationCount: number;
  };
}

export interface ExitPolicyTableFile {
  readonly meta: ExitPolicyTableMeta;
  readonly zones: readonly ExitPolicyZone[];
}

export interface ExitPolicyLookupInput {
  readonly side: ExitPolicySide;
  readonly entryCents: number;
  readonly currentBidCents: number;
  readonly tauSec: number;
  readonly deltaDollars: number;
  readonly regime: Regime;
}

function toBucket(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function keyStr(k: ExitPolicyKey, noDelta?: boolean): string {
  return noDelta
    ? `${k.side}:${k.entry}:${k.current}:${k.tau}:${k.regime}`
    : `${k.side}:${k.entry}:${k.current}:${k.tau}:${k.delta}:${k.regime}`;
}

export class ExitPolicyTable {
  private readonly _meta: ExitPolicyTableMeta;
  private readonly _zones: Map<string, ExitPolicyZone>;

  static fromFile(path: string): ExitPolicyTable {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ExitPolicyTableFile;
    if (!raw.meta || !Array.isArray(raw.zones)) {
      throw new Error(`ExitPolicyTable: invalid file format at ${path}`);
    }
    return new ExitPolicyTable(raw);
  }

  constructor(file: ExitPolicyTableFile) {
    this._meta = file.meta;
    this._zones = new Map();
    const noDelta = file.meta.noDelta ?? false;
    for (const zone of file.zones) this._zones.set(keyStr(zone.key, noDelta), zone);
  }

  get meta(): ExitPolicyTableMeta {
    return this._meta;
  }

  get size(): number {
    return this._zones.size;
  }

  lookup(input: ExitPolicyLookupInput): ExitPolicyZone | undefined {
    const b = this._meta.bucketing;
    const noDelta = this._meta.noDelta ?? false;
    if (input.tauSec < 0 || input.tauSec > b.maxTau) return undefined;
    if (!noDelta && Math.abs(input.deltaDollars) > b.maxDelta) return undefined;

    const key: ExitPolicyKey = {
      side: input.side,
      entry: toBucket(input.entryCents, b.entryStep),
      current: toBucket(input.currentBidCents, b.currentStep),
      tau: toBucket(input.tauSec, b.tauStep),
      delta: noDelta ? 0 : toBucket(input.deltaDollars, b.deltaStep),
      regime: input.regime,
    };
    return this._zones.get(keyStr(key, noDelta));
  }
}
