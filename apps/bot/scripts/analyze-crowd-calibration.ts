/**
 * Анализ калибровки толпы Polymarket.
 *
 * @see {@link ../docs/research/crowd-calibration-analysis.md} — полная документация, примеры
 * таблиц, расшифровка ячеек, сигналы и рекомендованные сценарии использования.
 *
 * @remarks
 * ### Режимы вывода (--show):
 * - `a`     — TABLE A: delta × tau
 * - `b`     — TABLE B: crowd¢ × tau
 * - `top`   — топ-20 ошибок
 * - `curve` — кривая калибровки
 * - `1`     — tau-срезы: delta × crowd¢ для каждого окна
 * - `2`     — edge score table: crowd¢ × tau (edge = real − crowd)
 * - `3`     — point lookup: поиск по (delta, tau, crowd)
 * - `4`     — ASCII heatmap: delta × crowd¢ с Unicode-блоками
 * - `all`   — всё вышеперечисленное
 *
 * @example
 * ```bash
 * # Стандартный анализ 5-мин рынков:
 * npx tsx scripts/analyze-crowd-calibration.ts ./snapshots \
 *   --duration 5min --token up --show a,b,top,curve
 *
 * # Все 4 новых варианта:
 * npx tsx scripts/analyze-crowd-calibration.ts ./snapshots \
 *   --duration 5min --show 1,2,3,4 --tau-windows "0:90,90:180,180:300"
 *
 * # Точечный поиск:
 * npx tsx scripts/analyze-crowd-calibration.ts ./snapshots \
 *   --duration 5min --show 3 --point "delta=50,tau=120,crowd=72"
 *
 * # Тепловая карта для среднего tau-окна:
 * npx tsx scripts/analyze-crowd-calibration.ts ./snapshots \
 *   --duration 5min --show 4 --heatmap-tau "90:180"
 * ```
 */

import { createReadStream, readdirSync, writeFileSync } from 'fs';
import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { join } from 'path';

// ── ANSI ──────────────────────────────────────────────────────────────────────

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';
const WHITE  = '\x1b[37m';

/**
 * Окрашивает ячейку по bias (crowd − real).
 * Положительный = толпа завышает; отрицательный = недооценивает.
 */
function colorBias(text: string, bias: number): string {
  if (bias <= -0.10) return `${BOLD}${GREEN}${text}${RESET}`;
  if (bias <= -0.05) return `${YELLOW}${text}${RESET}`;
  if (bias >= +0.10) return `${DIM}${RED}${text}${RESET}`;
  if (bias >= +0.05) return `${DIM}${text}${RESET}`;
  return text;
}

/**
 * Окрашивает ячейку по edge (real − crowd = -bias).
 * Положительный = есть преимущество покупки UP.
 */
function colorEdge(text: string, edge: number): string {
  if (edge >= +0.10) return `${BOLD}${GREEN}${text}${RESET}`;
  if (edge >= +0.05) return `${GREEN}${text}${RESET}`;
  if (edge <= -0.10) return `${BOLD}${RED}${text}${RESET}`;
  if (edge <= -0.05) return `${RED}${text}${RESET}`;
  return text;
}

/** Убирает ANSI escape-последовательности для подсчёта визуальной ширины. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Дополняет строку (с ANSI-кодами внутри) до визуальной ширины width пробелами. */
function padEndRaw(text: string, width: number): string {
  const vis = stripAnsi(text).length;
  return vis < width ? text + ' '.repeat(width - vis) : text;
}

// ── Конфигурация ──────────────────────────────────────────────────────────────

interface Config {
  dirs:        string[];
  deltaStep:   number;
  tauStep:     number;
  maxDelta:    number;
  maxTau:      number;
  outFile:     string;
  asset:       string;
  duration:    'all' | '5min' | '15min';
  token:       'up' | 'down' | 'both';
  minMarkets:  number;
  /** Варианты вывода: 'a','b','top','curve','1','2','3','4','all' */
  show:        Set<string>;
  /** Tau-окна для variant 1: [[from,to], ...] */
  tauWindows:  Array<[number, number]>;
  /** Tau-окно для variant 4 heatmap */
  heatmapTau:  [number, number] | null;
  /** Точка для variant 3 lookup */
  point:       { delta: number; tau: number; crowd: number } | null;
  /**
   * Режим подсчёта `n` в ячейках:
   * - `'markets'` (default) — уникальные рынки по slug. Защищает от bias
   *   долгоживущих рынков, «висящих» в одной ячейке на множестве снапшотов.
   * - `'observations'` — каждый снапшот считается отдельно. Даёт большее n,
   *   но один долго «зависший» рынок может доминировать в ячейке.
   */
  countBy:     'markets' | 'observations';
  /**
   * Если true — при отсутствии `outcomePrices`-резолюции пытаемся определить
   * исход по последней Chainlink-цене возле `endDate`. Полезно для свежих
   * данных, по которым Polymarket ещё не обновил meta.
   */
  approxResolution: boolean;
  /**
   * Фильтр наблюдений по режиму рынка (slope Chainlink за 60s).
   * - `'up'` — slope > +threshold $/min (восходящий).
   * - `'down'` — slope < -threshold $/min (нисходящий).
   * - `'flat'` — |slope| ≤ threshold.
   * - `'all'` (default) — без фильтра. V5-таблица всё равно показывает все три.
   */
  regime:          'up' | 'flat' | 'down' | 'all';
  /** Порог slope ($/min) для классификации режима. */
  regimeThreshold: number;
}

/** Режим рынка по slope Chainlink за 60s. */
export type Regime = 'up' | 'flat' | 'down';

/**
 * Классифицирует slope ($/min) в режим `up | flat | down`.
 *
 * @param slope      - наклон Chainlink-цены за последние 60s, $/min.
 * @param threshold  - порог, |slope| ≤ threshold ⇒ flat.
 */
export function classifyRegime(slope: number, threshold: number): Regime {
  if (slope >  threshold) return 'up';
  if (slope < -threshold) return 'down';
  return 'flat';
}

/**
 * Наклон Chainlink-цены на момент `currentTs` за окно ~60s назад.
 *
 * @param history      - отсортированная по ts история Chainlink-сэмплов.
 * @param currentTs    - момент наблюдения (ms).
 * @param currentPrice - цена Chainlink в момент `currentTs`.
 * @returns Slope в $/min; если истории < 2 точек или dt=0 — возвращает 0.
 */
export function computeTrendSlope(
  history: Array<{ ts: number; price: number }>,
  currentTs: number,
  currentPrice: number,
): number {
  if (history.length < 2) return 0;
  const targetTs = currentTs - 60_000;
  let found: { ts: number; price: number } | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].ts <= targetTs) { found = history[i]; break; }
  }
  if (!found) found = history[0];
  const dtMin = (currentTs - found.ts) / 60_000;
  if (dtMin <= 0) return 0;
  return (currentPrice - found.price) / dtMin;
}

/**
 * Разбирает аргументы CLI в Config.
 *
 * @returns Конфигурация
 *
 * @example
 * ```bash
 * npx tsx scripts/analyze-crowd-calibration.ts ./snapshots \
 *   --duration 5min --show 1,2,3,4 --point "delta=50,tau=120,crowd=72"
 * ```
 */
function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    dirs:       [],
    deltaStep:  25,
    tauStep:    30,
    maxDelta:   200,
    maxTau:     900,
    outFile:    '',
    asset:      '',
    duration:   'all',
    token:      'up',
    minMarkets: 5,
    show:       new Set(['a', 'b', 'top', 'curve']),
    tauWindows: [],
    heatmapTau: null,
    point:      null,
    countBy:    'markets',
    approxResolution: false,
    regime:          'all',
    regimeThreshold: 10,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if      (arg === '--delta-step')   { config.deltaStep  = Number(args[++i]); }
    else if (arg === '--tau-step')     { config.tauStep    = Number(args[++i]); }
    else if (arg === '--max-delta')    { config.maxDelta   = Number(args[++i]); }
    else if (arg === '--max-tau')      { config.maxTau     = Number(args[++i]); }
    else if (arg === '--out')          { config.outFile    = args[++i]; }
    else if (arg === '--asset')        { config.asset      = args[++i].toLowerCase(); }
    else if (arg === '--duration')     { config.duration   = args[++i] as Config['duration']; }
    else if (arg === '--token')        { config.token      = args[++i] as Config['token']; }
    else if (arg === '--min-markets')  { config.minMarkets = Number(args[++i]); }
    else if (arg === '--count-by') {
      const v = args[++i];
      if (v !== 'markets' && v !== 'observations') {
        throw new Error(`--count-by: ожидается 'markets' | 'observations', получено '${v}'`);
      }
      config.countBy = v;
    }
    else if (arg === '--approx-resolution') { config.approxResolution = true; }
    else if (arg === '--regime') {
      const v = args[++i];
      if (v !== 'up' && v !== 'flat' && v !== 'down' && v !== 'all') {
        throw new Error(`--regime: ожидается 'up' | 'flat' | 'down' | 'all', получено '${v}'`);
      }
      config.regime = v;
    }
    else if (arg === '--regime-threshold') { config.regimeThreshold = Number(args[++i]); }
    else if (arg === '--show') {
      const parts = args[++i].split(',').map(s => s.trim());
      config.show = new Set(parts);
    }
    else if (arg === '--tau-windows') {
      config.tauWindows = args[++i].split(',').map(s => {
        const [a, b] = s.trim().split(':').map(Number);
        return [a, b] as [number, number];
      });
    }
    else if (arg === '--heatmap-tau') {
      const [a, b] = args[++i].split(':').map(Number);
      config.heatmapTau = [a, b];
    }
    else if (arg === '--point') {
      const kv: Record<string, number> = {};
      args[++i].split(',').forEach(p => {
        const [k, v] = p.trim().split('=');
        kv[k] = Number(v);
      });
      if (kv.delta !== undefined && kv.tau !== undefined && kv.crowd !== undefined) {
        config.point = { delta: kv.delta, tau: kv.tau, crowd: kv.crowd };
      }
    }
    else { config.dirs.push(arg); }
  }

  if (config.dirs.length === 0) {
    console.error('Usage: npx tsx scripts/analyze-crowd-calibration.ts <dir1> [dir2...] [options]');
    console.error('Options:');
    console.error('  --show a,b,top,curve,1,2,3,4,all  Sections to display (default: a,b,top,curve)');
    console.error('  --token up|down|both               Order book to use (default: up)');
    console.error('  --duration 5min|15min|all');
    console.error('  --tau-step 30                      Tau bucket step in seconds (default: 30)');
    console.error('  --delta-step 25                    Delta bucket step in $ (default: 25)');
    console.error('  --max-tau 900  --max-delta 200  --min-markets 5  --asset bitcoin');
    console.error('  --tau-windows "0:90,90:180,180:300"  Tau windows for variant 1');
    console.error('  --heatmap-tau "90:180"               Tau window for variant 4 heatmap');
    console.error('  --point "delta=50,tau=120,crowd=72"  Point lookup for variant 3');
    console.error('  --count-by markets|observations      (default: markets) unit of "n" in cells');
    console.error('  --approx-resolution                   infer UP/DOWN from last Chainlink price near endDate when meta is not enriched');
    console.error('  --regime up|flat|down|all             filter observations by BTC trend regime (slope over 60s; default: all)');
    console.error('  --regime-threshold 10                 $/min threshold for up/down classification (default: 10)');
    console.error('  --out file.json');
    process.exit(1);
  }
  return config;
}

// ── Типы ──────────────────────────────────────────────────────────────────────

interface BucketAccum {
  crowdProbSum:      number;
  observations:      number;
  /** Уникальные рынки (dedup по slug) с резолюцией UP. */
  upCount:           number;
  /** Уникальные рынки (dedup по slug) с резолюцией DOWN. */
  downCount:         number;
  /** Наблюдения (каждый ордербук-снапшот) с резолюцией UP. Не дедуплицируется. */
  upObs:             number;
  /** Наблюдения (каждый ордербук-снапшот) с резолюцией DOWN. Не дедуплицируется. */
  downObs:           number;
  marketResolutions: Map<string, 'UP' | 'DOWN'>;
  spreadSum:         number;
}

export interface Observation {
  tsMs:          number;
  midPriceCents: number;
  spreadCents:   number;
  bestBidCents:  number;
  bestAskCents:  number;
  delta:         number;
  tauSec:        number;
  /** Наклон Chainlink за последние 60s в $/min (0 если истории < 2 точек). */
  trendSlope:    number;
}

export type MarketDuration = '5min' | '15min' | 'other';

export interface MarketData {
  slug:         string;
  resolution:   'UP' | 'DOWN';
  strikePrice:  number;
  endDateMs:    number;
  durationMin:  number;
  duration:     MarketDuration;
  observations: Observation[];
}

/**
 * Причины, по которым файл-снапшот не попал в анализ.
 *
 * - `no_strike` — нет `priceToBeat` в meta и не удалось восстановить по Chainlink.
 * - `no_resolution` — рынок не закрыт (нет `finalPrice` / `outcomePrices` не содержит `1`).
 *   Включая отдельный подкейс, когда `eventMetadata.finalPrice` явно пустой/отсутствует.
 * - `no_observations` — у нас не получилось собрать ни одного валидного (book+chainlink) наблюдения.
 * - `parse_error` — файл невозможно прочитать/распарсить.
 */
type SkipReason = 'no_strike' | 'no_resolution' | 'no_final_price' | 'no_observations' | 'parse_error';

/**
 * Подпричины, почему файл оказался в `no_observations`:
 *
 * - `no_chainlink_stream` — в файле вообще нет `crypto_price`-строк от Chainlink.
 * - `no_book_side`        — для запрошенного `--token` книга ни разу не появилась
 *                           (нет упомянутого `asset_id` в event_type=book).
 * - `all_before_start`    — данные есть, но все обновления до `startTime`.
 * - `all_tau_too_large`   — все валидные точки дальше, чем `--max-tau` от `endDate`.
 * - `all_desync`          — все пары book↔chainlink разошлись > 30с.
 * - `all_invalid_mid`     — mid вне [1,99] или spread > 50 во всех точках.
 * - `mixed`               — отбраковано по разным причинам, без доминирующей.
 */
type NoObsReason =
  | 'no_chainlink_stream'
  | 'no_book_side'
  | 'all_before_start'
  | 'all_tau_too_large'
  | 'all_desync'
  | 'all_invalid_mid'
  | 'mixed';

export interface ParseResult {
  data?:       MarketData;
  skipReason?: SkipReason;
  slug?:       string;
  /** Был ли `priceToBeat` в meta (для диагностики). */
  hasPriceToBeat?: boolean;
  /** Был ли `finalPrice` в meta (для диагностики). */
  hasFinalPrice?: boolean;
  /** Strike восстановлен по первой Chainlink-цене (не из meta). */
  approxStrike?:     boolean;
  /** Resolution восстановлена по последней Chainlink-цене у endDate (не из outcomePrices). */
  approxResolution?: boolean;
  /** Подпричина `no_observations` (если skipReason === 'no_observations'). */
  noObsReason?: NoObsReason;
}

// ── Парсинг snapshot ──────────────────────────────────────────────────────────

/**
 * Читает один JSONL/JSONL.GZ снапшот и возвращает данные рынка.
 *
 * @param filePath - путь к файлу
 * @param maxTau   - максимальный tau (сек), наблюдения позже отсекаются
 * @param token    - режим использования книги ордеров
 * @returns MarketData или null если файл неполный
 *
 * @remarks
 * Strike price:
 * 1. Из `events[0].eventMetadata.priceToBeat` (старый формат данных).
 * 2. Фоллбэк: Chainlink-цена ближайшая к `events[0].startTime` (новый формат).
 */
export async function parseSnapshot(
  filePath: string,
  maxTau:   number,
  token:    'up' | 'down' | 'both',
  approxResolution: boolean,
): Promise<ParseResult> {
  return new Promise((resolve) => {
    let resolution: 'UP' | 'DOWN' | null = null;
    let strikePrice = 0, endDateMs = 0, startTimeMs = 0;
    let hasPriceToBeat = false, hasFinalPrice = false;
    let slug = '', upTokenId: string | null = null, downTokenId: string | null = null;

    let lastChainlinkPrice = 0, lastChainlinkTs = 0;
    let upBid = 0, upAsk = 100, upBookTs = 0;
    let downBid = 0, downAsk = 100, downBookTs = 0;

    const chainlinkHistory: Array<{ ts: number; price: number }> = [];
    // Буфер book-событий на случай, если strikePrice ещё не известен на момент
    // стриминга. Без strikePrice tryEmit() возвращается рано и наблюдения теряются.
    // После восстановления strikePrice через approx-strike или market_resolved
    // проигрываем буфер хронологически вместе с chainlinkHistory — см. replay() ниже.
    const bookEventsBuffer: Array<{ aid: string; bid: number; ask: number; ts: number }> = [];
    const observations: Observation[] = [];

    // Диагностика причин отбраковки в tryEmit. Увеличиваются ТОЛЬКО когда оба стрима
    // уже присутствуют (т.е. логика дошла до проверки tau/desync/mid).
    const rejectCounts = {
      before_start:   0,
      tau_too_large:  0,
      desync:         0,
      invalid_mid:    0,
    };
    // Видели ли хоть один book для запрошенной стороны (--token).
    let bookSeenForSide = false;

    const stream = filePath.endsWith('.gz')
      ? createReadStream(filePath).pipe(createGunzip())
      : createReadStream(filePath);
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      try {
        const d = JSON.parse(line);

        if (d.t === 'meta' && d.m) {
          const m = d.m;
          const op = JSON.parse(m.outcomePrices || '[]');
          const ids = d.tokenIds || JSON.parse(m.clobTokenIds || '[]');
          if (op.length >= 2) {
            if      (Number(op[0]) === 1) resolution = 'UP';
            else if (Number(op[1]) === 1) resolution = 'DOWN';
          }
          upTokenId = ids[0] || null; downTokenId = ids[1] || null;
          endDateMs = new Date(m.endDate).getTime();
          slug = m.slug || m.question || '';
          const ev = (m.events as Array<Record<string, unknown>> | undefined)?.[0];
          if (ev) {
            const meta = ev.eventMetadata as Record<string, unknown> | undefined;
            if (meta?.priceToBeat !== undefined && meta.priceToBeat !== null && meta.priceToBeat !== '') {
              hasPriceToBeat = true;
              strikePrice = Number(meta.priceToBeat);
            }
            if (meta?.finalPrice !== undefined && meta.finalPrice !== null && meta.finalPrice !== '') {
              hasFinalPrice = true;
            }
            if (ev.startTime) startTimeMs = new Date(ev.startTime as string).getTime();
          }
          if (!startTimeMs && m.eventStartTime) startTimeMs = new Date(m.eventStartTime as string).getTime();
          return;
        }

        if (d.t === 'market_resolved') {
          if (typeof d.strikePrice === 'number' && !strikePrice) {
            strikePrice = d.strikePrice;
            hasPriceToBeat = true;
          }
          if (typeof d.resolutionPrice === 'number' && typeof d.strikePrice === 'number') {
            resolution = d.resolutionPrice >= d.strikePrice ? 'UP' : 'DOWN';
            hasFinalPrice = true;
          } else if (d.outcome === 'UP' || d.outcome === 'DOWN') {
            resolution = d.outcome;
            hasFinalPrice = true;
          }
          return;
        }

        if (d.t === 'crypto_price' && d.source === 'chainlink' && typeof d.price === 'number') {
          lastChainlinkPrice = d.price;
          lastChainlinkTs    = Number(d.ts);
          chainlinkHistory.push({ ts: lastChainlinkTs, price: lastChainlinkPrice });
          tryEmit(); return;
        }

        if (d.event_type === 'book' && d.bids && d.asks) {
          const bids = d.bids as Array<{ price: string; size: string }>;
          const asks = d.asks as Array<{ price: string; size: string }>;
          const bb = bids.reduce((m, b) => Number(b.size) > 0 ? Math.max(m, Number(b.price)) : m, 0);
          const ba = asks.reduce((m, a) => Number(a.size) > 0 ? Math.min(m, Number(a.price)) : m, 1);
          let ts = Number(d.timestamp); if (ts < 1e12) ts *= 1000;
          const bidC = Math.round(bb * 100), askC = Math.round(ba * 100);
          if (d.asset_id === upTokenId)   { upBid   = bidC; upAsk   = askC; upBookTs   = ts; }
          if (d.asset_id === downTokenId) { downBid = bidC; downAsk = askC; downBookTs = ts; }
          // Если strikePrice ещё не известен, tryEmit() отскочит по первой проверке.
          // Сохраняем событие, чтобы при approx-strike fallback проиграть его заново.
          if (!strikePrice) bookEventsBuffer.push({ aid: String(d.asset_id), bid: bidC, ask: askC, ts });
          tryEmit();
        }
      } catch { /* skip */ }
    });

    function tryEmit(): void {
      if (!strikePrice || !endDateMs || !lastChainlinkPrice) return;
      const hasUp = upBid > 0 && upAsk > 0, hasDown = downBid > 0 && downAsk > 0;
      if (token === 'up' && !hasUp) return;
      if (token === 'down' && !hasDown) return;
      if (token === 'both' && (!hasUp || !hasDown)) return;
      bookSeenForSide = true;

      const bookTs = token === 'down' ? downBookTs : token === 'up' ? upBookTs : Math.max(upBookTs, downBookTs);
      const tsMs = Math.max(bookTs, lastChainlinkTs);
      if (tsMs === 0) return;
      // Анализируем только данные после старта рынка — всё pre-market = шум.
      if (startTimeMs > 0 && (bookTs < startTimeMs || lastChainlinkTs < startTimeMs)) {
        rejectCounts.before_start++; return;
      }
      const tauSec = Math.max(0, (endDateMs - tsMs) / 1000);
      if (tauSec > maxTau) { rejectCounts.tau_too_large++; return; }
      if (bookTs > 0 && lastChainlinkTs > 0 && Math.abs(bookTs - lastChainlinkTs) > 30_000) {
        rejectCounts.desync++; return;
      }

      let mid: number, spread: number, bestBidCents: number, bestAskCents: number;
      if      (token === 'up')   {
        mid = Math.round((upBid + upAsk) / 2);
        spread = upAsk - upBid;
        bestBidCents = upBid;
        bestAskCents = upAsk;
      }
      else if (token === 'down') {
        mid = 100 - Math.round((downBid + downAsk) / 2);
        spread = downAsk - downBid;
        bestBidCents = 100 - downAsk;
        bestAskCents = 100 - downBid;
      }
      else {
        mid    = Math.round(((upBid + upAsk) / 2 + (100 - (downBid + downAsk) / 2)) / 2);
        spread = Math.round(((upAsk - upBid) + (downAsk - downBid)) / 2);
        bestBidCents = Math.round((upBid + (100 - downAsk)) / 2);
        bestAskCents = Math.round((upAsk + (100 - downBid)) / 2);
      }
      if (mid < 1 || mid > 99 || spread > 50) { rejectCounts.invalid_mid++; return; }
      const trendSlope = computeTrendSlope(chainlinkHistory, tsMs, lastChainlinkPrice);
      observations.push({
        tsMs,
        midPriceCents: mid, spreadCents: spread,
        bestBidCents, bestAskCents,
        delta: lastChainlinkPrice - strikePrice, tauSec, trendSlope,
      });
    }

    rl.on('close', () => {
      let approxStrikeUsed = false;
      let approxResolutionUsed = false;

      if (!strikePrice && startTimeMs > 0 && chainlinkHistory.length > 0) {
        let best = chainlinkHistory[0];
        for (const p of chainlinkHistory) if (Math.abs(p.ts - startTimeMs) < Math.abs(best.ts - startTimeMs)) best = p;
        strikePrice = best.price;
        approxStrikeUsed = true;
      }
      if (!strikePrice) {
        resolve({ skipReason: 'no_strike', slug, hasPriceToBeat, hasFinalPrice }); return;
      }

      /**
       * Replay буферизированных book-событий.
       *
       * Когда `strikePrice` был неизвестен во время стриминга (нет `priceToBeat`
       * в meta), `tryEmit()` выходил по первой проверке — и наблюдения не
       * накапливались. После восстановления strike через approx-strike или
       * `market_resolved` мы проигрываем сохранённые book-события хронологически,
       * подтягивая chainlink-цену на момент события по `chainlinkHistory`.
       */
      if ((approxStrikeUsed || observations.length === 0) && bookEventsBuffer.length > 0) {
        upBid = 0; upAsk = 100; upBookTs = 0;
        downBid = 0; downAsk = 100; downBookTs = 0;
        lastChainlinkPrice = 0; lastChainlinkTs = 0;
        const sortedBooks = bookEventsBuffer.slice().sort((a, b) => a.ts - b.ts);
        let clIdx = 0;
        for (const ev of sortedBooks) {
          while (clIdx < chainlinkHistory.length && chainlinkHistory[clIdx].ts <= ev.ts) {
            lastChainlinkPrice = chainlinkHistory[clIdx].price;
            lastChainlinkTs    = chainlinkHistory[clIdx].ts;
            clIdx++;
          }
          if (ev.aid === upTokenId)   { upBid   = ev.bid; upAsk   = ev.ask; upBookTs   = ev.ts; }
          if (ev.aid === downTokenId) { downBid = ev.bid; downAsk = ev.ask; downBookTs = ev.ts; }
          tryEmit();
        }
      }

      /**
       * Фоллбэк резолюции по Chainlink.
       *
       * Берём последний сэмпл строго в окне `[endDate − 2s, endDate)`:
       *   - `ts >= endDate − 2000ms` — не раньше 58-й секунды последней минуты рынка;
       *   - `ts <  endDate`          — строго до момента закрытия (не позже :00).
       *
       * Если ни одного сэмпла в этом окне нет — не угадываем, скипаем рынок.
       */
      if (!resolution && approxResolution && endDateMs > 0 && chainlinkHistory.length > 0) {
        const WINDOW_BEFORE_MS = 2_000;
        let best: { ts: number; price: number } | null = null;
        for (const p of chainlinkHistory) {
          if (p.ts < endDateMs - WINDOW_BEFORE_MS || p.ts >= endDateMs) continue;
          if (!best || p.ts > best.ts) best = p;
        }
        if (best) {
          resolution = best.price >= strikePrice ? 'UP' : 'DOWN';
          approxResolutionUsed = true;
        }
      }

      if (!resolution) {
        // Различаем: meta пришла без finalPrice vs. outcomePrices не содержит 1.
        const reason: SkipReason = hasFinalPrice ? 'no_resolution' : 'no_final_price';
        resolve({ skipReason: reason, slug, hasPriceToBeat, hasFinalPrice }); return;
      }
      if (observations.length === 0) {
        // Определяем доминирующую подпричину, в порядке приоритета:
        // 1. целый стрим отсутствует — это сильнее локальных отбраковок;
        // 2. среди rejectCounts: если одна категория покрывает >70% — это «all_<X>»;
        // 3. иначе — mixed.
        let noObsReason: NoObsReason;
        if (chainlinkHistory.length === 0)       noObsReason = 'no_chainlink_stream';
        else if (!bookSeenForSide)                noObsReason = 'no_book_side';
        else {
          const total =
            rejectCounts.before_start + rejectCounts.tau_too_large +
            rejectCounts.desync + rejectCounts.invalid_mid;
          if (total === 0) noObsReason = 'mixed';
          else {
            const dom = (Object.entries(rejectCounts) as Array<[keyof typeof rejectCounts, number]>)
              .sort((a, b) => b[1] - a[1])[0];
            if (dom[1] / total >= 0.7) {
              noObsReason = `all_${dom[0]}` as NoObsReason;
            } else {
              noObsReason = 'mixed';
            }
          }
        }
        resolve({ skipReason: 'no_observations', slug, hasPriceToBeat, hasFinalPrice, noObsReason });
        return;
      }
      const dMin = startTimeMs && endDateMs ? (endDateMs - startTimeMs) / 60_000 : 0;
      const duration: MarketDuration = dMin >= 4 && dMin <= 6 ? '5min' : dMin >= 13 && dMin <= 17 ? '15min' : 'other';
      resolve({
        data: { slug, resolution, strikePrice, endDateMs, durationMin: dMin, duration, observations },
        slug, hasPriceToBeat, hasFinalPrice,
        approxStrike: approxStrikeUsed, approxResolution: approxResolutionUsed,
      });
    });
    rl.on('error', () => resolve({ skipReason: 'parse_error' }));
    stream.on('error', () => resolve({ skipReason: 'parse_error' }));
  });
}

// ── Вспомогательные функции ───────────────────────────────────────────────────

function bucketKey(a: number, b: number): string { return `${a}:${b}`; }
function toBucket(v: number, step: number): number { return Math.floor(v / step) * step; }
function crowdBucket5(cents: number): number { return Math.round(cents / 5) * 5; }
function crowdBucket10(cents: number): number { return Math.max(10, Math.min(90, Math.round(cents / 10) * 10)); }

function newBucket(): BucketAccum {
  return {
    crowdProbSum: 0, observations: 0,
    upCount: 0, downCount: 0,
    upObs: 0, downObs: 0,
    marketResolutions: new Map(), spreadSum: 0,
  };
}

function accumulate(b: BucketAccum, midCents: number, spread: number, slug: string, res: 'UP' | 'DOWN'): void {
  b.crowdProbSum += midCents / 100; b.observations++; b.spreadSum += spread;
  if (res === 'UP') b.upObs++; else b.downObs++;
  if (!b.marketResolutions.has(slug)) {
    b.marketResolutions.set(slug, res);
    if (res === 'UP') b.upCount++; else b.downCount++;
  }
}

/**
 * Глобальный режим подсчёта `n`. Устанавливается в `printResults`.
 * По умолчанию — 'markets' (уникальные рынки).
 */
let COUNT_BY: 'markets' | 'observations' = 'markets';

/** Возвращает `n` для бакета в зависимости от режима подсчёта. */
function bucketN(b: BucketAccum): number {
  return COUNT_BY === 'observations' ? b.upObs + b.downObs : b.upCount + b.downCount;
}

/** Возвращает «UP-часть» бакета: уникальные рынки или наблюдения. */
function bucketUp(b: BucketAccum): number {
  return COUNT_BY === 'observations' ? b.upObs : b.upCount;
}

/** Возвращает «DOWN-часть» бакета: уникальные рынки или наблюдения. */
function bucketDown(b: BucketAccum): number {
  return COUNT_BY === 'observations' ? b.downObs : b.downCount;
}

/**
 * Объединяет массив бакетов с правильной дедупликацией рынков по slug.
 *
 * @param buckets - бакеты для объединения
 * @returns Новый BucketAccum с дедуплицированными рынками
 *
 * @remarks
 * `crowdProbSum` и `observations` суммируются напрямую (статистика наблюдений).
 * `upCount`/`downCount` пересчитываются из merged `marketResolutions` (уникальные рынки).
 */
function mergeBuckets(buckets: BucketAccum[]): BucketAccum {
  const m = newBucket();
  for (const b of buckets) {
    m.crowdProbSum += b.crowdProbSum;
    m.observations += b.observations;
    m.spreadSum    += b.spreadSum;
    m.upObs        += b.upObs;
    m.downObs      += b.downObs;
    for (const [slug, res] of b.marketResolutions) {
      if (!m.marketResolutions.has(slug)) {
        m.marketResolutions.set(slug, res);
        if (res === 'UP') m.upCount++; else m.downCount++;
      }
    }
  }
  return m;
}

/**
 * Генерирует 3 равных tau-окна для заданного maxTau.
 *
 * @param maxTau  - максимальный tau в секундах
 * @param tauStep - шаг бакета
 * @returns Три окна [[0,a],[a,b],[b,maxTau]]
 */
function defaultTauWindows(maxTau: number, tauStep: number): Array<[number, number]> {
  const step = Math.ceil(maxTau / 3 / tauStep) * tauStep;
  return [[0, step], [step, step * 2], [step * 2, maxTau + tauStep]];
}

/** Символ блока по абсолютной величине edge. */
function blockChar(absEdge: number): string {
  if (absEdge >= 0.15) return '█';
  if (absEdge >= 0.10) return '▓';
  if (absEdge >= 0.06) return '▒';
  if (absEdge >= 0.03) return '░';
  return '·';
}

/** Форматирует и окрашивает ячейку edge score. */
function edgeCell(edge: number, n: number, minN: number, w: number): string {
  if (n < minN) return ' '.repeat(w);
  const sign = edge >= 0 ? '+' : '';
  const txt  = `${sign}${(edge * 100).toFixed(0)}% n=${n}`;
  return colorEdge(txt.padStart(w), edge);
}

// ── Рендер TABLE A / B (существующие) ────────────────────────────────────────

const CELL_W  = 14;
const LABEL_W = 10;

/**
 * Печатает двухмерную калибровочную таблицу с ANSI-цветами.
 *
 * @param title        - заголовок
 * @param rowKeys      - значения строк
 * @param colKeys      - значения tau-столбцов
 * @param tauStep      - шаг tau в секундах
 * @param rowLabel     - заголовок левой колонки
 * @param getLabel     - rowKey → строка для левой колонки
 * @param getBucket    - (row, col) → BucketAccum | undefined
 * @param getCrowdProb - (row, bucket) → crowd probability [0..1]
 * @param minMarkets   - мин. рынков для отображения ячейки
 */
function printCalibrationTable(
  title:        string,
  rowKeys:      number[],
  colKeys:      number[],
  tauStep:      number,
  rowLabel:     string,
  getLabel:     (k: number) => string,
  getBucket:    (r: number, c: number) => BucketAccum | undefined,
  getCrowdProb: (r: number, b: BucketAccum) => number,
  minMarkets:   number,
): void {
  const W = LABEL_W + colKeys.length * CELL_W;
  console.log();
  console.log(`${BOLD}${CYAN}${'═'.repeat(W)}${RESET}`);
  console.log(`${BOLD}${CYAN}  ${title}${RESET}`);
  console.log(`${BOLD}${CYAN}  Ячейка: real%(bias) n=${COUNT_BY === 'observations' ? 'наблюдений' : 'рынков'}  ${GREEN}■${RESET} недооценка  ${YELLOW}■${RESET} слабая  ${DIM}■${RESET} переоценка${RESET}`);
  console.log(`${BOLD}${CYAN}${'═'.repeat(W)}${RESET}`);
  console.log(`${BOLD}${WHITE}${rowLabel.padEnd(LABEL_W)}${colKeys.map(t => `${t}-${t + tauStep}s`.padStart(CELL_W)).join('')}${RESET}`);
  console.log(`${DIM}${'─'.repeat(W)}${RESET}`);

  for (const row of rowKeys) {
    const cells: string[] = [];
    for (const col of colKeys) {
      const b = getBucket(row, col);
      const n = b ? bucketN(b) : 0;
      if (!b || n < minMarkets) { cells.push(' '.repeat(CELL_W)); continue; }
      const real  = bucketUp(b) / n;
      const crowd = getCrowdProb(row, b);
      const bias  = crowd - real;
      const sign  = (bias * 100) >= 0 ? '+' : '';
      cells.push(colorBias(`${(real * 100).toFixed(0).padStart(3)}%(${sign}${(bias * 100).toFixed(0)}) n=${n}`.padStart(CELL_W), bias));
    }
    console.log(getLabel(row).padEnd(LABEL_W) + cells.join(''));
  }
}

/**
 * Печатает авто-инсайты под таблицей.
 *
 * @param rowKeys      - значения строк
 * @param colKeys      - значения tau-столбцов
 * @param getBucket    - (row, col) → BucketAccum | undefined
 * @param getCrowdProb - (row, bucket) → crowd probability [0..1]
 * @param getLabel     - rowKey → строка для вывода
 * @param tauStep      - шаг tau
 * @param minMarkets   - мин. рынков
 *
 * @remarks
 * Выводит до 5 выводов: лучшая зона входа, зона переоценки,
 * систематические строки и тренд по tau.
 */
function printInsights(
  rowKeys:      number[],
  colKeys:      number[],
  getBucket:    (r: number, c: number) => BucketAccum | undefined,
  getCrowdProb: (r: number, b: BucketAccum) => number,
  getLabel:     (r: number) => string,
  tauStep:      number,
  minMarkets:   number,
): void {
  interface C { row: number; col: number; bias: number; n: number; real: number; crowd: number; }
  const cells: C[] = [];
  for (const row of rowKeys) for (const col of colKeys) {
    const b = getBucket(row, col); const n = b ? bucketN(b) : 0;
    if (!b || n < minMarkets) continue;
    const real = bucketUp(b) / n, crowd = getCrowdProb(row, b);
    cells.push({ row, col, bias: crowd - real, n, real, crowd });
  }
  if (cells.length === 0) return;

  const rowAgg = new Map<number, { bs: number; ns: number }>();
  for (const c of cells) { const r = rowAgg.get(c.row) ?? { bs: 0, ns: 0 }; r.bs += c.bias * c.n; r.ns += c.n; rowAgg.set(c.row, r); }
  const rowBiases = [...rowAgg.entries()].map(([row, { bs, ns }]) => ({ row, avg: bs / ns, n: ns })).sort((a, b) => a.avg - b.avg);

  const colAgg = new Map<number, { bs: number; ns: number }>();
  for (const c of cells) { const r = colAgg.get(c.col) ?? { bs: 0, ns: 0 }; r.bs += c.bias * c.n; r.ns += c.n; colAgg.set(c.col, r); }
  const colBiases = [...colAgg.entries()].map(([col, { bs, ns }]) => ({ col, avg: bs / ns })).sort((a, b) => a.col - b.col);

  const sorted   = [...cells].sort((a, b) => a.bias - b.bias);
  const bestU    = sorted[0];
  const bestO    = sorted[sorted.length - 1];
  const sysUnder = rowBiases.filter(r => r.avg < -0.05 && r.n >= minMarkets * 3);
  const sysOver  = rowBiases.slice().reverse().filter(r => r.avg > 0.05 && r.n >= minMarkets * 3);

  const bullets: string[] = [];

  if (bestU?.bias < -0.05)
    bullets.push(`${GREEN}${BOLD}●${RESET} Лучшая зона (недооценка): ${BOLD}${getLabel(bestU.row)}, tau ${bestU.col}−${bestU.col + tauStep}s${RESET} — crowd ${(bestU.crowd * 100).toFixed(0)}¢ → ${(bestU.real * 100).toFixed(0)}%, ошибка ${GREEN}${BOLD}${(bestU.bias * 100).toFixed(1)}%${RESET} (n=${bestU.n})`);

  if (bestO?.bias > 0.05)
    bullets.push(`${DIM}${RED}●${RESET} Зона переоценки: ${getLabel(bestO.row)}, tau ${bestO.col}−${bestO.col + tauStep}s — crowd ${(bestO.crowd * 100).toFixed(0)}¢ → ${(bestO.real * 100).toFixed(0)}%, +${(bestO.bias * 100).toFixed(1)}% (n=${bestO.n})`);

  if (sysUnder.length > 0)
    bullets.push(`${GREEN}●${RESET} Систематич. недооценка: ${sysUnder.slice(0, 4).map(r => `${GREEN}${getLabel(r.row)}${RESET}(avg ${GREEN}${(r.avg * 100).toFixed(1)}%${RESET},n=${r.n})`).join('  ')}`);

  if (sysOver.length > 0)
    bullets.push(`${DIM}${RED}●${RESET} Систематич. переоценка: ${sysOver.slice(0, 3).map(r => `${DIM}${getLabel(r.row)}${RESET}(+${(r.avg * 100).toFixed(1)}%,n=${r.n})`).join('  ')}`);

  if (colBiases.length >= 4) {
    const near = (colBiases[0].avg + colBiases[1].avg) / 2;
    const far  = (colBiases[colBiases.length - 1].avg + colBiases[colBiases.length - 2].avg) / 2;
    if (Math.abs(near - far) > 0.03) {
      const nLabel = `${colBiases[0].col}−${colBiases[1].col + tauStep}s`;
      const fLabel = `${colBiases[colBiases.length - 2].col}−${colBiases[colBiases.length - 1].col + tauStep}s`;
      const desc   = near < far
        ? `чем ближе к экспирации, тем ${GREEN}сильнее недооценка${RESET}`
        : `при большом tau ${GREEN}недооценка сильнее${RESET}`;
      bullets.push(`${CYAN}●${RESET} Тренд по tau: ${desc} (near ${nLabel}: ${(near * 100).toFixed(1)}% vs far ${fLabel}: ${(far * 100).toFixed(1)}%)`);
    }
  }

  if (bullets.length === 0) return;
  console.log(); console.log(`${BOLD}  ▸ INSIGHTS${RESET}`); console.log(`${DIM}  ${'─'.repeat(78)}${RESET}`);
  bullets.forEach((b, i) => console.log(`  ${DIM}${i + 1}.${RESET} ${b}`));
}

// ── Variant 1: Tau-sliced delta × crowd tables ────────────────────────────────

/**
 * Вариант 1 — таблицы delta × crowd¢ для каждого tau-окна.
 *
 * @param tripleMap  - Map ключ "delta:tau:crowd10"
 * @param tauWindows - массив tau-окон [[from,to], ...]
 * @param sortedTaus - все tau-бакеты из tripleMap (отсортированные)
 * @param config     - конфигурация
 *
 * @remarks
 * Для каждого окна объединяет все tau-бакеты через mergeBuckets,
 * обеспечивая корректную дедупликацию рынков по slug.
 */
function printTauSliced(
  tripleMap:   Map<string, BucketAccum>,
  tauWindows:  Array<[number, number]>,
  sortedTaus:  number[],
  config:      Config,
): void {
  const allDeltas = new Set<number>();
  for (const key of tripleMap.keys()) allDeltas.add(Number(key.split(':')[0]));
  const sortedDeltas = [...allDeltas].sort((a, b) => a - b);
  const CROWDS = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  const CW = 13;

  for (const [winFrom, winTo] of tauWindows) {
    const winTaus = sortedTaus.filter(t => t >= winFrom && t < winTo);
    if (winTaus.length === 0) continue;

    const W = LABEL_W + CROWDS.length * CW;
    console.log();
    console.log(`${BOLD}${CYAN}${'═'.repeat(W)}${RESET}`);
    console.log(`${BOLD}${CYAN}  VARIANT 1 — DELTA × CROWD¢ | tau ${winFrom}−${winTo}s | ${config.duration.toUpperCase()} | ${config.token.toUpperCase()} book${RESET}`);
    console.log(`${BOLD}${CYAN}  Ячейка: real%(bias) n=${COUNT_BY === 'observations' ? 'наблюдений' : 'рынков'}${RESET}`);
    console.log(`${BOLD}${CYAN}${'═'.repeat(W)}${RESET}`);
    console.log(`${BOLD}${WHITE}${'Delta'.padEnd(LABEL_W)}${CROWDS.map(c => `${c}¢`.padStart(CW)).join('')}${RESET}`);
    console.log(`${DIM}${'─'.repeat(W)}${RESET}`);

    // Prepare (delta, crowd) → merged bucket for this window
    const merged = new Map<string, BucketAccum>();
    for (const db of sortedDeltas) {
      for (const cb of CROWDS) {
        const parts = winTaus.map(tb => tripleMap.get(`${db}:${tb}:${cb}`)).filter((b): b is BucketAccum => b !== undefined);
        if (parts.length > 0) merged.set(`${db}:${cb}`, mergeBuckets(parts));
      }
    }

    for (const db of sortedDeltas) {
      const cells: string[] = [];
      for (const cb of CROWDS) {
        const b = merged.get(`${db}:${cb}`);
        const n = b ? bucketN(b) : 0;
        if (!b || n < config.minMarkets) { cells.push(' '.repeat(CW)); continue; }
        const real  = bucketUp(b) / n;
        const crowd = b.crowdProbSum / b.observations;
        const bias  = crowd - real;
        const sign  = (bias * 100) >= 0 ? '+' : '';
        cells.push(colorBias(`${(real * 100).toFixed(0).padStart(3)}%(${sign}${(bias * 100).toFixed(0)}) n=${n}`.padStart(CW), bias));
      }
      const lbl = db >= 0 ? `+$${db}` : `-$${Math.abs(db)}`;
      console.log(lbl.padEnd(LABEL_W) + cells.join(''));
    }

    // Insights for this window
    printInsights(
      sortedDeltas, CROWDS,
      (db, cb) => merged.get(`${db}:${cb}`),
      (_r, b) => b.crowdProbSum / b.observations,
      d => d >= 0 ? `+$${d}` : `-$${Math.abs(d)}`,
      winTo - winFrom, config.minMarkets,
    );
  }
}

// ── Variant 2: Edge Score table ───────────────────────────────────────────────

/**
 * Вариант 2 — таблица edge score (crowd¢ × tau), агрегированная по delta.
 *
 * @param tripleMap  - Map ключ "delta:tau:crowd10"
 * @param sortedTaus - все tau-бакеты
 * @param config     - конфигурация
 *
 * @remarks
 * Edge = real − crowd (инверсия bias).
 * Положительный edge = crowd недооценивает UP → есть преимущество покупки.
 */
function printEdgeTable(
  tripleMap:  Map<string, BucketAccum>,
  sortedTaus: number[],
  config:     Config,
): void {
  const CROWDS = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  const EW = 12;
  const W  = LABEL_W + sortedTaus.length * EW;

  // For each (crowd, tau): aggregate all delta buckets
  const edgeMap = new Map<string, BucketAccum>();
  for (const key of tripleMap.keys()) {
    const [, tb, cb] = key.split(':').map(Number);
    const ek = `${cb}:${tb}`;
    const b  = tripleMap.get(key)!;
    if (!edgeMap.has(ek)) edgeMap.set(ek, newBucket());
    const m = edgeMap.get(ek)!;
    m.crowdProbSum += b.crowdProbSum; m.observations += b.observations; m.spreadSum += b.spreadSum;
    m.upObs += b.upObs; m.downObs += b.downObs;
    for (const [slug, res] of b.marketResolutions) {
      if (!m.marketResolutions.has(slug)) { m.marketResolutions.set(slug, res); if (res === 'UP') m.upCount++; else m.downCount++; }
    }
  }

  console.log();
  console.log(`${BOLD}${CYAN}${'═'.repeat(W)}${RESET}`);
  console.log(`${BOLD}${CYAN}  VARIANT 2 — EDGE SCORE: crowd¢ × tau | edge = real P(UP) − crowd price${RESET}`);
  console.log(`${BOLD}${CYAN}  ${GREEN}■${RESET} edge > 0 = crowd недооценивает UP (выгодно покупать)  ${RED}■${RESET} edge < 0 = переоценка${RESET}`);
  console.log(`${BOLD}${CYAN}${'═'.repeat(W)}${RESET}`);
  console.log(`${BOLD}${WHITE}${'Crowd¢'.padEnd(LABEL_W)}${sortedTaus.map(t => `${t}-${t + config.tauStep}s`.padStart(EW)).join('')}${RESET}`);
  console.log(`${DIM}${'─'.repeat(W)}${RESET}`);

  const topEdges: Array<{ crowd: number; tau: number; edge: number; n: number; real: number }> = [];

  for (const cb of CROWDS) {
    const cells: string[] = [];
    for (const tb of sortedTaus) {
      const b = edgeMap.get(`${cb}:${tb}`);
      const n = b ? bucketN(b) : 0;
      cells.push(edgeCell(b ? bucketUp(b) / n - cb / 100 : 0, n, config.minMarkets, EW));
      if (b && n >= config.minMarkets) {
        const edge = bucketUp(b) / n - cb / 100;
        topEdges.push({ crowd: cb, tau: tb, edge, n, real: bucketUp(b) / n });
      }
    }
    console.log(`${(cb + '¢').padEnd(LABEL_W)}${cells.join('')}`);
  }

  // Top positive edge zones
  topEdges.sort((a, b) => b.edge - a.edge);
  const top = topEdges.filter(e => e.edge > 0.05).slice(0, 5);
  if (top.length > 0) {
    console.log();
    console.log(`${BOLD}  ▸ ТОП-5 ЗОН С ПОЗИТИВНЫМ EDGE (выгодно покупать UP)${RESET}`);
    console.log(`${DIM}  ${'─'.repeat(60)}${RESET}`);
    console.log(`  ${BOLD}${'Crowd¢'.padEnd(10)} ${'Tau'.padEnd(12)} ${'Real%'.padEnd(8)} ${'Edge'.padEnd(8)} n${RESET}`);
    for (const e of top) {
      console.log(
        `  ${(e.crowd + '¢').padEnd(10)} ${(e.tau + '-' + (e.tau + config.tauStep) + 's').padEnd(12)} ` +
        `${(e.real * 100).toFixed(1).padStart(5)}%   ${colorEdge(`+${(e.edge * 100).toFixed(1)}%`.padStart(7), e.edge)}   ${e.n}`,
      );
    }
  }
}

// ── Variant 3: Point lookup ───────────────────────────────────────────────────

/**
 * Вариант 3 — поиск калибровки для конкретной точки (delta, tau, crowd).
 *
 * @param tripleMap - Map ключ "delta:tau:crowd10"
 * @param config    - конфигурация
 *
 * @remarks
 * Если `config.point` задан — ищет ближайший бакет с расширяющимся радиусом.
 * Если не задан — показывает топ-5 зон с наибольшим позитивным edge.
 *
 * Сигнал: STRONG BUY (edge ≥ 15%), BUY (7-15%), NEUTRAL (±7%), SELL (7-15%), STRONG SELL (≥ 15%).
 */
function printPointLookup(
  tripleMap: Map<string, BucketAccum>,
  config:    Config,
): void {
  console.log();
  console.log(`${BOLD}${CYAN}${'═'.repeat(70)}${RESET}`);
  console.log(`${BOLD}${CYAN}  VARIANT 3 — POINT LOOKUP${RESET}`);
  console.log(`${BOLD}${CYAN}${'═'.repeat(70)}${RESET}`);

  if (!config.point) {
    // Show top-5 zones
    const zones: Array<{ db: number; tb: number; cb: number; edge: number; n: number; real: number; crowd: number }> = [];
    for (const [key, b] of tripleMap) {
      const n = bucketN(b);
      if (n < config.minMarkets) continue;
      const [db, tb, cb] = key.split(':').map(Number);
      const real  = bucketUp(b) / n;
      const crowd = cb / 100;
      zones.push({ db, tb, cb, edge: real - crowd, n, real, crowd });
    }
    zones.sort((a, b) => b.edge - a.edge);
    console.log(`  ${DIM}--point не задан. Топ-5 зон с максимальным edge:${RESET}`);
    console.log();
    console.log(`  ${BOLD}${'Delta'.padEnd(10)} ${'Tau'.padEnd(12)} ${'Crowd'.padEnd(8)} ${'Real%'.padEnd(8)} ${'Edge'.padEnd(8)} ${'n'.padEnd(6)} Сигнал${RESET}`);
    console.log(`  ${DIM}${'─'.repeat(65)}${RESET}`);
    for (const z of zones.filter(z => z.edge > 0).slice(0, 5)) {
      const dStr = z.db >= 0 ? `+$${z.db}` : `-$${Math.abs(z.db)}`;
      const tStr = `${z.tb}-${z.tb + config.tauStep}s`;
      const sig  = z.edge >= 0.15 ? `${GREEN}${BOLD}STRONG BUY${RESET}` : z.edge >= 0.07 ? `${GREEN}BUY${RESET}` : 'NEUTRAL';
      console.log(`  ${dStr.padEnd(10)} ${tStr.padEnd(12)} ${(z.cb + '¢').padEnd(8)} ${(z.real * 100).toFixed(1).padStart(5)}%   ${colorEdge(`+${(z.edge * 100).toFixed(1)}%`.padStart(7), z.edge)}   ${z.n}  ${sig}`);
    }
    return;
  }

  const { delta, tau, crowd } = config.point;
  const db = toBucket(delta, config.deltaStep);
  const tb = toBucket(tau, config.tauStep);
  const cb = crowdBucket10(crowd);

  // Nearest-neighbor search with expanding radius
  let result: BucketAccum | null = null;
  let radius = 0;
  while (radius <= 2 && !result) {
    const candidates: BucketAccum[] = [];
    for (let dd = -radius; dd <= radius; dd++) for (let dt = -radius; dt <= radius; dt++) for (let dc = -radius; dc <= radius; dc++) {
      const key = `${db + dd * config.deltaStep}:${tb + dt * config.tauStep}:${Math.max(10, Math.min(90, cb + dc * 10))}`;
      const b   = tripleMap.get(key);
      if (b) candidates.push(b);
    }
    if (candidates.length > 0) {
      const merged = mergeBuckets(candidates);
      if (bucketN(merged) >= config.minMarkets) { result = merged; break; }
    }
    radius++;
  }

  const dStr = db >= 0 ? `+$${db}` : `-$${Math.abs(db)}`;
  console.log();
  console.log(`  Запрос: delta=${dStr} (input: ${delta >= 0 ? '+' : ''}$${delta}), tau=${tb}-${tb + config.tauStep}s (input: ${tau}s), crowd=${cb}¢ (input: ${crowd}¢)`);
  if (radius > 0) console.log(`  ${DIM}Точного совпадения нет, использован радиус поиска ${radius}${RESET}`);
  console.log();

  if (!result) {
    console.log(`  ${RED}Недостаточно данных в базе калибровки для этой зоны.${RESET}`);
    return;
  }

  const n     = bucketN(result);
  const real  = bucketUp(result) / n;
  const edge  = real - crowd / 100;
  const bias  = crowd / 100 - real;

  const signal = edge >= 0.15 ? `${GREEN}${BOLD}● STRONG BUY UP${RESET}  (crowd сильно недооценивает)` :
                 edge >= 0.07 ? `${GREEN}● BUY UP${RESET}  (crowd недооценивает)` :
                 edge >= -0.07 ? `${DIM}◯ NEUTRAL${RESET}` :
                 edge >= -0.15 ? `${RED}● SELL / FADE UP${RESET}  (crowd переоценивает)` :
                                 `${RED}${BOLD}● STRONG SELL / FADE UP${RESET}  (crowd сильно переоценивает)`;

  const bar = Array(40).fill('░');
  const realPos  = Math.round(real * 40);
  const crowdPos = Math.round((crowd / 100) * 40);
  for (let i = 0; i < realPos; i++) bar[i] = '█';
  if (crowdPos >= 0 && crowdPos < 40) bar[crowdPos] = '│';

  console.log(`  ${'Показатель'.padEnd(22)} ${'Значение'.padEnd(12)} Бар`);
  console.log(`  ${DIM}${'─'.repeat(60)}${RESET}`);
  console.log(`  ${'Crowd price'.padEnd(22)} ${(crowd + '¢').padEnd(12)} (implied P(UP) по рынку)`);
  console.log(`  ${'Calibrated P(UP)'.padEnd(22)} ${(real * 100).toFixed(1).padStart(5)}%       ${bar.join('')}`);
  console.log(`  ${'Edge (real−crowd)'.padEnd(22)} ${colorEdge((edge >= 0 ? '+' : '') + (edge * 100).toFixed(1) + '%', edge)}`);
  console.log(`  ${'Bias (crowd−real)'.padEnd(22)} ${colorBias((bias >= 0 ? '+' : '') + (bias * 100).toFixed(1) + '%', bias)}`);
  console.log(`  ${(COUNT_BY === 'observations' ? 'Наблюдений' : 'Исторических рынков').padEnd(22)} ${n}`);
  console.log();
  console.log(`  Сигнал: ${signal}`);
}

// ── Variant 4: ASCII Heatmap ──────────────────────────────────────────────────

/**
 * Вариант 4 — ASCII тепловая карта delta × crowd¢ для заданного tau-окна.
 *
 * @param tripleMap - Map ключ "delta:tau:crowd10"
 * @param tauWindow - tau-окно [from, to]
 * @param sortedTaus - все tau-бакеты
 * @param config    - конфигурация
 *
 * @remarks
 * Символы блоков по |edge|:
 * · < 3%   ░ < 6%   ▒ < 10%   ▓ < 15%   █ ≥ 15%
 *
 * Цвет: зелёный = edge > 0 (недооценка), красный = edge < 0 (переоценка).
 * ANSI-коды не влияют на выравнивание: padding строится ДО добавления цвета.
 */
function printHeatmap(
  tripleMap:  Map<string, BucketAccum>,
  tauWindow:  [number, number],
  sortedTaus: number[],
  config:     Config,
): void {
  const allDeltas = new Set<number>();
  for (const key of tripleMap.keys()) allDeltas.add(Number(key.split(':')[0]));
  const sortedDeltas = [...allDeltas].sort((a, b) => b - a); // top-down: max delta first
  const CROWDS = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  const CW = 5; // visual width per cell: "██  " = block(1) + space(1) + sep(1) = 3... use 4

  const [winFrom, winTo] = tauWindow;
  const winTaus = sortedTaus.filter(t => t >= winFrom && t < winTo);
  if (winTaus.length === 0) {
    console.log(`  ${DIM}Нет данных для tau-окна ${winFrom}-${winTo}s${RESET}`); return;
  }

  // Build (delta, crowd) → merged bucket
  const hm = new Map<string, BucketAccum>();
  for (const db of sortedDeltas) for (const cb of CROWDS) {
    const parts = winTaus.map(tb => tripleMap.get(`${db}:${tb}:${cb}`)).filter((b): b is BucketAccum => b !== undefined);
    if (parts.length > 0) hm.set(`${db}:${cb}`, mergeBuckets(parts));
  }

  const W = LABEL_W + CROWDS.length * CW;
  console.log();
  console.log(`${BOLD}${CYAN}${'═'.repeat(W)}${RESET}`);
  console.log(`${BOLD}${CYAN}  VARIANT 4 — HEATMAP: delta × crowd¢ | tau ${winFrom}−${winTo}s${RESET}`);
  console.log(`${BOLD}${CYAN}  Символ = |edge|: · <3%  ░ <6%  ▒ <10%  ▓ <15%  █ ≥15%  Цвет: ${GREEN}зелёный${RESET}=недооценка  ${RED}красный${RESET}=переоценка${RESET}`);
  console.log(`${BOLD}${CYAN}${'═'.repeat(W)}${RESET}`);

  // Header (no ANSI — pure padding)
  const header = 'Delta'.padEnd(LABEL_W) + CROWDS.map(c => `${c}¢`.padStart(CW)).join('');
  console.log(`${BOLD}${WHITE}${header}${RESET}`);
  console.log(`${DIM}${'─'.repeat(W)}${RESET}`);

  for (const db of sortedDeltas) {
    const dStr  = (db >= 0 ? `+$${db}` : `-$${Math.abs(db)}`).padEnd(LABEL_W);
    const cells = CROWDS.map(cb => {
      const b = hm.get(`${db}:${cb}`);
      const n = b ? bucketN(b) : 0;
      if (!b || n < config.minMarkets) return ' '.repeat(CW);
      const real  = bucketUp(b) / n;
      const edge  = real - cb / 100;
      const char  = blockChar(Math.abs(edge));
      // pad first (CW-1 spaces before char), then color
      const padded = (char + ' ').padStart(CW);
      return colorEdge(padded, edge);
    });
    // Use padEndRaw-safe join: each colored cell is already CW visual chars
    console.log(dStr + cells.join(''));
  }

  // Legend with edge values
  console.log();
  console.log(`  ${DIM}n<${config.minMarkets} показывается пустым. Ниже — значения edge по знаковым ячейкам:${RESET}`);
  console.log();

  // Mini summary: best and worst cells
  const summary: Array<{ db: number; cb: number; edge: number; n: number; real: number }> = [];
  for (const [key, b] of hm) {
    const [db, cb] = key.split(':').map(Number);
    const n = bucketN(b);
    if (n < config.minMarkets) continue;
    summary.push({ db, cb, edge: bucketUp(b) / n - cb / 100, n, real: bucketUp(b) / n });
  }
  summary.sort((a, b) => b.edge - a.edge);

  if (summary.length > 0) {
    console.log(`  ${BOLD}${'Delta'.padEnd(10)} ${'Crowd¢'.padEnd(8)} ${'Real%'.padEnd(8)} ${'Edge'.padEnd(10)} n${RESET}`);
    console.log(`  ${DIM}${'─'.repeat(45)}${RESET}`);
    const show = [...summary.slice(0, 3), ...summary.slice(-3).reverse()];
    let shownSep = false;
    for (const s of show) {
      if (!shownSep && s.edge < 0) { console.log(`  ${DIM}${'·'.repeat(45)}${RESET}`); shownSep = true; }
      const dS = s.db >= 0 ? `+$${s.db}` : `-$${Math.abs(s.db)}`;
      const eS = (s.edge >= 0 ? '+' : '') + (s.edge * 100).toFixed(1) + '%';
      console.log(`  ${dS.padEnd(10)} ${(s.cb + '¢').padEnd(8)} ${(s.real * 100).toFixed(1).padStart(5)}%   ${colorEdge(eS.padStart(8), s.edge)}   ${s.n}`);
    }
  }
}

/**
 * V5 — Edge по крауд-цене × режиму (slope BTC за 60s).
 *
 * Показывает 3 колонки (DOWN / FLAT / UP) для каждого бакета crowd¢.
 * Ячейка: `edge=(real − crowd)` в п.п. и `n` рынков/наблюдений.
 *
 * @remarks
 * Назначение — проверить, зависит ли калибровка толпы от направления рынка.
 * Если edge резко меняется между режимами — стратегия должна учитывать режим
 * BTC (slope за последние 60 секунд).
 */
function printRegimeTable(
  regimeCrowdMap: Map<string, BucketAccum>,
  regimeCounts:   Record<Regime, number>,
  config:         Config,
): void {
  const W = 90;
  console.log();
  console.log(`${BOLD}${CYAN}${'═'.repeat(W)}${RESET}`);
  console.log(`${BOLD}${CYAN}  VARIANT 5 — EDGE × REGIME × CROWD¢ | threshold = ±$${config.regimeThreshold}/min${RESET}`);
  console.log(`${BOLD}${CYAN}  slope BTC за 60s: down < -$${config.regimeThreshold}/min, |slope| ≤ $${config.regimeThreshold}/min = flat, > +$${config.regimeThreshold}/min = up${RESET}`);
  console.log(`${BOLD}${CYAN}${'═'.repeat(W)}${RESET}`);
  const total = regimeCounts.down + regimeCounts.flat + regimeCounts.up;
  if (total === 0) { console.log(`${DIM}  нет данных${RESET}`); return; }
  const pct = (n: number) => ((n / total) * 100).toFixed(1);
  console.log(
    `${DIM}  Наблюдений: down=${regimeCounts.down} (${pct(regimeCounts.down)}%)  ` +
    `flat=${regimeCounts.flat} (${pct(regimeCounts.flat)}%)  ` +
    `up=${regimeCounts.up} (${pct(regimeCounts.up)}%)${RESET}`,
  );
  console.log();

  const crowds = new Set<number>();
  for (const key of regimeCrowdMap.keys()) crowds.add(Number(key.split(':')[1]));
  const sortedCrowds = [...crowds].sort((a, b) => a - b).filter(c => c >= 10 && c <= 95);

  const CW = 20;
  const header = 'Crowd¢'.padEnd(10) + ['DOWN', 'FLAT', 'UP'].map(r => r.padStart(CW)).join('');
  console.log(`${BOLD}${WHITE}${header}${RESET}`);
  console.log(`${DIM}${'─'.repeat(10 + 3 * CW)}${RESET}`);

  type Row = { regime: Regime; crowd: number; edge: number; n: number; real: number };
  const rows: Row[] = [];

  for (const crowd of sortedCrowds) {
    const cells: string[] = [];
    for (const regime of ['down', 'flat', 'up'] as Regime[]) {
      const b = regimeCrowdMap.get(`${regime}:${crowd}`);
      if (!b) { cells.push(' '.repeat(CW)); continue; }
      const n = bucketN(b);
      if (n < config.minMarkets) { cells.push(`${DIM}${('n=' + n).padStart(CW)}${RESET}`); continue; }
      const real = bucketUp(b) / n;
      const edge = real - crowd / 100;
      const eStr = (edge >= 0 ? '+' : '') + (edge * 100).toFixed(1) + '%';
      const text = `${eStr} n=${n}`;
      cells.push(colorEdge(text.padStart(CW), edge));
      rows.push({ regime, crowd, edge, n, real });
    }
    console.log(`${(crowd + '¢').padEnd(10)}${cells.join('')}`);
  }

  // Топ-5 зон с максимальным |edge|-разрывом между режимами для того же crowd.
  console.log();
  console.log(`  ${BOLD}▸ Регимо-зависимые зоны (разрыв edge между режимами)${RESET}`);
  console.log(`  ${DIM}${'─'.repeat(78)}${RESET}`);
  const byCrowd = new Map<number, Partial<Record<Regime, Row>>>();
  for (const r of rows) {
    const m = byCrowd.get(r.crowd) ?? {};
    m[r.regime] = r;
    byCrowd.set(r.crowd, m);
  }
  type Gap = { crowd: number; best: Row; worst: Row; spread: number };
  const gaps: Gap[] = [];
  for (const [crowd, m] of byCrowd) {
    const present = (['down', 'flat', 'up'] as Regime[]).map(r => m[r]).filter(Boolean) as Row[];
    if (present.length < 2) continue;
    present.sort((a, b) => b.edge - a.edge);
    gaps.push({ crowd, best: present[0], worst: present[present.length - 1], spread: present[0].edge - present[present.length - 1].edge });
  }
  gaps.sort((a, b) => b.spread - a.spread);
  for (const g of gaps.slice(0, 5)) {
    const bE = (g.best.edge  >= 0 ? '+' : '') + (g.best.edge  * 100).toFixed(1) + '%';
    const wE = (g.worst.edge >= 0 ? '+' : '') + (g.worst.edge * 100).toFixed(1) + '%';
    console.log(
      `  ${(g.crowd + '¢').padEnd(8)} ` +
      `best: ${g.best.regime.padEnd(4)} ${colorEdge(bE.padStart(7), g.best.edge)} n=${String(g.best.n).padEnd(5)} ` +
      `worst: ${g.worst.regime.padEnd(4)} ${colorEdge(wE.padStart(7), g.worst.edge)} n=${String(g.worst.n).padEnd(5)} ` +
      `Δedge=${(g.spread * 100).toFixed(1)}pp`,
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const config = parseArgs();
  COUNT_BY = config.countBy;
  const show   = config.show;
  const showAll = show.has('all');

  const files: string[] = [];
  for (const dir of config.dirs) {
    let entries = readdirSync(dir).filter(f => f.endsWith('.jsonl.gz') || f.endsWith('.jsonl'));
    if (config.asset) entries = entries.filter(f => f.toLowerCase().includes(config.asset));
    for (const e of entries) files.push(join(dir, e));
  }

  const tokenLabel = config.token === 'both' ? 'UP+DOWN avg' : `${config.token.toUpperCase()} book`;
  console.error(`Found ${files.length} files | token: ${tokenLabel} | duration: ${config.duration} | count-by: ${config.countBy} | regime: ${config.regime} (±$${config.regimeThreshold}/min)`);
  console.error(`Show: ${showAll ? 'all' : [...show].join(',')}`);

  let processed = 0, skipped = 0, totalObs = 0;
  const deltaBuckets    = new Map<string, BucketAccum>(); // "delta:tau"
  const crowdTauBuckets = new Map<string, BucketAccum>(); // "dur:crowd5:tau"
  const tripleMap       = new Map<string, BucketAccum>(); // "delta:tau:crowd10"
  const regimeCrowdMap  = new Map<string, BucketAccum>(); // "regime:crowd10"
  const regimeCounts: Record<Regime, number> = { up: 0, flat: 0, down: 0 };
  const durationCounts  = { '5min': 0, '15min': 0, 'other': 0 };
  const skipCounts: Record<SkipReason, number> = {
    no_strike:        0,
    no_resolution:    0,
    no_final_price:   0,
    no_observations:  0,
    parse_error:      0,
  };
  /** Файлы без priceToBeat — отдельно, сверх skipCounts (могут перекрываться). */
  let missingPriceToBeat = 0;
  /** Файлы без finalPrice — отдельно, сверх skipCounts. */
  let missingFinalPrice = 0;
  /** Сколько рынков принято благодаря approx-strike (первая Chainlink-цена). */
  let approxStrikeCount = 0;
  /** Сколько рынков принято благодаря approx-resolution (последняя Chainlink-цена). */
  let approxResolutionCount = 0;
  /** Разбивка подпричин внутри `no_observations`. */
  const noObsBreakdown: Record<NoObsReason, number> = {
    no_chainlink_stream: 0,
    no_book_side:        0,
    all_before_start:    0,
    all_tau_too_large:   0,
    all_desync:          0,
    all_invalid_mid:     0,
    mixed:               0,
  };

  for (const file of files) {
    const result = await parseSnapshot(file, config.maxTau, config.token, config.approxResolution);
    if (result.hasPriceToBeat === false) missingPriceToBeat++;
    if (result.hasFinalPrice === false)  missingFinalPrice++;
    if (result.data && result.approxStrike)     approxStrikeCount++;
    if (result.data && result.approxResolution) approxResolutionCount++;
    if (!result.data) {
      skipped++;
      if (result.skipReason) skipCounts[result.skipReason]++;
      if (result.skipReason === 'no_observations' && result.noObsReason) {
        noObsBreakdown[result.noObsReason]++;
      }
      continue;
    }
    const data = result.data;
    processed++;
    totalObs += data.observations.length;
    durationCounts[data.duration]++;

    for (const obs of data.observations) {
      if (Math.abs(obs.delta) > config.maxDelta) continue;
      const tb  = toBucket(obs.tauSec, config.tauStep);
      const cb5 = crowdBucket5(obs.midPriceCents);
      const regime = classifyRegime(obs.trendSlope, config.regimeThreshold);
      regimeCounts[regime]++;

      // V5 (regime × crowd10) не зависит от --regime фильтра: показываем все три.
      if (config.duration === 'all' || data.duration === config.duration) {
        const cb10R = crowdBucket10(obs.midPriceCents);
        const rKey  = `${regime}:${cb10R}`;
        if (!regimeCrowdMap.has(rKey)) regimeCrowdMap.set(rKey, newBucket());
        accumulate(regimeCrowdMap.get(rKey)!, obs.midPriceCents, obs.spreadCents, data.slug, data.resolution);
      }

      // Остальные таблицы — с учётом --regime фильтра.
      if (config.regime !== 'all' && regime !== config.regime) continue;

      if (config.duration === 'all' || data.duration === config.duration) {
        const db  = toBucket(obs.delta, config.deltaStep);

        // Existing: delta×tau
        const dKey = bucketKey(db, tb);
        if (!deltaBuckets.has(dKey)) deltaBuckets.set(dKey, newBucket());
        accumulate(deltaBuckets.get(dKey)!, obs.midPriceCents, obs.spreadCents, data.slug, data.resolution);

        // New: delta×tau×crowd (10¢ buckets)
        const cb10  = crowdBucket10(obs.midPriceCents);
        const tKey  = `${db}:${tb}:${cb10}`;
        if (!tripleMap.has(tKey)) tripleMap.set(tKey, newBucket());
        accumulate(tripleMap.get(tKey)!, obs.midPriceCents, obs.spreadCents, data.slug, data.resolution);
      }

      // Existing: crowd5×tau (all durations)
      for (const dur of [data.duration, 'all'] as const) {
        const ck = `${dur}:${cb5}:${tb}`;
        if (!crowdTauBuckets.has(ck)) crowdTauBuckets.set(ck, newBucket());
        accumulate(crowdTauBuckets.get(ck)!, obs.midPriceCents, obs.spreadCents, data.slug, data.resolution);
      }
    }

    if (processed % 50 === 0) console.error(`  Processed ${processed}/${files.length}, obs: ${totalObs}...`);
  }

  const dLabel = config.duration === 'all' ? 'ALL MARKETS' : `${config.duration.toUpperCase()} MARKETS`;
  console.error(`\nDone: ${processed} markets | ${skipped} skipped | ${totalObs} obs`);
  console.error(`  5-min: ${durationCounts['5min']}, 15-min: ${durationCounts['15min']}, other: ${durationCounts['other']}`);
  console.error(`  skipped breakdown:`);
  console.error(`    no_strike        : ${skipCounts.no_strike}       (нет priceToBeat и не удалось восстановить по Chainlink)`);
  console.error(`    no_final_price   : ${skipCounts.no_final_price}  (meta без finalPrice — рынок не обогащён)`);
  console.error(`    no_resolution    : ${skipCounts.no_resolution}   (finalPrice есть, но outcomePrices без 1 — рынок не settled)`);
  console.error(`    no_observations  : ${skipCounts.no_observations} (нет валидных book+chainlink точек в tau окне)`);
  if (skipCounts.no_observations > 0) {
    console.error(`      ├─ no_chainlink_stream : ${noObsBreakdown.no_chainlink_stream}  (в файле нет chainlink-цен)`);
    console.error(`      ├─ no_book_side        : ${noObsBreakdown.no_book_side}  (нет book для выбранного --token)`);
    console.error(`      ├─ all_before_start    : ${noObsBreakdown.all_before_start}  (все данные до startTime)`);
    console.error(`      ├─ all_tau_too_large   : ${noObsBreakdown.all_tau_too_large}  (всё дальше --max-tau от endDate)`);
    console.error(`      ├─ all_desync          : ${noObsBreakdown.all_desync}  (book↔chainlink рассинхрон > 30s)`);
    console.error(`      ├─ all_invalid_mid     : ${noObsBreakdown.all_invalid_mid}  (mid вне [1,99] или spread > 50)`);
    console.error(`      └─ mixed               : ${noObsBreakdown.mixed}  (без доминирующей причины)`);
  }
  console.error(`    parse_error      : ${skipCounts.parse_error}`);
  console.error(`  meta diagnostics (может пересекаться со skipped):`);
  console.error(`    files w/o priceToBeat : ${missingPriceToBeat}`);
  console.error(`    files w/o finalPrice  : ${missingFinalPrice}`);
  const regimeTotal = regimeCounts.down + regimeCounts.flat + regimeCounts.up;
  if (regimeTotal > 0) {
    const pct = (n: number) => ((n / regimeTotal) * 100).toFixed(1);
    console.error(`  regime breakdown (slope Chainlink за 60s, порог ±$${config.regimeThreshold}/min):`);
    console.error(`    down : ${regimeCounts.down}  (${pct(regimeCounts.down)}%)`);
    console.error(`    flat : ${regimeCounts.flat}  (${pct(regimeCounts.flat)}%)`);
    console.error(`    up   : ${regimeCounts.up}  (${pct(regimeCounts.up)}%)`);
  }
  if (approxStrikeCount > 0 || approxResolutionCount > 0 || config.approxResolution) {
    console.error(`  approx (restored from Chainlink):`);
    console.error(`    strike    : ${approxStrikeCount}  (ближайшая цена к startTime)`);
    console.error(`    resolution: ${approxResolutionCount}  (последний Chainlink-сэмпл в окне [endDate-2s, endDate))${config.approxResolution ? '' : '  [OFF — включите --approx-resolution]'}`);
  }
  console.error('');

  // ── Оси ──────────────────────────────────────────────────────────────────

  const allDeltas = new Set<number>(), allTaus = new Set<number>();
  for (const key of deltaBuckets.keys()) {
    const [d, t] = key.split(':').map(Number); allDeltas.add(d); allTaus.add(t);
  }
  const sortedDeltas = [...allDeltas].sort((a, b) => a - b);
  const sortedTaus   = [...allTaus].sort((a, b) => a - b);

  // ── TABLE A ───────────────────────────────────────────────────────────────

  if (showAll || show.has('a')) {
    printCalibrationTable(
      `TABLE A — DELTA × TAU | ${dLabel} | ${tokenLabel}`,
      sortedDeltas, sortedTaus, config.tauStep,
      'Delta ($)', d => d >= 0 ? `+$${d}` : `-$${Math.abs(d)}`,
      (d, t) => deltaBuckets.get(bucketKey(d, t)),
      (_, b) => b.crowdProbSum / b.observations,
      config.minMarkets,
    );
    printInsights(
      sortedDeltas, sortedTaus,
      (d, t) => deltaBuckets.get(bucketKey(d, t)),
      (_, b) => b.crowdProbSum / b.observations,
      d => d >= 0 ? `+$${d}` : `-$${Math.abs(d)}`,
      config.tauStep, config.minMarkets,
    );
  }

  // ── TABLE B ───────────────────────────────────────────────────────────────

  function printCrowdTable(durFilter: string, label: string): void {
    const ctTaus = new Set<number>(), ctCrowds = new Set<number>();
    for (const key of crowdTauBuckets.keys()) {
      const [dur, crowd, tau] = key.split(':');
      if (dur !== durFilter) continue;
      ctCrowds.add(Number(crowd)); ctTaus.add(Number(tau));
    }
    if (ctTaus.size === 0) return;
    const sTaus   = [...ctTaus].sort((a, b) => a - b);
    const sCrowds = [...ctCrowds].sort((a, b) => a - b).filter(c => c >= 10 && c <= 95);
    printCalibrationTable(
      `TABLE B — CROWD PRICE × TAU | ${label} | ${tokenLabel}`,
      sCrowds, sTaus, config.tauStep,
      'Crowd¢', c => `${c}¢`,
      (c, t) => crowdTauBuckets.get(`${durFilter}:${c}:${t}`),
      (c, _) => c / 100,
      config.minMarkets,
    );
    printInsights(
      sCrowds, sTaus,
      (c, t) => crowdTauBuckets.get(`${durFilter}:${c}:${t}`),
      (c, _) => c / 100,
      c => `${c}¢`,
      config.tauStep, config.minMarkets,
    );
  }

  if (showAll || show.has('b')) {
    if (config.duration === 'all') {
      if (durationCounts['5min']  > 0) printCrowdTable('5min',  '5-MIN MARKETS');
      if (durationCounts['15min'] > 0) printCrowdTable('15min', '15-MIN MARKETS');
      printCrowdTable('all', 'ALL MARKETS');
    } else {
      printCrowdTable(config.duration, dLabel);
    }
  }

  // ── TOP ERRORS ────────────────────────────────────────────────────────────

  if (showAll || show.has('top')) {
    const results: Array<{ d: number; t: number; crowdP: number; realP: number; bias: number; n: number; spread: number }> = [];
    for (const [key, b] of deltaBuckets) {
      const [d, t] = key.split(':').map(Number);
      const n = bucketN(b);
      if (n < config.minMarkets) continue;
      const cp = b.crowdProbSum / b.observations, rp = bucketUp(b) / n;
      results.push({ d, t, crowdP: cp, realP: rp, bias: cp - rp, n, spread: b.spreadSum / b.observations });
    }
    results.sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias));

    console.log();
    console.log(`${BOLD}${CYAN}${'═'.repeat(75)}${RESET}`);
    console.log(`${BOLD}${CYAN}  TOP-20 CROWD ERRORS (DELTA×TAU) — ${dLabel}${RESET}`);
    console.log(`${BOLD}${CYAN}${'═'.repeat(75)}${RESET}`);
    console.log(`${BOLD}${'Delta'.padEnd(10)} ${'Tau'.padEnd(12)} ${'Crowd%'.padEnd(8)} ${'Real%'.padEnd(8)} ${'Bias'.padEnd(10)} ${'n'.padEnd(6)} Spread¢${RESET}`);
    console.log(`${DIM}${'─'.repeat(68)}${RESET}`);
    for (const r of results.slice(0, 20)) {
      const d  = r.d >= 0 ? `+$${r.d}` : `-$${Math.abs(r.d)}`;
      const bs = r.bias > 0 ? `${DIM}+${(r.bias * 100).toFixed(1)}%${RESET}` : `${BOLD}${GREEN}-${Math.abs(r.bias * 100).toFixed(1)}%${RESET}`;
      console.log(`${d.padEnd(10)} ${(r.t + 's').padEnd(12)} ${(r.crowdP * 100).toFixed(1).padStart(5)}%   ${(r.realP * 100).toFixed(1).padStart(5)}%   ${bs}    ${String(r.n).padStart(4)}    ${r.spread.toFixed(1).padStart(5)}`);
    }
  }

  // ── CALIBRATION CURVE ─────────────────────────────────────────────────────

  if (showAll || show.has('curve')) {
    const curveKey = config.duration === 'all' ? 'all' : config.duration;
    const curveTaus = new Set<number>(), curveCrowds = new Set<number>();
    for (const key of crowdTauBuckets.keys()) {
      const [dur, crowd, tau] = key.split(':');
      if (dur !== curveKey) continue;
      curveCrowds.add(Number(crowd)); curveTaus.add(Number(tau));
    }
    const curveParts = new Map<number, BucketAccum[]>();
    for (const crowd of curveCrowds) for (const tau of curveTaus) {
      const b = crowdTauBuckets.get(`${curveKey}:${crowd}:${tau}`);
      if (!b) continue;
      const c = curveParts.get(crowd) ?? [];
      c.push(b);
      curveParts.set(crowd, c);
    }
    const entries = [...curveParts.entries()]
      .map(([crowd, buckets]) => [crowd, mergeBuckets(buckets)] as const)
      .filter(([, b]) => bucketN(b) >= config.minMarkets)
      .sort(([a], [b]) => a - b);

    console.log();
    console.log(`${BOLD}${CYAN}${'═'.repeat(78)}${RESET}`);
    console.log(`${BOLD}${CYAN}  CALIBRATION CURVE — crowd price → realized P(UP)${RESET}`);
    console.log(`${BOLD}${CYAN}${'═'.repeat(78)}${RESET}`);
    console.log(`${BOLD}${'Crowd¢'.padEnd(8)} ${'Real%'.padEnd(8)} ${'Bias'.padEnd(10)} ${'n'.padEnd(7)} Bar (│ = crowd price)${RESET}`);
    console.log(`${DIM}${'─'.repeat(70)}${RESET}`);

    let biasSum = 0, totalN = 0;
    for (const [cents, d] of entries) {
      const n = bucketN(d), real = bucketUp(d) / n, crowd = cents / 100, bias = crowd - real;
      biasSum += bias * n; totalN += n;
      const bar = ('█'.repeat(Math.round(real * 40)) + '░'.repeat(40 - Math.round(real * 40))).split('');
      const m   = Math.round(crowd * 40); if (m >= 0 && m < 40) bar[m] = '│';
      const bs  = bias > 0 ? `${DIM}+${(bias * 100).toFixed(1)}%${RESET}` : `${BOLD}${GREEN}-${Math.abs(bias * 100).toFixed(1)}%${RESET}`;
      console.log(`${(cents + '¢').padEnd(8)} ${(real * 100).toFixed(1).padStart(5)}%   ${bs}    ${String(n).padStart(5)}   ${bar.join('')}`);
    }
    if (totalN > 0) {
      const avg = biasSum / totalN;
      const dir = avg > 0.01 ? `${DIM}переоценивает${RESET}` : avg < -0.01 ? `${GREEN}${BOLD}недооценивает${RESET}` : 'хорошо откалибрована';
      console.log(); console.log(`  ${DIM}▸ Итог:${RESET} толпа в среднем ${dir} UP на ${Math.abs(avg * 100).toFixed(1)}% (n=${totalN})`);
    }
  }

  // ── VARIANT 1: Tau-sliced ─────────────────────────────────────────────────

  if (showAll || show.has('1')) {
    const windows = config.tauWindows.length > 0 ? config.tauWindows : defaultTauWindows(config.maxTau, config.tauStep);
    const triTaus = new Set<number>();
    for (const key of tripleMap.keys()) triTaus.add(Number(key.split(':')[1]));
    printTauSliced(tripleMap, windows, [...triTaus].sort((a, b) => a - b), config);
  }

  // ── VARIANT 2: Edge Score ─────────────────────────────────────────────────

  if (showAll || show.has('2')) {
    printEdgeTable(tripleMap, sortedTaus, config);
  }

  // ── VARIANT 3: Point Lookup ───────────────────────────────────────────────

  if (showAll || show.has('3')) {
    printPointLookup(tripleMap, config);
  }

  // ── VARIANT 4: Heatmap ────────────────────────────────────────────────────

  if (showAll || show.has('4')) {
    const triTaus = new Set<number>();
    for (const key of tripleMap.keys()) triTaus.add(Number(key.split(':')[1]));
    const sTaus   = [...triTaus].sort((a, b) => a - b);
    const window  = config.heatmapTau ?? defaultTauWindows(config.maxTau, config.tauStep)[1];
    printHeatmap(tripleMap, window, sTaus, config);
  }

  // ── VARIANT 5: Regime × Crowd ─────────────────────────────────────────────

  if (showAll || show.has('5')) {
    printRegimeTable(regimeCrowdMap, regimeCounts, config);
  }

  // ── JSON ──────────────────────────────────────────────────────────────────

  if (config.outFile) {
    const out: Record<string, unknown> = {
      config: {
        deltaStep: config.deltaStep, tauStep: config.tauStep,
        duration: config.duration, token: config.token,
        countBy: config.countBy, regime: config.regime,
        regimeThreshold: config.regimeThreshold,
      },
      summary: {
        markets: processed,
        totalObservations: totalObs,
        skipped,
        skipCounts,
        noObsBreakdown,
        approxStrike:     approxStrikeCount,
        approxResolution: approxResolutionCount,
        missingPriceToBeat,
        missingFinalPrice,
      },
    };
    writeFileSync(config.outFile, JSON.stringify(out, null, 2));
    console.error(`\nJSON: ${config.outFile}`);
  }
}

// Запускаем main() только при прямом вызове скрипта, не при импорте из других файлов.
const invokedDirectly = process.argv[1] != null && process.argv[1].endsWith('analyze-crowd-calibration.ts');
if (invokedDirectly) {
  main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
}
