/**
 * Анализ калибровки толпы: насколько стакан (order book) ошибается
 * относительно реальности (Chainlink price vs strike).
 *
 * @remarks
 * ### Идея:
 * В каждый момент времени у нас есть:
 * - **Реальность**: Chainlink price vs strike → дельта в $ (BTC выше/ниже страйка)
 * - **Мнение толпы**: mid-price стакана (= implied probability UP)
 * - **Время**: tau (секунды до экспирации)
 *
 * Группируем по бакетам (deltaBucket × tauBucket) и считаем:
 * - Средний mid-price толпы (= crowd implied P(UP))
 * - Реальный P(UP) (= доля рынков с resolution UP)
 * - Ошибка = crowd - reality
 *
 * ### Бакеты:
 * - **Delta**: разница (chainlinkPrice - strikePrice) в $, шаг $25
 *   Пример: [-100, -75, -50, -25, 0, +25, +50, +75, +100]
 * - **Tau**: секунды до экспирации, шаг 30 сек
 *   Пример: [0, 30, 60, 90, 120, ..., 300]
 *
 * ### Выход:
 * Таблица: delta × tau → { crowdProb, realProb, error, sampleSize }
 *
 * @example
 * ```bash
 * npx tsx scripts/analyze-crowd-calibration.ts /path/to/snapshots/2026-03-25 /path/to/snapshots/2026-03-26
 * npx tsx scripts/analyze-crowd-calibration.ts /path/to/snapshots --delta-step 25 --tau-step 30
 * npx tsx scripts/analyze-crowd-calibration.ts /path/to/snapshots --out calibration.json
 * ```
 */

import { createReadStream, readdirSync, writeFileSync } from 'fs';
import { createGunzip } from 'zlib';
import { createInterface } from 'readline';
import { join } from 'path';

// ── Конфигурация ──────────────────────────────────────────────────────────────

interface Config {
  dirs: string[];
  deltaStep: number;   // Шаг бакета по дельте ($)
  tauStep: number;     // Шаг бакета по tau (сек)
  maxDelta: number;    // Максимальная дельта для анализа ($)
  maxTau: number;      // Максимальный tau (сек)
  outFile: string;
  asset: string;       // Фильтр по активу (bitcoin, bnb, etc.), пустая строка = все
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    dirs: [],
    deltaStep: 25,
    tauStep: 30,
    maxDelta: 200,
    maxTau: 900,
    outFile: '',
    asset: '',
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--delta-step') { config.deltaStep = Number(args[++i]); }
    else if (args[i] === '--tau-step') { config.tauStep = Number(args[++i]); }
    else if (args[i] === '--max-delta') { config.maxDelta = Number(args[++i]); }
    else if (args[i] === '--max-tau') { config.maxTau = Number(args[++i]); }
    else if (args[i] === '--out') { config.outFile = args[++i]; }
    else if (args[i] === '--asset') { config.asset = args[++i].toLowerCase(); }
    else { config.dirs.push(args[i]); }
  }

  if (config.dirs.length === 0) {
    console.error('Usage: npx tsx scripts/analyze-crowd-calibration.ts <dir1> [dir2...] [options]');
    console.error('Options:');
    console.error('  --delta-step 25   Delta bucket step in $ (default: 25)');
    console.error('  --tau-step 30     Tau bucket step in seconds (default: 30)');
    console.error('  --max-delta 200   Max absolute delta to track (default: 200)');
    console.error('  --max-tau 900     Max tau in seconds (default: 900)');
    console.error('  --out file.json   Write JSON output (default: stdout only)');
    process.exit(1);
  }
  return config;
}

// ── Типы ──────────────────────────────────────────────────────────────────────

/** Ключ бакета: (deltaBucket, tauBucket) */
interface BucketKey {
  /** Нижняя граница дельты ($). Пример: -50 означает [-50, -25) */
  deltaBucket: number;
  /** Нижняя граница tau (сек). Пример: 60 означает [60, 90) */
  tauBucket: number;
}

/** Аккумулированная статистика одного бакета */
interface BucketAccum {
  /** Сумма crowd mid-prices (для среднего) */
  crowdProbSum: number;
  /** Количество наблюдений */
  observations: number;
  /** Количество рынков с resolution UP */
  upCount: number;
  /** Количество рынков с resolution DOWN */
  downCount: number;
  /** Множество уникальных рынков (для подсчёта upCount/downCount по рынкам) */
  marketResolutions: Map<string, 'UP' | 'DOWN'>;
  /** Сумма спредов (для среднего) */
  spreadSum: number;
}

/** Наблюдение: момент в рынке с book + crypto price */
interface Observation {
  midPriceCents: number;  // Mid price стакана (0-100 центов)
  bestBid: number;        // Best bid (центы)
  bestAsk: number;        // Best ask (центы)
  spreadCents: number;    // Spread (центы)
  delta: number;          // chainlinkPrice - strikePrice ($)
  tauSec: number;         // Секунды до экспирации
  chainlinkPrice: number; // Текущая цена Chainlink
  strikePrice: number;    // Strike price (priceToBeat)
}

/** Данные одного рынка */
/** Длительность рынка */
type MarketDuration = '5min' | '15min' | 'other';

/** Данные одного рынка */
interface MarketData {
  slug: string;
  resolution: 'UP' | 'DOWN';
  strikePrice: number;
  endDateMs: number;
  durationMin: number;
  duration: MarketDuration;
  observations: Observation[];
}

// ── Парсинг snapshot файла ────────────────────────────────────────────────────

async function parseSnapshot(filePath: string, maxTau: number): Promise<MarketData | null> {
  return new Promise((resolve) => {
    let resolution: 'UP' | 'DOWN' | null = null;
    let strikePrice = 0;
    let endDateMs = 0;
    let startTimeMs = 0;
    let slug = '';
    let upTokenId: string | null = null;

    // Последние известные значения
    let lastChainlinkPrice = 0;
    let lastChainlinkTs = 0;
    let lastBestBid = 0;   // центы
    let lastBestAsk = 0;   // центы
    let lastBookTs = 0;

    const observations: Observation[] = [];

    const isGz = filePath.endsWith('.gz');
    const raw = createReadStream(filePath);
    const stream = isGz ? raw.pipe(createGunzip()) : raw;
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      try {
        const d = JSON.parse(line);

        // Meta event
        if (d.t === 'meta' && d.m) {
          const m = d.m;
          const outcomePrices = JSON.parse(m.outcomePrices || '[]');
          const tokenIds = d.tokenIds || JSON.parse(m.clobTokenIds || '[]');

          if (outcomePrices.length >= 2) {
            if (Number(outcomePrices[0]) === 1) resolution = 'UP';
            else if (Number(outcomePrices[1]) === 1) resolution = 'DOWN';
          }

          upTokenId = tokenIds[0] || null;
          endDateMs = new Date(m.endDate).getTime();
          slug = m.slug || m.question || '';

          // Strike price и startTime из eventMetadata
          const events = m.events as Array<Record<string, unknown>> | undefined;
          if (events?.[0]) {
            const meta = events[0].eventMetadata as Record<string, unknown> | undefined;
            if (meta?.priceToBeat) {
              strikePrice = Number(meta.priceToBeat);
            }
            if (events[0].startTime) {
              startTimeMs = new Date(events[0].startTime as string).getTime();
            }
          }
          // Fallback: eventStartTime из m
          if (!startTimeMs && m.eventStartTime) {
            startTimeMs = new Date(m.eventStartTime as string).getTime();
          }
          return;
        }

        // Crypto price event (Chainlink)
        if (d.t === 'crypto_price' && d.source === 'chainlink' && typeof d.price === 'number') {
          lastChainlinkPrice = d.price;
          lastChainlinkTs = Number(d.ts);
          tryEmitObservation();
          return;
        }

        // Orderbook event (book snapshot для UP токена)
        if (d.event_type === 'book' && d.bids && d.asks) {
          // Только UP token
          if (upTokenId && d.asset_id !== upTokenId) return;

          const bids = d.bids as Array<{ price: string; size: string }>;
          const asks = d.asks as Array<{ price: string; size: string }>;

          // Best bid: максимальная цена среди bids с size > 0
          // (bids отсортированы по возрастанию — best bid последний)
          let bestBid = 0;
          for (const b of bids) {
            if (Number(b.size) > 0) {
              const p = Number(b.price);
              if (p > bestBid) bestBid = p;
            }
          }
          lastBestBid = Math.round(bestBid * 100);

          // Best ask: минимальная цена среди asks с size > 0
          // (asks отсортированы по убыванию — best ask последний)
          let bestAsk = 100;
          for (const a of asks) {
            if (Number(a.size) > 0) {
              const p = Number(a.price);
              if (p < bestAsk) bestAsk = p;
            }
          }
          lastBestAsk = Math.round(bestAsk * 100);

          lastBookTs = Number(d.timestamp);
          if (lastBookTs < 1e12) lastBookTs *= 1000;
          tryEmitObservation();
          return;
        }
      } catch {
        // Skip malformed lines
      }
    });

    /** Пытаемся создать наблюдение если есть свежие данные по обоим каналам */
    function tryEmitObservation(): void {
      if (!strikePrice || !endDateMs || !lastChainlinkPrice || !lastBestBid || !lastBestAsk) return;
      // Берём timestamp от последнего обновления (book или chainlink)
      const tsMs = Math.max(lastBookTs, lastChainlinkTs);
      if (tsMs === 0) return;

      const tauSec = Math.max(0, (endDateMs - tsMs) / 1000);
      if (tauSec > maxTau) return;

      // Проверка стейл: book и chainlink не должны отличаться > 30 сек
      if (lastBookTs > 0 && lastChainlinkTs > 0 && Math.abs(lastBookTs - lastChainlinkTs) > 30_000) return;

      const midPriceCents = Math.round((lastBestBid + lastBestAsk) / 2);
      const spreadCents = lastBestAsk - lastBestBid;
      const delta = lastChainlinkPrice - strikePrice;

      // Не записываем бессмысленные данные
      if (midPriceCents < 1 || midPriceCents > 99) return;
      if (spreadCents > 50) return; // Слишком широкий спред — книга не информативна

      observations.push({
        midPriceCents,
        bestBid: lastBestBid,
        bestAsk: lastBestAsk,
        spreadCents,
        delta,
        tauSec,
        chainlinkPrice: lastChainlinkPrice,
        strikePrice,
      });
    }

    rl.on('close', () => {
      if (!resolution || !strikePrice || observations.length === 0) {
        resolve(null);
        return;
      }
      const durationMin = startTimeMs && endDateMs ? (endDateMs - startTimeMs) / 60_000 : 0;
      let duration: MarketDuration = 'other';
      if (durationMin >= 4 && durationMin <= 6) duration = '5min';
      else if (durationMin >= 13 && durationMin <= 17) duration = '15min';
      resolve({ slug, resolution, strikePrice, endDateMs, durationMin, duration, observations });
    });

    rl.on('error', () => resolve(null));
    stream.on('error', () => resolve(null));
  });
}

// ── Бакетирование ─────────────────────────────────────────────────────────────

function bucketKey(deltaBucket: number, tauBucket: number): string {
  return `${deltaBucket}:${tauBucket}`;
}

function toBucket(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const config = parseArgs();
  const buckets = new Map<string, BucketAccum>();

  // Собираем все файлы
  const files: string[] = [];
  for (const dir of config.dirs) {
    let entries = readdirSync(dir).filter(f => f.endsWith('.jsonl.gz') || f.endsWith('.jsonl'));
    // Фильтр по активу (по имени файла)
    if (config.asset) {
      entries = entries.filter(f => f.toLowerCase().includes(config.asset));
    }
    for (const entry of entries) {
      files.push(join(dir, entry));
    }
  }
  console.error(`Found ${files.length} snapshot files in ${config.dirs.length} dirs`);

  let processed = 0;
  let skipped = 0;
  let totalObservations = 0;

  /** Бакеты crowd_price × tau, по длительности: ключ = "duration:crowdCents:tauBucket" */
  const crowdTauBuckets = new Map<string, BucketAccum>();
  /** Счётчик рынков по длительности */
  const durationCounts = { '5min': 0, '15min': 0, 'other': 0 };

  for (const file of files) {
    const data = await parseSnapshot(file, config.maxTau);
    if (!data) {
      skipped++;
      continue;
    }
    processed++;
    totalObservations += data.observations.length;
    durationCounts[data.duration]++;

    for (const obs of data.observations) {
      // Ограничиваем дельту
      if (Math.abs(obs.delta) > config.maxDelta) continue;

      const db = toBucket(obs.delta, config.deltaStep);
      const tb = toBucket(obs.tauSec, config.tauStep);
      const key = bucketKey(db, tb);

      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          crowdProbSum: 0,
          observations: 0,
          upCount: 0,
          downCount: 0,
          marketResolutions: new Map(),
          spreadSum: 0,
        };
        buckets.set(key, bucket);
      }

      bucket.crowdProbSum += obs.midPriceCents / 100;
      bucket.observations++;
      bucket.spreadSum += obs.spreadCents;

      if (!bucket.marketResolutions.has(data.slug)) {
        bucket.marketResolutions.set(data.slug, data.resolution);
        if (data.resolution === 'UP') bucket.upCount++;
        else bucket.downCount++;
      }

      // ── Аккумуляция для crowd_price × tau, split по duration ──
      const crowdCentsBucket = Math.round(obs.midPriceCents / 5) * 5;

      // Для каждой duration + "all"
      for (const dur of [data.duration, 'all'] as const) {
        const ctKey = `${dur}:${crowdCentsBucket}:${tb}`;
        let ctBucket = crowdTauBuckets.get(ctKey);
        if (!ctBucket) {
          ctBucket = {
            crowdProbSum: 0,
            observations: 0,
            upCount: 0,
            downCount: 0,
            marketResolutions: new Map(),
            spreadSum: 0,
          };
          crowdTauBuckets.set(ctKey, ctBucket);
        }
        ctBucket.crowdProbSum += obs.midPriceCents / 100;
        ctBucket.observations++;
        ctBucket.spreadSum += obs.spreadCents;
        if (!ctBucket.marketResolutions.has(data.slug)) {
          ctBucket.marketResolutions.set(data.slug, data.resolution);
          if (data.resolution === 'UP') ctBucket.upCount++;
          else ctBucket.downCount++;
        }
      }
    }

    if (processed % 50 === 0) {
      console.error(`  Processed ${processed}/${files.length} files, ${totalObservations} observations...`);
    }
  }

  console.error(`\nDone: ${processed} markets processed, ${skipped} skipped, ${totalObservations} total observations`);
  console.error(`  5-min: ${durationCounts['5min']}, 15-min: ${durationCounts['15min']}, other: ${durationCounts['other']}\n`);

  // ── Вывод результатов ─────────────────────────────────────────────────────

  // Собираем все уникальные бакеты и сортируем
  const allDeltas = new Set<number>();
  const allTaus = new Set<number>();
  for (const [key] of buckets) {
    const [d, t] = key.split(':').map(Number);
    allDeltas.add(d);
    allTaus.add(t);
  }
  const sortedDeltas = [...allDeltas].sort((a, b) => a - b);
  const sortedTaus = [...allTaus].sort((a, b) => a - b);

  // ── 1. Сводная таблица: delta × tau ─────────────────────────────────────

  console.log('='.repeat(120));
  console.log('CROWD CALIBRATION: crowd implied P(UP) vs realized P(UP)');
  console.log('='.repeat(120));
  console.log(`Delta step: $${config.deltaStep}, Tau step: ${config.tauStep}s, Markets: ${processed}, Observations: ${totalObservations}`);
  console.log();

  // Результаты для JSON
  const results: Array<{
    deltaBucket: number;
    tauBucket: number;
    crowdProb: number;
    realProb: number;
    error: number;
    absError: number;
    markets: number;
    observations: number;
    avgSpread: number;
  }> = [];

  // Header
  const tauHeader = sortedTaus.map(t => `${t}-${t + config.tauStep}s`.padStart(12));
  console.log(`${'Delta ($)'.padEnd(14)}${tauHeader.join('')}`);
  console.log('-'.repeat(14 + sortedTaus.length * 12));

  for (const delta of sortedDeltas) {
    const row: string[] = [];
    const deltaLabel = delta >= 0 ? `+$${delta}` : `-$${Math.abs(delta)}`;

    for (const tau of sortedTaus) {
      const key = bucketKey(delta, tau);
      const b = buckets.get(key);

      if (!b || b.upCount + b.downCount < 3) {
        row.push('   ---   '.padStart(12));
        continue;
      }

      const crowdProb = b.crowdProbSum / b.observations;
      const totalMarkets = b.upCount + b.downCount;
      const realProb = b.upCount / totalMarkets;
      const error = crowdProb - realProb;

      results.push({
        deltaBucket: delta,
        tauBucket: tau,
        crowdProb: Math.round(crowdProb * 1000) / 1000,
        realProb: Math.round(realProb * 1000) / 1000,
        error: Math.round(error * 1000) / 1000,
        absError: Math.round(Math.abs(error) * 1000) / 1000,
        markets: totalMarkets,
        observations: b.observations,
        avgSpread: Math.round(b.spreadSum / b.observations * 10) / 10,
      });

      // Форматируем: crowd→real (err)
      const c = (crowdProb * 100).toFixed(0).padStart(2);
      const r = (realProb * 100).toFixed(0).padStart(2);
      const e = (error * 100).toFixed(0);
      const sign = Number(e) > 0 ? '+' : '';
      row.push(`${c}→${r}(${sign}${e})`.padStart(12));
    }

    console.log(`${deltaLabel.padEnd(14)}${row.join('')}`);
  }

  // ── 2. Топ ошибок толпы ────────────────────────────────────────────────

  console.log();
  console.log('='.repeat(80));
  console.log('TOP CROWD ERRORS (where crowd is most wrong)');
  console.log('='.repeat(80));

  const significantResults = results.filter(r => r.markets >= 5);
  significantResults.sort((a, b) => b.absError - a.absError);

  console.log(`${'Delta'.padEnd(10)} ${'Tau'.padEnd(10)} ${'Crowd%'.padEnd(8)} ${'Real%'.padEnd(8)} ${'Error'.padEnd(8)} ${'Markets'.padEnd(8)} ${'Spread¢'.padEnd(8)}`);
  console.log('-'.repeat(70));

  for (const r of significantResults.slice(0, 20)) {
    const d = r.deltaBucket >= 0 ? `+$${r.deltaBucket}` : `-$${Math.abs(r.deltaBucket)}`;
    const errStr = r.error > 0 ? `+${(r.error * 100).toFixed(1)}%` : `${(r.error * 100).toFixed(1)}%`;
    console.log(
      `${d.padEnd(10)} ${(r.tauBucket + 's').padEnd(10)} ${(r.crowdProb * 100).toFixed(1).padStart(5)}%  ${(r.realProb * 100).toFixed(1).padStart(5)}%  ${errStr.padStart(7)}  ${String(r.markets).padStart(5)}    ${r.avgSpread.toFixed(1).padStart(5)}`,
    );
  }

  // ── 3. Калибровка по crowd price ───────────────────────────────────────
  // Для каждого crowd price bucket (5¢ шаг): реальный P(UP)

  console.log();
  console.log('='.repeat(80));
  console.log('CALIBRATION CURVE: crowd price → realized P(UP)');
  console.log('='.repeat(80));

  const crowdBuckets = new Map<number, { upCount: number; downCount: number; markets: Set<string> }>();

  for (const [key, b] of buckets) {
    for (const [slug, res] of b.marketResolutions) {
      // Нужен crowd price для этого рынка — берём средний по наблюдениям
      // Упрощение: используем средний crowd prob бакета
      const crowdCentsBucket = Math.round((b.crowdProbSum / b.observations) * 100 / 5) * 5; // 5¢ шаг
      let cb = crowdBuckets.get(crowdCentsBucket);
      if (!cb) {
        cb = { upCount: 0, downCount: 0, markets: new Set() };
        crowdBuckets.set(crowdCentsBucket, cb);
      }
      if (!cb.markets.has(`${slug}:${key}`)) {
        cb.markets.add(`${slug}:${key}`);
        if (res === 'UP') cb.upCount++;
        else cb.downCount++;
      }
    }
  }

  const crowdPriceBuckets = [...crowdBuckets.entries()]
    .filter(([, v]) => v.upCount + v.downCount >= 5)
    .sort(([a], [b]) => a - b);

  console.log(`${'Crowd¢'.padEnd(10)} ${'Real P(UP)'.padEnd(12)} ${'Error'.padEnd(10)} ${'Markets'.padEnd(10)} ${'Bar'}`);
  console.log('-'.repeat(70));

  for (const [cents, data] of crowdPriceBuckets) {
    const total = data.upCount + data.downCount;
    const realProb = data.upCount / total;
    const crowdProb = cents / 100;
    const error = crowdProb - realProb;
    const errStr = error > 0 ? `+${(error * 100).toFixed(1)}%` : `${(error * 100).toFixed(1)}%`;

    const barLen = Math.round(realProb * 40);
    const bar = '█'.repeat(barLen) + '░'.repeat(40 - barLen);
    const marker = Math.round(crowdProb * 40);
    const barArr = bar.split('');
    if (marker >= 0 && marker < 40) barArr[marker] = '│';

    console.log(
      `${(cents + '¢').padEnd(10)} ${(realProb * 100).toFixed(1).padStart(5)}%      ${errStr.padStart(7)}    ${String(total).padStart(5)}     ${barArr.join('')}`,
    );
  }

  // ── 4. Crowd Price × Tau матрица (split по duration) ─────────────────
  // Для каждого crowd price bucket (5¢) × tau bucket (30s): реальный P(UP)

  function printCrowdTauMatrix(durationFilter: string, label: string): void {
    // Собираем уникальные tau и crowd price бакеты для этого duration
    const ctTaus = new Set<number>();
    const ctCrowds = new Set<number>();
    for (const [key] of crowdTauBuckets) {
      const parts = key.split(':');
      if (parts[0] !== durationFilter) continue;
      ctCrowds.add(Number(parts[1]));
      ctTaus.add(Number(parts[2]));
    }
    if (ctTaus.size === 0) {
      console.log(`\n(No data for ${label})\n`);
      return;
    }
    const sTaus = [...ctTaus].sort((a, b) => a - b);
    const sCrowds = [...ctCrowds].sort((a, b) => a - b)
      .filter(c => c >= 10 && c <= 95); // Интересный диапазон

    console.log();
    console.log('='.repeat(14 + sTaus.length * 14));
    console.log(`CROWD PRICE × TAU: real P(UP) | ${label}`);
    console.log('='.repeat(14 + sTaus.length * 14));
    console.log(`Формат: crowd¢ → real%(ошибка) | Минимум 5 рынков в бакете`);
    console.log();

    const tHeader = sTaus.map(t => `${t}-${t + config.tauStep}s`.padStart(14));
    console.log(`${'Crowd¢'.padEnd(14)}${tHeader.join('')}`);
    console.log('-'.repeat(14 + sTaus.length * 14));

    for (const crowd of sCrowds) {
      const row: string[] = [];
      for (const tau of sTaus) {
        const ctKey = `${durationFilter}:${crowd}:${tau}`;
        const b = crowdTauBuckets.get(ctKey);
        const totalMkts = b ? b.upCount + b.downCount : 0;
        if (!b || totalMkts < 5) {
          row.push('  ---  '.padStart(14));
          continue;
        }
        const realProb = b.upCount / totalMkts;
        const crowdProb = crowd / 100;
        const error = crowdProb - realProb;
        const r = (realProb * 100).toFixed(0).padStart(3);
        const e = (error * 100).toFixed(0);
        const sign = Number(e) > 0 ? '+' : '';
        row.push(`${r}%(${sign}${e}) n=${totalMkts}`.padStart(14));
      }
      console.log(`${(crowd + '¢').padEnd(14)}${row.join('')}`);
    }
  }

  // Печатаем для 5-мин, 15-мин и всех
  if (durationCounts['5min'] > 0) printCrowdTauMatrix('5min', '5-MINUTE MARKETS');
  if (durationCounts['15min'] > 0) printCrowdTauMatrix('15min', '15-MINUTE MARKETS');
  printCrowdTauMatrix('all', 'ALL MARKETS');

  // ── 5. Дискордантные моменты ───────────────────────────────────────────
  // Когда стакан > 55¢ (crowd thinks UP) но BTC < strike (delta < 0)

  console.log();
  console.log('='.repeat(80));
  console.log('DISCORDANT MOMENTS: crowd says UP (mid>55¢) but BTC < strike (delta<0)');
  console.log('='.repeat(80));

  let discordUpCount = 0;
  let discordDownCount = 0;
  let discordTotal = 0;
  const discordByTau = new Map<number, { up: number; down: number }>();

  for (const [key, b] of buckets) {
    const [d, t] = key.split(':').map(Number);
    const crowdProb = b.crowdProbSum / b.observations;

    // Дискордантный: crowd > 55% но дельта < 0 (BTC ниже strike)
    if (crowdProb > 0.55 && d < 0) {
      for (const [, res] of b.marketResolutions) {
        discordTotal++;
        if (res === 'UP') discordUpCount++;
        else discordDownCount++;

        let byTau = discordByTau.get(t);
        if (!byTau) { byTau = { up: 0, down: 0 }; discordByTau.set(t, byTau); }
        if (res === 'UP') byTau.up++; else byTau.down++;
      }
    }
  }

  if (discordTotal > 0) {
    console.log(`Total discordant: ${discordTotal} (UP: ${discordUpCount}, DOWN: ${discordDownCount})`);
    console.log(`Crowd was RIGHT (actually UP): ${(discordUpCount / discordTotal * 100).toFixed(1)}%`);
    console.log(`Crowd was WRONG (actually DOWN): ${(discordDownCount / discordTotal * 100).toFixed(1)}%`);
    console.log();
    console.log('By tau:');
    for (const [tau, data] of [...discordByTau].sort(([a], [b]) => a - b)) {
      const total = data.up + data.down;
      if (total < 2) continue;
      console.log(`  ${tau}-${tau + config.tauStep}s: crowd right ${(data.up / total * 100).toFixed(0)}%, wrong ${(data.down / total * 100).toFixed(0)}% (n=${total})`);
    }
  } else {
    console.log('No discordant moments found');
  }

  // ── 5. Обратный дискорданс: crowd < 45¢ (DOWN) но BTC > strike ────────

  console.log();
  console.log('='.repeat(80));
  console.log('REVERSE DISCORDANT: crowd says DOWN (mid<45¢) but BTC > strike (delta>0)');
  console.log('='.repeat(80));

  let revDiscordUpCount = 0;
  let revDiscordDownCount = 0;
  let revDiscordTotal = 0;

  for (const [key, b] of buckets) {
    const [d] = key.split(':').map(Number);
    const crowdProb = b.crowdProbSum / b.observations;

    if (crowdProb < 0.45 && d > 0) {
      for (const [, res] of b.marketResolutions) {
        revDiscordTotal++;
        if (res === 'UP') revDiscordUpCount++;
        else revDiscordDownCount++;
      }
    }
  }

  if (revDiscordTotal > 0) {
    console.log(`Total reverse discordant: ${revDiscordTotal} (UP: ${revDiscordUpCount}, DOWN: ${revDiscordDownCount})`);
    console.log(`Crowd was RIGHT (actually DOWN): ${(revDiscordDownCount / revDiscordTotal * 100).toFixed(1)}%`);
    console.log(`Crowd was WRONG (actually UP): ${(revDiscordUpCount / revDiscordTotal * 100).toFixed(1)}%`);
  } else {
    console.log('No reverse discordant moments found');
  }

  // ── JSON output ────────────────────────────────────────────────────────

  if (config.outFile) {
    writeFileSync(config.outFile, JSON.stringify({
      config: { deltaStep: config.deltaStep, tauStep: config.tauStep },
      summary: { markets: processed, totalObservations, skipped },
      buckets: results,
      discordant: {
        crowdSaysUpButBtcBelow: { total: discordTotal, upCount: discordUpCount, downCount: discordDownCount },
        crowdSaysDownButBtcAbove: { total: revDiscordTotal, upCount: revDiscordUpCount, downCount: revDiscordDownCount },
      },
    }, null, 2));
    console.error(`\nJSON output: ${config.outFile}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
