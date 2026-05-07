/**
 * Построитель live режима — создаёт реальный exchange client и recovery сервисы.
 *
 * @remarks
 * ### Порядок создания компонентов:
 * 1. `PolymarketRestClient` — базовый HTTP клиент с подписью
 * 2. `PolymarketExecutionAdapter` → `PolymarketExchangeClientAdapter` → `IExchangeClient`
 * 3. `PolymarketBalanceProvider` → `ICurrentBalanceProvider` (inline adapter)
 * 4. Recovery: `PortfolioReplayService`, `OrderReconciler`, `ReconcileTradesUseCase`
 * 5. `UserEventFeedAdapter` — WS user channel (основной путь fills)
 *
 * ### Delivery fills в live режиме:
 * - **Основной**: WS user channel → `UserEventFeedAdapter` → `FillEventHandler` (< 100ms)
 * - **Fallback**: `ReconcileTradesUseCase.execute()` каждые 60 сек (REST polling)
 *   Срабатывает при: старт, WS reconnect, и периодически (safety net)
 *
 * @example
 * ```typescript
 * const live = buildLiveInfra({ credentials, infra, repos, processFillUseCase, userWsAdapter, accountId });
 *
 * // Recovery
 * await live.portfolioReplayService.replay(accountId);
 * await live.orderReconciler.reconcile(accountId);
 *
 * // WS user channel (отдельное соединение /ws/user)
 * await userWsAdapter.subscribeUserChannel({ apiKey, secret: apiSecret, passphrase: apiPassphrase });
 * live.userEventFeedAdapter.start();
 * ```
 */

import Decimal from 'decimal.js';
import type { AccountId } from '@polymarket/ids';
import type { IExchangeClient } from '@polymarket/ports';
import type { ProcessFillUseCase } from '@polymarket/use-cases';
import { ReconcileTradesUseCase, PortfolioService } from '@polymarket/use-cases';
import { assetIdToInstrumentId } from '@polymarket/ids';
import { FillEventHandler, OrderUpdateHandler } from '@polymarket/handlers';
import { PortfolioReplayService, OrderReconciler } from '@polymarket/recovery';
import type { ICurrentBalanceProvider, IVenueOrderProvider } from '@polymarket/recovery';
import { UserEventFeedAdapter } from '@polymarket/exchange/adapters';
import { PolymarketExchangeClientAdapter } from '@polymarket/exchange/adapters';
import {
  PolymarketRestClient,
  PolymarketExecutionAdapter,
  PolymarketOrderRestClient,
  PolymarketOrderbookRestClient,
  PolymarketBalanceRestClient,
  PolymarketBalanceMapper,
  PolymarketBalancePolicy,
  PolymarketOrderMapper,
  PolymarketBalanceProvider,
  PolymarketOrderBuilder,
  PolymarketUserTradesRestClient,
  SignatureType,
} from '@polymarket/exchange/rest';
import type { DnsOverride } from '@polymarket/exchange/dns';
import type { PolymarketWsAdapter } from '@polymarket/exchange/ws';
import type { CoreInfra } from './buildCoreInfra.js';
import type { Repositories } from './buildRepositories.js';

// ── Типы ─────────────────────────────────────────────────────────────────────

/**
 * Учётные данные для live торговли.
 */
export interface LiveCredentials {
  /** Приватный ключ кошелька (hex, с 0x) */
  readonly privateKey: string;
  /** Адрес фандера для POLY_PROXY кошелька (опционально) */
  readonly funderAddress?: string;
  /** Polymarket L2 API key (UUID) */
  readonly apiKey: string;
  /** Polymarket L2 API secret (base64url) */
  readonly apiSecret: string;
  /** Polymarket L2 API passphrase (hex) */
  readonly apiPassphrase: string;
  /**
   * Builder code для атрибуции ордеров в CLOB V2 (bytes32 hex)
   *
   * @remarks
   * Выдаётся на странице Polymarket Builder Profile.
   * Включается в каждый подписанный ордер автоматически.
   */
  readonly builderCode?: string;
}

/** Параметры для buildLiveInfra */
export interface BuildLiveInfraParams {
  readonly credentials: LiveCredentials;
  readonly infra: CoreInfra;
  readonly repos: Repositories;
  readonly processFillUseCase: ProcessFillUseCase;
  /**
   * WS-адаптер для user channel (`/ws/user`).
   * Должен быть отдельным от market WS-адаптера — Polymarket принимает
   * только одно subscription-сообщение на соединение.
   */
  readonly userWsAdapter: PolymarketWsAdapter;
  readonly accountId: AccountId;
  readonly dnsOverride?: DnsOverride;
}

/** Результат построения live инфраструктуры */
export interface LiveInfra {
  /** Реальный exchange client (для PlaceOrderUseCase / CancelOrderUseCase) */
  readonly exchangeClient: IExchangeClient;
  /** WS user channel adapter (основной путь fills) */
  readonly userEventFeedAdapter: UserEventFeedAdapter;
  /** Recovery: инициализация Portfolio из баланса venue */
  readonly portfolioReplayService: PortfolioReplayService;
  /** Recovery: сверка ордеров с venue при старте и reconnect */
  readonly orderReconciler: OrderReconciler;
  /** Fallback polling: сверка fills через REST (safety net) */
  readonly reconcileTradesUseCase: ReconcileTradesUseCase;
  /** Проверка баланса токена на CLOB (для диагностики SELL rejection) */
  readonly balanceRestClient: PolymarketBalanceRestClient;
  /** Провайдер текущего USDC-баланса от venue (для периодической синхронизации) */
  readonly currentBalanceProvider: ICurrentBalanceProvider;
}

// ── Реализация ────────────────────────────────────────────────────────────────

/**
 * Создаёт все компоненты live режима.
 *
 * @param params - Зависимости и credentials
 * @returns Объект с exchange client, WS adapter и recovery сервисами
 *
 * @remarks
 * Не запускает WS подписку и polling — это делает `runLive()` в main.ts
 * после инициализации strategy engine.
 */
export function buildLiveInfra(params: BuildLiveInfraParams): LiveInfra {
  const { credentials, infra, repos, processFillUseCase, userWsAdapter, accountId, dnsOverride } = params;
  const { clock, logger, eventBus } = infra;
  const { orderRepo, portfolioStore, processedFillRepo } = repos;

  // ── 1. REST stack ──────────────────────────────────────────────────────────

  const restConfig = {
    baseUrl: 'https://clob.polymarket.com',
    privateKey: credentials.privateKey,
    chainId: 137,
    l2Credentials: {
      apiKey: credentials.apiKey,
      secret: credentials.apiSecret,
      passphrase: credentials.apiPassphrase,
    },
    signatureType: credentials.funderAddress ? SignatureType.POLY_PROXY : SignatureType.EOA,
    funderAddress: credentials.funderAddress,
    builderCode: credentials.builderCode,
  };

  const restClient = new PolymarketRestClient(restConfig, logger, dnsOverride);
  const signer = restClient.getSigner();
  const makerAddress = credentials.funderAddress ?? signer.getAddress();

  const orderBuilder = new PolymarketOrderBuilder(
    signer.getWallet(),
    restConfig.chainId,
    makerAddress,
    restConfig.signatureType,
    logger,
    restConfig.builderCode,
  );

  const orderRestClient = new PolymarketOrderRestClient(restClient, orderBuilder, logger);
  const orderbookRestClient = new PolymarketOrderbookRestClient(restClient, logger);
  const orderMapper = new PolymarketOrderMapper(logger);

  const executionAdapter = new PolymarketExecutionAdapter(
    orderRestClient,
    orderbookRestClient,
    orderMapper,
    eventBus,
    logger,
  );

  // ── 2. Balance infrastructure (нужна ДО exchangeClient для pre-flight SELL check) ──

  const balanceMapper = new PolymarketBalanceMapper(logger);
  const balanceRestClient = new PolymarketBalanceRestClient(restClient, logger);
  const balanceProvider = new PolymarketBalanceProvider(balanceRestClient, balanceMapper, logger, false);

  // Policy БЕЗ portfolioProjector — для SELL проверок использует Balance API (on-chain truth).
  // Другой инстанс с portfolioProjector используется для стратегий (event-sourced, zero-lag),
  // но здесь нам нужен on-chain источник, чтобы ловить рассинхрон проекции и реального баланса.
  const onChainBalancePolicy = new PolymarketBalancePolicy(balanceProvider, logger);

  // ── 3. IExchangeClient ────────────────────────────────────────────────────

  const userTradesClient = new PolymarketUserTradesRestClient(restClient, logger);
  const exchangeClient: IExchangeClient = new PolymarketExchangeClientAdapter(
    executionAdapter,
    logger,
    userTradesClient,
    onChainBalancePolicy,
  );

  // Inline adapter: ICurrentBalanceProvider → PolymarketBalanceProvider.getAvailableBalance()
  const currentBalanceProvider: ICurrentBalanceProvider = {
    async getUsdcBalance(_accountId: AccountId): Promise<Decimal> {
      const money = await balanceProvider.getAvailableBalance();
      return new Decimal(money.toNumber());
    },
  };

  // ── 4. Recovery сервисы ───────────────────────────────────────────────────

  const portfolioReplayService = new PortfolioReplayService({
    balanceProvider: currentBalanceProvider,
    portfolioStore,
    logger,
  });

  // PortfolioService для освобождения резервации при внешней отмене ордера
  const portfolioServiceForCancel = new PortfolioService(portfolioStore, logger);

  const orderUpdateHandler = new OrderUpdateHandler(orderRepo, eventBus, logger,
    // Callback: освобождение резервации при venue-initiated отмене (ручная отмена на бирже).
    // CancelOrderUseCase делает unreserve сам; здесь — только внешние отмены.
    (cancelledOrder) => {
      // accountId берём из closure buildLiveInfra — Order entity не хранит accountId
      const orderAccountId = accountId;
      if (cancelledOrder.side === 'BUY') {
        const remainingNotional = cancelledOrder.price.value().times(cancelledOrder.remainingSize.value());
        const releaseResult = portfolioServiceForCancel.releaseReservation(orderAccountId, remainingNotional);
        if (!releaseResult.ok) {
          logger.error('Failed to release USDC reservation after external BUY cancel', {
            orderId: String(cancelledOrder.id),
            error: releaseResult.error.message,
          });
        }
      } else {
        // SELL: освобождаем резервацию токенов
        const instrumentId = assetIdToInstrumentId(cancelledOrder.asset);
        if (instrumentId) {
          const releaseResult = portfolioServiceForCancel.releaseTokenReservation(
            orderAccountId,
            instrumentId,
            cancelledOrder.remainingSize.value(),
          );
          if (!releaseResult.ok) {
            logger.error('Failed to release token reservation after external SELL cancel', {
              orderId: String(cancelledOrder.id),
              error: releaseResult.error.message,
            });
          }
        }
      }
    },
  );

  // Inline adapter: IVenueOrderProvider → LIVE + MATCHED ордера
  // ВАЖНО: включаем и MATCHED ордера (сматченные, ожидающие on-chain сеттлмента).
  // Polymarket не возвращает MATCHED из /orders (getOpenOrders), только LIVE.
  // Без учёта MATCHED reconciler локально отменяет ордер до прихода fill → двойная покупка.
  const venueOrderProvider: IVenueOrderProvider = {
    async getOpenOrderIds(): Promise<readonly string[]> {
      const [liveResult, matchedOrders] = await Promise.allSettled([
        exchangeClient.getOpenOrders(accountId),
        orderRestClient.getMatchedOrders(undefined, 50),
      ]);

      if (liveResult.status === 'rejected') {
        throw new Error(`getOpenOrders failed: ${String(liveResult.reason)}`);
      }
      if (!liveResult.value.ok) {
        throw new Error(`getOpenOrders failed: ${liveResult.value.error.message}`);
      }

      const liveIds = liveResult.value.value.map((o) => String(o.orderId));

      // MATCHED ордера — best-effort (не прерываем reconciliation при ошибке)
      const matchedIds: string[] = [];
      if (matchedOrders.status === 'fulfilled') {
        for (const o of matchedOrders.value) {
          matchedIds.push(o.id);
        }
      }

      return [...liveIds, ...matchedIds];
    },
  };

  const orderReconciler = new OrderReconciler({
    venueOrderProvider,
    orderRepo,
    orderUpdateHandler,
    logger,
  });

  // REST polling fallback (safety net при gaps в WS)
  const reconcileTradesUseCase = new ReconcileTradesUseCase({
    exchangeClient,
    processedFillRepo,
    processFillUseCase,
    logger,
  });

  // ── 5. WS user channel ────────────────────────────────────────────────────

  const fillEventHandler = new FillEventHandler(eventBus, clock, logger);

  const userEventFeedAdapter = new UserEventFeedAdapter(
    userWsAdapter,
    fillEventHandler,
    orderUpdateHandler,
    accountId,
    logger,
    // onReconnect: запускаем reconciliation ордеров после реконнекта WS
    async () => {
      logger.info('WS user channel reconnected — running order reconciliation');
      await orderReconciler.reconcile(accountId);
    },
    // makerAddress: ETH-адрес нашего кошелька — fallback для cross-outcome fills
    makerAddress,
    // onMatchedOnExchange: помечаем ордер как MATCHED, чтобы CancelOrderUseCase пропустил его.
    // Устраняет race: partial fill → стратегия cancels → fill 4.68 на "не найден" → portfolio desync.
    (orderId) => { repos.orderRepo.markMatchedOnExchange(orderId); },
    // onInFlightFill: instrument-level tracking — блокирует стратегию даже если ордер уже cancelled/deleted.
    // Решает race: cancel → place → fill(старый) → двойная покупка.
    (instrumentId) => { repos.orderRepo.markInFlightFill(instrumentId); },
  );

  return {
    exchangeClient,
    userEventFeedAdapter,
    portfolioReplayService,
    orderReconciler,
    reconcileTradesUseCase,
    balanceRestClient,
    currentBalanceProvider,
  };
}
