/**
 * Точка входа production-коллектора рыночных данных.
 *
 * @remarks
 * Тонкий bootstrap: загрузить конфигурацию → создать логгер/часы →
 * применить process-требования → собрать контур → установить обработку
 * сигналов → запустить. Ни рыночного состояния, ни WS-обработчиков, ни
 * очередей обогащения, ни ротации файлов здесь нет — всем этим владеют
 * компоненты контура (см. `runtime/`).
 *
 * ```text
 * loadConfig → logger/clock → processBootstrap → createDataCollector
 *            → installShutdownHandlers → collector.start()
 * ```
 *
 * ### Запуск
 *
 * ```bash
 * # Dev (hot-reload):
 * npm run dev
 *
 * # Production (после npm run build):
 * npm start
 * ```
 */
import { ColorConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { loadConfig } from './config.js';
import {
  applyProcessBootstrap,
  createDataCollector,
  installShutdownHandlers,
  toDataCollectorConfig,
} from './runtime/index.js';

const LOG_LEVELS: Record<string, LogLevel> = {
  TRACE: LogLevel.TRACE,
  DEBUG: LogLevel.DEBUG,
  INFO: LogLevel.INFO,
  WARN: LogLevel.WARN,
  ERROR: LogLevel.ERROR,
  FATAL: LogLevel.FATAL,
};

const config = loadConfig();
const clock = new LiveClock();
const logger = new ColorConsoleLogger(
  clock,
  LOG_LEVELS[process.env['LOG_LEVEL'] ?? 'INFO'] ?? LogLevel.INFO,
);

// Конверсия валидирует внешнюю конфигурацию (в т.ч. `cex-config.json`) и
// падает на невалидной. Без этого перехвата отказ ушёл бы в stderr голым
// stack trace-ом мимо логгера — в production-логах его было бы не найти.
let runtimeConfig;
try {
  runtimeConfig = toDataCollectorConfig(config);
} catch (error) {
  logger.fatal('Invalid collector configuration', {
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exit(1);
}

logger.info('Starting Polymarket data collector', {
  outputDir: runtimeConfig.outputDir,
  sourceSubDir: runtimeConfig.polymarket.sourceSubDir,
  compression: runtimeConfig.polymarket.compression,
  acquireLimit: runtimeConfig.control.acquireLimit,
  controlTickMs: runtimeConfig.control.tickMs,
  policyFamily: runtimeConfig.polymarketPolicy.family,
  policyAssets: runtimeConfig.polymarketPolicy.assets ?? [],
  cexExchanges: runtimeConfig.cex.policies.flatMap((policy) => policy.exchangeIds),
});

const bootstrap = await applyProcessBootstrap({
  dnsOverrideEnabled: config.dnsOverrideEnabled,
  logger,
});

const { collector } = createDataCollector({ config: runtimeConfig, logger, clock });

// Единственный охраняемый путь остановки устанавливается ДО start(): отказ
// запуска и сигнал во время него сходятся в тот же shutdown.
const stopped = installShutdownHandlers({ target: collector, bootstrap, logger });

// Периодический operational-снимок: одна строка вместо набора таймеров.
const statusInterval = setInterval(() => {
  const status = collector.status();
  const memory = process.memoryUsage();
  logger.info('Collector status', {
    uptimeMin: status.uptimeMs === null ? null : Math.round(status.uptimeMs / 60_000),
    pmActiveMarkets: status.polymarket.activeMarkets,
    pmClaims: status.polymarket.claims,
    pmRtdsFeeds: status.polymarket.rtdsFeeds.length,
    admitted: status.gate.admitted,
    ignoredUnknown: status.gate.ignoredUnknownMarket,
    ignoredByPolicy: status.gate.ignoredByPolicy,
    cexDesiredPools: status.cex.desiredPools,
    cexPhysicalPools: status.cex.physicalPools,
    cexFailedPools: status.cex.failedPools,
    recordsWritten: status.recorder.recordsWritten,
    cexRecords: status.recorderCex.cexRecordsAccepted,
    cexPartitions: status.cexWindows.partitionsCompleted,
    busQueue: status.bus.queueSize,
    pmSourceFailed: status.polymarketSource.hasFailed,
    rssMb: Math.round(memory.rss / (1024 * 1024)),
    heapUsedMb: Math.round(memory.heapUsed / (1024 * 1024)),
  });
}, 60_000);
statusInterval.unref();

let started = false;
try {
  await collector.start();
  started = true;
} catch (error) {
  // start() уже откатил всё, что успел поднять, — держать процесс живым
  // нечем и незачем; зарегистрированные обработчики сигналов event loop
  // не удерживают, поэтому процесс завершится сам.
  logger.fatal('Data collector failed to start', {
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exitCode = 1;
  clearInterval(statusInterval);
  bootstrap.dispose();
}

if (started) {
  logger.info('Collector running. Press Ctrl+C to stop.');
  await stopped;
  clearInterval(statusInterval);
}
