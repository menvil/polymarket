/**
 * Composition root контура сбора после Collector-cutover.
 *
 * @remarks
 * Единственное место, где собираются шина, recorder, control-plane и source-ы.
 * Ключевой сдвиг cutover: коллектор больше НЕ владеет источниками — он
 * выражает спрос (`collector:raw`) через общий control-plane и записывает
 * интересующие рынки как обычный подписчик шины.
 *
 * ```text
 * MarketDiscovery → MarketUniverse
 *        │                 ▲
 *        │        collector demand (collector:raw + PolymarketPolicy)
 *        ▼                 │
 * PolymarketControlRuntime.runOnce()
 *        ▼
 * PolymarketSubscriptionController → PolymarketSource ──┐
 *                                                       │
 * collector CEX demand (collector:raw:<exchange> + CexPolicy)
 *        ▼                                              │
 * CexSubscriptionController → CexSource generations ────┤
 *                                                       ▼
 *                                              ExternalMessageBus
 *                                                ├── Collector (recorder + gate)
 *                                                └── (semantic adapter — sibling)
 * ```
 *
 * Второй copy composition root в репозитории быть не должно: расхождение
 * «проверенного» и «работающего» контура — тот класс дефектов, который
 * verification обязан ловить, а не создавать.
 */
import { createPublicClient } from '@polymarket/client';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import { LiveHighResolutionClock, MessageMetadataGenerator } from '@polymarket/messages';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { PolymarketMarketDiscovery, PolymarketSource } from '@polymarket/polymarket-v2';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import { MarketUniverse } from '@polymarket/market-discovery';
import { PolymarketSubscriptionPlanner } from '@polymarket/subscription-planning';
import { PolymarketSubscriptionController } from '@polymarket/polymarket-subscription-control';
import { PolymarketControlRuntime } from '@polymarket/polymarket-control-runtime';
import type { PolymarketSubscriptionDemand } from '@polymarket/polymarket-control-runtime';
import { CexSubscriptionController } from '@polymarket/cex-subscription-control';
import type { CexSubscriptionDemand } from '@polymarket/cex-subscription-control';
import { CexSource } from '@polymarket/cex-v2';
import type { CexExternalMessage } from '@polymarket/cex-v2';
import {
  CexWindowRecorder,
  DataRecorder,
  GzipCompressor,
  NDJSONFormatter,
} from '@polymarket/data-collection';
import { ExternalMessageRecorder } from '@polymarket/external-message-recorder';
import { COLLECTOR_RAW_OWNER_KEY, PolymarketCollectionGate } from '@polymarket/collector';
import type {
  CexExchangeConfig,
  CexTransportConfig,
  DataCollectorConfig,
} from './DataCollectorConfig.js';
import { cexTransportKey } from './DataCollectorConfig.js';
import { DataCollector } from './DataCollector.js';

/**
 * Union сообщений всех raw sources контура на ОДНОЙ шине.
 *
 * @remarks
 * Общий тип шины — это и есть raw-event boundary системы: семантический
 * adapter подписывается на него, а не на API коллектора.
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
   * Передача снаружи — extension point: consumer (semantic adapter,
   * verification-наблюдатель) создаёт bus, подписывается на него и только
   * потом отдаёт его коллектору. Обратной зависимости нет.
   */
  readonly bus?: ContourBus;
  /** Общий SDK-клиент. Если не передан — создаётся фабрикой. */
  readonly client?: ContourPolymarketClient;
}

/** Результат сборки контура. */
export interface CreatedDataCollector {
  /** Рантайм сбора. */
  readonly collector: DataCollector;
  /** Общий raw bus контура (для подписки consumer-а ДО `start()`). */
  readonly bus: ContourBus;
  /** Общий SDK-клиент контура (для диагностики; закрывает его `collector.close()`). */
  readonly client: ContourPolymarketClient;
}

/**
 * Строит owner key CEX-спроса для профиля конфигурации.
 *
 * @param profileKey - Ключ записи `cex-config.json`
 * @returns Ключ вида `collector:raw:<profile>` (стабильный, непрозрачный)
 *
 * @remarks
 * Владельца идентифицирует ПРОФИЛЬ, а не биржа. Одна биржа законно описывается
 * несколькими профилями (`binance-spot`, `binance-futures` с одинаковым
 * `exchangeId`), а CEX-контроллер запрещает дубликат `ownerKey` в одном
 * `reconcile` и отверг бы весь спрос ещё до каких-либо изменений. Ключ профиля
 * уникален по построению — это ключ JSON-объекта.
 */
function cexOwnerKeyFor(profileKey: string): string {
  return `${COLLECTOR_RAW_OWNER_KEY}:${profileKey}`;
}

/**
 * Собирает CEX-спрос коллектора из описаний профилей конфигурации.
 *
 * @param exchanges - Описания профилей (`parseCexExchangeConfigs`)
 * @returns Спрос по владельцу на профиль
 *
 * @remarks
 * Экспортируется, чтобы инвариант «профили одной биржи дают РАЗНЫХ владельцев»
 * проверялся тестом против настоящего `CexSubscriptionController`, а не через
 * подъём всей композиции.
 *
 * @example
 * ```typescript
 * const demands = buildCexDemands(config.cex.exchanges);
 * await cexController.reconcile(demands, now);
 * ```
 */
export function buildCexDemands(
  exchanges: readonly CexExchangeConfig[],
): readonly CexSubscriptionDemand[] {
  return exchanges.map((exchange) => ({
    ownerKey: cexOwnerKeyFor(exchange.profileKey),
    policy: exchange.policy,
  }));
}

/**
 * Строит индекс транспорта по паре «биржа + вид рынка».
 *
 * @param exchanges - Описания профилей (`parseCexExchangeConfigs`)
 * @returns Индекс, из которого фабрика источников берёт транспорт пула
 *
 * @remarks
 * Ключ — {@link cexTransportKey}, а не один `exchangeId`: контроллер ключует
 * физический пул тройкой `exchangeId + marketType + stream`, и адресация одной
 * биржей схлопнула бы spot и future одного экземпляра биржи. Конфликт двух
 * профилей на один пул уже отвергнут при разборе конфигурации, поэтому
 * перезаписи здесь быть не может.
 */
export function buildCexTransportIndex(
  exchanges: readonly CexExchangeConfig[],
): ReadonlyMap<string, CexTransportConfig> {
  return new Map(
    exchanges.map((exchange) => [
      cexTransportKey(exchange.exchangeId, exchange.marketType),
      exchange.transport,
    ]),
  );
}

/**
 * Собирает полный контур сбора и возвращает рантайм вместе с общим bus.
 *
 * @param options - Конфигурация, логгер, часы и (опционально) готовый bus/клиент
 * @returns Рантайм и общий raw bus контура
 *
 * @remarks
 * Инварианты сборки:
 * - ОДИН `ExternalMessageBus` на процесс;
 * - ОДИН `ExternalMessageRecorder` (Collector) как recording-consumer с
 *   политикой допуска `PolymarketCollectionGate` в качестве `sessionProvider`;
 * - PM source ПРИНАДЛЕЖИТ контуру и разделён с discovery/контроллером;
 * - CEX source-ы создаёт и закрывает CEX-контроллер через фабрику;
 * - policy допуска коллектора == policy его PM-спроса (иначе подписались бы на
 *   одно, а записывали другое).
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
      ...(config.cex.windowMinutes !== undefined ? { windowMinutes: config.cex.windowMinutes } : {}),
    },
    logger,
  );

  // ── Polymarket control-plane ──────────────────────────────────────────
  const discovery = new PolymarketMarketDiscovery(
    { client, clock, logger },
    config.discoveryWindowMs !== undefined ? { endDateWindowMs: config.discoveryWindowMs } : {},
  );
  const universe = new MarketUniverse(clock);
  const planner = new PolymarketSubscriptionPlanner();
  const polymarketSource = new PolymarketSource({ client, bus, metadataGenerator, logger });
  const polymarketController = new PolymarketSubscriptionController({
    discovery,
    source: polymarketSource,
    clock,
    logger,
  });
  const polymarketControlRuntime = new PolymarketControlRuntime({
    discovery,
    universe,
    planner,
    controller: polymarketController,
    clock,
    logger,
  });

  // ── Collector: recorder + политика допуска (universe + owner policy) ──
  const gate = new PolymarketCollectionGate({
    universe,
    policy: config.polymarketPolicy,
    logger,
  });
  const recorder = new ExternalMessageRecorder({
    bus,
    storage: polymarketStorage,
    logger,
    sessionProvider: gate.sessionProvider(),
    ...(config.cex.exchanges.length > 0 ? { cex: { bus, storage: cexStorage } } : {}),
  });

  // ── CEX control-plane: контроллер создаёт immutable-поколения источников ─
  // Транспорт адресуется парой `exchangeId + marketType` — так же, как
  // контроллер ключует физический пул. Адресация одной биржей схлопнула бы
  // spot и future одного экземпляра биржи, и один транспорт молча затирал бы
  // другой.
  const cexTransportByPool = buildCexTransportIndex(config.cex.exchanges);
  const cexController = new CexSubscriptionController({
    sourceFactory: (sourceConfig) => {
      const transport = cexTransportByPool.get(
        cexTransportKey(sourceConfig.exchangeId, sourceConfig.marketType),
      );
      return new CexSource({
        config: {
          ...sourceConfig,
          ...(transport?.orderbookMethod !== undefined
            ? { orderbookMethod: transport.orderbookMethod }
            : {}),
          ...(transport?.restartIntervalMs !== undefined
            ? { restartIntervalMs: transport.restartIntervalMs }
            : {}),
        },
        bus,
        metadataGenerator,
        logger,
      });
    },
    logger,
  });

  // ── Спрос коллектора: PM (один owner) и CEX (owner на биржу) ──────────
  const polymarketDemands: readonly PolymarketSubscriptionDemand[] = [
    {
      ownerKey: COLLECTOR_RAW_OWNER_KEY,
      policy: config.polymarketPolicy,
      acquireLimit: config.control.acquireLimit,
    },
  ];
  const cexDemands: readonly CexSubscriptionDemand[] = buildCexDemands(config.cex.exchanges);

  const collector = new DataCollector({
    components: {
      bus,
      recorder,
      gate,
      polymarketStorage,
      cexStorage,
      polymarketSource,
      polymarketClient: client,
      polymarketControlRuntime,
      polymarketController,
      cexController,
      polymarketDemands,
      cexDemands,
    },
    control: config.control,
    clock,
    logger,
  });

  return { collector, bus, client };
}
