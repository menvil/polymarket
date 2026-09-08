/**
 * Загрузчик CEX-данных для построения edge-table на оси cexResidualBps.
 *
 * @remarks
 * Парсит снапшоты бирж (binance/coinbase/okx) для BTC-USDT, выделяет orderbook
 * события (`{t:"ob",ts,bids,asks}`), считает mid = (bestBid+bestAsk)/2 и
 * даунсэмплирует до 1 Hz. Результат — JSON-кеш на день/венчур.
 *
 * Поверх этого `makeConsensus()` возвращает функцию `consensusAt(tsMs)` →
 * медиану трёх mid'ов, либо `null` если хотя бы одна биржа stale.
 *
 * @example CLI build-cache
 * ```bash
 * npx tsx scripts/cex-loader.ts \
 *   --mode build-cache \
 *   --day-dir /path/to/snapshots/2026-04-21 \
 *   --asset bitcoin \
 *   --out tables/cex-cache/2026-04-21.json
 * ```
 *
 * @example Использование как библиотека
 * ```ts
 * import { loadCexCache, makeConsensus } from './cex-loader';
 * const cache = loadCexCache('tables/cex-cache/2026-04-21.json');
 * const cons = makeConsensus(cache, 2000);
 * const mid = cons.consensusAt(Date.now());
 * ```
 */

/* eslint-disable no-console */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream } from 'fs';
import { join, dirname, basename } from 'path';
import { createGunzip } from 'zlib';
import { createInterface } from 'readline';

/** Поддерживаемые венчуры. */
export const VENUES = ['binance', 'coinbase', 'okx'] as const;
export type Venue = typeof VENUES[number];

/** Один отсчёт серии: epoch sec + mid в USD. */
export interface Tick {
  s: number;   // tsSec
  m: number;   // mid USD
}

/** Кеш CEX за один день. */
export interface DayCache {
  meta: {
    asset:  string;
    day:    string;
    venues: Venue[];
    fromMs: number;
    toMs:   number;
  };
  series: Record<Venue, Tick[]>;
}

/** Тег BTC в имени файла снапшота, для фильтрации. */
const BTC_NAME_RX = /BTC[-_]?USDT/i;

/**
 * Список всех BTC-USDT файлов одной биржи в директории дня.
 *
 * @param venueDir - Путь вида `.../2026-04-21/binance`
 */
function findBtcFiles(venueDir: string): string[] {
  if (!existsSync(venueDir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(venueDir)) {
    if (!BTC_NAME_RX.test(f)) continue;
    if (!f.endsWith('.jsonl.gz') && !f.endsWith('.jsonl')) continue;
    out.push(join(venueDir, f));
  }
  return out.sort();
}

/**
 * Парсит файл биржи, выдаёт даунсэмплированную серию `(tsSec, mid)`.
 *
 * @remarks
 * Для каждой секунды берётся последний по времени ob-event, mid=(bestBid+bestAsk)/2.
 * События с пустыми сторонами игнорируются.
 *
 * @param filePath - .jsonl или .jsonl.gz
 * @returns Массив отсортированный по `s` возрастающе.
 */
async function parseVenueFile(filePath: string): Promise<Tick[]> {
  return new Promise((resolve, reject) => {
    const stream = filePath.endsWith('.gz')
      ? createReadStream(filePath).pipe(createGunzip())
      : createReadStream(filePath);
    const rl = createInterface({ input: stream });

    /** Map sec → последний mid в этой секунде. */
    const bySec = new Map<number, number>();

    rl.on('line', (line) => {
      if (!line || line[0] !== '{') return;
      let ev: { t?: string; ts?: number; bids?: [number, number][]; asks?: [number, number][] };
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.t !== 'ob') return;
      if (typeof ev.ts !== 'number') return;
      const bids = ev.bids;
      const asks = ev.asks;
      if (!bids?.length || !asks?.length) return;
      const bestBid = Number(bids[0][0]);
      const bestAsk = Number(asks[0][0]);
      if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return;
      if (bestBid <= 0 || bestAsk <= 0 || bestAsk < bestBid) return;
      const mid = (bestBid + bestAsk) / 2;
      const sec = Math.floor(ev.ts / 1000);
      bySec.set(sec, mid);
    });
    rl.on('close', () => {
      const ticks: Tick[] = [];
      const keys = [...bySec.keys()].sort((a, b) => a - b);
      for (const k of keys) ticks.push({ s: k, m: bySec.get(k)! });
      resolve(ticks);
    });
    rl.on('error', reject);
  });
}

/** Сливает несколько отсортированных серий в одну с дедупликацией по sec (last wins). */
function mergeSeries(parts: Tick[][]): Tick[] {
  const m = new Map<number, number>();
  for (const arr of parts) for (const t of arr) m.set(t.s, t.m);
  const keys = [...m.keys()].sort((a, b) => a - b);
  return keys.map((k) => ({ s: k, m: m.get(k)! }));
}

/**
 * Строит DayCache для одного дня.
 *
 * @param dayDir - Путь `.../snapshots/2026-04-21`
 * @param asset - Только `bitcoin` пока (другие — easy extend, RX в BTC_NAME_RX).
 */
export async function buildDayCache(dayDir: string, asset = 'bitcoin'): Promise<DayCache> {
  if (asset !== 'bitcoin') throw new Error(`asset=${asset} not supported (BTC only)`);
  const day = basename(dayDir);
  const series = {} as Record<Venue, Tick[]>;
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = 0;
  for (const v of VENUES) {
    const files = findBtcFiles(join(dayDir, v));
    if (!files.length) {
      console.error(`  ${v}: no BTC files in ${join(dayDir, v)}`);
      series[v] = [];
      continue;
    }
    console.error(`  ${v}: parsing ${files.length} files`);
    const parts: Tick[][] = [];
    for (const f of files) parts.push(await parseVenueFile(f));
    const merged = mergeSeries(parts);
    series[v] = merged;
    if (merged.length) {
      minMs = Math.min(minMs, merged[0].s * 1000);
      maxMs = Math.max(maxMs, merged[merged.length - 1].s * 1000);
    }
    console.error(`  ${v}: ${merged.length} ticks (1 Hz)`);
  }
  return {
    meta: {
      asset, day, venues: [...VENUES],
      fromMs: Number.isFinite(minMs) ? minMs : 0,
      toMs:   maxMs,
    },
    series,
  };
}

/** Загрузка раннее построенного кеша. */
export function loadCexCache(file: string): DayCache {
  return JSON.parse(readFileSync(file, 'utf8')) as DayCache;
}

/** Сохранение кеша в JSON (без pretty-print, чтобы не раздувать). */
export function saveCexCache(file: string, cache: DayCache): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cache));
}

/** Поиск в отсортированной серии — последний tick с `s ≤ targetSec`. */
function lookupBefore(series: Tick[], targetSec: number): Tick | null {
  if (!series.length) return null;
  let lo = 0, hi = series.length - 1;
  if (series[lo].s > targetSec) return null;
  if (series[hi].s <= targetSec) return series[hi];
  while (lo + 1 < hi) {
    const m = (lo + hi) >> 1;
    if (series[m].s <= targetSec) lo = m;
    else hi = m;
  }
  return series[lo];
}

/** Интерфейс консенсуса, потребляемый parseSnapshot. */
export interface CexConsensus {
  consensusAt(tsMs: number): number | null;
}

/**
 * Сборка консенсус-функции из набора DayCache.
 *
 * @remarks
 * Для каждой биржи ищет ближайший tick `s ≤ targetSec`. Биржа считается «свежей»
 * если возраст ≤ staleMs. Если ≥`minVenues` свежих — берём медиану/среднее их mid'ов.
 * Иначе `null`. Default minVenues=2 — устойчивость к gap'у одной биржи.
 *
 * @param caches - Массив дневных кешей (можно несколько дней — серии конкатенируются).
 * @param staleMs - Допустимый возраст последнего tick'а.
 * @param minVenues - Минимум свежих венчуров (default 2 of 3).
 */
export function makeConsensus(caches: DayCache[], staleMs = 2000, minVenues = 2): CexConsensus {
  const all = {} as Record<Venue, Tick[]>;
  for (const v of VENUES) {
    const parts = caches.map((c) => c.series[v] ?? []);
    all[v] = mergeSeries(parts);
  }
  return {
    consensusAt(tsMs: number): number | null {
      const sec = Math.floor(tsMs / 1000);
      const mids: number[] = [];
      for (const v of VENUES) {
        const t = lookupBefore(all[v], sec);
        if (!t) continue;
        if ((tsMs - t.s * 1000) > staleMs) continue;
        mids.push(t.m);
      }
      if (mids.length < minVenues) return null;
      mids.sort((a, b) => a - b);
      const n = mids.length;
      return n % 2 === 1 ? mids[(n - 1) >> 1] : (mids[n/2 - 1] + mids[n/2]) / 2;
    },
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

interface Args {
  mode:    'build-cache';
  dayDir:  string;
  asset:   string;
  outFile: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { mode: 'build-cache', dayDir: '', asset: 'bitcoin', outFile: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--mode')    args.mode    = argv[++i] as 'build-cache';
    else if (a === '--day-dir') args.dayDir  = argv[++i];
    else if (a === '--asset')   args.asset   = argv[++i].toLowerCase();
    else if (a === '--out')     args.outFile = argv[++i];
  }
  if (!args.dayDir || !args.outFile) {
    console.error('Usage: --mode build-cache --day-dir DIR --asset bitcoin --out FILE');
    process.exit(1);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(`Building CEX cache: ${args.dayDir} → ${args.outFile}`);
  const cache = await buildDayCache(args.dayDir, args.asset);
  saveCexCache(args.outFile, cache);
  const total = VENUES.reduce((s, v) => s + (cache.series[v]?.length ?? 0), 0);
  console.error(`Done. ${total} ticks total. fromMs=${new Date(cache.meta.fromMs).toISOString()} toMs=${new Date(cache.meta.toMs).toISOString()}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
}
