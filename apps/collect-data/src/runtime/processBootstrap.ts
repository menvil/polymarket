/**
 * Process-level подготовка и завершение процесса коллектора.
 *
 * @remarks
 * Всё, что относится к процессу, а не к контуру сбора: обход DNS и один
 * охраняемый путь остановки по сигналу. Рантайм об этом не знает —
 * `DataCollector` остаётся чистой composition без process-специфики.
 */
import type { ILogger } from '@polymarket/logger';
import { DnsOverride } from '@polymarket/dns-override';

/**
 * Хосты, которые контур V2 действительно резолвит.
 *
 * @remarks
 * Список выведен из фактических вызовов V2-пути, а не скопирован из
 * legacy-коллектора:
 * - `gamma-api` — discovery (`listMarkets`) и enrichment (`fetchMarket`/`fetchEvent`);
 * - `clob` — REST официального SDK;
 * - `ws-subscriptions-clob` — market-подписки `PolymarketSource`;
 * - `ws-live-data` — RTDS-фиды крипто-цен.
 *
 * `data-api.polymarket.com` из legacy-списка исключён сознательно: он
 * обслуживает пользовательские позиции/сделки и в пути сбора не участвует.
 * Хосты бирж не входят в список: CCXT резолвит их системным DNS, который
 * для них не блокируется.
 */
const V2_COLLECTOR_HOSTS: readonly string[] = [
  'gamma-api.polymarket.com',
  'clob.polymarket.com',
  'ws-subscriptions-clob.polymarket.com',
  'ws-live-data.polymarket.com',
];

/** Результат подготовки процесса. */
export interface ProcessBootstrap {
  /** Снимает установленные process-level патчи. */
  readonly dispose: () => void;
}

/**
 * Применяет process-level требования до любых сетевых вызовов.
 *
 * @param options - Признак включения DNS-обхода и логгер
 * @returns Хэндл для снятия установленных патчей
 *
 * @remarks
 * DNS-обход опционален (`DNS_OVERRIDE_ENABLED`) и нужен только на машинах с
 * подменённым DNS провайдера; его отказ не мешает старту — процесс
 * продолжает с системным DNS.
 *
 * @example
 * ```typescript
 * const bootstrap = await applyProcessBootstrap({ dnsOverrideEnabled: true, logger });
 * // ... работа ...
 * bootstrap.dispose();
 * ```
 */
export async function applyProcessBootstrap(options: {
  readonly dnsOverrideEnabled: boolean;
  readonly logger: ILogger;
}): Promise<ProcessBootstrap> {
  const { dnsOverrideEnabled, logger } = options;
  if (!dnsOverrideEnabled) {
    logger.debug('DNS override disabled (DNS_OVERRIDE_ENABLED != true)');
    return { dispose: () => undefined };
  }

  const dnsOverride = new DnsOverride(logger);
  try {
    await dnsOverride.install([...V2_COLLECTOR_HOSTS]);
    logger.info('DNS override installed', { hosts: V2_COLLECTOR_HOSTS.length });
  } catch (error) {
    logger.warn('DNS override install failed, continuing with system DNS', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    dispose: () => {
      dnsOverride.uninstall();
    },
  };
}

/** Что останавливать по сигналу. */
export interface ShutdownTarget {
  /** Остановка контура (идемпотентна). */
  readonly close: () => Promise<void>;
}

/**
 * Устанавливает единственный охраняемый путь остановки процесса.
 *
 * @param options - Цель остановки, process-хэндл и логгер
 * @returns Promise, разрешающийся после завершения остановки
 *
 * @remarks
 * Повторный сигнал НЕ запускает вторую параллельную остановку: `SIGINT`,
 * `SIGTERM` и фатальная ошибка сходятся в один путь, который выполняется
 * ровно один раз. `process.exit()` не вызывается — процесс обязан
 * завершиться сам, когда не осталось живых хэндлов; принудительный выход
 * замаскировал бы утечку таймера или незакрытый поток.
 *
 * @example
 * ```typescript
 * const stopped = installShutdownHandlers({ target: collector, bootstrap, logger });
 * await collector.start();
 * await stopped;
 * ```
 */
export function installShutdownHandlers(options: {
  readonly target: ShutdownTarget;
  readonly bootstrap: ProcessBootstrap;
  readonly logger: ILogger;
}): Promise<void> {
  const { target, bootstrap, logger } = options;
  let shutdownRun: Promise<void> | null = null;

  const shutdown = (reason: string): Promise<void> => {
    if (shutdownRun !== null) {
      logger.info('Shutdown already in progress, ignoring signal', { reason });
      return shutdownRun;
    }
    logger.info('Shutting down', { reason });
    shutdownRun = (async () => {
      try {
        await target.close();
      } catch (error) {
        logger.error('Collector close failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        bootstrap.dispose();
        logger.info('Shutdown complete');
      }
    })();
    return shutdownRun;
  };

  return new Promise<void>((resolve) => {
    const finish = (reason: string): void => {
      void shutdown(reason).then(resolve, resolve);
    };
    process.once('SIGINT', () => finish('SIGINT'));
    process.once('SIGTERM', () => finish('SIGTERM'));
    process.on('uncaughtException', (error) => {
      logger.fatal('Uncaught exception, shutting down', { error: error.stack ?? error.message });
      process.exitCode = 1;
      finish('uncaughtException');
    });
    process.on('unhandledRejection', (reason) => {
      logger.fatal('Unhandled rejection, shutting down', {
        error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
      });
      process.exitCode = 1;
      finish('unhandledRejection');
    });
  });
}
