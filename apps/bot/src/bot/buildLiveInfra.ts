/**
 * Построитель live режима — создаёт реальный exchange client и startup use-cases.
 *
 * @remarks
 * ### Порядок создания компонентов:
 * 1. `PolymarketRestClient` — базовый HTTP клиент с подписью
 * 2. `PolymarketExecutionAdapter` → `PolymarketExchangeClientAdapter` → `IExchangeClient`
 * 3. `PolymarketBalanceProvider` → `ICurrentBalanceProvider` (inline adapter)
 * 4. Startup: `InitializePortfolioUseCase`, `OrderReconciler` (inline), `ReconcileTradesUseCase`
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
 * // Startup
 * await live.initializePortfolioUseCase.execute(accountId);
 * await live.orderReconciler.reconcile(accountId);
 *
 * // WS user channel (отдельное соединение /ws/user)
 * await userWsAdapter.subscribeUserChannel({ apiKey, secret: apiSecret, passphrase: apiPassphrase });
 * live.userEventFeedAdapter.start();
 * ```
 */

import type { AccountId } from '@polymarket/ids';
import type { Money } from '@polymarket/value-objects';
import type { IExchangeClient, ICurrentBalanceProvider, IOrderedEventOutbox } from '@polymarket/ports';
import type { ProcessFillUseCase } from '@polymarket/use-cases';
import { ReconcileTradesUseCase, ReconcileUnknownSubmissionsUseCase, ResolveUnknownSubmissionUseCase, CancelBoundVenueOrderUseCase, SettleTerminalOrdersUseCase, venueTradeToFill, PortfolioService, InitializePortfolioUseCase, UpdateOrderStatusUseCase } from '@polymarket/use-cases';
import { FillEventHandler, OrderUpdateHandler } from '@polymarket/handlers';
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
   * Разделяемый ordered event outbox (из `buildProcessFillUseCase`) — ТОТ ЖЕ
   * инстанс, что у Place/Fill/Cancel; передаётся в UpdateOrderStatusUseCase для
   * per-order FIFO событий.
   */
  readonly orderedEventOutbox: IOrderedEventOutbox;
  /**
   * WS-адаптер для user channel (`/ws/user`).
   * Должен быть отдельным от market WS-адаптера — Polymarket принимает
   * только одно subscription-сообщение на соединение.
   */
  readonly userWsAdapter: PolymarketWsAdapter;
  readonly accountId: AccountId;
  readonly dnsOverride?: DnsOverride;
  /**
   * Разрешает automatic terminal settlement release (Portfolio release
   * authoritative остатка) внутри `orderReconciler.reconcile()` — вызывается
   * на startup И на КАЖДЫЙ WS reconnect, а не только из периодического
   * таймера. Default `false` (safe): единственный источник истины для флага —
   * main.ts читает `ENABLE_AUTO_TERMINAL_SETTLEMENT` ОДИН раз при старте и
   * передаёт сюда то же значение, что использует для гейта периодического
   * вызова — исключает рассинхрон между двумя местами вызова settle.
   */
  readonly enableAutoTerminalSettlement?: boolean;
}

/** Результат построения live инфраструктуры */
export interface LiveInfra {
  /** Реальный exchange client (для PlaceOrderUseCase / CancelOrderUseCase) */
  readonly exchangeClient: IExchangeClient;
  /** WS user channel adapter (основной путь fills) */
  readonly userEventFeedAdapter: UserEventFeedAdapter;
  /** Startup: инициализация Portfolio из баланса venue */
  readonly initializePortfolioUseCase: InitializePortfolioUseCase;
  /** Startup: сверка ордеров с venue при старте и reconnect (LIVE + MATCHED) */
  readonly orderReconciler: { reconcile(accountId: AccountId): Promise<void> };
  /** Fallback polling: сверка fills через REST (safety net) */
  readonly reconcileTradesUseCase: ReconcileTradesUseCase;
  /**
   * DISCOVERY-ONLY обнаружение venue-кандидатов для ambiguous submissions без
   * venueOrderId: только findings + issues, никаких автоматических bind/release.
   */
  readonly reconcileUnknownSubmissionsUseCase: ReconcileUnknownSubmissionsUseCase;
  /**
   * ЯВНОЕ операторское разрешение UNKNOWN submission (bind venueOrderId /
   * подтверждённое отсутствие) — единственный путь снятия manual block.
   */
  readonly resolveUnknownSubmissionUseCase: ResolveUnknownSubmissionUseCase;
  /**
   * Разрешение terminal settlement pending: применение delayed fills (held path)
   * + release только authoritative остатка резервации.
   */
  readonly settleTerminalOrdersUseCase: SettleTerminalOrdersUseCase;
  /**
   * Операторская отмена привязанного live venue-ордера без локального Order —
   * закрытие workflow BOUND_AWAITING_ORDER_RECOVERY.
   */
  readonly cancelBoundVenueOrderUseCase: CancelBoundVenueOrderUseCase;
  /** Проверка баланса токена на CLOB (для диагностики SELL rejection) */
  readonly balanceRestClient: PolymarketBalanceRestClient;
  /** Провайдер текущего USDC-баланса от venue (для периодической синхронизации) */
  readonly currentBalanceProvider: ICurrentBalanceProvider;
  /** Use case обновления статуса ордера — для OrderUpdateOrchestrator и прямого вызова из reconciler */
  readonly updateOrderStatusUseCase: UpdateOrderStatusUseCase;
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
  const { credentials, infra, repos, processFillUseCase, orderedEventOutbox, userWsAdapter, accountId, dnsOverride, enableAutoTerminalSettlement = false } = params;
  const { clock, logger, eventBus, metadataGenerator } = infra;
  const { orderRepo, portfolioStore, processedFillRepo, reconciliationIssueRepo, keyedMutex, orderSubmissionRepo } = repos;

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
    // MAKER ownership matching в getTrades() (см. mapUserFillsToVenueTrades) —
    // тот же makerAddress, что уже передаётся в UserEventFeedAdapter ниже.
    makerAddress,
  );

  // Inline adapter: ICurrentBalanceProvider → PolymarketBalanceProvider.getAvailableBalance()
  // Чистый passthrough — getAvailableBalance() уже возвращает Money, лишний
  // Money.toNumber() → new Decimal(...) раунд-трип (lossy) убран в Этапе 10c.
  const currentBalanceProvider: ICurrentBalanceProvider = {
    getUsdcBalance(_accountId: AccountId): Promise<Money> {
      return balanceProvider.getAvailableBalance();
    },
  };

  // ── 4. Startup use-cases ─────────────────────────────────────────────────

  const initializePortfolioUseCase = new InitializePortfolioUseCase({
    balanceProvider: currentBalanceProvider,
    portfolioStore,
    logger,
  });

  const portfolioService = new PortfolioService(portfolioStore, logger);

  const updateOrderStatusUseCase = new UpdateOrderStatusUseCase({
    metadataGenerator,
    orderRepo,
    orderStateStore: orderRepo,
    portfolioService,
    // Сериализация с PlaceOrderUseCase по [accountId, orderId] — закрывает race
    // «ранний terminal ORDER_UPDATE до локального save».
    keyedMutex,
    // ТОТ ЖЕ outbox, что у Place/Fill/Cancel — per-order FIFO; flush после lock.
    orderedEventOutbox,
    // Journal release остатка резервации при терминальном venue-update.
    submissions: orderSubmissionRepo,
    logger,
    // Сбой release резервации после committed venue update теперь queryable
    // (ORDER_PORTFOLIO_DESYNC), а не только лог. Плюс early-terminal-update issue.
    reconciliationIssues: reconciliationIssueRepo,
    clock,
  });

  const orderUpdateHandler = new OrderUpdateHandler(eventBus, metadataGenerator, clock, accountId, logger);

  // DISCOVERY-ONLY обнаружение venue-кандидатов для ambiguous submissions без
  // venueOrderId (fail-closed): работает НЕЗАВИСИМО от наличия локальных Order,
  // только создаёт findings/issues — решение принимает оператор через
  // resolveUnknownSubmissionUseCase.
  const reconcileUnknownSubmissionsUseCase = new ReconcileUnknownSubmissionsUseCase({
    submissions: orderSubmissionRepo,
    exchangeClient,
    clock,
    logger,
    reconciliationIssues: reconciliationIssueRepo,
  });

  // Явное операторское разрешение UNKNOWN submission — единственный путь
  // bind/release/снятия manual block (админ-команды/tooling).
  const resolveUnknownSubmissionUseCase = new ResolveUnknownSubmissionUseCase({
    submissions: orderSubmissionRepo,
    exchangeClient,
    portfolioService,
    orderStateStore: orderRepo,
    keyedMutex,
    clock,
    logger,
    reconciliationIssues: reconciliationIssueRepo,
    // Немедленное применение уже полученных trade snapshots при TRADE bind
    // (см. ResolveUnknownSubmissionUseCase._applyBoundTrades) — вне lock,
    // fillProcessor берёт свой mutex сам.
    fillProcessor: processFillUseCase,
    processedFillRepo,
  });

  // Операторская отмена привязанного live venue-ордера (закрытие
  // BOUND_AWAITING_ORDER_RECOVERY): venue cancel → release → снятие блока.
  const cancelBoundVenueOrderUseCase = new CancelBoundVenueOrderUseCase({
    submissions: orderSubmissionRepo,
    exchangeClient,
    portfolioService,
    orderStateStore: orderRepo,
    orderRepo,
    keyedMutex,
    clock,
    logger,
    reconciliationIssues: reconciliationIssueRepo,
  });

  // Разрешение terminal settlement pending: delayed fills применяются held-path,
  // затем release только authoritative остатка (см. SettleTerminalOrdersUseCase).
  const settleTerminalOrdersUseCase = new SettleTerminalOrdersUseCase({
    orderStateStore: orderRepo,
    submissions: orderSubmissionRepo,
    portfolioService,
    exchangeClient,
    processedFillRepo,
    fillProcessor: processFillUseCase,
    tradeToFill: venueTradeToFill,
    keyedMutex,
    clock,
    logger,
    reconciliationIssues: reconciliationIssueRepo,
  });

  // Inline reconciler: сверяет локальные ордера с venue (LIVE + MATCHED).
  // Вызываем updateOrderStatusUseCase напрямую (не через EventBus) для синхронной обработки.
  const orderReconciler = {
    async reconcile(reconcileAccountId: AccountId): Promise<void> {
      // Сначала — UNKNOWN submissions discovery (НЕ зависит от наличия локальных
      // Order: ambiguous submit без venueOrderId локального Order не имеет).
      const unknownResult = await reconcileUnknownSubmissionsUseCase.execute({ accountId: reconcileAccountId });
      if (!unknownResult.ok) {
        logger.warn('Unknown-submission discovery failed (will retry next cycle)', {
          error: unknownResult.error.message,
        });
      }

      // Затем — terminal settlement pending (delayed fills + authoritative
      // release). Гейт flag'ом: reconcile() вызывается на startup и на
      // КАЖДЫЙ WS reconnect, не только из периодического таймера — без этой
      // проверки ENABLE_AUTO_TERMINAL_SETTLEMENT=false не гарантировал бы
      // отключение automatic release (main.ts гейтит только свой собственный
      // прямой вызов settleTerminalOrdersUseCase, не этот reconciler).
      if (enableAutoTerminalSettlement) {
        const settleResult = await settleTerminalOrdersUseCase.execute({ accountId: reconcileAccountId });
        if (!settleResult.ok) {
          logger.warn('Terminal settlement run failed (will retry next cycle)', {
            error: settleResult.error.message,
          });
        }
      }

      const localOrders = await orderRepo.getAll();
      if (localOrders.length === 0) {
        logger.info('No local orders to reconcile');
        return;
      }

      const [liveResult, matchedOrders] = await Promise.allSettled([
        exchangeClient.getOpenOrders(reconcileAccountId),
        orderRestClient.getMatchedOrders(undefined, 50),
      ]);

      if (liveResult.status === 'rejected') {
        logger.error('Order reconciliation: failed to fetch open orders from venue, skipping', { error: String(liveResult.reason) });
        return;
      }
      if (!liveResult.value.ok) {
        logger.error('Order reconciliation: failed to fetch open orders from venue, skipping', { error: liveResult.value.error.message });
        return;
      }

      const venueIds = new Set<string>(liveResult.value.value.map((o) => String(o.orderId)));
      if (matchedOrders.status === 'fulfilled') {
        for (const o of matchedOrders.value) venueIds.add(o.id);
      }

      let cancelledCount = 0;
      for (const order of localOrders) {
        if (!venueIds.has(String(order.id))) {
          await updateOrderStatusUseCase.execute({
            update: { type: 'CANCELLED', orderId: order.id, reason: 'Reconciliation: order not found on venue' },
            accountId: reconcileAccountId,
          });
          cancelledCount++;
        }
      }

      logger.info('Order reconciliation completed', {
        total: localOrders.length,
        cancelled: cancelledCount,
      });
    },
  };

  // REST polling fallback (safety net при gaps в WS)
  const reconcileTradesUseCase = new ReconcileTradesUseCase({
    exchangeClient,
    processedFillRepo,
    processFillUseCase,
    logger,
    // venue FAILED при локальном APPLIED теперь queryable
    // (VENUE_LOCAL_ORDER_DESYNC), а не только лог.
    reconciliationIssues: reconciliationIssueRepo,
    clock,
  });

  // ── 5. WS user channel ────────────────────────────────────────────────────

  const fillEventHandler = new FillEventHandler(eventBus, metadataGenerator, clock, logger);

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
    // onMatchedOnExchange: помечаем fill ордера как MATCHED, чтобы CancelOrderUseCase пропустил его.
    // Устраняет race: partial fill → стратегия cancels → fill 4.68 на "не найден" → portfolio desync.
    (orderId, fillId) => { repos.orderRepo.markOrderFillMatched(orderId, fillId); },
    // onInFlightFill: instrument-level tracking — блокирует стратегию даже если ордер уже cancelled/deleted.
    // Решает race: cancel → place → fill(старый) → двойная покупка.
    // status: 'MATCHED' — UserEventFeedAdapter вызывает callback только при dto.status === 'MATCHED'.
    (instrumentId, fillId, orderId) => {
      repos.orderRepo.markInFlightFill({ instrumentId, fillId, orderId, status: 'MATCHED' });
    },
  );

  return {
    exchangeClient,
    userEventFeedAdapter,
    initializePortfolioUseCase,
    orderReconciler,
    reconcileTradesUseCase,
    reconcileUnknownSubmissionsUseCase,
    resolveUnknownSubmissionUseCase,
    cancelBoundVenueOrderUseCase,
    settleTerminalOrdersUseCase,
    balanceRestClient,
    currentBalanceProvider,
    updateOrderStatusUseCase,
  };
}
