/**
 * DEVELOPMENT-ONLY live smoke / characterization N-001 (PART 27).
 *
 * @remarks
 * Проверяет против ПУБЛИЧНЫХ endpoints Polymarket (без credentials):
 *
 * - A. `createPublicClient()`;
 * - B. Gamma capability: `listMarkets()` (+ `fetchMarket()`), coverage полей
 *   текущего Market Discovery;
 * - C. CLOB `market`-подписку на реальные tokenIds через ПОЛНЫЙ pipeline
 *   `PolymarketSource → ExternalMessage → ExternalMessageBus`;
 * - D. RTDS topics текущей системы (`prices.crypto.binance`,
 *   `prices.crypto.chainlink`);
 * - E. clean close (source → bus; процесс завершается сам, без висящих
 *   итераторов).
 *
 * Это НЕ production daemon: скрипт работает ~25 секунд и завершается.
 *
 * Запуск из корня repo (нужен собранный dist зависимостей: `npm run build`
 * в пакете строит их через project references):
 *
 * ```bash
 * npx tsx packages/infrastructure/polymarket-v2/scripts/smoke.ts
 * ```
 */
import { createPublicClient } from '@polymarket/client';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import {
  LiveHighResolutionClock,
  MessageMetadataGenerator,
} from '@polymarket/messages';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { PolymarketSource } from '../src/index.js';
import type { PolymarketExternalMessage } from '../src/index.js';

/** Длительность прослушивания подписок. */
const LISTEN_MS = 25_000;

/** Поля Gamma, которые использует текущий Market Discovery / recording header. */
const REQUIRED_GAMMA_FIELDS: ReadonlyArray<{
  readonly current: string;
  readonly probe: (market: Record<string, unknown>) => unknown;
}> = [
  { current: 'conditionId', probe: (m) => m['conditionId'] },
  { current: 'question', probe: (m) => m['question'] },
  { current: 'slug', probe: (m) => m['slug'] },
  { current: 'clobTokenIds', probe: (m) => (m['outcomes'] as Record<string, Record<string, unknown>>)?.['yes']?.['tokenId'] },
  { current: 'outcomes', probe: (m) => (m['outcomes'] as Record<string, Record<string, unknown>>)?.['yes']?.['label'] },
  { current: 'outcomePrices', probe: (m) => (m['outcomes'] as Record<string, Record<string, unknown>>)?.['yes']?.['price'] },
  { current: 'active', probe: (m) => (m['state'] as Record<string, unknown>)?.['active'] },
  { current: 'closed', probe: (m) => (m['state'] as Record<string, unknown>)?.['closed'] },
  { current: 'enableOrderBook', probe: (m) => (m['state'] as Record<string, unknown>)?.['enableOrderBook'] },
  { current: 'endDate', probe: (m) => (m['state'] as Record<string, unknown>)?.['endDate'] },
  { current: 'liquidity', probe: (m) => (m['metrics'] as Record<string, unknown>)?.['liquidity'] },
  { current: 'volume', probe: (m) => (m['metrics'] as Record<string, unknown>)?.['volume'] },
  { current: 'spread', probe: (m) => (m['prices'] as Record<string, unknown>)?.['spread'] },
  { current: 'bestBid', probe: (m) => (m['prices'] as Record<string, unknown>)?.['bestBid'] },
  { current: 'bestAsk', probe: (m) => (m['prices'] as Record<string, unknown>)?.['bestAsk'] },
  { current: 'orderPriceMinTickSize', probe: (m) => (m['trading'] as Record<string, unknown>)?.['minimumTickSize'] },
  { current: 'orderMinSize', probe: (m) => (m['trading'] as Record<string, unknown>)?.['minimumOrderSize'] },
  { current: 'description', probe: (m) => m['description'] },
  { current: 'tags', probe: (m) => m['tags'] },
  { current: 'resolutionSource', probe: (m) => (m['resolution'] as Record<string, unknown>)?.['source'] },
  { current: 'eventStartTime', probe: (m) => m['eventStartTime'] },
  { current: 'events[0].eventMetadata (priceToBeat)', probe: (m) => (m['events'] as Array<Record<string, unknown>>)?.[0]?.['eventMetadata'] },
];

async function main(): Promise<void> {
  const logger = new ConsoleLogger(new LiveClock(), LogLevel.INFO);
  logger.info('N-001 smoke started');

  // ── A. Public client ───────────────────────────────────────────────────────
  const client = createPublicClient();
  logger.info('A. createPublicClient() ok');

  // ── B. Gamma capability ────────────────────────────────────────────────────
  const paginator = client.listMarkets({
    closed: false,
    order: 'endDate',
    ascending: true,
    endDateMin: new Date().toISOString(),
    pageSize: 100,
  });
  const firstPage = await paginator.firstPage();
  logger.info('B. listMarkets() first page', {
    items: firstPage.items.length,
    hasMore: firstPage.hasMore,
  });

  const upOrDown = firstPage.items.filter(
    (m) =>
      /up or down/i.test(m.question ?? '') &&
      m.outcomes.yes.tokenId !== null &&
      m.outcomes.no.tokenId !== null &&
      m.state.enableOrderBook === true,
  );
  const target = upOrDown[0] ?? firstPage.items.find((m) => m.outcomes.yes.tokenId !== null);
  if (target === undefined) {
    throw new Error('No suitable live market found on the first Gamma page');
  }
  logger.info('B. target market', {
    id: target.id,
    question: target.question,
    endDate: target.state.endDate,
    yesTokenId: target.outcomes.yes.tokenId,
    noTokenId: target.outcomes.no.tokenId,
  });

  // Gamma field coverage для parity-таблицы
  const marketRecord = target as unknown as Record<string, unknown>;
  for (const field of REQUIRED_GAMMA_FIELDS) {
    const value = field.probe(marketRecord);
    logger.info(`B. gamma field: ${field.current}`, {
      present: value !== undefined && value !== null,
      sample: typeof value === 'object' ? JSON.stringify(value)?.slice(0, 120) : value,
    });
  }

  // fetchMarket capability (по id найденного рынка)
  const fetched = await client.fetchMarket({ id: target.id });
  logger.info('B. fetchMarket() ok', { sameId: fetched.id === target.id });

  // Полный SDK Market (обрезанный) — для отчёта
  logger.info('B. SDK Market JSON (truncated 1500)', {
    json: JSON.stringify(target).slice(0, 1500),
  });

  // ── C+D. Полный pipeline: Source → ExternalMessage → ExternalMessageBus ───
  const bus = new ExternalMessageBus<PolymarketExternalMessage>();
  const metadataGenerator = new MessageMetadataGenerator({
    clock: new LiveClock(),
    highResolutionClock: new LiveHighResolutionClock(),
  });
  const source = new PolymarketSource({ client, bus, metadataGenerator, logger });

  const counts = new Map<string, number>();
  const samples = new Map<string, PolymarketExternalMessage>();
  const serializationFailures: string[] = [];

  const record = (message: PolymarketExternalMessage): void => {
    const payloadKind = `${message.type}/${(message.payload as { type: string }).type}`;
    counts.set(payloadKind, (counts.get(payloadKind) ?? 0) + 1);
    if (!samples.has(payloadKind)) {
      samples.set(payloadKind, message);
      // PART 15: payload обязан быть JSON-serializable без потерь
      const roundTripped: unknown = JSON.parse(JSON.stringify(message.payload));
      if (JSON.stringify(roundTripped) !== JSON.stringify(message.payload)) {
        serializationFailures.push(payloadKind);
      }
    }
  };
  bus.subscribe('POLYMARKET_MARKET', record);
  bus.subscribe('POLYMARKET_CRYPTO_BINANCE', record);
  bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK', record);

  const yesTokenId = target.outcomes.yes.tokenId;
  const noTokenId = target.outcomes.no.tokenId;
  if (yesTokenId === null || noTokenId === null) {
    throw new Error('Target market has no token ids');
  }
  await source.subscribeMarket([yesTokenId, noTokenId]);
  await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt', 'ethusdt']);
  await source.subscribeCryptoPrices('prices.crypto.chainlink', ['btc/usd', 'eth/usd']);
  logger.info('C+D. subscriptions opened, listening', { listenMs: LISTEN_MS });

  await new Promise<void>((resolve) => {
    setTimeout(resolve, LISTEN_MS);
  });

  // ── E. Clean close ─────────────────────────────────────────────────────────
  await source.close();
  const busClose = await bus.close();
  logger.info('E. source and bus closed', { busCloseOk: busClose.ok });

  logger.info('RESULT: message counts by type/payload-kind', {
    counts: Object.fromEntries(counts),
  });
  for (const [kind, message] of samples) {
    logger.info(`RESULT: sample ${kind}`, {
      metadata: {
        messageId: message.metadata.messageId,
        sequence: message.metadata.sequence,
        isRoot:
          message.metadata.correlationId === message.metadata.messageId &&
          message.metadata.causationId === undefined,
      },
      payload: JSON.stringify(message.payload).slice(0, 900),
    });
  }
  logger.info('RESULT: payload JSON serialization', {
    checkedKinds: samples.size,
    failures: serializationFailures,
  });
  logger.info('RESULT: bus stats', { stats: bus.getStats() });
  logger.info('N-001 smoke finished (process should exit cleanly now)');
}

main().catch((error: unknown) => {
  console.error('Smoke failed:', error);
  process.exitCode = 1;
});
