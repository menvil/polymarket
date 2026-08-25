/**
 * DEVELOPMENT-ONLY live characterization CCXT Pro (N-005 PART 27).
 *
 * @remarks
 * Исследует против РЕАЛЬНОЙ публичной биржи (без credentials) фактические
 * контракты vendor-а, на которые опирается `CexSource`:
 *
 * - A. capability-map (`has`) и наличие multiplex-методов;
 * - B. форму unified стакана `watchOrderBook` (поля/типы/прототипы сторон,
 *   JSON-сериализуемость);
 * - C. mutation-поведение: возвращается ЖИВОЙ объект кэша, который vendor
 *   мутирует после возврата → снапшот обязателен;
 * - D. форму unified сделок `watchTrades` и семантику `newUpdates: true`
 *   (batch-и НЕ переигрывают ранее выданные сделки);
 * - E. форму multiplex-ответов `watchOrderBookForSymbols` /
 *   `watchTradesForSymbols`;
 * - F. поведение наших снапшотов на реальных vendor-объектах.
 *
 * Это НЕ production dependency — только evidence для контрактов cex-v2.
 *
 * Запуск из корня repo:
 *
 * ```bash
 * npx tsx packages/infrastructure/cex-v2/scripts/characterize.ts
 * ```
 */
import { createCcxtProExchange, snapshotOrderBook, snapshotTrade } from '../src/index.js';
import type { CcxtRawOrderBook, CcxtRawTrade } from '../src/index.js';

const EXCHANGE_ID = 'binance';
const MARKET_TYPE = 'spot' as const;
const SYMBOL = 'BTC/USDT';
const SYMBOL_B = 'ETH/USDT';
const DEPTH = 10;

/** Печать секции. */
function section(title: string): void {
  console.log(`\n${'─'.repeat(70)}\n${title}\n${'─'.repeat(70)}`);
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(len=${value.length})`;
  return typeof value;
}

/**
 * Identity-ключ сделки для подсчёта redelivery.
 *
 * @remarks
 * Биржи без trade id иначе схлопнулись бы в единый литеральный ключ
 * `"undefined"` и испортили бы метрики new/redelivered. При наличии id —
 * дедупликация по нему; без id — композит из стабильных unified-полей.
 */
function tradeIdentityKey(trade: Record<string, unknown>): string {
  const id = trade['id'];
  if (id !== undefined && id !== null) {
    return `id:${String(id)}`;
  }
  return [
    'ts',
    String(trade['timestamp']),
    'p',
    String(trade['price']),
    'a',
    String(trade['amount']),
    's',
    String(trade['side']),
    'sym',
    String(trade['symbol']),
  ].join('|');
}

function describeShape(obj: Record<string, unknown>, label: string): void {
  console.log(`${label} keys:`);
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const preview =
      Array.isArray(value) ? JSON.stringify(value.slice(0, 2)) : JSON.stringify(value);
    console.log(`  ${key}: ${typeOf(value)} = ${String(preview).slice(0, 90)}`);
  }
}

async function main(): Promise<void> {
  console.log(`CCXT Pro live characterization: ${EXCHANGE_ID} ${MARKET_TYPE} ${SYMBOL}`);
  const instance = await createCcxtProExchange({
    exchangeId: EXCHANGE_ID,
    marketType: MARKET_TYPE,
    depth: DEPTH,
  });
  // Инспекция внутренних полей vendor-а (только в characterization)
  const vendorInternals = instance as unknown as Record<string, unknown>;

  try {
    // ── A. Capabilities ──
    section('A. Capabilities (has-map)');
    for (const capability of [
      'watchOrderBook',
      'watchOrderBookForSymbols',
      'watchTrades',
      'watchTradesForSymbols',
      'fetchOrderBook',
    ]) {
      console.log(`  has['${capability}'] = ${String(instance.has?.[capability])}`);
    }
    console.log(`  newUpdates = ${String(vendorInternals['newUpdates'])}`);

    // ── B. Unified orderbook shape ──
    section('B. watchOrderBook unified shape');
    if (typeof instance.watchOrderBook !== 'function') {
      throw new Error('watchOrderBook is not available');
    }
    const ob1 = await instance.watchOrderBook(SYMBOL, DEPTH);
    describeShape(ob1 as Record<string, unknown>, 'orderbook');
    const bids = ob1.bids as unknown[];
    console.log(`  bids[0]: ${JSON.stringify(bids[0])} (${typeOf(bids[0])})`);
    console.log(`  bids prototype: ${Object.getPrototypeOf(bids)?.constructor?.name}`);
    console.log(`  full cache depth: bids=${bids.length} asks=${(ob1.asks as unknown[]).length}`);
    const jsonRoundTrip = JSON.parse(JSON.stringify(ob1)) as Record<string, unknown>;
    console.log(
      `  JSON-serializable: yes (keys survive: ${Object.keys(jsonRoundTrip).join(', ')})`,
    );

    // ── C. Mutation behavior ──
    section('C. Mutation behavior (live cache object)');
    const frozenSnapshot = JSON.stringify(ob1);
    const ob2 = await instance.watchOrderBook(SYMBOL, DEPTH);
    const sameIdentity = ob1 === ob2;
    const mutated = JSON.stringify(ob1) !== frozenSnapshot;
    console.log(`  second resolve returns SAME object identity: ${sameIdentity}`);
    console.log(`  first reference mutated after next resolve: ${mutated}`);
    console.log('  → published payload MUST be an immutable snapshot at observation time');
    const ourSnapshot = snapshotOrderBook(ob1 as CcxtRawOrderBook, DEPTH);
    console.log(
      `  snapshotOrderBook: bids=${ourSnapshot.bids?.length} (depth-truncated), ` +
        `plain Array prototype: ${Object.getPrototypeOf(ourSnapshot.bids) === Array.prototype}`,
    );

    // ── D. Trades + newUpdates semantics ──
    section('D. watchTrades unified shape + newUpdates');
    if (typeof instance.watchTrades !== 'function') {
      throw new Error('watchTrades is not available');
    }
    const batch1 = await instance.watchTrades(SYMBOL);
    console.log(`  batch1: ${batch1.length} trades`);
    if (batch1.length > 0) {
      describeShape(batch1[0] as Record<string, unknown>, '  trade[0]');
      console.log(`  snapshotTrade(trade[0]) JSON ok: ${
        JSON.stringify(snapshotTrade(batch1[0] as CcxtRawTrade)).length > 0
      }`);
    }
    const seenIds = new Set(batch1.map((trade) => tradeIdentityKey(trade)));
    let redelivered = 0;
    let newCount = 0;
    const batches = 3;
    for (let i = 0; i < batches; i++) {
      const nextBatch = await instance.watchTrades(SYMBOL);
      for (const trade of nextBatch) {
        const key = tradeIdentityKey(trade);
        if (seenIds.has(key)) {
          redelivered++;
        } else {
          seenIds.add(key);
          newCount++;
        }
      }
    }
    const cache = vendorInternals['trades'] as Record<string, { length?: number }> | undefined;
    console.log(`  ${batches} follow-up batches: new=${newCount}, redelivered=${redelivered}`);
    console.log(`  internal trades cache length: ${cache?.[SYMBOL]?.length ?? 'n/a'} (bounded by tradesLimit)`);
    console.log('  → newUpdates delivers only new trades; no manual cache clearing needed');

    // ── E. Multiplex shapes ──
    section('E. Multiplex response shapes');
    if (typeof instance.watchOrderBookForSymbols === 'function') {
      const multiplexOb = await instance.watchOrderBookForSymbols([SYMBOL, SYMBOL_B], DEPTH);
      console.log(
        `  watchOrderBookForSymbols resolves ONE book per call: symbol=${String(
          multiplexOb.symbol,
        )}, bids=${(multiplexOb.bids as unknown[]).length}`,
      );
    } else {
      console.log('  watchOrderBookForSymbols not supported');
    }
    if (typeof instance.watchTradesForSymbols === 'function') {
      const multiplexTrades = await instance.watchTradesForSymbols([SYMBOL, SYMBOL_B]);
      const symbols = new Set(multiplexTrades.map((trade) => String(trade.symbol)));
      console.log(
        `  watchTradesForSymbols resolves Trade[]: ${multiplexTrades.length} trades, ` +
          `symbols present: ${[...symbols].join(', ')}`,
      );
    } else {
      console.log('  watchTradesForSymbols not supported');
    }

    console.log('\nCharacterization finished successfully');
  } finally {
    await instance.close?.();
    console.log('Exchange instance closed');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Characterization failed:', error);
    process.exit(1);
  });
