/**
 * Точка входа сервиса сбора рыночных данных Polymarket.
 *
 * @remarks
 * Читает конфигурацию из переменных окружения, создаёт `CollectorService`
 * и управляет его жизненным циклом (SIGINT/SIGTERM → graceful shutdown).
 *
 * ### Переменные окружения:
 * - `OUTPUT_DIR` — директория для записи файлов (по умолчанию: `./data`)
 * - `COMPRESSION` — режим сжатия: `none` | `gzip` (по умолчанию: `none`)
 * - `TOKEN_IDS` — список token ID через запятую (обязательно для подписки)
 * - `WS_URL` — Polymarket WS endpoint (по умолчанию: официальный market-channel)
 * - `BUFFER_SIZE` — количество событий в буфере (по умолчанию: 100)
 * - `FLUSH_INTERVAL_MS` — интервал сброса буфера в мс (по умолчанию: 10000)
 *
 * @example
 * ```bash
 * TOKEN_IDS="0xabc,0xdef" OUTPUT_DIR=./data node --loader ts-node/esm src/main.ts
 * ```
 */

import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { PolymarketWebSocketManager } from '@polymarket/exchange/ws';
import { PolymarketWsAdapter } from '@polymarket/exchange/ws';
import { CollectorService } from './CollectorService.js';
import type { CollectorConfig } from './CollectorConfig.js';

/** Официальный Polymarket market-channel WebSocket URL */
const DEFAULT_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// ── Считываем конфигурацию из переменных окружения ────────────────────────────

const tokenIdsRaw = process.env['TOKEN_IDS'] ?? '';
const tokenIds = tokenIdsRaw.split(',').filter(Boolean);

const config: CollectorConfig = {
  outputDir: process.env['OUTPUT_DIR'] ?? './data',
  compression: (process.env['COMPRESSION'] as 'none' | 'gzip') ?? 'none',
  bufferSize: process.env['BUFFER_SIZE'] ? Number(process.env['BUFFER_SIZE']) : undefined,
  flushIntervalMs: process.env['FLUSH_INTERVAL_MS']
    ? Number(process.env['FLUSH_INTERVAL_MS'])
    : undefined,
  wsUrl: process.env['WS_URL'] ?? DEFAULT_WS_URL,
  tokenIds,
};

// ── Инициализация логгера ─────────────────────────────────────────────────────

const clock = new LiveClock();
const logger = new ConsoleLogger(clock, LogLevel.INFO);

logger.info('Collector starting', {
  outputDir: config.outputDir,
  compression: config.compression,
  tokenCount: config.tokenIds.length,
  wsUrl: config.wsUrl,
});

if (config.tokenIds.length === 0) {
  logger.warn('TOKEN_IDS is empty — no tokens will be tracked', {});
}

// ── Создаём WS инфраструктуру ─────────────────────────────────────────────────

const wsManager = new PolymarketWebSocketManager(
  { url: config.wsUrl ?? DEFAULT_WS_URL },
  logger,
);
const wsAdapter = new PolymarketWsAdapter(wsManager, logger);

// ── Создаём сервис сбора данных ───────────────────────────────────────────────

const service = new CollectorService(wsAdapter, config, logger);

// ── Graceful shutdown ─────────────────────────────────────────────────────────

/**
 * Выполняет graceful shutdown: останавливает сервис и отключает WS.
 *
 * @param signal - Имя сигнала (SIGINT или SIGTERM)
 */
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down`);
  try {
    await service.stop();
    await wsAdapter.disconnect();
    logger.info('Shutdown complete');
  } catch (err) {
    logger.error('Error during shutdown', {
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// ── Запуск ────────────────────────────────────────────────────────────────────

try {
  // Подписываемся на токены до запуска сервиса
  for (const tokenId of config.tokenIds) {
    await wsAdapter.subscribeToToken(tokenId);
  }

  // Запускаем маршрутизацию (регистрирует рынки, подписывается на WS-события)
  service.start();

  // Подключаемся к WebSocket (инициирует соединение и переподписки)
  await wsAdapter.connect();

  logger.info('Collector is running — press Ctrl+C to stop');
} catch (err) {
  logger.fatal('Failed to start collector', {
    err: err instanceof Error ? err : new Error(String(err)),
  });
  process.exit(1);
}
