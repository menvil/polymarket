/**
 * CHECKPOINT #2 — полная верификация семантической границы.
 *
 * Доказывает, что контур `raw → semantic` завершён и пригоден к
 * эксплуатации ОДНОВРЕМЕННО для Polymarket и CEX:
 *
 * ```text
 *                    Sources
 *                       ↓
 *              createDataCollector(...)
 *                       ↓
 *                ExternalMessageBus            ← ОДНА общая шина
 *             ↙          ↓          ↘
 *        Recorder    PM Semantic   CEX Semantic
 *           ↓            ↓             ↓
 *         JSONL      canonical      canonical
 *                     events          events
 *                        \             /
 *                         \           /
 *                     ApplicationEventBus      ← ОДНА общая шина событий
 * ```
 *
 * Ключевое свидетельство раздела 7: оба адаптера публикуют в ОДИН
 * `EventBus`. Если бы `Orderbook<AssetPrice>` не проходил через ту же
 * каноническую инфраструктуру, что и `Orderbook<OutcomePrice>`, этот
 * скрипт не скомпилировался бы — без `as unknown`, DTO и второго типа
 * стакана.
 *
 * Запуск:
 * ```bash
 * npx tsx scripts/checkpoint-2-semantic-boundary.mts
 * CHECKPOINT_MINUTES=15 npx tsx scripts/checkpoint-2-semantic-boundary.mts
 * ```
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import type { ILogger } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { LiveHighResolutionClock, MessageMetadataGenerator } from '@polymarket/messages';
import type { MessageMetadata } from '@polymarket/messages';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { EventBus } from '@polymarket/event-bus';
import type { EventBusEvent } from '@polymarket/event-bus';
import { PolymarketSemanticAdapter } from '@polymarket/polymarket-semantic-adapter';
import { CexSemanticAdapter } from '@polymarket/cex-semantic-adapter';
import { createDataCollector } from '@polymarket/collect-data/runtime';
import type { ContourMessage } from '@polymarket/collect-data/runtime';
import type { DataCollectorConfig } from '@polymarket/collect-data/runtime';

/** Биржи, участвующие в прогоне. */
const EXCHANGES = ['binance', 'okx', 'bybit', 'coinbase'] as const;

/** Одновременно наблюдаемых рынков Polymarket. */
const MAX_MARKETS = 4;

/** Длительность живого прогона. */
const RUN_MINUTES = Number(process.env.CHECKPOINT_MINUTES ?? '12');

/** Сколько образцов паритета хранить на каждый вид. */
const PARITY_SAMPLES = 6;

/**
 * Конфигурация коллектора: та же фабрика, что у production.
 *
 * @param runDir - Каталог прогона
 * @returns Конфигурация с Polymarket-открытием и CEX-источниками
 */
function checkpointConfig(runDir: string): DataCollectorConfig {
  return {
    outputDir: runDir,
    polymarket: {
      sourceSubDir: 'polymarket',
      bufferSize: 200,
      flushIntervalMs: 5_000,
      compression: 'gzip',
    },
    discovery: {
      filter: {
        minTimeToExpiryHours: 0,
        minSpread: 0,
        minLiquidity: 0,
        maxMarketsToReturn: MAX_MARKETS * 3,
        requiredKeywords: ['up or down'],
        anyOfKeywords: ['bitcoin', 'ethereum'],
        excludedKeywords: [],
      },
    },
    collection: {
      maxMarkets: MAX_MARKETS,
      minTimeToStartMs: 30_000,
      discoveryRefreshMs: 30_000,
      runtimeTickMs: 5_000,
    },
    finalization: { enrichmentRetryMs: 30_000, enrichmentMaxWaitMs: 5 * 60_000 },
    cex: {
      sources: EXCHANGES.map((exchangeId) => ({
        exchangeId,
        marketType: 'spot' as const,
        symbols: ['BTC/USDT', 'ETH/USDT'],
        watchOrderbook: true,
        watchTrades: true,
        orderbookDepth: exchangeId === 'bybit' ? 50 : 10,
        restartIntervalMs: 900_000,
        orderbookMethod: 'watch' as const,
      })),
      bufferSize: 200,
      flushIntervalMs: 2_000,
      compression: 'gzip',
    },
  };
}

// ── Свидетельства ────────────────────────────────────────────────────────

/** Сверка «сырое наблюдение против canonical представления». */
interface Parity {
  readonly scope: string;
  readonly instrument: string;
  readonly rawBid: string;
  readonly rawAsk: string;
  readonly canonicalBid: string;
  readonly canonicalAsk: string;
  readonly match: boolean;
}

/** Сверка одной сделки. */
interface TradeParity {
  readonly scope: string;
  readonly instrument: string;
  readonly rawId: string;
  readonly canonicalId: string;
  readonly rawPrice: string;
  readonly canonicalPrice: string;
  readonly rawSize: string;
  readonly canonicalSize: string;
  readonly match: boolean;
}

/** Последовательность BOOK_UPDATED одного инструмента. */
interface SequenceTrack {
  readonly seen: number[];
  depthOnlyEvents: number;
}

/** Свидетельства по одной бирже. */
interface VenueEvidence {
  depth: number;
  updated: number;
  trades: number;
  readonly instruments: Set<string>;
}

/** Наблюдение референсной цены одного фида. */
interface FeedEvidence {
  count: number;
  sample: string;
  baseAsset: string;
  quoteAsset: string;
  window: string;
}

/** Итог проверки причинности метаданных. */
interface CausalityEvidence {
  checked: number;
  linked: number;
  orphans: number;
  roots: number;
}

/**
 * Возвращает или создаёт запись в карте.
 *
 * @param map - Карта свидетельств
 * @param key - Ключ
 * @param make - Фабрика пустой записи
 * @returns Существующая либо новая запись
 */
function ensure<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = make();
  map.set(key, created);
  return created;
}

/**
 * Приводит цену/размер к строке независимо от домена значения.
 *
 * @param value - Значение канонического уровня либо сырое
 * @returns Строковое представление без потери точности
 */
function asText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const holder = value as { value?: () => { toString: () => string } };
  if (typeof holder.value === 'function') return holder.value().toString();
  return String(value);
}

/**
 * Прогоняет живой чекпоинт и печатает отчёт.
 *
 * @returns Промис, разрешающийся по завершении прогона
 * @throws Никогда — все отказы попадают в отчёт как нарушения
 */
async function main(): Promise<void> {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint2-'));
  const clock = new LiveClock();
  const logger: ILogger = new ConsoleLogger(clock, LogLevel.WARN);
  const violations: string[] = [];

  // ── ОДНА общая raw-шина ───────────────────────────────────────────────
  const bus = new ExternalMessageBus<ContourMessage>();
  const { collector } = createDataCollector({
    config: checkpointConfig(runDir),
    logger,
    clock,
    bus,
  });

  // ── Раздел 13: снимок raw ДО семантики ────────────────────────────────
  // Порядок подписки = порядок доставки, поэтому снимок ставится ПЕРВЫМ,
  // до конструирования адаптеров, а сверка — ПОСЛЕДНЕЙ, после них.
  // Расхождение означало бы, что адаптер мутировал общее сообщение.
  const payloadSnapshots = new Map<string, string>();
  const rawMessageIds = new Set<string>();
  const RAW_TYPES = [
    'POLYMARKET_MARKET',
    'POLYMARKET_CRYPTO_BINANCE',
    'POLYMARKET_CRYPTO_CHAINLINK',
    'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
    'CEX_ORDERBOOK',
    'CEX_TRADE',
  ] as const;
  let rawSeenTotal = 0;
  let immutabilityChecked = 0;
  let immutabilityViolations = 0;

  for (const type of RAW_TYPES) {
    bus.subscribe(type, (message: ContourMessage) => {
      rawSeenTotal += 1;
      const id = String(message.metadata.messageId);
      rawMessageIds.add(id);
      if (payloadSnapshots.size < 5000) {
        payloadSnapshots.set(id, JSON.stringify(message.payload));
      }
    });
  }

  // ── Сырые значения для паритета (разделы 9, 10) ───────────────────────
  // Пишутся ДО адаптеров, поэтому к моменту canonical-события карта уже
  // содержит значение ИЗ ТОГО ЖЕ сообщения.
  const rawTop = new Map<string, { bid: string; ask: string }>();
  const rawTrades = new Map<string, Record<string, unknown>>();
  // Сколько сырых сделок перезаписано ДО сверки. Показывает плотность
  // сопоставления: пара «последнее сырое ↔ текущее semantic» честна
  // ровно настолько, насколько редко наблюдение вытесняется неиспользованным.
  const rawTradeConsumed = new Set<string>();
  let rawTradesSuperseded = 0;

  bus.subscribe('CEX_ORDERBOOK', (message) => {
    const payload = message.payload as {
      exchangeId: string;
      marketType: string;
      symbol: string;
      orderBook: { bids?: readonly (readonly unknown[])[]; asks?: readonly (readonly unknown[])[] };
    };
    const bestBid = payload.orderBook.bids?.[0]?.[0];
    const bestAsk = payload.orderBook.asks?.[0]?.[0];
    if (bestBid === undefined || bestAsk === undefined) return;
    // Сырое печатается СВОИМ представлением (JS-число как отдал CCXT):
    // сверка идёт против источника, а не против нашей же строки
    rawTop.set(`${payload.exchangeId}|${payload.marketType}:${payload.symbol}`, {
      bid: String(bestBid),
      ask: String(bestAsk),
    });
  });

  bus.subscribe('CEX_TRADE', (message) => {
    const payload = message.payload as {
      exchangeId: string;
      marketType: string;
      symbol: string;
      trade: Record<string, unknown>;
    };
    // Ключ ОБЯЗАН включать инструмент: BTC/USDT и ETH/USDT идут
    // одновременно, и ключ по одной бирже сопоставил бы semantic-сделку
    // с последней сырой сделкой ДРУГОГО инструмента
    const key = `${payload.exchangeId.toUpperCase()}|${payload.marketType}:${payload.symbol}`;
    if (rawTrades.has(key) && !rawTradeConsumed.has(key)) rawTradesSuperseded += 1;
    rawTradeConsumed.delete(key);
    rawTrades.set(key, payload.trade);
  });

  bus.subscribe('POLYMARKET_MARKET', (message) => {
    // Живая форма — SDK-событие {topic, type, payload}: дискриминатор в
    // `type`, рыночные поля во ВЛОЖЕННОМ payload. Тот же контракт читает
    // и сам адаптер (`_onMarketEvent`).
    const envelope = message.payload as {
      type?: unknown;
      payload?: {
        tokenId?: unknown;
        bids?: readonly { price?: unknown }[];
        asks?: readonly { price?: unknown }[];
        priceChanges?: readonly {
          tokenId?: unknown;
          bestBid?: unknown;
          bestAsk?: unknown;
        }[];
      };
    };
    const kind = String(envelope.type ?? '');
    const inner = envelope.payload;
    if (inner === undefined) return;
    const token = String(inner.tokenId ?? '');

    if (kind === 'book') {
      if (token === '') return;
      // Лучшее берётся как max(bid)/min(ask), а не по позиции в массиве:
      // порядок уровней — деталь вендора, определение лучшей цены — нет
      const bidPrices = (inner.bids ?? []).map((l) => Number(l.price)).filter((n) => !Number.isNaN(n));
      const askPrices = (inner.asks ?? []).map((l) => Number(l.price)).filter((n) => !Number.isNaN(n));
      if (bidPrices.length === 0 || askPrices.length === 0) return;
      rawTop.set(`POLYMARKET|${token}`, {
        bid: String(Math.max(...bidPrices)),
        ask: String(Math.min(...askPrices)),
      });
      return;
    }
    if (kind === 'price_change') {
      // Верхушку объявляет КАЖДАЯ запись priceChanges — тем же полем,
      // которое читает сам адаптер для обнаружения рассинхронизации.
      // На верхнем уровне payload-а её нет, и брать оттуда нечего.
      for (const change of inner.priceChanges ?? []) {
        const changedToken = String(change.tokenId ?? '');
        if (changedToken === '' || change.bestBid == null || change.bestAsk == null) continue;
        rawTop.set(`POLYMARKET|${changedToken}`, {
          bid: String(change.bestBid),
          ask: String(change.bestAsk),
        });
      }
      return;
    }
    if (kind === 'last_trade_price' && token !== '') {
      const key = `POLYMARKET|${token}`;
      if (rawTrades.has(key) && !rawTradeConsumed.has(key)) rawTradesSuperseded += 1;
      rawTradeConsumed.delete(key);
      rawTrades.set(key, inner as Record<string, unknown>);
    }
  });

  // ── ОДНА общая шина Application-событий для ОБОИХ адаптеров ───────────
  // Это и есть доказательство раздела 7: Orderbook<OutcomePrice> и
  // Orderbook<AssetPrice> проходят через одну каноническую инфраструктуру.
  // Второго типа стакана, DTO и `as unknown` здесь нет.
  const eventBus = new EventBus(logger);
  const metadataGenerator = new MessageMetadataGenerator({
    clock,
    highResolutionClock: new LiveHighResolutionClock(),
  });

  const pmAdapter = new PolymarketSemanticAdapter({ bus, eventBus, metadataGenerator, logger });
  const cexAdapter = new CexSemanticAdapter({ bus, eventBus, metadataGenerator, logger });

  // Подписка адаптеров происходит в start(), а не в конструкторе, — и
  // делается ЗДЕСЬ: после снимка raw и до сверки неизменяемости, чтобы
  // оба адаптера оказались между ними в порядке доставки
  pmAdapter.start();
  cexAdapter.start();

  // Сверка неизменяемости — ПОСЛЕ обоих адаптеров
  for (const type of RAW_TYPES) {
    bus.subscribe(type, (message: ContourMessage) => {
      const id = String(message.metadata.messageId);
      const before = payloadSnapshots.get(id);
      if (before === undefined) return;
      immutabilityChecked += 1;
      if (JSON.stringify(message.payload) !== before) {
        immutabilityViolations += 1;
        if (immutabilityViolations <= 3) {
          violations.push(`raw payload mutated by a semantic consumer: ${id}`);
        }
      }
    });
  }

  // ── Раздел 14: свидетельство независимости Recorder ───────────────────
  // Подписчик, который БРОСАЕТ. Если изоляция обработчиков сломана, это
  // повалит Recorder и остальных — и счётчики это покажут.
  let faultInjections = 0;
  bus.subscribe('CEX_TRADE', () => {
    faultInjections += 1;
    if (faultInjections % 50 === 0) {
      throw new Error('checkpoint: intentional handler failure (isolation probe)');
    }
  });

  // ── Наблюдатели Application-событий ───────────────────────────────────
  const pmEvidence = { depth: 0, updated: 0, trades: 0, tickSize: 0, reference: 0 };
  const pmInstruments = new Map<string, { depth: number; updated: number }>();
  const pmMarkets = new Set<string>();
  const cexVenues = new Map<string, VenueEvidence>();
  const sequences = new Map<string, SequenceTrack>();
  const feeds = new Map<string, FeedEvidence>();
  const causality: CausalityEvidence = { checked: 0, linked: 0, orphans: 0, roots: 0 };
  const bookParity: Parity[] = [];
  const tradeParity: TradeParity[] = [];
  const outcomePriceLeaks: string[] = [];
  let cexMarketIdFabrications = 0;
  let bookMismatches = 0;
  let tradeMismatches = 0;
  const bookCompared = new Map<string, number>();
  const tradeCompared = new Map<string, number>();
  let fabricatedTradeIds = 0;

  /** Проверяет, что метаданные события — потомок известного raw-сообщения. */
  const checkCausality = (metadata: MessageMetadata): void => {
    causality.checked += 1;
    const causation = metadata.causationId === undefined ? undefined : String(metadata.causationId);
    if (causation === undefined) {
      causality.roots += 1;
      violations.push('semantic event published without causationId (unrelated root metadata)');
      return;
    }
    if (rawMessageIds.has(causation)) {
      causality.linked += 1;
    } else {
      causality.orphans += 1;
    }
  };

  /** Регистрирует номер последовательности BOOK_UPDATED для инструмента. */
  const trackSequence = (key: string, sequenceNumber: number): void => {
    const track = ensure(sequences, key, () => ({ seen: [], depthOnlyEvents: 0 }));
    track.seen.push(sequenceNumber);
  };

  eventBus.subscribe('BOOK_DEPTH', (event: EventBusEvent) => {
    const payload = event.payload as {
      venueId: unknown;
      marketId?: unknown;
      instrumentId: unknown;
      snapshot: { getBestBid: () => unknown; getBestAsk: () => unknown; getBidDepth: () => number };
    };
    checkCausality(event.metadata);
    const venue = String(payload.venueId);
    const instrument = String(payload.instrumentId);

    if (venue === 'POLYMARKET') {
      pmEvidence.depth += 1;
      ensure(pmInstruments, instrument, () => ({ depth: 0, updated: 0 })).depth += 1;
      if (payload.marketId !== undefined) pmMarkets.add(String(payload.marketId));
      return;
    }

    const venueEvidence = ensure(cexVenues, venue, () => ({
      depth: 0,
      updated: 0,
      trades: 0,
      instruments: new Set<string>(),
    }));
    venueEvidence.depth += 1;
    venueEvidence.instruments.add(instrument);

    // Раздел 6: marketId у биржи НЕ выдумывается
    if (payload.marketId !== undefined) {
      cexMarketIdFabrications += 1;
      if (cexMarketIdFabrications <= 3) {
        violations.push(`CEX BOOK_DEPTH carries fabricated marketId: ${venue}/${instrument}`);
      }
    }

    // Раздел 23.5: OutcomePrice не имеет права протечь в цены биржи
    const best = payload.snapshot.getBestBid();
    if (best !== null && best !== undefined) {
      const name = (best as object).constructor.name;
      if (name === 'OutcomePrice' && outcomePriceLeaks.length < 3) {
        outcomePriceLeaks.push(`${venue}/${instrument} best bid is OutcomePrice`);
      }
    }
  });

  eventBus.subscribe('BOOK_UPDATED', (event: EventBusEvent) => {
    const payload = event.payload as {
      venueId: unknown;
      marketId?: unknown;
      instrumentId: unknown;
      sequenceNumber: number;
      topOfBook: { bestBid?: unknown; bestAsk?: unknown };
    };
    checkCausality(event.metadata);
    const venue = String(payload.venueId);
    const instrument = String(payload.instrumentId);
    trackSequence(`${venue}/${instrument}`, payload.sequenceNumber);

    if (venue === 'POLYMARKET') {
      pmEvidence.updated += 1;
      ensure(pmInstruments, instrument, () => ({ depth: 0, updated: 0 })).updated += 1;
    } else {
      const venueEvidence = ensure(cexVenues, venue, () => ({
        depth: 0,
        updated: 0,
        trades: 0,
        instruments: new Set<string>(),
      }));
      venueEvidence.updated += 1;
      venueEvidence.instruments.add(instrument);
    }

    // Раздел 9: сверка с сырым значением ИЗ ТОГО ЖЕ сообщения
    const rawKey = venue === 'POLYMARKET' ? `POLYMARKET|${instrument}` : `${venue.toLowerCase()}|${instrument}`;
    const raw = rawTop.get(rawKey);
    if (raw !== undefined) {
      const scope = venue === 'POLYMARKET' ? 'POLYMARKET' : 'CEX';
      bookCompared.set(scope, (bookCompared.get(scope) ?? 0) + 1);
      const canonicalBid = asText(payload.topOfBook.bestBid);
      const canonicalAsk = asText(payload.topOfBook.bestAsk);
      // У рынка предсказаний объявленная источником верхушка вне
      // [0.0001, 0.9999] НЕПРЕДСТАВИМА как OutcomePrice. Адаптер трактует
      // такой случай третьим состоянием `unusable` (`unverifiedBest`): он
      // НЕ считает это рассинхронизацией и не выдумывает цену — сторону
      // просто нельзя проверить. Сверка обязана вести себя так же, иначе
      // она объявляет дефектом ровно то, что домен считает нормой.
      const unverifiable = (value: string): boolean =>
        venue === 'POLYMARKET' && (Number(value) <= 0 || Number(value) >= 1);
      const sideSame = (rawValue: string, canonicalValue: string): boolean =>
        unverifiable(rawValue) ? true : Number(rawValue) === Number(canonicalValue);
      // Числовая сверка: сырое представление у CCXT — JS-число, у
      // Polymarket — строка; сравнение идёт по ЗНАЧЕНИЮ, не по написанию
      const same = sideSame(raw.bid, canonicalBid) && sideSame(raw.ask, canonicalAsk);
      if (!same) {
        bookMismatches += 1;
        if (bookMismatches <= 5) {
          violations.push(
            `book parity mismatch ${venue}/${instrument}: ` +
              `raw ${raw.bid}/${raw.ask} vs canonical ${canonicalBid}/${canonicalAsk}`,
          );
        }
      }
      // Квота НА ИСТОЧНИК: у CEX событий кратно больше, и общий лимит
      // заполнялся бы ими одними — образцов Polymarket не осталось бы
      const scopeSamples = bookParity.filter((x) => (x.scope === 'POLYMARKET') === (scope === 'POLYMARKET'));
      if (scopeSamples.length < PARITY_SAMPLES) {
        bookParity.push({
          scope: venue,
          instrument,
          rawBid: raw.bid,
          rawAsk: raw.ask,
          canonicalBid,
          canonicalAsk,
          match: same,
        });
      }
    }
  });

  eventBus.subscribe('TRADE_RECEIVED', (event: EventBusEvent) => {
    const payload = event.payload as {
      venueId: unknown;
      marketId?: unknown;
      instrumentId: unknown;
      venueTradeId?: unknown;
      price: unknown;
      size: unknown;
      side: unknown;
    };
    checkCausality(event.metadata);
    const venue = String(payload.venueId);
    const instrument = String(payload.instrumentId);

    if (venue === 'POLYMARKET') {
      pmEvidence.trades += 1;
    } else {
      const venueEvidence = ensure(cexVenues, venue, () => ({
        depth: 0,
        updated: 0,
        trades: 0,
        instruments: new Set<string>(),
      }));
      venueEvidence.trades += 1;
      venueEvidence.instruments.add(instrument);
      if (payload.marketId !== undefined) {
        cexMarketIdFabrications += 1;
      }
    }

    // Раздел 10/23.15: отсутствующий venueTradeId остаётся ОТСУТСТВУЮЩИМ,
    // а не подменяется синтетическим
    const tradeId = payload.venueTradeId;
    if (tradeId !== undefined && String(tradeId).startsWith('synthetic')) {
      fabricatedTradeIds += 1;
    }

    // Раздел 10: сверка с сырой сделкой ИЗ ТОГО ЖЕ сообщения
    const rawTradeKey = `${venue}|${instrument}`;
    const rawTrade = rawTrades.get(rawTradeKey);
    const tradeScope = venue === 'POLYMARKET' ? 'POLYMARKET' : 'CEX';
    if (rawTrade !== undefined) {
      // Сверяется КАЖДАЯ сделка. Квота ниже ограничивает только печать
      // образцов: раньше сравнение стояло ВНУТРИ квоты, и счётчик
      // «сверок» показывал сотни тысяч при шести реальных сравнениях.
      tradeCompared.set(tradeScope, (tradeCompared.get(tradeScope) ?? 0) + 1);
      rawTradeConsumed.add(rawTradeKey);

      const rawPrice = String(rawTrade.price ?? '—');
      const rawSize = String(rawTrade.amount ?? rawTrade.size ?? '—');
      const rawIdValue = rawTrade.id ?? rawTrade.transactionHash;
      const rawId = rawIdValue === undefined || rawIdValue === null ? undefined : String(rawIdValue);
      const canonicalPrice = asText(payload.price);
      const canonicalSize = asText(payload.size);
      const canonicalId = tradeId === undefined ? undefined : String(tradeId);

      // Идентификатор входит в условие PASS, а не только в печать:
      // есть у источника — обязан совпасть ПОБАЙТОВО; нет у источника —
      // обязан отсутствовать и в canonical, а не быть придуманным
      const idSame = rawId === undefined ? canonicalId === undefined : canonicalId === rawId;
      const valuesSame =
        Number(rawPrice) === Number(canonicalPrice) && Number(rawSize) === Number(canonicalSize);
      const same = idSame && valuesSame;

      if (!same) {
        tradeMismatches += 1;
        if (tradeMismatches <= 5) {
          violations.push(
            `trade parity mismatch ${venue}/${instrument}: ` +
              `raw ${rawId ?? '(absent)'} ${rawPrice}x${rawSize} vs ` +
              `canonical ${canonicalId ?? '(absent)'} ${canonicalPrice}x${canonicalSize}`,
          );
        }
      }

      const tradeScopeSamples = tradeParity.filter(
        (x) => (x.scope === 'POLYMARKET') === (tradeScope === 'POLYMARKET'),
      );
      if (tradeScopeSamples.length < PARITY_SAMPLES) {
        tradeParity.push({
          scope: venue,
          instrument,
          rawId: rawId ?? '(absent)',
          canonicalId: canonicalId ?? '(absent)',
          rawPrice,
          canonicalPrice,
          rawSize,
          canonicalSize,
          match: same,
        });
      }
    }
  });

  eventBus.subscribe('TICK_SIZE_CHANGED', (event: EventBusEvent) => {
    checkCausality(event.metadata);
    pmEvidence.tickSize += 1;
  });

  eventBus.subscribe('REFERENCE_PRICE_UPDATED', (event: EventBusEvent) => {
    const payload = event.payload as {
      sourceId: unknown;
      baseAsset: unknown;
      quoteAsset: unknown;
      nativeSymbol: unknown;
      feed: { kind: string; windowSeconds?: number };
      value: unknown;
    };
    checkCausality(event.metadata);
    pmEvidence.reference += 1;
    const window = payload.feed.kind === 'TWAP' ? `TWAP:${String(payload.feed.windowSeconds)}s` : 'SPOT';
    const key = `${String(payload.sourceId)}|${window}`;
    const entry = ensure(feeds, key, () => ({
      count: 0,
      sample: '',
      baseAsset: '',
      quoteAsset: '',
      window,
    }));
    entry.count += 1;
    entry.sample = asText(payload.value);
    entry.baseAsset = String(payload.baseAsset);
    entry.quoteAsset = String(payload.quoteAsset);
  });

  // ── Живой прогон ──────────────────────────────────────────────────────
  console.log(`CHECKPOINT #2 — live run ${RUN_MINUTES} min, dir ${runDir}`);
  const startedAt = Date.now();
  await collector.start();

  const deadline = startedAt + RUN_MINUTES * 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const status = collector.status();
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `  t+${String(elapsed).padStart(4)}s  raw=${String(rawSeenTotal).padStart(6)}` +
        `  pm[d=${pmEvidence.depth} u=${pmEvidence.updated} t=${pmEvidence.trades} r=${pmEvidence.reference}]` +
        `  cex[${[...cexVenues.entries()].map(([v, e]) => `${v.slice(0, 3)}:${e.updated}`).join(' ')}]` +
        `  rec=${String(status.recorder.recordsWritten)}`,
    );
  }

  const liveDurationMs = Date.now() - startedAt;
  const finalStatus = collector.status();
  const pmStats = pmAdapter.getStats();
  const cexStats = cexAdapter.getStats();

  // ── Раздел 19: эквивалентность живой и replay-формы ───────────────────
  // Replay-движок НЕ строится. Берётся сообщение той же формы, в какой
  // его восстановит будущий reader, и подаётся в СВЕЖИЙ адаптер; сравнение
  // идёт по каноническому финансовому смыслу.
  const replay = await verifyReplayShape({ clock, logger, runDir, metadataGenerator });
  for (const issue of replay.violations) violations.push(issue);

  // ── Раздел 20: обратное чтение сырых архивов ──────────────────────────
  // ДО close: сессии, не дошедшие до резолюции, при остановке законно
  // отбрасываются (MR-B: «архива без победителя больше нет»), поэтому
  // после close каталог короткого прогона пуст — и читать было бы нечего.
  const readback = readBackArchives(runDir);

  // ── Остановка ─────────────────────────────────────────────────────────
  await collector.close();
  pmAdapter.close();
  cexAdapter.close();
  for (const issue of readback.violations) violations.push(issue);

  // ── Раздел 8: непрерывность последовательностей ───────────────────────
  const sequenceReport: string[] = [];
  let contiguousInstruments = 0;
  let brokenInstruments = 0;
  for (const [key, track] of [...sequences.entries()].sort()) {
    // Проверяется ПОРЯДОК ПРИХОДА, а не отсортированный ряд: сортировка
    // признала бы корректным поток 1, 3, 2 — то есть непоследовательную
    // публикацию, которую контракт как раз запрещает.
    const seen = track.seen;
    const problems: string[] = [];
    if (seen.length === 0) {
      problems.push('no observations');
    } else {
      if (seen[0] !== 1) problems.push(`starts at ${String(seen[0])}, expected 1`);
      for (let i = 1; i < seen.length; i += 1) {
        if (seen[i] !== seen[i - 1] + 1) {
          problems.push(`${String(seen[i - 1])} → ${String(seen[i])}`);
          if (problems.length >= 5) break;
        }
      }
    }
    const contiguous = problems.length === 0;
    if (contiguous) contiguousInstruments += 1;
    else {
      brokenInstruments += 1;
      violations.push(
        `BOOK_UPDATED sequence not strictly increasing by 1 for ${key}: ` +
          `count=${String(seen.length)} last=${String(seen[seen.length - 1] ?? 0)} ` +
          `problems=[${problems.join(', ')}]`,
      );
    }
    const sorted = seen;
    if (sequenceReport.length < 12) {
      sequenceReport.push(
        `  ${key.padEnd(46)} n=${String(track.seen.length).padStart(5)} ` +
          `range=1..${String(sorted[sorted.length - 1] ?? 0)} ${contiguous ? 'CONTIGUOUS' : 'BROKEN'}`,
      );
    }
  }

  // ── Обязательная классификация счётчиков ──────────────────────────────
  // Каждый счётчик отказа должен быть ЯВНО объявлен либо фатальным, либо
  // объяснённым. Раньше здесь была функция, которая ни разу не
  // вызывалась, а объяснения жили только в прозе отчёта — то есть
  // чекпоинт мог пройти с необъяснённым ненулевым счётчиком.
  const fatal: string[] = [];
  const explained: string[] = [];

  /** Счётчик, любое ненулевое значение которого валит чекпоинт. */
  const mustBeZero = (label: string, value: number): void => {
    if (value === 0) return;
    fatal.push(`${label}=${String(value)}`);
  };

  /** Счётчик, ненулевое значение которого объяснимо и допустимо. */
  const benign = (label: string, value: number, reason: string): void => {
    if (value === 0) return;
    explained.push(`${label}=${String(value)} — ${reason}`);
  };

  /** Порог минимального покрытия: ноль означает, что проверка не шла. */
  const evidence: string[] = [];
  const requireEvidence = (label: string, value: number): void => {
    if (value > 0) return;
    evidence.push(`${label} produced NO observations — check did not actually run`);
  };

  // Фатальные: любое ненулевое значение — дефект контура
  mustBeZero('bus.rejected', finalStatus.bus.rejectedPublicationsTotal);
  mustBeZero('recorder.serializationFailures', finalStatus.recorder.serializationFailures);
  mustBeZero('recorder.registrationFailures', finalStatus.recorder.registrationFailures);
  mustBeZero('recorderCex.writeFailures', finalStatus.recorderCex.cexWriteFailures);
  mustBeZero('pm.invalidPayloads', pmStats.invalidPayloads);
  mustBeZero('pm.semanticPublishFailures', pmStats.semanticPublishFailures);
  mustBeZero('cex.invalidOrderBooks', cexStats.invalidOrderBooks);
  mustBeZero('cex.invalidTrades', cexStats.invalidTrades);
  mustBeZero('cex.invalidIdentities', cexStats.invalidIdentities);
  mustBeZero('cex.semanticPublishFailures', cexStats.semanticPublishFailures);
  mustBeZero('raw.mutationsDetected', immutabilityViolations);
  mustBeZero('cex.outcomePriceLeaks', outcomePriceLeaks.length);
  mustBeZero('cex.fabricatedMarketId', cexMarketIdFabrications);
  mustBeZero('trade.fabricatedIds', fabricatedTradeIds);
  mustBeZero('bookParity.mismatches', bookMismatches);
  mustBeZero('tradeParity.mismatches', tradeMismatches);
  // rawMessageIds НЕ ограничен и ничего не вытесняет, поэтому неизвестный
  // causationId — настоящий разрыв причинности, а не артефакт измерения
  mustBeZero('causality.orphans', causality.orphans);
  mustBeZero('causality.unrelatedRoots', causality.roots);
  mustBeZero('sequence.brokenInstruments', brokenInstruments);
  mustBeZero('readback.malformedLines', readback.malformed);

  // Объяснимые: ненулевые по природе наблюдаемого потока
  benign(
    'bus.handlerErrors',
    finalStatus.bus.handlerErrorsTotal,
    `intentional isolation probes (harness threw ${String(Math.floor(faultInjections / 50))} times); ` +
      'recorder lost nothing',
  );
  benign(
    'pm.desyncs',
    pmStats.desyncs,
    `reconstruction paused publication and resynced ${String(pmStats.resyncs)} times`,
  );
  benign(
    'pm.unverifiedBestClaims',
    pmStats.unverifiedBestClaims,
    'source-declared best outside OutcomePrice range — side unverifiable, not absent',
  );
  benign(
    'rawTrades.supersededBeforeCompare',
    rawTradesSuperseded,
    'raw trade overwritten before a semantic event paired with it (pairing density)',
  );
  benign('cex.duplicateTrades', cexStats.duplicateTrades, 'venue redelivered a trade id; deduped');
  benign('cex.crossedOrderBooks', cexStats.crossedOrderBooks, 'venue published a crossed book');
  benign('cex.tradesMissingId', cexStats.tradesMissingId, 'left ABSENT, never fabricated');
  benign('cex.tradesMissingSide', cexStats.tradesMissingSide, 'side never guessed');
  benign('readback.openPartitions', readback.incomplete, 'rotation cycle outlives the run window');

  // Минимальное покрытие: без него сломанная подписка прошла бы часть
  // проверок с нулевым объёмом наблюдений и всё равно дала PASS
  requireEvidence('polymarket book comparisons', bookCompared.get('POLYMARKET') ?? 0);
  requireEvidence('cex book comparisons', bookCompared.get('CEX') ?? 0);
  requireEvidence('polymarket trade comparisons', tradeCompared.get('POLYMARKET') ?? 0);
  requireEvidence('cex trade comparisons', tradeCompared.get('CEX') ?? 0);
  requireEvidence('polymarket BOOK_DEPTH', pmEvidence.depth);
  requireEvidence('polymarket BOOK_UPDATED', pmEvidence.updated);
  requireEvidence('cex venues observed', cexVenues.size);
  requireEvidence('sequence observations', sequences.size);
  requireEvidence('causality checks', causality.checked);
  requireEvidence('raw payload immutability checks', immutabilityChecked);
  requireEvidence('readback lines', readback.lines);
  requireEvidence('replay polymarket samples', replay.polymarketSamples);
  requireEvidence('replay cex samples', replay.cexSamples);
  requireEvidence('reference feeds observed', feeds.size);
  for (const required of ['BINANCE', 'CHAINLINK', 'TWAP'] as const) {
    const present = [...feeds.keys()].some((key) => key.toUpperCase().includes(required));
    if (!present) evidence.push(`reference feed ${required} was never observed`);
  }

  // ── ОТЧЁТ ─────────────────────────────────────────────────────────────
  const line = (title: string): void => console.log(`\n${'─'.repeat(72)}\n${title}\n`);

  line('E. RAW BUS / RECORDER');
  console.log(`  bus published            ${String(finalStatus.bus.publishedTotal)}`);
  console.log(`  bus dispatched           ${String(finalStatus.bus.dispatchedTotal)}`);
  console.log(`  bus rejected             ${String(finalStatus.bus.rejectedPublicationsTotal)}`);
  console.log(`  bus handler errors       ${String(finalStatus.bus.handlerErrorsTotal)}  (injected probes: ${String(Math.floor(faultInjections / 50))})`);
  console.log(`  recorder written         ${String(finalStatus.recorder.recordsWritten)}`);
  console.log(`  recorder failures        ${String(finalStatus.recorder.serializationFailures + finalStatus.recorder.registrationFailures)}`);
  console.log(`  recorder CEX written     ${String(finalStatus.recorderCex.cexRecordsAccepted)}`);
  console.log(`  raw observed by observer ${String(rawSeenTotal)}`);

  line('F. POLYMARKET SEMANTICS');
  console.log(`  raw seen                 ${String(pmStats.rawMessagesSeen)}`);
  console.log(`  BOOK_DEPTH               ${String(pmEvidence.depth)}`);
  console.log(`  BOOK_UPDATED             ${String(pmEvidence.updated)}`);
  console.log(`  TRADE_RECEIVED           ${String(pmEvidence.trades)}`);
  console.log(`  TICK_SIZE_CHANGED        ${String(pmEvidence.tickSize)}`);
  console.log(`  REFERENCE_PRICE_UPDATED  ${String(pmEvidence.reference)}`);
  console.log(`  delta before snapshot    ${String(pmStats.deltaBeforeSnapshot)}  (skipped safely)`);
  console.log(`  desyncs / resyncs        ${String(pmStats.desyncs)} / ${String(pmStats.resyncs)}`);
  console.log(`  invalid payloads         ${String(pmStats.invalidPayloads)}`);
  console.log(`  publish failures         ${String(pmStats.semanticPublishFailures)}`);
  console.log(`  unverified best claims   ${String(pmStats.unverifiedBestClaims)}  (source best outside OutcomePrice range)`);
  console.log(`  markets observed         ${String(pmMarkets.size)}`);
  console.log(`  instruments observed     ${String(pmInstruments.size)}`);

  line('G. CEX SEMANTICS (per venue)');
  for (const [venue, e] of [...cexVenues.entries()].sort()) {
    console.log(
      `  ${venue.padEnd(12)} depth=${String(e.depth).padStart(5)} updated=${String(e.updated).padStart(6)}` +
        ` trades=${String(e.trades).padStart(5)} instruments=${String(e.instruments.size)}` +
        `  [${[...e.instruments].sort().join(', ')}]`,
    );
  }
  console.log(`  invalid books            ${String(cexStats.invalidOrderBooks)}`);
  console.log(`  crossed books            ${String(cexStats.crossedOrderBooks)}`);
  console.log(`  invalid trades           ${String(cexStats.invalidTrades)}`);
  console.log(`  duplicate trades         ${String(cexStats.duplicateTrades)}`);
  console.log(`  trades missing id        ${String(cexStats.tradesMissingId)}  (left ABSENT, not fabricated)`);
  console.log(`  trades missing side      ${String(cexStats.tradesMissingSide)}`);
  console.log(`  invalid identities       ${String(cexStats.invalidIdentities)}`);
  console.log(`  publish failures         ${String(cexStats.semanticPublishFailures)}`);

  line('H. BOOK PARITY (raw vs canonical)');
  for (const p of bookParity.slice(0, PARITY_SAMPLES * 2)) {
    console.log(
      `  ${p.scope.padEnd(10)}${p.instrument.padEnd(26)}` +
        `raw ${p.rawBid}/${p.rawAsk}  canonical ${p.canonicalBid}/${p.canonicalAsk}  ${p.match ? 'MATCH' : 'MISMATCH'}`,
    );
  }
  console.log(
    `  comparisons: POLYMARKET=${String(bookCompared.get('POLYMARKET') ?? 0)} ` +
      `CEX=${String(bookCompared.get('CEX') ?? 0)}   mismatches: ${String(bookMismatches)}`,
  );

  line('I. TRADE PARITY (raw vs canonical)');
  for (const t of tradeParity.slice(0, PARITY_SAMPLES * 2)) {
    console.log(
      `  ${t.scope.padEnd(10)}${t.instrument.padEnd(22)}` +
        `id ${t.rawId.slice(0, 18)}→${t.canonicalId.slice(0, 18)}  ` +
        `${t.rawPrice}x${t.rawSize} → ${t.canonicalPrice}x${t.canonicalSize}  ${t.match ? 'MATCH' : 'MISMATCH'}`,
    );
  }
  console.log(
    `  comparisons: POLYMARKET=${String(tradeCompared.get('POLYMARKET') ?? 0)} ` +
      `CEX=${String(tradeCompared.get('CEX') ?? 0)}   mismatches: ${String(tradeMismatches)}   ` +
      `raw superseded before compare: ${String(rawTradesSuperseded)}`,
  );

  line('J. REFERENCE PRICE PARITY');
  for (const [key, f] of [...feeds.entries()].sort()) {
    console.log(
      `  ${key.padEnd(48)} n=${String(f.count).padStart(4)}  ` +
        `${f.baseAsset}/${f.quoteAsset}  last=${f.sample}`,
    );
  }

  line('K. BOOK_UPDATED SEQUENCE SEMANTICS');
  for (const row of sequenceReport) console.log(row);
  console.log(`  instruments contiguous   ${String(contiguousInstruments)}`);
  console.log(`  instruments broken       ${String(brokenInstruments)}`);

  line('L. METADATA CAUSALITY');
  console.log(`  semantic events checked  ${String(causality.checked)}`);
  console.log(`  children of a raw msg    ${String(causality.linked)}`);
  console.log(`  orphan causationId       ${String(causality.orphans)}  (unbounded id set — any orphan is a real break)`);
  console.log(`  unrelated roots          ${String(causality.roots)}`);

  line('M. REPLAY-SHAPED EQUIVALENCE');
  console.log(`  polymarket               ${replay.polymarket}`);
  console.log(`  cex                      ${replay.cex}`);

  line('N. RAW READBACK / FINALIZATION');
  console.log(`  archives read            ${String(readback.files)}`);
  console.log(`  lines parsed             ${String(readback.lines)}`);
  console.log(`  malformed lines          ${String(readback.malformed)}`);
  console.log(`  open partitions (.jsonl) ${String(readback.incomplete)}  (legal mid-run state)`);
  console.log(`  finalization state       ${String(finalStatus.finalization.archivedTotal)} archived, ${String(finalStatus.finalization.archiveFailures)} failures`);

  line('RAW IMMUTABILITY / ISOLATION');
  console.log(`  payloads compared        ${String(immutabilityChecked)}`);
  console.log(`  mutations detected       ${String(immutabilityViolations)}`);
  console.log(`  OutcomePrice leaks (CEX) ${String(outcomePriceLeaks.length)}`);
  console.log(`  fabricated CEX marketId  ${String(cexMarketIdFabrications)}`);
  console.log(`  fabricated trade ids     ${String(fabricatedTradeIds)}`);

  line('P. DEFECTS / VIOLATIONS');
  if (violations.length === 0) console.log('  None');
  else for (const v of violations.slice(0, 40)) console.log(`  • ${v}`);

  line('COUNTER CLASSIFICATION');
  if (explained.length === 0) console.log('  (no non-zero benign counters)');
  else for (const row of explained) console.log(`  • ${row}`);
  if (fatal.length > 0) {
    console.log('\n  FATAL COUNTERS:');
    for (const row of fatal) console.log(`  ✗ ${row}`);
  }

  line('MINIMUM EVIDENCE');
  if (evidence.length === 0) console.log('  every check produced observations');
  else for (const row of evidence) console.log(`  ✗ ${row}`);

  // PASS требует ВСЕХ трёх условий. Раньше exit-код зависел только от
  // violations, а необъяснённые счётчики лишь печатались — чекпоинт мог
  // завершиться нулём при непустом списке.
  const pass = violations.length === 0 && fatal.length === 0 && evidence.length === 0;
  line(`RESULT: CHECKPOINT #2 — ${pass ? 'PASS' : 'FAIL'}`);
  console.log(`  live duration ${String(Math.round(liveDurationMs / 1000))}s`);
  console.log(`  violations ${String(violations.length)} · fatal counters ${String(fatal.length)} · evidence gaps ${String(evidence.length)}`);
  console.log(`  run dir ${runDir}`);
  process.exitCode = pass ? 0 : 1;
}

/** Итог проверки replay-формы. */
interface ReplayOutcome {
  readonly polymarket: string;
  readonly cex: string;
  readonly polymarketSamples: number;
  readonly cexSamples: number;
  readonly violations: readonly string[];
}

/**
 * Проверяет, что сообщение в replay-форме даёт тот же канонический смысл.
 *
 * @param options - Часы, логгер, каталог прогона и генератор метаданных
 * @returns Итог сверки по обоим источникам
 *
 * @remarks
 * Replay-движок здесь НЕ строится намеренно. Берётся сообщение той формы,
 * в которой его восстановит будущий reader: payload как он записан в
 * архив, свежие метаданные, тот же тип. Оно подаётся в ОТДЕЛЬНЫЙ экземпляр
 * адаптера, и сравнивается каноническая финансовая семантика — цена и
 * размер, а не идентификаторы сообщений, которые у replay законно другие.
 */
async function verifyReplayShape(options: {
  readonly clock: LiveClock;
  readonly logger: ILogger;
  readonly runDir: string;
  readonly metadataGenerator: MessageMetadataGenerator;
}): Promise<ReplayOutcome> {
  const violations: string[] = [];
  const samples = collectArchivedPayloads(options.runDir);

  const replayBus = new ExternalMessageBus<ContourMessage>();
  const replayEventBus = new EventBus(options.logger);
  const pm = new PolymarketSemanticAdapter({
    bus: replayBus,
    eventBus: replayEventBus,
    metadataGenerator: options.metadataGenerator,
    logger: options.logger,
  });
  const cex = new CexSemanticAdapter({
    bus: replayBus,
    eventBus: replayEventBus,
    metadataGenerator: options.metadataGenerator,
    logger: options.logger,
  });

  pm.start();
  cex.start();

  const seen = { pmDepth: 0, pmTrade: 0, pmReference: 0, cexDepth: 0, cexTrade: 0 };
  // Сверка идёт по ФИНАНСОВОМУ СМЫСЛУ: canonical лучшая цена против той,
  // что записана в архивном payload-е. Идентификаторы сообщений у replay
  // законно другие и не сравниваются.
  // ОЧЕРЕДЬ, а не последнее значение: адаптер подписан асинхронно, и к
  // моменту прихода события карта «последнего ожидания» уже перезаписана
  // следующим образцом. Порядок обработки внутри инструмента сохраняется,
  // поэтому N-е событие соответствует N-му архивному наблюдению.
  const replayTop = new Map<string, Array<{ bid: string; ask: string }>>();
  const replayTrades = new Map<
    string,
    Array<{ price: string; size: string; id: string | undefined }>
  >();
  let semanticMismatches = 0;

  replayEventBus.subscribe('BOOK_DEPTH', (event: EventBusEvent) => {
    const payload = event.payload as {
      venueId: unknown;
      instrumentId: unknown;
      snapshot: { getBestBid: () => unknown; getBestAsk: () => unknown };
    };
    const venue = String(payload.venueId);
    if (venue === 'POLYMARKET') seen.pmDepth += 1;
    else seen.cexDepth += 1;

    const queue = replayTop.get(`${venue}|${String(payload.instrumentId)}`);
    const expected = queue?.shift();
    if (expected === undefined) return;
    const bid = asText(payload.snapshot.getBestBid());
    const ask = asText(payload.snapshot.getBestAsk());
    if (Number(bid) !== Number(expected.bid) || Number(ask) !== Number(expected.ask)) {
      semanticMismatches += 1;
      violations.push(
        `replay semantics differ for ${venue}/${String(payload.instrumentId)}: ` +
          `archived ${expected.bid}/${expected.ask} vs canonical ${bid}/${ask}`,
      );
    }
  });
  replayEventBus.subscribe('REFERENCE_PRICE_UPDATED', () => {
    seen.pmReference += 1;
  });
  replayEventBus.subscribe('TRADE_RECEIVED', (event: EventBusEvent) => {
    const payload = event.payload as {
      venueId: unknown;
      instrumentId: unknown;
      venueTradeId?: unknown;
      price: unknown;
      size: unknown;
    };
    const venue = String(payload.venueId);
    if (venue === 'POLYMARKET') seen.pmTrade += 1;
    else seen.cexTrade += 1;

    const expected = replayTrades.get(`${venue}|${String(payload.instrumentId)}`)?.shift();
    if (expected === undefined) return;
    const canonicalId =
      payload.venueTradeId === undefined ? undefined : String(payload.venueTradeId);
    const idSame = expected.id === undefined ? canonicalId === undefined : canonicalId === expected.id;
    const valuesSame =
      Number(expected.price) === Number(asText(payload.price)) &&
      Number(expected.size) === Number(asText(payload.size));
    if (!idSame || !valuesSame) {
      semanticMismatches += 1;
      violations.push(
        `replay trade semantics differ for ${venue}/${String(payload.instrumentId)}: ` +
          `archived ${expected.id ?? '(absent)'} ${expected.price}x${expected.size} vs ` +
          `canonical ${canonicalId ?? '(absent)'} ${asText(payload.price)}x${asText(payload.size)}`,
      );
    }
  });

  for (const sample of samples.polymarket) {
    const envelope = sample.payload as {
      type?: unknown;
      payload?: {
        tokenId?: unknown;
        bids?: readonly { price?: unknown }[];
        asks?: readonly { price?: unknown }[];
        price?: unknown;
        size?: unknown;
        transactionHash?: unknown;
      };
    };
    const inner = envelope.payload;
    const token = String(inner?.tokenId ?? '');
    if (inner !== undefined && token !== '') {
      if (envelope.type === 'book') {
        // Ожидание строится ИЗ АРХИВНОГО payload-а: лучшее как
        // max(bid)/min(ask), независимо от порядка уровней у вендора
        const bids = (inner.bids ?? []).map((l) => Number(l.price)).filter((n) => !Number.isNaN(n));
        const asks = (inner.asks ?? []).map((l) => Number(l.price)).filter((n) => !Number.isNaN(n));
        if (bids.length > 0 && asks.length > 0) {
          ensure(replayTop, `POLYMARKET|${token}`, () => []).push({
            bid: String(Math.max(...bids)),
            ask: String(Math.min(...asks)),
          });
        }
      } else if (envelope.type === 'last_trade_price') {
        ensure(replayTrades, `POLYMARKET|${token}`, () => []).push({
          price: String(inner.price ?? '—'),
          size: String(inner.size ?? '—'),
          id: inner.transactionHash === undefined ? undefined : String(inner.transactionHash),
        });
      }
    }
    replayBus.publish({
      type: sample.type as 'POLYMARKET_MARKET',
      payload: sample.payload,
      metadata: options.metadataGenerator.nextRoot(),
    } as ContourMessage);
  }
  for (const sample of samples.cex) {
    const payload = sample.payload as {
      exchangeId?: string;
      marketType?: string;
      symbol?: string;
      orderBook?: { bids?: readonly (readonly unknown[])[]; asks?: readonly (readonly unknown[])[] };
    };
    if (payload.orderBook !== undefined && payload.exchangeId !== undefined) {
      const bid = payload.orderBook.bids?.[0]?.[0];
      const ask = payload.orderBook.asks?.[0]?.[0];
      if (bid !== undefined && ask !== undefined) {
        const key = `${payload.exchangeId.toUpperCase()}|${String(payload.marketType)}:${String(payload.symbol)}`;
        ensure(replayTop, key, () => []).push({ bid: String(bid), ask: String(ask) });
      }
    }
    const tradePayload = sample.payload as {
      exchangeId?: string;
      marketType?: string;
      symbol?: string;
      trade?: Record<string, unknown>;
    };
    if (tradePayload.trade !== undefined && tradePayload.exchangeId !== undefined) {
      const t = tradePayload.trade;
      const rawId = t.id ?? t.transactionHash;
      ensure(
        replayTrades,
        `${tradePayload.exchangeId.toUpperCase()}|${String(tradePayload.marketType)}:${String(tradePayload.symbol)}`,
        () => [],
      ).push({
        price: String(t.price ?? '—'),
        size: String(t.amount ?? t.size ?? '—'),
        id: rawId === undefined || rawId === null ? undefined : String(rawId),
      });
    }
    replayBus.publish({
      type: sample.type as 'CEX_ORDERBOOK',
      payload: sample.payload,
      metadata: options.metadataGenerator.nextRoot(),
    } as ContourMessage);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));

  pm.close();
  cex.close();

  const pmKinds = new Map<string, number>();
  for (const sample of samples.polymarket) {
    const envelope = sample.payload as { topic?: unknown; type?: unknown };
    const kind = envelope.topic === 'market' ? String(envelope.type) : 'rtds';
    pmKinds.set(kind, (pmKinds.get(kind) ?? 0) + 1);
  }
  const pmBreakdown = [...pmKinds.entries()].map(([k, n]) => `${k}:${String(n)}`).join(' ');
  const pmVerdict =
    samples.polymarket.length === 0
      ? 'NO SAMPLES (no archived polymarket payloads in run window)'
      : `${String(samples.polymarket.length)} replay-shaped msgs [${pmBreakdown}] → ` +
        `${String(seen.pmDepth)} BOOK_DEPTH, ${String(seen.pmTrade)} TRADE_RECEIVED, ` +
        `${String(seen.pmReference)} REFERENCE_PRICE_UPDATED`;
  const cexVerdict =
    samples.cex.length === 0
      ? 'NO SAMPLES (no archived cex payloads in run window)'
      : `${String(samples.cex.length)} replay-shaped msgs → ${String(seen.cexDepth)} BOOK_DEPTH, ` +
        `${String(seen.cexTrade)} TRADE_RECEIVED, semantic mismatches ${String(semanticMismatches)}`;

  if (samples.polymarket.length > 0 && seen.pmDepth === 0 && seen.pmTrade === 0 && seen.pmReference === 0) {
    violations.push('replay-shaped polymarket messages produced no canonical events');
  }
  if (samples.cex.length > 0 && seen.cexDepth === 0 && seen.cexTrade === 0) {
    violations.push('replay-shaped cex messages produced no canonical events');
  }

  return {
    polymarket: pmVerdict,
    cex: cexVerdict,
    polymarketSamples: samples.polymarket.length,
    cexSamples: samples.cex.length,
    violations,
  };
}

/** Образец payload-а, восстановленный из архива. */
interface ArchivedSample {
  readonly type: string;
  readonly payload: unknown;
}

/**
 * Собирает payload-ы из записанных архивов для replay-формы.
 *
 * @param runDir - Каталог прогона
 * @returns Образцы, разделённые по источнику
 *
 * @remarks
 * Читаются как завершённые `.jsonl.gz`, так и ещё открытые `.jsonl`:
 * живое окно чекпоинта короче, чем цикл финализации, и ограничиваться
 * сжатыми значило бы не получить образцов вовсе.
 */
function collectArchivedPayloads(runDir: string): {
  readonly polymarket: readonly ArchivedSample[];
  readonly cex: readonly ArchivedSample[];
} {
  // Квоты ПО ВИДАМ, а не общий лимит: RTDS-строк в архиве кратно больше
  // рыночных, и выборка «первые N» состояла бы из них одних — раздел 19
  // требует покрыть книгу, сделку и референс, а не то, чего больше.
  const QUOTA = 12;
  const buckets = new Map<string, ArchivedSample[]>();
  const take = (bucket: string, sample: ArchivedSample): void => {
    const list = ensure(buckets, bucket, () => []);
    if (list.length < QUOTA) list.push(sample);
  };
  const full = (): boolean =>
    ['pm-book', 'pm-trade', 'pm-rtds', 'cex-book', 'cex-trade'].every(
      (b) => (buckets.get(b)?.length ?? 0) >= QUOTA,
    );

  walkRunFiles(runDir, (file, source) => {
    if (full()) return;
    let text: string;
    try {
      text = file.endsWith('.gz')
        ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')
        : fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const lines = text.trimEnd().split('\n').filter((l) => l.length > 0);
    // Первая строка — заголовок архива, не наблюдение
    for (const raw of lines.slice(1)) {
      if (full()) break;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (source === 'polymarket') {
        // Записанная строка — это SDK-событие с оболочкой {topic,type,payload},
        // то есть ровно то, что в live лежит в message.payload. Источник
        // различается по vendor topic-дискриминатору, как и у Recorder-а:
        // рыночный поток идёт под topic 'market', референсные — под
        // 'prices.crypto.*'.
        const topic = typeof parsed.topic === 'string' ? parsed.topic : '';
        const kind = typeof parsed.type === 'string' ? parsed.type : '';
        if (topic === 'market') {
          if (kind === 'book') take('pm-book', { type: 'POLYMARKET_MARKET', payload: parsed });
          else if (kind === 'last_trade_price') {
            take('pm-trade', { type: 'POLYMARKET_MARKET', payload: parsed });
          }
          continue;
        }
        let type: string;
        if (topic.includes('twap')) type = 'POLYMARKET_CRYPTO_CHAINLINK_TWAP';
        else if (topic.includes('chainlink')) type = 'POLYMARKET_CRYPTO_CHAINLINK';
        else if (topic.includes('binance')) type = 'POLYMARKET_CRYPTO_BINANCE';
        else continue;
        take('pm-rtds', { type, payload: parsed });
        continue;
      }
      if (parsed.trade !== undefined) take('cex-trade', { type: 'CEX_TRADE', payload: parsed });
      else if (parsed.orderBook !== undefined) {
        take('cex-book', { type: 'CEX_ORDERBOOK', payload: parsed });
      }
    }
  });

  // Снапшот книги обязан идти ПЕРВЫМ: дельту без него адаптер правильно
  // пропускает, и порядок здесь повторяет живой
  const polymarket = [
    ...(buckets.get('pm-book') ?? []),
    ...(buckets.get('pm-trade') ?? []),
    ...(buckets.get('pm-rtds') ?? []),
  ];
  const cex = [...(buckets.get('cex-book') ?? []), ...(buckets.get('cex-trade') ?? [])];
  return { polymarket, cex };
}

/** Итог обратного чтения архивов. */
interface ReadbackOutcome {
  readonly files: number;
  readonly lines: number;
  readonly malformed: number;
  readonly incomplete: number;
  readonly violations: readonly string[];
}

/**
 * Читает записанные архивы прогона и проверяет их целостность.
 *
 * @param runDir - Каталог прогона
 * @returns Счётчики и найденные нарушения
 */
function readBackArchives(runDir: string): ReadbackOutcome {
  const violations: string[] = [];
  let files = 0;
  let lines = 0;
  let malformed = 0;
  let incomplete = 0;

  walkRunFiles(runDir, (file) => {
    files += 1;
    const finalized = file.endsWith('.gz');
    if (!finalized) incomplete += 1;
    let text: string;
    try {
      // Открытая партиция читается как есть, завершённая — через gunzip.
      // Обе формы законны: какая именно, определяет цикл recorder-а, а не мы.
      text = finalized
        ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')
        : fs.readFileSync(file, 'utf8');
    } catch (error) {
      violations.push(
        `archive unreadable: ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const raw of text.trimEnd().split('\n')) {
      if (raw.length === 0) continue;
      lines += 1;
      try {
        JSON.parse(raw);
      } catch {
        malformed += 1;
        if (malformed <= 3) violations.push(`malformed JSONL line in ${path.basename(file)}`);
      }
    }
  });

  return { files, lines, malformed, incomplete, violations };
}

/**
 * Обходит файлы датасетов прогона.
 *
 * @param runDir - Каталог прогона
 * @param visit - Обработчик файла с именем источника
 */
function walkRunFiles(runDir: string, visit: (file: string, source: string) => void): void {
  if (!fs.existsSync(runDir)) return;
  for (const dateEntry of fs.readdirSync(runDir, { withFileTypes: true })) {
    if (!dateEntry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) continue;
    const dateDir = path.join(runDir, dateEntry.name);
    for (const sourceEntry of fs.readdirSync(dateDir, { withFileTypes: true })) {
      if (!sourceEntry.isDirectory()) continue;
      const sourceDir = path.join(dateDir, sourceEntry.name);
      for (const fileEntry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (!fileEntry.isFile()) continue;
        visit(path.join(sourceDir, fileEntry.name), sourceEntry.name);
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error('CHECKPOINT #2 harness crashed:', error);
  process.exitCode = 1;
});
