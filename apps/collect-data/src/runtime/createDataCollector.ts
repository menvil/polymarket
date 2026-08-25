/**
 * Composition root контура сбора: единственное место, где создаются bus,
 * recorder, source-ы и control-plane компоненты.
 *
 * @remarks
 * Фабрика существует, чтобы production-`main.ts` и verification-runner
 * checkpoint-а поднимали ОДИН И ТОТ ЖЕ контур:
 *
 * ```text
 *                createDataCollector(...)
 *                    ↑              ↑
 *              production      checkpoint
 *                 main         verification
 * ```
 *
 * Второй copy composition root в репозитории быть не должно: расхождение
 * между «проверенным» и «работающим» контуром — именно тот класс дефектов,
 * который verification обязан ловить, а не создавать.
 */
import { createPublicClient } from '@polymarket/client';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import { LiveHighResolutionClock, MessageMetadataGenerator } from '@polymarket/messages';
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { PolymarketMarketDiscovery, PolymarketSource } from '@polymarket/polymarket-v2';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import {
  CexWindowRecorder,
  DataRecorder,
  GzipCompressor,
  NDJSONFormatter,
} from '@polymarket/data-collection';
import { ExternalMessageRecorder } from '@polymarket/external-message-recorder';
import { MarketCollectionCoordinator } from '@polymarket/collection-coordinator';
import { MarketFinalizer } from '@polymarket/market-finalizer';
import { CexSource } from '@polymarket/cex-v2';
import type { CexExternalMessage } from '@polymarket/cex-v2';
import type { DataCollectorConfig } from './DataCollectorConfig.js';
import type { CollectorCexSourceEntry } from './DataCollector.js';
import { DataCollector } from './DataCollector.js';

/**
 * Union сообщений всех raw sources контура на ОДНОМ bus.
 *
 * @remarks
 * Общий тип bus-а — это и есть raw-event boundary системы: будущий
 * Semantic Adapter подписывается на него, а не на API коллектора.
 */
export type ContourMessage = PolymarketExternalMessage | CexExternalMessage;

/** Общий bus внешнего контура коллектора. */
export type ContourBus = ExternalMessageBus<ContourMessage>;

/** Официальный SDK-клиент, разделяемый компонентами Polymarket-контура. */
export type ContourPolymarketClient = ReturnType<typeof createPublicClient>;

/** Зависимости {@link createDataCollector}. */
export interface CreateDataCollectorOptions {
  /** Конфигурация рантайма (см. `DataCollectorConfig`). */
  readonly config: DataCollectorConfig;
  /** Логгер приложения. */
  readonly logger: ILogger;
  /** Источник времени. */
  readonly clock: IClock;
  /**
   * Общий raw bus. Если не передан — создаётся фабрикой.
   *
   * @remarks
   * Передача снаружи — тот самый extension point: consumer (наблюдатель
   * checkpoint-а, будущий Semantic Adapter) создаёт bus, подписывается на
   * него и только потом отдаёт его коллектору. Обратной зависимости не
   * возникает: consumer знает про bus, а не про `DataCollector`.
   */
  readonly bus?: ContourBus;
  /**
   * Общий SDK-клиент. Если не передан — создаётся фабрикой по
   * `config.polymarket.environment`.
   *
   * @remarks
   * Клиент — разделяемый ресурс source/discovery/finalizer, и его realtime
   * закрывает рантайм (`closeSubscriptions` в лестнице остановки). Инъекция
   * нужна диагностике и тестам, которым важно держать ссылку на тот же
   * экземпляр.
   */
  readonly client?: ContourPolymarketClient;
}

/** Результат сборки контура. */
export interface CreatedDataCollector {
  /** Рантайм сбора. */
  readonly collector: DataCollector;
  /**
   * Общий raw bus контура.
   *
   * @remarks
   * Возвращается, чтобы consumer мог подписаться ДО `collector.start()` —
   * recorder уже подписан, ingress ещё не начат.
   */
  readonly bus: ContourBus;
  /**
   * Общий SDK-клиент контура.
   *
   * @remarks
   * Возвращается для диагностики; закрывать его самостоятельно не нужно —
   * это делает `collector.close()`.
   */
  readonly client: ContourPolymarketClient;
}

/**
 * Собирает полный контур сбора и возвращает рантайм вместе с общим bus.
 *
 * @param options - Конфигурация, логгер, часы и (опционально) готовый bus
 * @returns Рантайм и общий raw bus контура
 *
 * @remarks
 * Инварианты сборки:
 * - ОДИН `ExternalMessageBus` на процесс (отдельных PM/CEX/RTDS bus нет);
 * - ОДИН `ExternalMessageRecorder` как общий recording-consumer, под
 *   которым живут ДВЕ storage-политики (market-сессии и CEX-окна);
 * - весь ingress идёт `source → bus`; recorder — consumer bus, а не цель
 *   прямых вызовов source-ов;
 * - обе storage-политики получают ОДИН `outputDir` (раскладка parity с
 *   legacy: `{date}/{sourceSubDir}/` для рынков, `{date}/{exchange}/` для бирж).
 *
 * @example
 * ```typescript
 * const { collector, bus } = createDataCollector({ config, logger, clock });
 * bus.subscribe('CEX_TRADE', (message) => observer.onTrade(message.payload));
 * await collector.start();
 * ```
 */
export function createDataCollector(options: CreateDataCollectorOptions): CreatedDataCollector {
  const { config, logger, clock } = options;
  const bus: ContourBus = options.bus ?? new ExternalMessageBus<ContourMessage>();
  const client: ContourPolymarketClient =
    options.client ??
    createPublicClient(
      config.polymarket.environment !== undefined
        ? { environment: config.polymarket.environment }
        : {},
    );
  const metadataGenerator = new MessageMetadataGenerator({
    clock,
    highResolutionClock: new LiveHighResolutionClock(),
  });

  // ── Storage-политики (общий корень датасетов) ─────────────────────────
  const polymarketStorage = new DataRecorder(
    {
      outputDir: config.outputDir,
      sourceSubDir: config.polymarket.sourceSubDir,
      bufferSize: config.polymarket.bufferSize,
      flushIntervalMs: config.polymarket.flushIntervalMs,
      compression: config.polymarket.compression,
      formatVersion: 2,
    },
    new NDJSONFormatter(),
    config.polymarket.compression === 'gzip' ? new GzipCompressor() : null,
    logger,
  );
  const cexStorage = new CexWindowRecorder(
    {
      outputDir: config.outputDir,
      compression: config.cex.compression,
      bufferSize: config.cex.bufferSize,
      flushIntervalMs: config.cex.flushIntervalMs,
      ...(config.cex.windowMinutes !== undefined
        ? { windowMinutes: config.cex.windowMinutes }
        : {}),
    },
    logger,
  );

  // ── ОДИН recording-consumer общего bus ────────────────────────────────
  const recorder = new ExternalMessageRecorder({
    bus,
    storage: polymarketStorage,
    logger,
    ...(config.cex.sources.length > 0 ? { cex: { bus, storage: cexStorage } } : {}),
  });

  // ── Polymarket: ingress + discovery + coordinator + finalizer ─────────
  const polymarketSource = new PolymarketSource({ client, bus, metadataGenerator, logger });
  const discovery = new PolymarketMarketDiscovery(
    { client, filter: new MarketFilter(), scorer: new MarketScorer(clock), clock, logger },
    { filter: config.discovery.filter },
  );
  const coordinator = new MarketCollectionCoordinator(
    { discovery, source: polymarketSource, recorder, clock, logger },
    {
      maxMarkets: config.collection.maxMarkets,
      ...(config.collection.minTimeToStartMs !== undefined
        ? { minTimeToStartMs: config.collection.minTimeToStartMs }
        : {}),
    },
  );
  const finalizer = new MarketFinalizer(
    { coordinator, recorder, gamma: client, clock, logger },
    config.finalization,
  );

  // ── CEX: по одному source на биржу, на ТОМ ЖЕ bus ─────────────────────
  const cexSources: readonly CollectorCexSourceEntry[] = config.cex.sources.map(
    (sourceConfig) => ({
      exchangeId: sourceConfig.exchangeId,
      source: new CexSource({ config: sourceConfig, bus, metadataGenerator, logger }),
    }),
  );

  const collector = new DataCollector({
    components: {
      bus,
      recorder,
      polymarketStorage,
      cexStorage,
      polymarketSource,
      polymarketClient: client,
      cexSources,
      discovery,
      coordinator,
      finalizer,
    },
    collection: config.collection,
    clock,
    logger,
  });

  return { collector, bus, client };
}
