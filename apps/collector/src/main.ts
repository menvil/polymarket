/**
 * Точка входа сервиса сбора рыночных данных.
 *
 * @remarks
 * Запускает два независимых коллектора в одном процессе:
 *
 * 1. **Polymarket коллектор** (`CollectorService`) — WS подписка на ордербуки
 *    Polymarket, запись в `outputDir/YYYY-MM-DD/polymarket/{market}.jsonl`
 *
 * 2. **CEX коллектор** (`CexCollectorService`) — ccxt.pro подписка на
 *    ордербуки и трейды CEX бирж, запись в
 *    `outputDir/YYYY-MM-DD/{exchange}/{symbol}__{HHMM}.jsonl(.gz)`
 *    с ротацией по 5-минутным UTC-окнам.
 *
 * ### Переменные окружения (Polymarket):
 * - `TOKEN_IDS` — список token ID через запятую
 * - `WS_URL` — Polymarket WS endpoint (опционально)
 *
 * ### Переменные окружения (CEX):
 * - `CEX_CONFIG` — JSON строка конфигурации бирж (опционально)
 *   Пример: `'{"binance":{"type":"spot","symbols":["BTC/USDT"],"orderbook":true,"trades":true}}'`
 * - `CEX_COMPRESSION` — `'none'` | `'gzip'` (по умолчанию: совпадает с COMPRESSION)
 *
 * ### Общие переменные:
 * - `OUTPUT_DIR` — директория для записи файлов (по умолчанию: `./data`)
 * - `COMPRESSION` — режим сжатия: `none` | `gzip` (по умолчанию: `none`)
 *
 * @example
 * ```bash
 * # Polymarket + Binance BTC/USDT
 * TOKEN_IDS="0xabc" \
 * CEX_CONFIG='{"binance":{"type":"spot","symbols":["BTC/USDT"],"orderbook":true,"trades":true,"obDepth":10}}' \
 * OUTPUT_DIR=./data \
 * node --loader ts-node/esm src/main.ts
 * ```
 */

import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { PolymarketWebSocketManager } from '@polymarket/exchange/ws';
import { PolymarketWsAdapter } from '@polymarket/exchange/ws';
import { CollectorService } from './CollectorService.js';
import type { CollectorConfig } from './CollectorConfig.js';
import { CexCollectorService } from './cex/CexCollectorService.js';
import type { CexCollectorConfig } from './cex/CexCollectorConfig.js';

/** Официальный Polymarket market-channel WebSocket URL */
const DEFAULT_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// ── Инициализация логгера ─────────────────────────────────────────────────────

const clock = new LiveClock();
const logger = new ConsoleLogger(clock, LogLevel.INFO);

// ── Общие настройки ───────────────────────────────────────────────────────────

// Корневая директория данных — все источники пишут сюда
// Polymarket: outputDir/snapshots/YYYY-MM-DD/polymarket/
// CEX:        outputDir/snapshots/YYYY-MM-DD/{exchange}/
// По умолчанию outputDir=. чтобы data/ создавалась рядом с процессом
const outputDir = process.env['OUTPUT_DIR'] ?? '.';
const compression = (process.env['COMPRESSION'] as 'none' | 'gzip') ?? 'none';

// ── Polymarket конфиг ─────────────────────────────────────────────────────────

const tokenIdsRaw = process.env['TOKEN_IDS'] ?? '';
const tokenIds = tokenIdsRaw.split(',').filter(Boolean);

const polymarketConfig: CollectorConfig = {
  outputDir: `${outputDir}/data/snapshots`,
  sourceSubDir: 'polymarket',
  compression,
  bufferSize: process.env['BUFFER_SIZE'] ? Number(process.env['BUFFER_SIZE']) : undefined,
  flushIntervalMs: process.env['FLUSH_INTERVAL_MS']
    ? Number(process.env['FLUSH_INTERVAL_MS'])
    : undefined,
  wsUrl: process.env['WS_URL'] ?? DEFAULT_WS_URL,
  tokenIds,
};

// ── CEX конфиг ────────────────────────────────────────────────────────────────

/**
 * Парсит CEX конфигурацию из переменной окружения CEX_CONFIG.
 *
 * @returns CexCollectorConfig или null если CEX_CONFIG не задан
 */
function parseCexConfig(): CexCollectorConfig | null {
  const cexConfigRaw = process.env['CEX_CONFIG'];
  if (!cexConfigRaw) return null;

  try {
    const exchanges = JSON.parse(cexConfigRaw);
    const config: CexCollectorConfig = {
      exchanges,
      outputDir: `${outputDir}/data/snapshots`,
      compression: (process.env['CEX_COMPRESSION'] as 'none' | 'gzip') ?? compression,
      windowMinutes: process.env['CEX_WINDOW_MINUTES']
        ? Number(process.env['CEX_WINDOW_MINUTES'])
        : undefined,
    };
    return config;
  } catch (err) {
    logger.error('Failed to parse CEX_CONFIG — CEX collector disabled', {
      err: err instanceof Error ? err : new Error(String(err)),
      cexConfigRaw: cexConfigRaw.slice(0, 100),
    });
    return null;
  }
}

const cexConfig = parseCexConfig();

// ── Логируем план ─────────────────────────────────────────────────────────────

logger.info('Collector starting', {
  outputDir,
  compression,
  polymarketTokens: tokenIds.length,
  cexEnabled: cexConfig !== null,
  cexExchanges: cexConfig ? Object.keys(cexConfig.exchanges) : [],
});

if (tokenIds.length === 0 && !cexConfig) {
  logger.warn('Nothing to collect: TOKEN_IDS is empty and CEX_CONFIG is not set');
}

// ── Создаём сервисы ───────────────────────────────────────────────────────────

// Polymarket WS инфраструктура
const wsManager = new PolymarketWebSocketManager(
  { url: polymarketConfig.wsUrl ?? DEFAULT_WS_URL },
  logger,
);
const wsAdapter = new PolymarketWsAdapter(wsManager, logger);

const polymarketService = new CollectorService(wsAdapter, polymarketConfig, logger);
const cexService = cexConfig ? new CexCollectorService(cexConfig, logger) : null;

// ── Graceful shutdown ─────────────────────────────────────────────────────────

/**
 * Выполняет graceful shutdown: останавливает все сервисы.
 *
 * @param signal - Имя сигнала (SIGINT или SIGTERM)
 */
async function shutdown(signal: string): Promise<void> {
  // Удерживаем event loop живым пока идёт async cleanup.
  const keepAlive = setInterval(() => {}, 500);
  logger.info(`Received ${signal}, shutting down`);
  try {
    if (cexService) {
      await cexService.stop();
    }
    await polymarketService.stop();
    await wsAdapter.disconnect();
    logger.info('Shutdown complete');
  } catch (err) {
    logger.error('Error during shutdown', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
  clearInterval(keepAlive);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// ── Запуск ────────────────────────────────────────────────────────────────────

try {
  // Polymarket: подписываемся на токены и запускаем
  if (tokenIds.length > 0) {
    for (const tokenId of tokenIds) {
      await wsAdapter.subscribeToToken(tokenId);
    }
    polymarketService.start();
    await wsAdapter.connect();
    logger.info('Polymarket collector running', { tokenCount: tokenIds.length });
  }

  // CEX: чистим артефакты от предыдущего краш-запуска, затем запускаем
  if (cexService) {
    await cexService.cleanup();
    cexService.start();
    logger.info('CEX collector running', {
      exchanges: Object.keys(cexConfig!.exchanges),
    });
  }

  logger.info('Collector is running — press Ctrl+C to stop');
} catch (err) {
  logger.fatal('Failed to start collector', {
    err: err instanceof Error ? err : new Error(String(err)),
  });
  process.exit(1);
}
