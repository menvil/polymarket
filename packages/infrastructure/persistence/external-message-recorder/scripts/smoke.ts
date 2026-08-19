/**
 * DEVELOPMENT-ONLY live smoke N-002 (PART 29/30).
 *
 * @remarks
 * Доказывает НАСТОЯЩИЙ recording pipeline против публичных endpoints
 * Polymarket (без credentials):
 *
 * ```text
 * @polymarket/client → PolymarketSource → ExternalMessageBus
 *        → ExternalMessageRecorder → DataRecorder → JSONL/GZIP file
 * ```
 *
 * Шаги: находит representative активный рынок через public SDK, вручную
 * регистрирует recording-сессию (Market Discovery V2 НЕ внедряется),
 * подписывает market tokenIds + BTC/ETH RTDS, слушает ~25 секунд, затем
 * shutdown в порядке контура (source → drain → finalize → recorder → bus)
 * и проверяет структуру полученного файла (PART 30).
 *
 * Это НЕ production daemon: скрипт работает ~30 секунд и завершается.
 *
 * Запуск из корня repo (нужен собранный dist зависимостей: `npm run build`):
 *
 * ```bash
 * npx tsx packages/infrastructure/persistence/external-message-recorder/scripts/smoke.ts
 * ```
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { createPublicClient } from '@polymarket/client';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { LiveHighResolutionClock, MessageMetadataGenerator } from '@polymarket/messages';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { PolymarketSource } from '@polymarket/polymarket-v2';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import { DataRecorder, GzipCompressor, NDJSONFormatter } from '@polymarket/data-collection';
import { asMarketId } from '@polymarket/ids';
import { TimestampService } from '@polymarket/timestamp';
import { ExternalMessageRecorder } from '../src/index.js';

/** Длительность прослушивания подписок. */
const LISTEN_MS = 25_000;

/** Допустимые виды market-строк файла (PART 30). */
const MARKET_TYPES = new Set(['book', 'price_change', 'last_trade_price', 'tick_size_change']);

/** Допустимые RTDS topics файла (PART 30). */
const RTDS_TOPICS = new Set(['prices.crypto.binance', 'prices.crypto.chainlink']);

async function main(): Promise<void> {
  const logger = new ConsoleLogger(new LiveClock(), LogLevel.INFO);
  logger.info('N-002 smoke started');

  // ── 1. Public SDK: representative активный рынок ───────────────────────────
  const client = createPublicClient();
  const firstPage = await client
    .listMarkets({
      closed: false,
      order: 'endDate',
      ascending: true,
      endDateMin: new Date().toISOString(),
      pageSize: 100,
    })
    .firstPage();

  const target =
    firstPage.items.find(
      (m) =>
        /up or down/i.test(m.question ?? '') &&
        m.outcomes.yes.tokenId !== null &&
        m.outcomes.no.tokenId !== null &&
        m.state.enableOrderBook === true,
    ) ?? firstPage.items.find((m) => m.outcomes.yes.tokenId !== null);
  if (target === undefined) {
    throw new Error('No suitable live market found on the first Gamma page');
  }
  const conditionId = (target as unknown as Record<string, unknown>)['conditionId'];
  if (typeof conditionId !== 'string') {
    throw new Error('Target market has no conditionId');
  }
  const marketId = asMarketId(conditionId);
  if (marketId === undefined) {
    throw new Error(`conditionId is not a valid MarketId: ${conditionId}`);
  }
  const yesTokenId = target.outcomes.yes.tokenId;
  const noTokenId = target.outcomes.no.tokenId;
  if (yesTokenId === null || noTokenId === null) {
    throw new Error('Target market has no token ids');
  }
  logger.info('1. target market', {
    conditionId,
    question: target.question,
    endDate: target.state.endDate,
  });

  // ── 2. Recording pipeline ─────────────────────────────────────────────────
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n002-smoke-'));
  const bus = new ExternalMessageBus<PolymarketExternalMessage>();
  const metadataGenerator = new MessageMetadataGenerator({
    clock: new LiveClock(),
    highResolutionClock: new LiveHighResolutionClock(),
  });
  const source = new PolymarketSource({ client, bus, metadataGenerator, logger });
  const storage = new DataRecorder(
    {
      outputDir,
      sourceSubDir: 'polymarket',
      bufferSize: 100,
      flushIntervalMs: 2_000,
      compression: 'gzip',
      formatVersion: 2,
    },
    new NDJSONFormatter(),
    new GzipCompressor(),
    logger,
  );
  const recorder = new ExternalMessageRecorder({ bus, storage, logger });
  recorder.start();

  // Ручная регистрация recording-сессии (без Market Discovery V2)
  const expiresAt = TimestampService.create(Date.now() + 60 * 60_000);
  if (!expiresAt.ok) throw expiresAt.error;
  recorder.registerMarket({
    marketMeta: {
      marketId,
      question: target.question ?? 'unknown-question',
      tokenIds: [yesTokenId, noTokenId],
      expiresAt: expiresAt.value,
      rawMarket: target as unknown as Record<string, unknown>,
    },
    rtdsFeeds: [
      { topic: 'prices.crypto.binance', symbol: 'btcusdt' },
      { topic: 'prices.crypto.binance', symbol: 'ethusdt' },
      { topic: 'prices.crypto.chainlink', symbol: 'btc/usd' },
      { topic: 'prices.crypto.chainlink', symbol: 'eth/usd' },
    ],
  });

  // ── 3. Подписки Source + прослушивание ────────────────────────────────────
  try {
    await source.subscribeMarket([yesTokenId, noTokenId]);
    await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt', 'ethusdt']);
    await source.subscribeCryptoPrices('prices.crypto.chainlink', ['btc/usd', 'eth/usd']);
    logger.info('3. subscriptions opened, listening', { listenMs: LISTEN_MS });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, LISTEN_MS);
    });
  } finally {
    // ── 4. Shutdown в порядке контура (PART 20) ─────────────────────────────
    await source.close();
    const drained = await bus.drain();
    logger.info('4. source closed, bus drained', { drainOk: drained.ok });
  }

  // Финализируем ДО recorder.close(): EXPIRED-архив остаётся, incomplete удаляются
  await recorder.finalizeMarket(marketId, 'EXPIRED');

  const busStats = bus.getStats();
  const recorderStats = recorder.getStats();

  await recorder.close();
  const busClosed = await bus.close();
  logger.info('4. recorder and bus closed', { busCloseOk: busClosed.ok });

  // ── 5. Проверка файла (PART 30) ───────────────────────────────────────────
  const date = new Date().toISOString().slice(0, 10);
  const marketDir = path.join(outputDir, date, 'polymarket');
  const gzFiles = fs.existsSync(marketDir)
    ? fs.readdirSync(marketDir).filter((f) => f.endsWith('.jsonl.gz'))
    : [];
  if (gzFiles.length !== 1) {
    throw new Error(`Expected exactly one .jsonl.gz, found: ${JSON.stringify(gzFiles)}`);
  }
  const filePath = path.join(marketDir, gzFiles[0]!);
  const lines = zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf-8').trimEnd().split('\n');

  // LINE 1: valid JSON meta, formatVersion == 2, market identity
  const header = JSON.parse(lines[0]!) as Record<string, unknown>;
  const headerOk =
    header['t'] === 'meta' &&
    header['formatVersion'] === 2 &&
    header['marketId'] === conditionId &&
    typeof header['question'] === 'string' &&
    Array.isArray(header['tokenIds']);
  if (!headerOk) {
    throw new Error(`Header assertion failed: ${lines[0]!.slice(0, 300)}`);
  }

  // LINE 2+: valid JSON, source-native discriminators, без outer envelope
  const kindCounts = new Map<string, number>();
  for (const line of lines.slice(1)) {
    const parsed = JSON.parse(line) as { topic?: string; type?: string };
    const { topic, type } = parsed;
    if (topic === 'market') {
      if (!MARKET_TYPES.has(type ?? '')) throw new Error(`Unexpected market type: ${type}`);
    } else if (RTDS_TOPICS.has(topic ?? '')) {
      if (type !== 'update') throw new Error(`Unexpected RTDS type: ${type}`);
    } else {
      throw new Error(`Unexpected line topic: ${topic}`);
    }
    for (const forbidden of ['"messageId"', '"runId"', '"correlationId"', 'POLYMARKET_MARKET']) {
      if (line.includes(forbidden)) throw new Error(`Outer envelope leaked into file: ${forbidden}`);
    }
    const kind = `${topic}/${type}`;
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }

  // ── 6. Отчёт ──────────────────────────────────────────────────────────────
  logger.info('RESULT: pipeline numbers', {
    busPublishedTotal: busStats.publishedTotal,
    busDispatchedTotal: busStats.dispatchedTotal,
    recorderStats,
    fileLines: lines.length,
    payloadLines: lines.length - 1,
    lineKinds: Object.fromEntries(kindCounts),
  });
  logger.info('RESULT: recorded file', { filePath });
  logger.info('RESULT: sample header (truncated 600)', { header: lines[0]!.slice(0, 600).trim() });
  logger.info('RESULT: sample payload line (truncated 600)', {
    line: (lines[1] ?? '<none>').slice(0, 600),
  });
  logger.info('N-002 smoke finished (process should exit cleanly now)');
}

main().catch((error: unknown) => {
  console.error('Smoke failed:', error);
  process.exitCode = 1;
});
