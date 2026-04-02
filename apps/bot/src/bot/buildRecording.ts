/**
 * Builder: создание и подключение инфраструктуры записи данных.
 *
 * @remarks
 * Использует тот же подход что `packages/apps/collect-data`:
 * - `wsAdapter.onRawMessage` → `recorder.recordEvent` для ВСЕХ WS-событий
 * - RTDS `onPrice` → `recorder.recordEvent` для crypto_price событий
 * - `recorder.registerMarket` с `rawMarket` для meta-строки
 *
 * Единый модуль для paper и live режимов.
 *
 * @example
 * ```typescript
 * const recording = buildRecording(config.recording, logger);
 * if (recording) {
 *   recording.wireToWs(wsAdapter);
 *   recording.wireToRtds(rtdsClient);
 *   // При открытии рынка:
 *   recording.openMarket(candidate);
 *   // При закрытии:
 *   await recording.closeMarket(marketId, 'EXPIRED');
 * }
 * ```
 */

import type { ILogger } from '@polymarket/logger';
import type { IMarketDataRecorder, IDecisionJournal, MarketMeta, DiscoveredMarket } from '@polymarket/ports';
import type { IEventBus } from '@polymarket/event-bus';
import type { MarketId } from '@polymarket/ids';
import type { RecordingConfig } from '../config/BotConfig.js';
import { parseCryptoMeta } from '@polymarket/exchange/adapters';
import {
  DataRecorder,
  NDJSONFormatter,
  GzipCompressor,
  DecisionJournalRecorder,
} from '@polymarket/data-collection';

/**
 * Интерфейс WS-адаптера для recording (минимальный).
 */
interface WsEmitterForRecording {
  onRawMessage(cb: (tokenId: string, rawMsg: unknown) => void): () => void;
}

/**
 * Интерфейс RTDS-клиента для recording (минимальный).
 */
interface RtdsClientForRecording {
  onPrice(cb: (symbol: string, price: number, ts: number) => void): void;
}

/**
 * Результат создания инфраструктуры записи.
 */
export interface RecordingInfra {
  readonly dataRecorder: IMarketDataRecorder;
  readonly journal: IDecisionJournal;

  /**
   * Подключает запись к WS-адаптеру (onRawMessage → recordEvent).
   * Вызвать ОДИН раз после создания wsAdapter.
   */
  wireToWs(wsAdapter: WsEmitterForRecording): void;

  /**
   * Подключает запись к RTDS-клиенту (onPrice → recordEvent для crypto_price).
   * Вызвать ОДИН раз после создания rtdsClient.
   */
  wireToRtds(rtdsClient: RtdsClientForRecording): void;

  /**
   * Регистрирует рынок для записи (meta + WS routing + RTDS routing).
   * Вызывать при открытии рынка.
   *
   * @param candidate - Рынок из discovery (с rawMarket, allTokenIds, etc.)
   * @param meta - Метаданные для DataRecorder.registerMarket
   * @param mode - Режим работы (для journal)
   */
  openMarket(candidate: DiscoveredMarket, meta: MarketMeta, mode: 'live' | 'paper'): void;

  /**
   * Подключает journal к EventBus для записи order/fill событий.
   * Вызвать ОДИН раз при старте.
   *
   * @param eventBus - Шина событий
   * @param assetToTokenId - Конвертер AssetId → tokenId string (для роутинга в journal)
   */
  wireToEventBus(eventBus: IEventBus, assetToTokenId?: (asset: unknown) => string | undefined): void;

  /**
   * Записывает market_resolved event в snapshot (strike + resolution price).
   * Вызывать при settlement перед closeMarket.
   */
  recordResolved(tokenId: string, symbol: string, strikePrice: number, resolutionPrice: number, outcome: string): void;

  /**
   * Финализирует рынок (flush + compress + journal endSession).
   * Вызывать при закрытии/истечении рынка.
   */
  closeMarket(marketId: MarketId, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void>;

  /**
   * Закрывает все сессии и recorder.
   */
  close(): Promise<void>;
}

/**
 * Создаёт инфраструктуру записи данных.
 *
 * @param config - Конфигурация записи (из BotConfig.recording)
 * @param logger - Логгер
 * @returns RecordingInfra или undefined если запись отключена
 */
export function buildRecording(
  config: RecordingConfig | undefined,
  logger: ILogger,
): RecordingInfra | undefined {
  if (!config?.enabled) {
    logger.info('Recording disabled');
    return undefined;
  }

  const log = logger.child({ component: 'Recording' });

  const formatter = new NDJSONFormatter();
  const compressor = config.compression === 'gzip' ? new GzipCompressor() : null;

  const dataRecorder = new DataRecorder(
    {
      outputDir: config.outputDir,
      bufferSize: 100,
      flushIntervalMs: 10_000,
      compression: config.compression,
    },
    formatter,
    compressor,
    log,
  );

  const journal = new DecisionJournalRecorder(
    { journalDir: config.journalDir },
    log,
  );

  /**
   * RTDS symbol → Set<tokenId> для маршрутизации записи крипто-цен.
   * Несколько рынков могут следить за одним символом (BTC 430-445 и BTC 435-440).
   */
  const symbolToTokenIds = new Map<string, Set<string>>();

  log.warn('Recording enabled', {
    outputDir: config.outputDir,
    journalDir: config.journalDir,
    compression: config.compression,
  });

  return {
    dataRecorder,
    journal,

    wireToWs(wsAdapter: WsEmitterForRecording): void {
      // Записываем ВСЕ сырые WS-сообщения (тот же подход что collect-data)
      wsAdapter.onRawMessage((tokenId, rawMsg) => {
        dataRecorder.recordEvent(tokenId, rawMsg);
      });
      log.debug('WS recording wired (onRawMessage)');
    },

    wireToRtds(rtdsClient: RtdsClientForRecording): void {
      // Записываем крипто-цены в snapshot файл каждого рынка с этим символом
      rtdsClient.onPrice((symbol, price, ts) => {
        const tokenIds = symbolToTokenIds.get(symbol);
        if (!tokenIds || tokenIds.size === 0) return;
        const source = symbol.includes('/') ? 'chainlink' : 'binance';
        for (const tokenId of tokenIds) {
          dataRecorder.recordEvent(tokenId, { t: 'crypto_price', symbol, price, ts, source });
        }
      });
      log.debug('RTDS recording wired (crypto_price)');
    },

    wireToEventBus(eventBus: IEventBus, assetToTokenId?: (asset: unknown) => string | undefined): void {
      // Маппинг orderId → tokenId для роутинга fills в journal
      const orderToToken = new Map<string, string>();
      eventBus.subscribe('ORDER_CREATED', (event) => {
        // AssetId → tokenId: используем конвертер если передан, иначе String
        const tokenId = assetToTokenId?.(event.asset) ?? String(event.asset ?? '');
        const orderId = String(event.orderId);
        if (tokenId) orderToToken.set(orderId, tokenId);
        // Записываем размещение ордера в journal (время placement для latency)
        journal.recordOrder({
          marketId: tokenId,
          ts: Date.now(),
          orderId,
          side: event.side as 'BUY' | 'SELL',
          price: event.price.value().toFixed(4),
          size: event.size.value().toFixed(2),
        });
      });

      // Записываем fill события в journal
      eventBus.subscribe('ORDER_FILLED', (event) => {
        const price = event.fill.price.value();
        const size = event.fill.size.value();
        const tokenId = orderToToken.get(String(event.orderId)) ?? '';
        journal.recordFill({
          marketId: tokenId, // journal резолвит tokenId → marketId через _instrumentIndex
          ts: Date.now(),
          orderId: String(event.orderId),
          side: event.fill.side as 'BUY' | 'SELL',
          price: price.toFixed(4),
          size: size.toFixed(2),
          notional: price.times(size).toFixed(4),
          partial: false,
        });
      });
      eventBus.subscribe('ORDER_PARTIALLY_FILLED', (event) => {
        const price = event.fill.price.value();
        const size = event.fill.size.value();
        const tokenId = orderToToken.get(String(event.orderId)) ?? '';
        journal.recordFill({
          marketId: tokenId, // journal резолвит tokenId → marketId через _instrumentIndex
          ts: Date.now(),
          orderId: String(event.orderId),
          side: event.fill.side as 'BUY' | 'SELL',
          price: price.toFixed(4),
          size: size.toFixed(2),
          notional: price.times(size).toFixed(4),
          partial: true,
        });
      });
      log.debug('EventBus recording wired (fills)');
    },

    openMarket(candidate: DiscoveredMarket, meta: MarketMeta, mode: 'live' | 'paper'): void {
      // Регистрируем рынок в DataRecorder
      dataRecorder.registerMarket(meta);

      // RTDS маршрутизация для крипто-рынков
      const cryptoMeta = parseCryptoMeta(candidate.rawMarket);
      if (cryptoMeta) {
        const primaryTokenId = meta.tokenIds[0];
        if (primaryTokenId) {
          for (const sub of cryptoMeta.rtdsSubscriptions) {
            let ids = symbolToTokenIds.get(sub.filter);
            if (!ids) { ids = new Set(); symbolToTokenIds.set(sub.filter, ids); }
            ids.add(primaryTokenId);
          }
        }
      }

      // Журнал решений
      journal.startSession({
        marketId: String(meta.marketId),
        mode,
        strategyType: '',
        strategyConfig: {},
        marketQuestion: meta.question,
        tokenIds: Array.from(meta.tokenIds),
        instrumentId: String(candidate.instrumentId),
        expiresAtMs: candidate.expiresAt.toNumber(),
        eventStartMs: cryptoMeta?.eventStartTimeMs,
      });
    },

    recordResolved(tokenId: string, symbol: string, strikePrice: number, resolutionPrice: number, outcome: string): void {
      dataRecorder.recordEvent(tokenId, {
        t: 'market_resolved',
        symbol,
        strikePrice,
        resolutionPrice,
        outcome,
        ts: Date.now(),
      });
    },

    async closeMarket(marketId: MarketId, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
      await journal.endSession(marketId, reason);
      await dataRecorder.finalizeMarket(marketId, reason);

      // RTDS маршрутизация очищается на стороне caller'а (main.ts отписывает от RTDS)
    },

    async close(): Promise<void> {
      await journal.close();
      await dataRecorder.close();
    },
  };
}
