import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';

const ROOT = process.argv[2] ?? 'apps/collect-data/snapshots';
const MAX_STALE_MS = Number(process.env.MAX_STALE_MS ?? 1500);
const MIN_EDGE = Number(process.env.MIN_EDGE ?? 0.000001);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/Bitcoin_Up_or_Down.*\.jsonl(\.gz)?$/.test(entry.name)) out.push(p);
  }
  return out;
}

function streamFile(file) {
  const rs = fs.createReadStream(file);
  return file.endsWith('.gz') ? rs.pipe(zlib.createGunzip()) : rs;
}

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function bestAsk(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return undefined;
  let price;
  let size;
  for (const level of levels) {
    const p = num(level.price);
    const s = num(level.size);
    if (p === undefined || s === undefined || s <= 0) continue;
    if (price === undefined || p < price) {
      price = p;
      size = s;
    }
  }
  return price === undefined ? undefined : { price, size };
}

async function parseMarket(file) {
  const rl = readline.createInterface({ input: streamFile(file), crlfDelay: Infinity });
  let meta;
  const states = [];
  const current = new Map();
  let finalFromResolution;

  for await (const line of rl) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.t === 'meta') {
      const m = e.m ?? {};
      const event = Array.isArray(m.events) ? m.events[0] : undefined;
      const series = Array.isArray(event?.series) ? event.series[0] : undefined;
      const md = event?.eventMetadata ?? {};
      meta = {
        file,
        question: e.question ?? m.question,
        conditionId: m.conditionId ?? e.marketId,
        tokenIds: e.tokenIds ?? JSON.parse(m.clobTokenIds ?? '[]'),
        slug: m.slug ?? event?.slug,
        recurrence: series?.recurrence,
        endDate: m.endDate ?? event?.endDate,
        startTime: event?.startTime ?? m.eventStartTime,
        priceToBeat: num(md.priceToBeat),
        finalPrice: num(md.finalPrice),
      };
    } else if (e.t === 'market_resolved') {
      finalFromResolution = num(e.resolutionPrice);
    } else if (e.event_type === 'book' && meta?.tokenIds?.length >= 2) {
      const ask = bestAsk(e.asks);
      if (!ask) continue;
      const idx = meta.tokenIds.indexOf(String(e.asset_id));
      if (idx !== 0 && idx !== 1) continue;
      current.set(idx, { ask: ask.price, size: ask.size, ts: Number(e.timestamp ?? e.ts) });
      if (current.has(0) && current.has(1)) {
        const up = current.get(0);
        const down = current.get(1);
        states.push({
          ts: Math.max(up.ts, down.ts),
          upAsk: up.ask,
          downAsk: down.ask,
          upAskSize: up.size,
          downAskSize: down.size,
        });
      }
    }
  }

  if (!meta) return undefined;
  if (finalFromResolution !== undefined) meta.finalPrice = finalFromResolution;
  if (!meta.recurrence && meta.slug) {
    const m = meta.slug.match(/updown-(5m|15m)-/);
    if (m) meta.recurrence = m[1];
  }
  if (!meta.priceToBeat || !meta.endDate || !['5m', '15m'].includes(meta.recurrence)) return undefined;
  meta.states = states;
  return meta;
}

function pairOps(a, b) {
  const easy = a.priceToBeat <= b.priceToBeat ? a : b;
  const hard = easy === a ? b : a;
  const ops = [];
  const overlapStart = Math.max(Date.parse(a.startTime), Date.parse(b.startTime));
  const overlapEnd = Math.min(Date.parse(a.endDate), Date.parse(b.endDate));
  let i = 0;
  let j = 0;
  let sa;
  let sb;
  while (i < a.states.length || j < b.states.length) {
    const na = a.states[i];
    const nb = b.states[j];
    if (nb === undefined || (na !== undefined && na.ts <= nb.ts)) {
      sa = na;
      i += 1;
    } else {
      sb = nb;
      j += 1;
    }
    if (!sa || !sb) continue;
    const ts = Math.max(sa.ts, sb.ts);
    if (Number.isFinite(overlapStart) && ts < overlapStart) continue;
    if (Number.isFinite(overlapEnd) && ts > overlapEnd) continue;
    if (Math.abs(sa.ts - sb.ts) > MAX_STALE_MS) continue;
    const es = easy === a ? sa : sb;
    const hs = hard === a ? sa : sb;
    const cost = es.upAsk + hs.downAsk;
    const edge = 1 - cost;
    if (edge > MIN_EDGE) {
      ops.push({
        ts,
        cost,
        edge,
        maxSharesTop: Math.min(es.upAskSize, hs.downAskSize),
        easy,
        hard,
      });
    }
  }
  return ops;
}

function summarizeOps(ops) {
  if (ops.length === 0) return undefined;
  let best = ops[0];
  let first = ops[0].ts;
  let last = ops[0].ts;
  let maxTopProfit = 0;
  for (const op of ops) {
    if (op.edge > best.edge) best = op;
    if (op.ts < first) first = op.ts;
    if (op.ts > last) last = op.ts;
    maxTopProfit = Math.max(maxTopProfit, op.edge * op.maxSharesTop);
  }
  return { count: ops.length, first, last, best, durationSec: (last - first) / 1000, maxTopProfit };
}

const files = walk(ROOT);
const markets = [];
const skipped = [];
for (const file of files) {
  try {
    const market = await parseMarket(file);
    if (market && market.states.length > 0) markets.push(market);
  } catch (error) {
    skipped.push({ file, error: error?.code ?? error?.message ?? String(error) });
  }
}

const groups = new Map();
for (const m of markets) {
  const k = m.endDate;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(m);
}

const pairSummaries = [];
const gapThresholds = [1, 3, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const gapBuckets = new Map(
  gapThresholds.map((threshold) => [
    threshold,
    { pairs: 0, arbPairs: 0, finalBetween: 0, arbAndFinalBetween: 0 },
  ]),
);
let pairs = 0;
let sameFinal = 0;
let sameFinalWithStrikeGap = 0;
let finalBetween = 0;
const strikeGaps = [];

for (const [endDate, ms] of groups) {
  const m5 = ms.filter((m) => m.recurrence === '5m');
  const m15 = ms.filter((m) => m.recurrence === '15m');
  for (const a of m5) {
    for (const b of m15) {
      pairs += 1;
      const finalPrice = a.finalPrice ?? b.finalPrice;
      const strikeGap = Math.abs(a.priceToBeat - b.priceToBeat);
      strikeGaps.push(strikeGap);
      if (a.finalPrice !== undefined && b.finalPrice !== undefined && Math.abs(a.finalPrice - b.finalPrice) < 1e-9) sameFinal += 1;
      if (finalPrice !== undefined && finalPrice >= Math.min(a.priceToBeat, b.priceToBeat) && finalPrice < Math.max(a.priceToBeat, b.priceToBeat)) finalBetween += 1;
      if ((a.finalPrice ?? b.finalPrice) !== undefined && strikeGap > 0) sameFinalWithStrikeGap += 1;
      const ops = pairOps(a, b);
      const summary = summarizeOps(ops);
      const isFinalBetween = finalPrice !== undefined && finalPrice >= Math.min(a.priceToBeat, b.priceToBeat) && finalPrice < Math.max(a.priceToBeat, b.priceToBeat);
      for (const threshold of gapThresholds) {
        if (strikeGap <= threshold) {
          const bucket = gapBuckets.get(threshold);
          bucket.pairs += 1;
          if (summary) bucket.arbPairs += 1;
          if (isFinalBetween) bucket.finalBetween += 1;
          if (summary && isFinalBetween) bucket.arbAndFinalBetween += 1;
        }
      }
      if (summary) pairSummaries.push({ endDate, a, b, strikeGap, finalPrice, ...summary });
    }
  }
}

pairSummaries.sort((x, y) => y.best.edge - x.best.edge || y.count - x.count);
strikeGaps.sort((a, b) => a - b);

const pct = (p) => strikeGaps.length ? strikeGaps[Math.floor((strikeGaps.length - 1) * p)] : undefined;
const byDay = new Map();
for (const s of pairSummaries) {
  const day = s.endDate.slice(0, 10);
  const v = byDay.get(day) ?? { oppPairs: 0, ops: 0, best: 0 };
  v.oppPairs += 1;
  v.ops += s.count;
  v.best = Math.max(v.best, s.best.edge);
  byDay.set(day, v);
}

const bestEdges = pairSummaries.map((s) => s.best.edge).sort((a, b) => a - b);
const bestCosts = pairSummaries.map((s) => s.best.cost).sort((a, b) => a - b);
const durations = pairSummaries.map((s) => s.durationSec).sort((a, b) => a - b);
const edgePct = (p) => bestEdges.length ? bestEdges[Math.floor((bestEdges.length - 1) * p)] : undefined;
const costPct = (p) => bestCosts.length ? bestCosts[Math.floor((bestCosts.length - 1) * p)] : undefined;
const durationPct = (p) => durations.length ? durations[Math.floor((durations.length - 1) * p)] : undefined;
const edgeThresholds = [0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.15, 0.2];
const edgeBuckets = Object.fromEntries(
  edgeThresholds.map((threshold) => [
    String(threshold),
    pairSummaries.filter((s) => s.best.edge >= threshold).length,
  ]),
);

console.log(JSON.stringify({
  root: ROOT,
  maxStaleMs: MAX_STALE_MS,
  files: files.length,
  skippedFiles: skipped.length,
  skippedExamples: skipped.slice(0, 5),
  markets: markets.length,
  pairs,
  pairsWithAnyGuaranteedArb: pairSummaries.length,
  sameFinalPairsExplicitBoth: sameFinal,
  pairsWithKnownFinalAndStrikeGap: sameFinalWithStrikeGap,
  finalBetweenStrikesPairs: finalBetween,
  strikeGap: {
    min: strikeGaps[0],
    p25: pct(0.25),
    p50: pct(0.5),
    p75: pct(0.75),
    p90: pct(0.9),
    max: strikeGaps.at(-1),
  },
  gapBuckets: Object.fromEntries([...gapBuckets.entries()].map(([threshold, value]) => [String(threshold), value])),
  edgeStats: {
    min: bestEdges[0],
    p25: edgePct(0.25),
    p50: edgePct(0.5),
    p75: edgePct(0.75),
    p90: edgePct(0.9),
    max: bestEdges.at(-1),
    costMin: bestCosts[0],
    costP50: costPct(0.5),
    costMax: bestCosts.at(-1),
    durationSecP50: durationPct(0.5),
    durationSecP75: durationPct(0.75),
    durationSecP90: durationPct(0.9),
    edgeAtLeast: edgeBuckets,
  },
  byDay: Object.fromEntries([...byDay.entries()].sort()),
  top: pairSummaries.slice(0, 20).map((s) => ({
    endDate: s.endDate,
    endMinuteUtc: new Date(s.best.ts).toISOString(),
    pair: `${s.a.recurrence}<->${s.b.recurrence}`,
    strike5m: s.a.recurrence === '5m' ? s.a.priceToBeat : s.b.priceToBeat,
    strike15m: s.a.recurrence === '15m' ? s.a.priceToBeat : s.b.priceToBeat,
    strikeGap: s.strikeGap,
    finalPrice: s.finalPrice,
    finalBetweenStrikes: s.finalPrice !== undefined && s.finalPrice >= Math.min(s.a.priceToBeat, s.b.priceToBeat) && s.finalPrice < Math.max(s.a.priceToBeat, s.b.priceToBeat),
    easyRecurrence: s.best.easy.recurrence,
    hardRecurrence: s.best.hard.recurrence,
    bestCost: s.best.cost,
    bestEdge: s.best.edge,
    bestTopLiquidityShares: s.best.maxSharesTop,
    maxTopProfit: s.maxTopProfit,
    snapshots: s.count,
    durationSec: s.durationSec,
    easyQuestion: s.best.easy.question,
    hardQuestion: s.best.hard.question,
  })),
}, null, 2));
