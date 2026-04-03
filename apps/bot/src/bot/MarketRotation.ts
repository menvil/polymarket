/**
 * Единый модуль ротации рынков для paper и live режимов.
 *
 * @remarks
 * ### Проблема
 * Paper и live режимы имели дублированный код ротации (~1000 строк каждый).
 * Расхождения между копиями вызывали баги: разные eventStart-пороги,
 * забытые фильтры, отсутствие диагностики в одном из режимов.
 *
 * ### Решение
 * Один код, разница только в injected dependencies (`MarketRotationDeps`).
 * Paper передаёт `exchangeClient` (для `registerMarket`), live — `orderReconciler`
 * и `redeemer`.
 *
 * ### Алгоритм ротации
 * 1. `checkExpiredMarkets()` — каждые 5 сек проверяет TTL слотов.
 * 2. Истёкшие → `closeMarket()` (cancel orders, settlement, cleanup).
 * 3. Свободные слоты → `fillMarketSlots()` (discovery cache → `openMarket()`).
 * 4. `scheduleScanLoop()` — периодически обновляет discovery cache.
 *
 * @example
 * ```typescript
 * const rotation = new MarketRotation(deps);
 * await rotation.openMarket(candidate);
 * rotation.startExpiryCheck();
 * await rotation.scheduleScanLoop();
 * ```
 */

import Decimal from 'decimal.js';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { IEventBus } from '@polymarket/event-bus';
import {
  asInstrumentId,
  asPolymarketCtfToken,
  assetIdToInstrumentId,
} from '@polymarket/ids';
import type { InstrumentId, MarketId, AssetId, AccountId } from '@polymarket/ids';
import { Money, Price, Quantity, TimestampService } from '@polymarket/value-objects';
import type { DiscoveredMarket } from '@polymarket/ports';
import { parseCryptoMeta, computeInterval } from '@polymarket/exchange/adapters';
import type { CryptoMarketMeta } from '@polymarket/exchange/adapters';
import type { BinanceKlinesClient } from '@polymarket/exchange/adapters';
import type { CryptoPriceStore } from '@polymarket/market-state';
import { SimplePosition } from '@polymarket/use-cases';

import type { BotConfig, DiscoveryMarketConfig } from '../config/BotConfig.js';
import type { StrategyConfig } from '../strategyFactory.js';
import { createStrategy } from '../strategyFactory.js';
import { selectStrategyForMarket } from '../strategyRouter.js';
import type { IStrategy } from '@polymarket/strategy';
import type { StrategyEngine } from './buildStrategyEngine.js';
import type { RecordingInfra } from './buildRecording.js';
import type { CryptoSubscriptionManager } from './CryptoSubscriptionManager.js';
import type { InMemoryMarketCatalog } from '../InMemoryMarketCatalog.js';
import type { InMemoryPortfolioStore } from '@polymarket/in-memory';
import type { PolymarketMarketDiscoveryAdapter } from '@polymarket/exchange/adapters';
import type { PolymarketRedeemer } from './PolymarketRedeemer.js';

// ── Типы ────────────────────────────────────────────────────────────────────

/**
 * Запись о выполненном ордере в рыночном слоте.
 *
 * @remarks
 * Агрегирует partial fills до полного исполнения или отмены.
 * Используется для сводки по рынку (printMarketSummary).
 */
export interface FillRecord {
  side: 'BUY' | 'SELL';
  size: string;
  price: string;
  notional: string;
  at: string;
  partial?: boolean;
}

/**
 * Аккумулятор partial fills для одного ордера.
 *
 * @remarks
 * Собирает partial fills до ORDER_FILLED/ORDER_CANCELLED,
 * затем конвертируется в FillRecord.
 */
export interface PartialAccum {
  side: 'BUY' | 'SELL';
  totalSize: Decimal;
  totalNotional: Decimal;
  firstAt: string;
}

/**
 * Единый слот активного рынка для paper и live режимов.
 *
 * @remarks
 * Объединяет PaperMarketSlot и ActiveMarketSlot.
 * `tickSize` и `minOrderSize` опциональны — paper использует дефолты (0.001 / 1).
 *
 * @param instrumentId - ID инструмента (tokenId)
 * @param marketId - ID рынка (conditionId)
 * @param asset - AssetId (CTF token)
 * @param tokenIdStr - Строковое представление tokenId (ключ в activeMarkets)
 * @param expiresAtMs - Время истечения рынка (epoch ms)
 * @param tickSize - Шаг цены (live: из API, paper: default 0.001)
 * @param minOrderSize - Мин. размер ордера (live: из API, paper: default 1)
 * @param candidate - Кандидат из discovery (null для fixed markets)
 * @param strategy - Экземпляр стратегии
 * @param cryptoMeta - Метаданные крипто-рынка (undefined для не-крипто)
 * @param additionalInstrumentIds - Доп. инструменты для триггера тика (арбитраж)
 * @param complementaryInstrumentId - ID комплементарного токена (другой outcome)
 * @param complementaryAsset - AssetId комплементарного токена
 * @param outcomeIndex - Индекс outcome (0=UP, 1=DOWN)
 * @param fillHistory - История выполненных ордеров
 * @param partialAccum - Аккумуляторы partial fills
 * @param openedAt - Время открытия слота (epoch ms)
 */
export interface MarketSlot {
  readonly instrumentId: InstrumentId;
  readonly marketId: MarketId;
  readonly asset: AssetId;
  readonly tokenIdStr: string;
  readonly expiresAtMs: number;
  readonly tickSize?: Price;
  readonly minOrderSize?: Quantity;
  readonly candidate: DiscoveredMarket | null;
  readonly strategy: IStrategy;
  readonly cryptoMeta: CryptoMarketMeta | undefined;
  readonly additionalInstrumentIds?: readonly InstrumentId[];
  readonly complementaryInstrumentId?: InstrumentId;
  readonly complementaryAsset?: AssetId;
  readonly outcomeIndex: 0 | 1;
  fillHistory: FillRecord[];
  partialAccum: Map<string, PartialAccum>;
  openedAt: number;
}

/**
 * WS-адаптер для подписки/отписки от токенов.
 *
 * @remarks
 * Абстракция поверх PolymarketWsAdapter — paper и live используют
 * разные экземпляры, но с одинаковым интерфейсом.
 */
export interface IWsTokenSubscriber {
  subscribeToToken(tokenId: string): Promise<void>;
  unsubscribeFromToken(tokenId: string): Promise<void>;
}

/**
 * Paper exchange client с методом registerMarket.
 *
 * @remarks
 * В paper-режиме каждый рынок нужно зарегистрировать в MockExchangeClient
 * чтобы PaperFillSimulator мог маршрутизировать ордера.
 */
export interface IPaperExchangeClient {
  registerMarket(
    instrumentId: InstrumentId,
    marketId: MarketId,
    accountId: AccountId,
    asset: AssetId,
  ): void;
}

/**
 * Order reconciler для live-режима.
 *
 * @remarks
 * После открытия нового рынка сверяет ордера с биржей (REST).
 */
export interface IOrderReconciler {
  reconcile(accountId: AccountId): Promise<void>;
}

/**
 * Зависимости для ротации рынков.
 *
 * @remarks
 * Одинаковая структура для paper и live — разница в конкретных реализациях.
 * Mode-specific поля опциональны: paper передаёт `exchangeClient`,
 * live — `orderReconciler` и `redeemer`.
 *
 * @param logger - Логгер
 * @param clock - Часы (LiveClock для paper/live)
 * @param eventBus - Шина событий
 * @param portfolioStore - Хранилище портфелей
 * @param accountId - ID аккаунта
 * @param wsAdapter - WS-адаптер для подписки на токены
 * @param cryptoPriceStore - Хранилище крипто-цен
 * @param cryptoSubs - Менеджер подписок на RTDS
 * @param pendingChainlinkStrike - Ожидающие Chainlink strike prices
 * @param binanceClient - Клиент Binance klines API
 * @param engine - Strategy engine (scheduler, execution)
 * @param marketCatalog - Каталог инструментов
 * @param recording - Инфраструктура записи (опционально)
 * @param discoveryAdapter - Адаптер discovery (опционально, null для fixed)
 * @param config - Конфигурация бота
 * @param maxConcurrentMarkets - Макс. количество одновременных рынков
 * @param minCapitalPerMarket - Мин. капитал на один рынок (USDC)
 * @param mode - Режим: paper или live
 * @param exchangeClient - Paper exchange client (для registerMarket)
 * @param orderReconciler - Live order reconciler
 * @param redeemer - Live auto-redeemer
 */
export interface MarketRotationDeps {
  readonly logger: ILogger;
  readonly clock: IClock;
  readonly eventBus: IEventBus;
  readonly portfolioStore: InMemoryPortfolioStore;
  readonly accountId: AccountId;
  readonly wsAdapter: IWsTokenSubscriber;
  readonly cryptoPriceStore: CryptoPriceStore;
  readonly cryptoSubs: CryptoSubscriptionManager;
  readonly pendingChainlinkStrike: Map<string, number>;
  readonly binanceClient: BinanceKlinesClient;
  readonly engine: StrategyEngine;
  readonly marketCatalog: InMemoryMarketCatalog;
  readonly recording?: RecordingInfra;
  readonly config: BotConfig;
  readonly maxConcurrentMarkets: number;
  readonly minCapitalPerMarket: number;
  readonly mode: 'paper' | 'live';

  // Paper-specific
  readonly exchangeClient?: IPaperExchangeClient;

  // Live-specific
  readonly orderReconciler?: IOrderReconciler;
  readonly redeemer?: PolymarketRedeemer;
}

// ── Константы ───────────────────────────────────────────────────────────────

/**
 * Закрываем рынок за 5 сек до истечения чтобы успеть снять ордера.
 *
 * @remarks
 * CancelOrderUseCase через CANCEL_ALL при scheduler.unregister()
 * успевает за 1-2 сек, но 5 сек даёт запас на сетевые задержки.
 */
export const CANCEL_BEFORE_EXPIRY_MS = 5_000;

/**
 * Минимальное время жизни рынка (мс) для переключения.
 *
 * @remarks
 * Рынки с остатком < 30 сек не имеют смысла: ротация + подписка WS + первый тик
 * занимают ~5 сек, плюс CANCEL_BEFORE_EXPIRY_MS=5 сек на закрытие.
 */
export const MIN_VIABLE_TRADING_MS = 30_000;

/**
 * Максимальное время в будущем для eventStart (мс).
 *
 * @remarks
 * 10 минут — достаточно для подхвата следующего 5-мин рынка при ротации.
 * Polymarket создаёт рынки за 5-10 мин до eventStart.
 * Если порог слишком мал (30с), бот не может открыть следующий рынок
 * после закрытия текущего — все кандидаты отклоняются.
 */
const MAX_EVENT_START_AHEAD_MS = 10 * 60_000;

// ── Счётчик слотов (глобальный, не зависит от экземпляра) ────────────────

let _slotCounter = 0;

// ── Класс ───────────────────────────────────────────────────────────────────

/**
 * Единый модуль ротации рынков.
 *
 * @remarks
 * Управляет жизненным циклом рыночных слотов: открытие, закрытие,
 * ротация при истечении, периодическое обновление discovery кэша.
 *
 * ### Ответственности
 * - `openMarket()` — открывает слот из discovery-кандидата
 * - `closeMarket()` — закрывает слот (cancel orders, settlement, cleanup)
 * - `fillMarketSlots()` — заполняет свободные слоты из кэша
 * - `checkExpiredMarkets()` — проверяет TTL и ротирует
 * - `scheduleScanLoop()` — обновляет discovery кэш
 * - `registerFillTracking()` — подключает fill tracking через eventBus
 *
 * @example
 * ```typescript
 * const rotation = new MarketRotation(deps);
 * rotation.setDiscoveryAdapter(adapter);
 * rotation.registerFillTracking();
 * await rotation.fillMarketSlots();
 * rotation.startExpiryCheck();
 * await rotation.scheduleScanLoop();
 * ```
 */
export class MarketRotation {
  /** Активные рыночные слоты: key = tokenIdStr */
  readonly activeMarkets = new Map<string, MarketSlot>();
  /** ID комплементарных токенов для trade bridge */
  readonly activeCompTokens = new Set<string>();
  /** Маппинг orderId → tokenIdStr для роутинга fill-событий */
  readonly orderToSlot = new Map<string, string>();
  /** Закрытые рынки (blacklist — не открываем повторно) */
  readonly closedMarkets = new Set<string>();

  private readonly _deps: MarketRotationDeps;
  private _discoveryAdapter: PolymarketMarketDiscoveryAdapter | null = null;
  private _isShuttingDown = false;
  private _rotationInProgress = false;
  private _retryingFill = false;
  private _expiryCheckIntervalId: ReturnType<typeof setInterval> | null = null;
  private _scanTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: MarketRotationDeps) {
    this._deps = deps;
  }

  // ── Accessors ─────────────────────────────────────────────────────────

  get isShuttingDown(): boolean { return this._isShuttingDown; }
  set isShuttingDown(v: boolean) { this._isShuttingDown = v; }

  get discoveryAdapter(): PolymarketMarketDiscoveryAdapter | null { return this._discoveryAdapter; }

  /**
   * Устанавливает discovery адаптер для поиска рынков.
   *
   * @param adapter - Адаптер discovery
   */
  setDiscoveryAdapter(adapter: PolymarketMarketDiscoveryAdapter): void {
    this._discoveryAdapter = adapter;
  }

  // ── registerMarketAndStrategy ─────────────────────────────────────────

  /**
   * Регистрирует инструмент в каталоге и стратегию в планировщике.
   *
   * @param slot - Слот активного рынка
   * @returns true если регистрация успешна
   *
   * @remarks
   * Paper: tickSize/minOrderSize = default (0.001 / 1).
   * Live: tickSize/minOrderSize из API (candidate).
   */
  async registerMarketAndStrategy(slot: MarketSlot): Promise<boolean> {
    const { logger, wsAdapter, marketCatalog, engine, recording, accountId } = this._deps;
    const mode = this._deps.mode;

    // Подписка на WS комплементарного токена (для dual-token стратегий)
    if (slot.complementaryInstrumentId) {
      const compTokenStr = String(slot.complementaryInstrumentId);
      await wsAdapter.subscribeToToken(compTokenStr);
      this.activeCompTokens.add(compTokenStr);
      logger.info('Complementary token registered for trade bridge', {
        compTokenId: compTokenStr,
        primaryTokenId: String(slot.instrumentId),
        activeCompTokens: this.activeCompTokens.size,
      });
    }

    const expiresAtResult = TimestampService.create(slot.expiresAtMs);
    if (!expiresAtResult.ok) {
      logger.error('Failed to create expiresAt timestamp', { expiresAtMs: slot.expiresAtMs });
      return false;
    }

    const tickSize = slot.tickSize ?? Price.of(new Decimal('0.001'));
    const minOrderSize = slot.minOrderSize ?? Quantity.of(new Decimal('1'));

    marketCatalog.register({
      instrumentId: slot.instrumentId,
      marketId: slot.marketId,
      tickSize,
      minOrderSize,
      minOrderValue: Quantity.of(new Decimal('1')),
      active: true,
      expiresAt: expiresAtResult.value,
    });

    // Регистрируем комплементарный инструмент (для ExecutionEngine routing)
    if (slot.complementaryInstrumentId) {
      marketCatalog.register({
        instrumentId: slot.complementaryInstrumentId,
        marketId: slot.marketId,
        tickSize,
        minOrderSize,
        minOrderValue: Quantity.of(new Decimal('1')),
        active: true,
        expiresAt: expiresAtResult.value,
      });
    }

    // Recording: регистрируем рынок
    if (recording && slot.candidate) {
      const tokenIds = slot.complementaryInstrumentId
        ? [String(slot.instrumentId), String(slot.complementaryInstrumentId)]
        : [String(slot.instrumentId)];
      recording.openMarket(slot.candidate, {
        marketId: slot.marketId,
        question: slot.candidate.question ?? String(slot.marketId),
        tokenIds,
        expiresAt: expiresAtResult.value,
        rawMarket: slot.candidate.rawMarket,
      }, mode);
    }

    const marketStub = { expirationMs: slot.expiresAtMs } as Parameters<typeof engine.scheduler.register>[0]['market'];
    const compId = slot.complementaryInstrumentId;
    const regResult = await engine.scheduler.register({
      strategy: slot.strategy,
      instrumentId: slot.instrumentId,
      asset: slot.asset,
      accountId,
      market: marketStub,
      cryptoSymbol: slot.cryptoMeta?.rtdsFilter,
      eventStartMs: slot.cryptoMeta?.eventStartTimeMs,
      additionalInstrumentIds: slot.additionalInstrumentIds ?? (compId ? [compId] : undefined),
      complementaryInstrumentId: compId,
      complementaryAsset: slot.complementaryAsset,
    });
    if (!regResult.ok) {
      logger.error('Failed to register strategy', { error: String(regResult.error) });
      return false;
    }
    return true;
  }

  // ── openMarket ────────────────────────────────────────────────────────

  /**
   * Открывает новый рыночный слот из discovery-кандидата.
   *
   * @param candidate - Кандидат рынка из discovery
   * @returns true если рынок успешно открыт
   *
   * @remarks
   * Алгоритм:
   * 1. Проверка доступного капитала (>= minCapitalPerMarket).
   * 2. Парсинг crypto metadata + проверка eventStart (<=30с вперёд).
   * 3. Маршрутизация стратегии по правилам из конфига.
   * 4. Создание слота + подписка WS + регистрация стратегии.
   * 5. Paper: exchangeClient.registerMarket().
   * 6. Live: orderReconciler.reconcile().
   *
   * @throws Не бросает исключений — ошибки логируются, возвращает false.
   *
   * @example
   * ```typescript
   * const opened = await rotation.openMarket(candidate);
   * if (opened) console.log('Market opened');
   * ```
   */
  async openMarket(candidate: DiscoveredMarket): Promise<boolean> {
    const {
      logger, config, portfolioStore, accountId,
      cryptoSubs, wsAdapter, recording, exchangeClient, orderReconciler,
      maxConcurrentMarkets,
    } = this._deps;
    const mc = config.market as DiscoveryMarketConfig;

    // Проверяем доступный капитал
    const portfolio = portfolioStore.get(accountId);
    if (portfolio) {
      const available = portfolio.balance.available().value();
      if (available.lt(this._deps.minCapitalPerMarket)) {
        logger.warn('Insufficient capital for new market slot', {
          available: available.toFixed(2),
          minCapitalPerMarket: this._deps.minCapitalPerMarket,
          marketId: String(candidate.marketId),
        });
        return false;
      }
    }

    const expiresMs = candidate.expiresAt.toNumber();
    const slotCryptoMeta = parseCryptoMeta(candidate.rawMarket);

    // Не занимаем слот если eventStart > 10 мин вперёд
    if (slotCryptoMeta && slotCryptoMeta.eventStartTimeMs > Date.now() + MAX_EVENT_START_AHEAD_MS) {
      logger.info('Skipping market: event starts too far in the future', {
        marketId: String(candidate.marketId),
        question: candidate.question,
        eventStart: new Date(slotCryptoMeta.eventStartTimeMs).toISOString(),
        startsInMin: ((slotCryptoMeta.eventStartTimeMs - Date.now()) / 60_000).toFixed(1),
        maxAheadMin: (MAX_EVENT_START_AHEAD_MS / 60_000).toFixed(0),
      });
      return false;
    }

    // Fetch strike price и подписка RTDS для крипто-рынка
    if (slotCryptoMeta) {
      await this._resolveStrikePrice(slotCryptoMeta);
      cryptoSubs.subscribeMarket(String(candidate.instrumentId), slotCryptoMeta);
    }

    // Маршрутизация стратегии по правилам
    const marketSelection = selectStrategyForMarket(config, {
      eventStartMs: slotCryptoMeta?.eventStartTimeMs,
      expiresAtMs: expiresMs,
      question: candidate.question,
    });
    if (!marketSelection) {
      logger.debug('No strategy rule matches market, skipping', {
        marketId: String(candidate.marketId),
        question: candidate.question,
        durationMin: slotCryptoMeta
          ? ((slotCryptoMeta.endDateMs - slotCryptoMeta.eventStartTimeMs) / 60_000).toFixed(1)
          : 'unknown',
      });
      return false;
    }

    // Определяем стороны (bidirectional: UP + DOWN; non-bidirectional: одна сторона)
    const sides: Array<{ outcomeIndex: 0 | 1; side: 'up' | 'down' | undefined }> = [
      { outcomeIndex: mc.outcomeIndex, side: mc.bidirectional ? (mc.outcomeIndex === 0 ? 'up' : 'down') : undefined },
    ];
    if (mc.bidirectional) {
      const oppositeIndex: 0 | 1 = mc.outcomeIndex === 0 ? 1 : 0;
      sides.push({ outcomeIndex: oppositeIndex, side: oppositeIndex === 0 ? 'up' : 'down' });
    }

    let anyOpened = false;
    for (const { outcomeIndex, side } of sides) {
      const tStr = candidate.allTokenIds?.[outcomeIndex] ?? String(candidate.instrumentId);
      const iId = asInstrumentId(tStr);
      const ast = asPolymarketCtfToken(tStr);
      if (!iId || !ast) {
        logger.error('Cannot create instrument for candidate', { tokenIdStr: tStr, marketId: String(candidate.marketId), side });
        continue;
      }

      // Стратегия: side из конфига
      const sideParams = side !== undefined
        ? { ...marketSelection.strategyParams, side }
        : { ...marketSelection.strategyParams };
      const slotId = side !== undefined
        ? `${marketSelection.strategy}-${side}-slot-${_slotCounter++}`
        : `${marketSelection.strategy}-slot-${_slotCounter++}`;
      const slotStrategy = createStrategy(
        { type: marketSelection.strategy, id: slotId, params: sideParams } as unknown as StrategyConfig,
        logger,
        recording?.journal,
      );

      // Комплементарный токен для dual-token стратегий
      const compIndex = 1 - outcomeIndex;
      const compTokenStr = candidate.allTokenIds?.[compIndex];
      const compInstrumentId = compTokenStr ? (asInstrumentId(compTokenStr) ?? undefined) : undefined;
      const compAsset = compTokenStr ? (asPolymarketCtfToken(compTokenStr) ?? undefined) : undefined;
      if (!compTokenStr) {
        logger.warn('No complementary token found (allTokenIds missing or incomplete)', {
          allTokenIds: candidate.allTokenIds ?? 'undefined',
          outcomeIndex,
          compIndex,
          marketId: String(candidate.marketId),
        });
      }

      const slot: MarketSlot = {
        instrumentId: iId,
        marketId: candidate.marketId,
        asset: ast,
        tokenIdStr: tStr,
        expiresAtMs: expiresMs,
        tickSize: candidate.tickSize,
        minOrderSize: candidate.minOrderSize,
        candidate,
        strategy: slotStrategy,
        cryptoMeta: slotCryptoMeta,
        complementaryInstrumentId: compInstrumentId,
        complementaryAsset: compAsset,
        outcomeIndex,
        fillHistory: [],
        partialAccum: new Map(),
        openedAt: Date.now(),
      };

      // Paper: регистрация в MockExchangeClient
      if (exchangeClient) {
        exchangeClient.registerMarket(iId, candidate.marketId, accountId, ast);
        if (compInstrumentId && compAsset) {
          exchangeClient.registerMarket(compInstrumentId, candidate.marketId, accountId, compAsset);
        }
      }

      this.activeMarkets.set(tStr, slot);
      await wsAdapter.subscribeToToken(tStr);

      const ok = await this.registerMarketAndStrategy(slot);
      if (!ok) {
        this.activeMarkets.delete(tStr);
        continue;
      }

      // Live: сверяем ордера с биржей
      if (orderReconciler) {
        try {
          await orderReconciler.reconcile(accountId);
        } catch (err) {
          logger.warn('Order reconciliation after market open failed', {
            err: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }

      const slug = candidate.rawMarket?.['slug'] as string | undefined;
      logger.info('Market opened', {
        question: candidate.question,
        slug: slug ?? '(no slug)',
        marketId: String(candidate.marketId),
        tokenId: tStr,
        compTokenId: compInstrumentId ? String(compInstrumentId) : 'none',
        side,
        outcomeIndex,
        activeSlots: this.activeMarkets.size,
        maxSlots: maxConcurrentMarkets,
        expiresAt: new Date(expiresMs).toISOString(),
        hoursToExpiry: ((expiresMs - Date.now()) / 3_600_000).toFixed(2),
      });
      anyOpened = true;
    }

    return anyOpened;
  }

  // ── closeMarket ───────────────────────────────────────────────────────

  /**
   * Закрывает конкретный рыночный слот.
   *
   * @param tokenIdStr - Ключ слота (tokenIdStr)
   * @param reason - Причина закрытия: EXPIRED или SHUTDOWN
   *
   * @remarks
   * Алгоритм:
   * 1. Unregister strategy → CANCEL_ALL ордера.
   * 2. WS unsubscribe.
   * 3. Settlement (крипто-рынок: winning=$1, losing=$0).
   * 4. Live: auto-redeem winning tokens.
   * 5. Market summary → recording → MARKET_CLOSED event.
   * 6. Cleanup: orderToSlot, comp tokens, closedMarkets blacklist.
   *
   * @example
   * ```typescript
   * await rotation.closeMarket('123456789', 'EXPIRED');
   * ```
   */
  async closeMarket(tokenIdStr: string, reason: 'EXPIRED' | 'SHUTDOWN'): Promise<void> {
    const slot = this.activeMarkets.get(tokenIdStr);
    if (!slot) return;

    const {
      logger, engine, wsAdapter, marketCatalog, pendingChainlinkStrike,
      cryptoPriceStore, eventBus, recording, redeemer,
    } = this._deps;

    logger.info('Closing market', { reason, marketId: String(slot.marketId), question: slot.candidate?.question });

    // Снимаем стратегию → CANCEL_ALL
    await engine.scheduler.unregister(slot.strategy.id);

    await wsAdapter.unsubscribeFromToken(tokenIdStr);
    marketCatalog.remove(slot.instrumentId);

    // Очистка pending Chainlink strike (не отписываемся от RTDS — deferred cleanup)
    if (slot.cryptoMeta) {
      pendingChainlinkStrike.delete(slot.cryptoMeta.rtdsFilter);
    }

    // Settlement при экспирации крипто-рынка
    let settlementResult: { resolution: string; settlementPrice: Decimal; cashCredit: Decimal; qty: Decimal } | undefined;
    if (reason === 'EXPIRED' && slot.cryptoMeta) {
      settlementResult = this._settleMarket(slot);
    }

    // Live: auto-redeem winning tokens (fire-and-forget)
    if (redeemer && settlementResult && settlementResult.cashCredit.gt(0)) {
      const conditionId = String(slot.marketId);
      void redeemer.redeem(conditionId).then((result) => {
        if (result.success) {
          logger.info('Auto-redeem successful', {
            conditionId,
            txHash: result.txHash,
            cashCredit: settlementResult!.cashCredit.toFixed(4),
          });
        } else {
          logger.warn('Auto-redeem failed (will be picked up by balance sync)', {
            conditionId,
            error: result.error,
          });
        }
      });
    }

    // Сводка ПОСЛЕ settlement
    this._printMarketSummary(slot, settlementResult);

    // Recording
    if (recording) {
      if (reason === 'EXPIRED' && slot.cryptoMeta) {
        const cryptoSnap = cryptoPriceStore.get(slot.cryptoMeta.rtdsFilter);
        if (cryptoSnap?.targetPrice && cryptoSnap?.currentPrice) {
          recording.recordResolved(
            slot.tokenIdStr,
            slot.cryptoMeta.rtdsFilter,
            cryptoSnap.targetPrice,
            cryptoSnap.currentPrice,
            settlementResult?.resolution ?? 'UNKNOWN',
          );
        }
      }
      if (settlementResult) {
        recording.journal.recordResolution({
          marketId: String(slot.marketId), ts: Date.now(),
          resolution: settlementResult.resolution as 'UP' | 'DOWN' | 'UNKNOWN',
          pnl: settlementResult.cashCredit.toFixed(4),
          settlementPrice: settlementResult.settlementPrice.toFixed(2),
        });
      }
      await recording.closeMarket(slot.marketId, reason);
    }

    // MARKET_CLOSED event
    const closeTimestamp = TimestampService.create(Date.now());
    if (closeTimestamp.ok) {
      await eventBus.publish({
        type: 'MARKET_CLOSED',
        marketId: slot.marketId,
        reason: reason === 'EXPIRED' ? 'EXPIRED' : 'MANUAL',
        realizedPnL: Money.of(new Decimal(0), 'USDC'),
        timestamp: closeTimestamp.value,
      });
    }

    if (reason === 'EXPIRED') {
      this.closedMarkets.add(String(slot.marketId));
    }

    // Cleanup orderToSlot
    for (const [orderId, slotKey] of this.orderToSlot) {
      if (slotKey === tokenIdStr) this.orderToSlot.delete(orderId);
    }

    // Cleanup comp token
    if (slot.complementaryInstrumentId) {
      const compTokenStr = String(slot.complementaryInstrumentId);
      this.activeCompTokens.delete(compTokenStr);
      await wsAdapter.unsubscribeFromToken(compTokenStr);
    }

    this.activeMarkets.delete(tokenIdStr);
    logger.info('Market closed', { reason, marketId: String(slot.marketId), activeSlots: this.activeMarkets.size });
  }

  // ── fillMarketSlots ───────────────────────────────────────────────────

  /**
   * Заполняет свободные слоты рынками из кэша discovery.
   *
   * @remarks
   * Не делает новый API-запрос — читает из кэша discoveryAdapter.
   * Пропускает: уже активные (по marketId), закрытые (blacklist), истёкшие.
   * При bidirectional один рынок занимает 2 слота.
   * Включает диагностику: top-5 кандидатов с причинами пропуска.
   *
   * @example
   * ```typescript
   * await rotation.fillMarketSlots();
   * ```
   */
  async fillMarketSlots(): Promise<void> {
    if (!this._discoveryAdapter) return;

    const { logger } = this._deps;

    let candidates: readonly DiscoveredMarket[];
    try {
      candidates = await this._discoveryAdapter.findCandidates();
    } catch (err) {
      logger.error('Failed to read candidates from discovery cache', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    const activeMarketIds = new Set<string>();
    for (const slot of this.activeMarkets.values()) {
      activeMarketIds.add(String(slot.marketId));
    }

    const nowMs = Date.now();

    // Диагностика: первые 5 кандидатов с причиной пропуска
    if (candidates.length > 0) {
      const diag = candidates.slice(0, 5).map((c) => {
        const key = String(c.marketId);
        const exMs = c.expiresAt.toNumber();
        const minLeft = ((exMs - nowMs) / 60000).toFixed(1);
        let skip = '';
        if (this.closedMarkets.has(key)) skip = 'closed';
        else if (activeMarketIds.has(key)) skip = 'active';
        else if (exMs <= nowMs + MIN_VIABLE_TRADING_MS) skip = 'tooSoon';
        return `${c.question?.slice(-20) ?? key.slice(0, 10)} ${minLeft}m ${skip || 'OK'}`;
      });
      logger.debug('fillMarketSlots candidates', { top5: diag });
    }

    for (const c of candidates) {
      if (activeMarketIds.size >= this._deps.maxConcurrentMarkets) break;

      const key = String(c.marketId);
      if (this.closedMarkets.has(key)) continue;
      if (activeMarketIds.has(key)) continue;
      if (c.expiresAt.toNumber() <= nowMs + MIN_VIABLE_TRADING_MS) continue;

      const opened = await this.openMarket(c);
      if (opened) activeMarketIds.add(key);
    }

    if (this.activeMarkets.size === 0 && !this._retryingFill) {
      const reasons = { total: candidates.length, closed: 0, active: 0, tooSoon: 0, openFailed: 0 };
      for (const c of candidates) {
        const key = String(c.marketId);
        if (this.closedMarkets.has(key)) { reasons.closed++; continue; }
        if (activeMarketIds.has(key)) { reasons.active++; continue; }
        if (c.expiresAt.toNumber() <= nowMs + MIN_VIABLE_TRADING_MS) { reasons.tooSoon++; continue; }
        reasons.openFailed++;
      }
      logger.warn('No candidates from cache — forcing discovery refresh', reasons);

      // Принудительный refresh и повторная попытка (один раз, без рекурсии)
      this._retryingFill = true;
      try {
        await this._discoveryAdapter!.refresh();
        logger.info('Discovery force-refreshed after failed fillMarketSlots');
        await this.fillMarketSlots();
      } catch (err) {
        logger.error('Force discovery refresh failed', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      } finally {
        this._retryingFill = false;
      }
    }
  }

  // ── checkExpiredMarkets ───────────────────────────────────────────────

  /**
   * Проверяет истечение всех активных рынков и заполняет освободившиеся слоты.
   *
   * @remarks
   * Reentrancy guard: `_rotationInProgress` предотвращает параллельные вызовы.
   * После закрытия истёкших рынков вызывает `fillMarketSlots()` + deferred RTDS cleanup.
   *
   * @example
   * ```typescript
   * await rotation.checkExpiredMarkets();
   * ```
   */
  async checkExpiredMarkets(): Promise<void> {
    if (this._isShuttingDown || this._rotationInProgress) return;
    this._rotationInProgress = true;
    try {
      const { logger, cryptoSubs } = this._deps;
      const nowMs = Date.now();

      const expiredTokens: string[] = [];
      for (const [tokenIdStr, slot] of this.activeMarkets) {
        if (!slot.candidate) continue; // fixed-рынки не истекают
        if (slot.expiresAtMs - nowMs <= CANCEL_BEFORE_EXPIRY_MS) {
          logger.info('Market expiring soon, closing early to cancel orders', {
            marketId: String(slot.marketId),
            expiresAt: new Date(slot.expiresAtMs).toISOString(),
            msTillExpiry: Math.max(0, slot.expiresAtMs - nowMs),
          });
          expiredTokens.push(tokenIdStr);
        }
      }

      for (const tokenIdStr of expiredTokens) {
        await this.closeMarket(tokenIdStr, 'EXPIRED');
      }

      if (expiredTokens.length > 0) {
        await this.fillMarketSlots();

        // Deferred RTDS cleanup — отписать символы которые больше не нужны
        cryptoSubs.cleanupUnused(new Set(this.activeMarkets.keys()));
      }
    } finally {
      this._rotationInProgress = false;
    }
  }

  // ── scheduleScanLoop ──────────────────────────────────────────────────

  /**
   * Периодически обновляет кэш discovery (пауза после завершения запроса).
   *
   * @remarks
   * Не знает о текущем рынке — просто обновляет кэш.
   * Если есть свободные слоты, вызывает `fillMarketSlots()`.
   *
   * @example
   * ```typescript
   * await rotation.scheduleScanLoop();
   * ```
   */
  async scheduleScanLoop(): Promise<void> {
    if (this._isShuttingDown || !this._discoveryAdapter) return;
    const { logger, config, maxConcurrentMarkets } = this._deps;

    try {
      await this._discoveryAdapter.refresh();
      logger.debug('Discovery cache refreshed');
    } catch (err) {
      logger.error('Market discovery refresh failed', {
        err: err instanceof Error ? err : new Error(String(err)),
      });
    }

    // Если есть свободные слоты — ищем новые рынки
    if (this.activeMarkets.size < maxConcurrentMarkets && !this._isShuttingDown) {
      try {
        await this.fillMarketSlots();
      } catch (err) {
        logger.error('Periodic slot filling failed', {
          err: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }

    if (!this._isShuttingDown) {
      const mc = config.market as DiscoveryMarketConfig;
      this._scanTimeoutId = setTimeout(() => { void this.scheduleScanLoop(); }, mc.scanPauseMs ?? 60_000);
    }
  }

  // ── startExpiryCheck / stopExpiryCheck ────────────────────────────────

  /**
   * Запускает периодическую проверку истечения рынков (каждые 5 сек).
   *
   * @returns ID интервала (для clearInterval при shutdown)
   *
   * @example
   * ```typescript
   * rotation.startExpiryCheck();
   * ```
   */
  startExpiryCheck(): void {
    this._expiryCheckIntervalId = setInterval(() => {
      void this.checkExpiredMarkets();
    }, CANCEL_BEFORE_EXPIRY_MS);
  }

  /**
   * Останавливает проверку истечения и discovery scan loop.
   *
   * @remarks
   * Вызывать при SIGINT/SIGTERM для корректного shutdown.
   */
  stopTimers(): void {
    if (this._expiryCheckIntervalId) {
      clearInterval(this._expiryCheckIntervalId);
      this._expiryCheckIntervalId = null;
    }
    if (this._scanTimeoutId) {
      clearTimeout(this._scanTimeoutId);
      this._scanTimeoutId = null;
    }
  }

  // ── registerFillTracking ──────────────────────────────────────────────

  /**
   * Подключает fill tracking через eventBus.
   *
   * @remarks
   * Подписывается на ORDER_CREATED, ORDER_PARTIALLY_FILLED, ORDER_FILLED,
   * ORDER_CANCELLED. Роутит события в правильный MarketSlot через orderToSlot.
   *
   * @example
   * ```typescript
   * rotation.registerFillTracking();
   * ```
   */
  registerFillTracking(): void {
    const { eventBus, clock } = this._deps;

    // ORDER_CREATED → orderToSlot
    eventBus.subscribe('ORDER_CREATED', (event) => {
      const iId = assetIdToInstrumentId(event.asset);
      const tokenIdStr = iId ? String(iId) : undefined;
      if (tokenIdStr && this.activeMarkets.has(tokenIdStr)) {
        this.orderToSlot.set(String(event.orderId), tokenIdStr);
        return;
      }
      // Комплементарный токен → primary slot
      if (tokenIdStr && this.activeCompTokens.has(tokenIdStr)) {
        for (const [primaryTokenId, slot] of this.activeMarkets) {
          if (slot.complementaryInstrumentId && String(slot.complementaryInstrumentId) === tokenIdStr) {
            this.orderToSlot.set(String(event.orderId), primaryTokenId);
            return;
          }
        }
      }
    });

    // ORDER_PARTIALLY_FILLED → accumulate
    eventBus.subscribe('ORDER_PARTIALLY_FILLED', (event) => {
      const id = String(event.orderId);
      const slot = this._findSlotByOrderId(id);
      if (!slot) return;
      const existing = slot.partialAccum.get(id);
      const fillSize = event.fill.size.value();
      const fillNotional = fillSize.times(event.fill.price.value());
      if (existing) {
        existing.totalSize = existing.totalSize.plus(fillSize);
        existing.totalNotional = existing.totalNotional.plus(fillNotional);
      } else {
        slot.partialAccum.set(id, {
          side: event.fill.side as 'BUY' | 'SELL',
          totalSize: fillSize,
          totalNotional: fillNotional,
          firstAt: clock.now().toISOString().slice(11, 19),
        });
      }
    });

    // ORDER_FILLED → finalize fill record
    eventBus.subscribe('ORDER_FILLED', (event) => {
      const id = String(event.orderId);
      const slot = this._findSlotByOrderId(id);
      if (!slot) return;
      const accum = slot.partialAccum.get(id);
      slot.partialAccum.delete(id);
      const lastSize = event.fill.size.value();
      const totalSize = (accum?.totalSize ?? new Decimal(0)).plus(lastSize);
      const totalNotional = (accum?.totalNotional ?? new Decimal(0))
        .plus(lastSize.times(event.fill.price.value()));
      const avgPrice = totalNotional.div(totalSize);
      slot.fillHistory.push({
        side: event.fill.side as 'BUY' | 'SELL',
        size: totalSize.toFixed(2),
        price: avgPrice.toFixed(4),
        notional: totalNotional.toFixed(2),
        at: accum?.firstAt ?? clock.now().toISOString().slice(11, 19),
      });
    });

    // ORDER_CANCELLED → partial fill record
    eventBus.subscribe('ORDER_CANCELLED', (event) => {
      const id = String(event.orderId);
      const slot = this._findSlotByOrderId(id);
      if (!slot) return;
      const accum = slot.partialAccum.get(id);
      if (!accum || accum.totalSize.lte(0)) return;
      slot.partialAccum.delete(id);
      const avgPrice = accum.totalNotional.div(accum.totalSize);
      slot.fillHistory.push({
        side: accum.side,
        size: accum.totalSize.toFixed(2),
        price: avgPrice.toFixed(4),
        notional: accum.totalNotional.toFixed(2),
        at: accum.firstAt,
        partial: true,
      });
    });
  }

  // ── Приватные методы ──────────────────────────────────────────────────

  /**
   * Определяет strike price для крипто-рынка.
   *
   * @param cryptoMeta - Метаданные крипто-рынка
   *
   * @remarks
   * Приоритет: priceToBeat из API → Binance kline → Chainlink RTDS (fallback).
   */
  private async _resolveStrikePrice(cryptoMeta: CryptoMarketMeta): Promise<void> {
    const { logger, cryptoPriceStore, pendingChainlinkStrike, binanceClient } = this._deps;

    if (cryptoMeta.priceToBeat !== undefined) {
      cryptoPriceStore.setTargetPrice(cryptoMeta.rtdsFilter, cryptoMeta.priceToBeat);
      logger.info('Strike price from API (priceToBeat)', {
        symbol: cryptoMeta.rtdsFilter,
        strikePrice: cryptoMeta.priceToBeat,
      });
      return;
    }

    const eventStarted = Date.now() > cryptoMeta.eventStartTimeMs;
    if (eventStarted) {
      try {
        const interval = computeInterval(cryptoMeta.endDateMs - cryptoMeta.eventStartTimeMs);
        const kline = await binanceClient.getKline(cryptoMeta.binanceSymbol, cryptoMeta.eventStartTimeMs, interval);
        cryptoPriceStore.setTargetPrice(cryptoMeta.rtdsFilter, kline.open);
        logger.info('Strike price from Binance kline (event already started)', {
          symbol: cryptoMeta.rtdsFilter,
          strikePrice: kline.open,
        });
      } catch (err) {
        logger.warn('Binance kline fallback failed, waiting for Chainlink RTDS', {
          symbol: cryptoMeta.binanceSymbol,
          err: err instanceof Error ? err.message : String(err),
        });
        pendingChainlinkStrike.set(cryptoMeta.rtdsFilter, cryptoMeta.eventStartTimeMs);
      }
    } else {
      pendingChainlinkStrike.set(cryptoMeta.rtdsFilter, cryptoMeta.eventStartTimeMs);
      logger.info('Waiting for first Chainlink price after event start as strike', {
        symbol: cryptoMeta.rtdsFilter,
        eventStartTime: new Date(cryptoMeta.eventStartTimeMs).toISOString(),
      });
    }
  }

  /**
   * Settlement крипто-рынка: winning token = $1.00, losing = $0.00.
   *
   * @param slot - Слот рынка для settlement
   * @returns Результат settlement или undefined если позиции нет
   *
   * @remarks
   * Проверяет позиции на primary и comp токенах (auto-selection).
   * Обновляет портфель: удаляет позицию + зачисляет cash credit.
   */
  private _settleMarket(slot: MarketSlot): { resolution: string; settlementPrice: Decimal; cashCredit: Decimal; qty: Decimal } | undefined {
    const { logger, cryptoPriceStore, portfolioStore, accountId } = this._deps;

    const resolution = cryptoPriceStore.getResolution(slot.cryptoMeta!.rtdsFilter);
    const cryptoSnap = cryptoPriceStore.get(slot.cryptoMeta!.rtdsFilter);
    const portfolio = portfolioStore.get(accountId);

    // Ищем позицию на primary и comp токенах
    const primaryPosition = portfolio?.getPosition(slot.instrumentId);
    const compPosition = slot.complementaryInstrumentId
      ? portfolio?.getPosition(slot.complementaryInstrumentId)
      : undefined;
    const primaryHasTokens = primaryPosition && !primaryPosition.isClosed();
    const compHasTokens = compPosition && !compPosition.isClosed();

    const position = primaryHasTokens ? primaryPosition : compHasTokens ? compPosition : undefined;
    const positionInstrumentId = primaryHasTokens ? slot.instrumentId : slot.complementaryInstrumentId!;
    const positionIsComp = !primaryHasTokens && compHasTokens;
    const hasTokens = !!position;

    logger.info('Settlement check', {
      hasCryptoMeta: true,
      symbol: slot.cryptoMeta!.rtdsFilter,
      targetPrice: cryptoSnap?.targetPrice,
      currentPrice: cryptoSnap?.currentPrice,
      resolution: resolution ?? 'unknown',
      hasTokens,
      positionOn: positionIsComp ? 'complementary' : 'primary',
      tokenQty: hasTokens ? position!.quantity.value().toFixed(2) : '0',
    });

    if (!resolution || !portfolio || !position || !hasTokens) return undefined;

    const qty = position.quantity.value();
    const oi = positionIsComp ? (1 - slot.outcomeIndex) as 0 | 1 : slot.outcomeIndex;
    const isWinning = (oi === 0 && resolution === 'UP') || (oi === 1 && resolution === 'DOWN');
    const settlementPrice = isWinning ? new Decimal(1) : new Decimal(0);
    const cashCredit = qty.times(settlementPrice);

    const settlementResult = { resolution, settlementPrice, cashCredit, qty };

    // Удаляем позицию (settled)
    const closedPosition = new SimplePosition({
      instrumentId: positionInstrumentId,
      quantity: new Decimal(0),
      averageEntryPrice: position.averageEntryPrice.value(),
      side: 'LONG' as const,
    });
    let updated = portfolio.upsertPosition(closedPosition);

    // Зачисляем settlement cash
    if (cashCredit.gt(0)) {
      const creditResult = updated.applyCredit(Money.of(cashCredit, 'USDC'));
      if (creditResult.ok) updated = creditResult.value;
    }

    const ver = portfolioStore.getVersion(accountId);
    const saveRes = portfolioStore.save(updated, ver);
    if (!saveRes.ok) {
      logger.error('Settlement portfolio save failed (version conflict)', { expected: ver });
    }
    logger.info(`Market resolved ${resolution} — settlement @ $${settlementPrice} for ${qty.toFixed(2)} tokens`, {
      symbol: slot.cryptoMeta!.rtdsFilter,
      resolution,
      settlementPrice: settlementPrice.toFixed(2),
      cashCredit: cashCredit.toFixed(4),
      outcomeIndex: oi,
    });

    return settlementResult;
  }

  /**
   * Находит слот по orderId через orderToSlot.
   *
   * @param orderId - ID ордера
   * @returns Слот или undefined
   */
  private _findSlotByOrderId(orderId: string): MarketSlot | undefined {
    const tokenIdStr = this.orderToSlot.get(orderId);
    return tokenIdStr ? this.activeMarkets.get(tokenIdStr) : undefined;
  }

  /**
   * Выводит сводку по всем fills рыночного слота с учётом settlement.
   *
   * @param slot - Слот рынка
   * @param settlement - Результат settlement (если был)
   *
   * @remarks
   * Открытые циклы (buy без sell) получают settlement PnL:
   * settlementPrice × qty − entryPrice × qty.
   */
  private _printMarketSummary(
    slot: MarketSlot,
    settlement?: { resolution: string; settlementPrice: Decimal; cashCredit: Decimal; qty: Decimal },
  ): void {
    const { logger, portfolioStore, accountId } = this._deps;
    const marketQuestion = slot.candidate?.question ?? String(slot.marketId);

    if (slot.fillHistory.length === 0) {
      const noFillPortfolio = portfolioStore.get(accountId);
      logger.info('=== Market summary: no fills ===', {
        market: marketQuestion,
        usdcFree: noFillPortfolio?.balance.available().value().toFixed(2) ?? '-',
        usdcReserved: noFillPortfolio?.balance.reserved().value().toFixed(2) ?? '-',
      });
      return;
    }

    const durationMs = Date.now() - slot.openedAt;
    const durMin = Math.floor(durationMs / 60_000);
    const durSec = Math.round((durationMs % 60_000) / 1000);

    const buys = slot.fillHistory.filter(f => f.side === 'BUY');
    const sells = slot.fillHistory.filter(f => f.side === 'SELL');

    const cycles = buys.map((buy, i) => {
      const sell = sells[i];
      const buyLabel = `${buy.size}@${buy.price}${buy.partial ? '(partial)' : ''} [${buy.at}]`;
      if (!sell) {
        if (settlement) {
          const entryNotional = new Decimal(buy.price).times(new Decimal(buy.size));
          const settlePnl = settlement.settlementPrice.times(new Decimal(buy.size)).minus(entryNotional);
          return {
            buy: buyLabel,
            sell: `(settled@${settlement.settlementPrice} ${settlement.resolution})`,
            pnl: (settlePnl.gte(0) ? '+' : '') + settlePnl.toFixed(4) + ' USDC',
          };
        }
        return { buy: buyLabel, sell: '(open)', pnl: '-' };
      }
      const pnl = new Decimal(sell.price).minus(new Decimal(buy.price)).times(new Decimal(buy.size));
      const sellLabel = `${sell.size}@${sell.price}${sell.partial ? '(partial)' : ''} [${sell.at}]`;
      return {
        buy: buyLabel,
        sell: sellLabel,
        pnl: (pnl.gte(0) ? '+' : '') + pnl.toFixed(4) + ' USDC',
      };
    });

    // PnL от завершённых циклов
    let totalPnl = sells.reduce((acc, sell, i) => {
      const buy = buys[i];
      if (!buy) return acc;
      return acc.plus(new Decimal(sell.price).minus(new Decimal(buy.price)).times(new Decimal(sell.size)));
    }, new Decimal(0));

    // PnL от settlement открытых циклов
    if (settlement) {
      for (let i = sells.length; i < buys.length; i++) {
        const buy = buys[i]!;
        const entryNotional = new Decimal(buy.price).times(new Decimal(buy.size));
        const settlePnl = settlement.settlementPrice.times(new Decimal(buy.size)).minus(entryNotional);
        totalPnl = totalPnl.plus(settlePnl);
      }
    }

    const portfolio = portfolioStore.get(accountId);
    const position = portfolio?.getPosition(slot.instrumentId);

    logger.warn('=== Market summary ===', {
      market: marketQuestion,
      duration: `${durMin}m${durSec}s`,
      buys: buys.length,
      sells: sells.length,
      openCycles: settlement ? 0 : buys.length - sells.length,
      totalPnl: (totalPnl.gte(0) ? '+' : '') + totalPnl.toFixed(4) + ' USDC',
      settlement: settlement ? `${settlement.resolution} @${settlement.settlementPrice}` : undefined,
      cycles,
      finalTokens: position?.quantity.value().toFixed(2) ?? '0.00',
      finalUsdcFree: portfolio?.balance.available().value().toFixed(2) ?? '-',
      finalUsdcReserved: portfolio?.balance.reserved().value().toFixed(2) ?? '-',
    });
  }
}
