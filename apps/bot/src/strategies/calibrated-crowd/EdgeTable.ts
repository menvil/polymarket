/**
 * EdgeTable — загрузчик и lookup для JSON-таблицы зон `(delta, tau, crowd, regime)`.
 *
 * @remarks
 * Таблица генерируется `scripts/build-edge-table.ts` и содержит зоны
 * с агрегированной статистикой, Wilson 95% CI, OOS walk-forward валидацией,
 * composite-весами и рекомендуемым Kelly sizing.
 *
 * Формат ключа bucket совпадает с `build-edge-table.ts`:
 * ```
 * delta  = floor(chainlinkPrice − strikePrice, deltaStep)
 * tau    = floor(tauSec, tauStep)
 * crowd  = floor(midPriceCents, crowdStep)   // 0..90
 * regime = up | flat | down (slope BTC $/min)
 * ```
 *
 * @example
 * ```typescript
 * const table = EdgeTable.fromFile('/path/to/edge-table-5min.json');
 * const zone = table.lookup({ deltaDollars: -12, tauSec: 150, midCents: 27, regime: 'flat' });
 * if (zone && zone.signal !== 'SKIP') {
 *   const side = zone.kelly.side;       // 'UP' | 'DOWN'
 *   const size = zone.kelly.size;       // доля капитала (fractional Kelly × composite)
 * }
 * ```
 */
import { readFileSync } from 'fs';

// ── Типы зон (mirror scripts/build-edge-table.ts) ─────────────────────────────

/** Режим тренда BTC — классифицируется по slope $/min. */
export type Regime = 'up' | 'flat' | 'down';

/** Сторона Kelly-рекомендации. `NONE` — нет edge ни в одну сторону. */
export type KellySide = 'UP' | 'DOWN' | 'NONE';

/** Итоговый сигнал зоны. */
export type EdgeSignal = 'BUY' | 'SELL' | 'SKIP';

export interface EdgeZoneKey {
  readonly delta: number;
  readonly tau: number;
  readonly crowd: number;
  readonly regime: Regime;
}

export interface EdgeZoneTrain {
  readonly n: number;
  readonly upCount: number;
  readonly nMarkets?: number;
  readonly upMarkets?: number;
  readonly nObservations?: number;
  readonly upObservations?: number;
  readonly obsPerSample?: number;
  readonly crowdAvg: number;
  readonly pHat: number;
  readonly pLow: number;
  readonly pHigh: number;
  readonly edge: number;
  readonly spreadAvg: number;
}

export interface EdgeZoneOos {
  readonly n: number;
  readonly nMarkets?: number;
  readonly nObservations?: number;
  readonly pHat: number;
  readonly edge: number;
  readonly passes: boolean;
}

export interface EdgeZoneWeights {
  readonly nWeight: number;
  readonly ciWeight: number;
  readonly oosWeight: number;
  readonly regimeWeight: number;
  readonly composite: number;
}

export interface EdgeZoneKelly {
  readonly side: KellySide;
  readonly size: number;
}

export interface EdgeZone {
  readonly key: EdgeZoneKey;
  readonly train: EdgeZoneTrain;
  readonly oos: EdgeZoneOos | null;
  readonly weights: EdgeZoneWeights;
  readonly kelly: EdgeZoneKelly;
  readonly signal: EdgeSignal;
}

export interface EdgeTableMeta {
  readonly generatedAt: string;
  readonly duration: string;
  readonly token: string;
  readonly sampleMode?: 'markets' | 'observations';
  readonly features?: {
    readonly delta?: boolean;
    readonly tau?: boolean;
    readonly crowd?: boolean;
    readonly regime?: boolean;
  };
  readonly bucketing: {
    readonly deltaStep: number;
    readonly tauStep: number;
    readonly crowdStep: number;
    readonly regimeThreshold: number;
    readonly maxDelta: number;
    readonly maxTau: number;
  };
  readonly gates: {
    readonly minN: number;
    readonly minEdge: number;
    readonly minCiEdge: number;
    readonly fracKelly: number;
  };
  readonly training?: {
    readonly marketCount: number;
    readonly endDateMaxMs: number;
    readonly effectiveSamples?: number;
    readonly marketZoneSamples?: number;
    readonly observationCount?: number;
  };
  readonly validation?: {
    readonly marketCount: number;
    readonly method: string;
    readonly effectiveSamples?: number;
    readonly marketZoneSamples?: number;
    readonly observationCount?: number;
  };
}

export interface EdgeTableFile {
  readonly meta: EdgeTableMeta;
  readonly zones: readonly EdgeZone[];
}

// ── Lookup input ──────────────────────────────────────────────────────────────

/**
 * Параметры lookup в таблице.
 *
 * @param deltaDollars - Разница chainlink − strike (в $)
 * @param tauSec - Секунд до экспирации
 * @param midCents - Mid цена рынка в центах (0..100)
 * @param regime - Режим up/flat/down
 */
export interface EdgeLookupInput {
  readonly deltaDollars: number;
  readonly tauSec: number;
  readonly midCents: number;
  readonly regime: Regime;
}

// ── Реализация ────────────────────────────────────────────────────────────────

/**
 * Бакетизация значения по шагу (`Math.floor(v/step)*step`).
 * Совпадает с `toBucket()` из `build-edge-table.ts`.
 */
function toBucket(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

/** Строковый ключ Map: совпадает с `zoneKeyStr()` из генератора. */
function zoneKeyStr(k: EdgeZoneKey): string {
  return `${k.delta}:${k.tau}:${k.crowd}:${k.regime}`;
}

export class EdgeTable {
  private readonly _meta: EdgeTableMeta;
  private readonly _zones: Map<string, EdgeZone>;

  /**
   * Фабрика: загрузить таблицу из JSON-файла.
   *
   * @param path - Путь к JSON (результат `build-edge-table.ts`)
   * @throws Если файл не парсится или отсутствует секция `meta`/`zones`
   */
  static fromFile(path: string): EdgeTable {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as EdgeTableFile;
    if (!raw.meta || !Array.isArray(raw.zones)) {
      throw new Error(`EdgeTable: invalid file format at ${path}`);
    }
    return new EdgeTable(raw);
  }

  constructor(file: EdgeTableFile) {
    this._meta = file.meta;
    this._zones = new Map();
    for (const z of file.zones) this._zones.set(zoneKeyStr(z.key), z);
  }

  /** Метаданные таблицы (bucketing, gates, дата генерации). */
  get meta(): EdgeTableMeta {
    return this._meta;
  }

  /** Число загруженных зон. */
  get size(): number {
    return this._zones.size;
  }

  /**
   * Найти зону для текущего состояния рынка.
   *
   * @param input - Текущие значения (delta$, tauSec, midCents, regime)
   * @returns Зону если найдена, иначе `undefined` (неизвестный бакет → SKIP)
   */
  lookup(input: EdgeLookupInput): EdgeZone | undefined {
    const { deltaStep, tauStep, crowdStep, maxDelta, maxTau } = this._meta.bucketing;

    // За пределами покрытой сетки — SKIP (по договорённости: strict skip при нехватке данных).
    if (Math.abs(input.deltaDollars) > maxDelta) return undefined;
    if (input.tauSec < 0 || input.tauSec > maxTau) return undefined;

    // Фичи, использованные при сборке таблицы. Если поле отсутствует — считаем,
    // что включены все (обратная совместимость со старыми таблицами).
    const feats = this._meta.features;
    const useDelta  = feats?.delta  !== false;
    const useTau    = feats?.tau    !== false;
    const useCrowd  = feats?.crowd  !== false;
    const useRegime = feats?.regime !== false;

    const key: EdgeZoneKey = {
      delta:  useDelta  ? toBucket(input.deltaDollars, deltaStep) : 0,
      tau:    useTau    ? toBucket(input.tauSec,       tauStep)   : 0,
      crowd:  useCrowd  ? toBucket(input.midCents,     crowdStep) : 0,
      regime: useRegime ? input.regime : ('flat' as Regime),
    };
    return this._zones.get(zoneKeyStr(key));
  }
}
