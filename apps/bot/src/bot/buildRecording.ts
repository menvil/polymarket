/**
 * Builder: создание и подключение инфраструктуры записи данных.
 *
 * @remarks
 * Использует тот же подход что `apps/collect-data`:
 * - `wsAdapter.onRawMessage` → `recorder.recordEvent` для ВСЕХ WS-событий
 * - RTDS `onPrice` → `recorder.recordEvent` для crypto_price событий
 * - CEX `recordCexEvent` → `recorder.recordEvent` для cex_ob/cex_trade событий
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
import { asInstrumentId } from '@polymarket/ids';
import type { MarketId } from '@polymarket/ids';
import type { CexNormalizedEvent } from '@polymarket/cex-market-data';
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
   * Записывает нормализованное CEX-событие в snapshot соответствующего рынка.
   *
   * @remarks
   * Передаётся как sink в `CexCollectorService` при его создании.
   * Нормализует символ CCXT (напр. "BTC/USDT") в формат RTDS-фильтра ("btcusdt")
   * для поиска связанных tokenIds в `symbolToTokenIds`.
   *
   * @param event - Нормализованное CEX-событие (cex_ob или cex_trade)
   */
  recordCexEvent(event: CexNormalizedEvent): void;

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
        const instrumentId = asInstrumentId(tokenId);
        if (instrumentId === undefined) {
          log.debug('recordEvent: invalid tokenId, skipping', { tokenId });
          return;
        }
        dataRecorder.recordEvent(instrumentId, rawMsg);
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
          const instrumentId = asInstrumentId(tokenId);
          if (instrumentId === undefined) {
            log.debug('recordEvent: invalid tokenId, skipping', { tokenId });
            continue;
          }
          dataRecorder.recordEvent(instrumentId, { t: 'crypto_price', symbol, price, ts, source });
        }
      });
      log.debug('RTDS recording wired (crypto_price)');
    },

    recordCexEvent(event: CexNormalizedEvent): void {
      // Нормализуем символ CCXT → формат RTDS-фильтра для поиска tokenIds.
      // "BTC/USDT" (binance CCXT) → "btcusdt" (binance RTDS filter)
      const normalizedSymbol = event.symbol.replace('/', '').toLowerCase();
      const tokenIds = symbolToTokenIds.get(normalizedSymbol);
      if (!tokenIds || tokenIds.size === 0) return;
      for (const tokenId of tokenIds) {
        const instrumentId = asInstrumentId(tokenId);
        if (instrumentId === undefined) {
          log.debug('recordEvent: invalid tokenId, skipping', { tokenId });
          continue;
        }
        dataRecorder.recordEvent(instrumentId, event);
      }
    },

    wireToEventBus(eventBus: IEventBus, assetToTokenId?: (asset: unknown) => string | undefined): void {
      // Маппинг orderId → tokenId для роутинга fills в journal
      const orderToToken = new Map<string, string>();
      // Маппинг orderId → price (¢) для расчёта slippage при fill
      const orderToPriceCents = new Map<string, number>();
      const recordedFillIds = new Set<string>();

      eventBus.subscribe('ORDER_CREATED', (event) => {
        // AssetId → tokenId: используем конвертер если передан, иначе String
        const tokenId = assetToTokenId?.(event.payload.asset) ?? String(event.payload.asset ?? '');
        const orderId = event.payload.orderId;
        const priceCents = event.payload.price.value().toNumber() * 100;
        if (tokenId) orderToToken.set(orderId, tokenId);
        // Сохраняем цену ордера для последующего расчёта slippage при fill
        orderToPriceCents.set(orderId, priceCents);
        // Записываем размещение ордера в journal (время placement для latency)
        journal.recordOrder({
          marketId: tokenId,
          ts: Date.now(),
          orderId,
          side: event.payload.side as 'BUY' | 'SELL',
          price: event.payload.price.value().toFixed(4),
          size: event.payload.size.value().toFixed(2),
        });
      });

      /**
       * Вычисляет slippage (¢) между ценой fill и ценой ордера.
       *
       * @remarks
       * Знак конвенция: slippage = fillPrice − orderPrice (в центах).
       * - BUY: отрицательный → цена ниже плановой (улучшение); положительный → выше (ухудшение).
       * - SELL: положительный → цена выше плановой (улучшение); отрицательный → ниже (ухудшение).
       *
       * @param orderId - ID ордера
       * @param fillPriceCents - Цена исполнения (¢)
       * @returns { orderPriceCents, slippageCents } или undefined если ордер не найден
       */
      function computeSlippage(
        orderId: string,
        fillPriceCents: number,
      ): { orderPriceCents: number; slippageCents: number } | undefined {
        const orderPrice = orderToPriceCents.get(orderId);
        if (orderPrice === undefined) return undefined;
        return { orderPriceCents: orderPrice, slippageCents: fillPriceCents - orderPrice };
      }

      // FILL_RECEIVED fallback покрывает direct fills на уже terminal/cancelled ордера,
      // где ORDER_FILLED не публикуется. Откладываем на следующий tick, чтобы обычный
      // ORDER_FILLED/ORDER_PARTIALLY_FILLED успел записать точный partial/full статус.
      eventBus.subscribe('FILL_RECEIVED', (event) => {
        const fillId = String(event.payload.fill.id);
        setTimeout(() => {
          if (recordedFillIds.has(fillId)) return;
          recordedFillIds.add(fillId);

          const price = event.payload.fill.price.value();
          const size = event.payload.fill.size.value();
          const tokenId = assetToTokenId?.(event.payload.fill.tokenId) ?? String(event.payload.fill.tokenId ?? '');
          const orderId = event.payload.fill.orderId;
          const slippage = computeSlippage(orderId, price.toNumber() * 100);
          journal.recordFill({
            marketId: tokenId,
            ts: Date.now(),
            orderId,
            side: event.payload.fill.side as 'BUY' | 'SELL',
            price: price.toFixed(4),
            size: size.toFixed(2),
            notional: price.times(size).toFixed(4),
            partial: false,
            ...slippage,
          });
        }, 0);
      });

      // ORDER_* остаются fallback для synthetic/test flows, но dedupe защищает
      // normal live path от дублей после FILL_RECEIVED.
      eventBus.subscribe('ORDER_FILLED', (event) => {
        const fillId = String(event.payload.fill.id);
        if (recordedFillIds.has(fillId)) return;
        recordedFillIds.add(fillId);

        const price = event.payload.fill.price.value();
        const size = event.payload.fill.size.value();
        const orderId = event.payload.orderId;
        const tokenId = orderToToken.get(orderId) ?? '';
        const slippage = computeSlippage(orderId, price.toNumber() * 100);
        journal.recordFill({
          marketId: tokenId, // journal резолвит tokenId → marketId через _instrumentIndex
          ts: Date.now(),
          orderId,
          side: event.payload.fill.side as 'BUY' | 'SELL',
          price: price.toFixed(4),
          size: size.toFixed(2),
          notional: price.times(size).toFixed(4),
          partial: false,
          ...slippage,
        });
        // Очищаем price-кэш после полного fill — ордер больше не нужен
        orderToPriceCents.delete(orderId);
      });

      eventBus.subscribe('ORDER_PARTIALLY_FILLED', (event) => {
        const fillId = String(event.payload.fill.id);
        if (recordedFillIds.has(fillId)) return;
        recordedFillIds.add(fillId);

        const price = event.payload.fill.price.value();
        const size = event.payload.fill.size.value();
        const orderId = event.payload.orderId;
        const tokenId = orderToToken.get(orderId) ?? '';
        const slippage = computeSlippage(orderId, price.toNumber() * 100);
        journal.recordFill({
          marketId: tokenId, // journal резолвит tokenId → marketId через _instrumentIndex
          ts: Date.now(),
          orderId,
          side: event.payload.fill.side as 'BUY' | 'SELL',
          price: price.toFixed(4),
          size: size.toFixed(2),
          notional: price.times(size).toFixed(4),
          partial: true,
          ...slippage,
        });
        // Не удаляем из price-кэша — ордер может быть заполнен частично ещё раз
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
        marketId: meta.marketId,
        mode,
        strategyType: '',
        strategyConfig: {},
        marketQuestion: meta.question,
        tokenIds: Array.from(meta.tokenIds),
        instrumentId: candidate.instrumentId,
        expiresAtMs: candidate.expiresAt.toNumber(),
        eventStartMs: cryptoMeta?.eventStartTimeMs,
      });
    },

    recordResolved(tokenId: string, symbol: string, strikePrice: number, resolutionPrice: number, outcome: string): void {
      const instrumentId = asInstrumentId(tokenId);
      if (instrumentId === undefined) {
        log.debug('recordEvent: invalid tokenId, skipping', { tokenId });
        return;
      }
      dataRecorder.recordEvent(instrumentId, {
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
