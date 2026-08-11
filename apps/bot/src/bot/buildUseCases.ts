/**
 * Построитель use cases и прикладных сервисов.
 *
 * @remarks
 * Создаёт полный стек прикладного уровня.
 *
 * ### Два шага для paper режима (решение chicken-and-egg):
 *
 * В paper режиме `ProcessFillUseCase` нужен для `PaperFillSimulator`,
 * а `PaperExchangeClient` (содержащий simulator) нужен для `PlaceOrderUseCase`.
 * Порядок создания:
 *
 * ```
 * ProcessFillUseCase ← PaperFillSimulator ← PaperExchangeClient ← PlaceOrderUseCase
 * ```
 *
 * Решение: ProcessFillUseCase не вызывает exchangeClient, поэтому создаётся первым
 * (с временным mockClient), а PlaceOrderUseCase — после получения paperClient.
 *
 * ### Шаги:
 * 1. `buildProcessFillUseCase()` — создаёт сервисы + ProcessFillUseCase
 * 2. (вне этого модуля) создаём PaperFillSimulator + PaperExchangeClient
 * 3. `buildOrderUseCases()` — создаёт PlaceOrderUseCase + CancelOrderUseCase с paperClient
 *
 * ### Для live режима:
 * Используй `buildAllUseCases()` — все три use case сразу.
 *
 * @example
 * ```typescript
 * // Live режим:
 * const useCases = buildAllUseCases({ infra, repos, exchangeClient: liveClient, riskParams });
 *
 * // Paper режим:
 * const { processFillUseCase } = buildProcessFillUseCase({ infra, repos });
 * const { simulator, exchangeClient } = buildPaperSimulator({ processFillUseCase, ... });
 * const orderUseCases = buildOrderUseCases({ infra, repos, exchangeClient, riskParams });
 * ```
 */

import {
  PlaceOrderUseCase,
  CancelOrderUseCase,
  ProcessFillUseCase,
  PortfolioService,
  LedgerService,
} from '@polymarket/use-cases';
import { InMemoryOrderedEventOutbox } from '@polymarket/in-memory';
import { OrderRiskChecker, RiskPolicy } from '@polymarket/risk';
import type { RiskParams } from '@polymarket/risk';
import type { IExchangeClient, IMarketCatalog, IOrderedEventOutbox } from '@polymarket/ports';
import type { ApplicationEvent } from '@polymarket/event-bus';
import type { CoreInfra } from './buildCoreInfra.js';
import type { Repositories } from './buildRepositories.js';

// ── Общие типы ────────────────────────────────────────────────────────────────

/** Параметры для создания ProcessFillUseCase */
export interface BuildProcessFillParams {
  readonly infra: CoreInfra;
  readonly repos: Repositories;
}

/** Результат: ProcessFillUseCase + PortfolioService (для FillOrchestrator rollback) */
export interface ProcessFillBundle {
  readonly processFillUseCase: ProcessFillUseCase;
  readonly portfolioService: PortfolioService;
  /**
   * Ordered event outbox, разделяемый между ProcessFillUseCase и PlaceOrderUseCase.
   * Передаётся в `buildOrderUseCases` — единый инстанс гарантирует per-order FIFO
   * порядок событий Place↔Fill.
   */
  readonly orderedEventOutbox: IOrderedEventOutbox;
}

/** Параметры для создания PlaceOrderUseCase + CancelOrderUseCase */
export interface BuildOrderUseCasesParams {
  readonly infra: CoreInfra;
  readonly repos: Repositories;
  readonly exchangeClient: IExchangeClient;
  readonly riskParams: RiskParams;
  /**
   * Ordered event outbox — ТОТ ЖЕ инстанс, что у ProcessFillUseCase
   * (из `buildProcessFillUseCase().orderedEventOutbox`). Обязателен для per-order
   * порядка событий.
   */
  readonly orderedEventOutbox: IOrderedEventOutbox;
  /**
   * Каталог инструментов (опционально) — источник `expiresAt` для expiry-gate в
   * `PlaceOrderUseCase`. В production передавай его; без него expiry-проверка
   * fail-closed блокирует BUY при включённом `minTimeToExpiryMs`.
   */
  readonly marketCatalog?: IMarketCatalog;
}

/** Результат: PlaceOrderUseCase + CancelOrderUseCase */
export interface OrderUseCases {
  readonly placeOrderUseCase: PlaceOrderUseCase;
  readonly cancelOrderUseCase: CancelOrderUseCase;
}

/**
 * Полный набор use cases.
 *
 * @remarks
 * `orderedEventOutbox` — внутренняя деталь wiring (разделяется между
 * ProcessFillUseCase и PlaceOrderUseCase), поэтому исключён из публичного
 * набора: downstream-код не должен таскать его за собой.
 */
export interface UseCases extends Omit<ProcessFillBundle, 'orderedEventOutbox'>, OrderUseCases {}

// ── Построители ──────────────────────────────────────────────────────────────

/**
 * Создаёт ProcessFillUseCase (шаг 1 для paper режима).
 *
 * @remarks
 * ProcessFillUseCase не вызывает exchangeClient — обрабатывает входящий fill.
 * Поэтому может быть создан до PaperExchangeClient.
 *
 * @param params - Зависимости
 * @returns Объект с processFillUseCase
 */
export function buildProcessFillUseCase(params: BuildProcessFillParams): ProcessFillBundle {
  const { infra, repos } = params;
  const { clock, logger, eventBus } = infra;
  const { orderRepo, portfolioStore, processedFillRepo, reconciliationIssueRepo, keyedMutex, orderSubmissionRepo } = repos;

  const portfolioService = new PortfolioService(portfolioStore, logger);
  const ledgerService = new LedgerService(logger);

  // Единый ordered event outbox: публикует Order-события ПОСЛЕ выхода из keyed
  // mutex (без deadlock) и сохраняет per-order FIFO порядок Place↔Fill.
  const orderedEventOutbox = new InMemoryOrderedEventOutbox({
    publish: async (events) => {
      const result = await eventBus.publishAll(events as ApplicationEvent[]);
      if (!result.ok) throw result.error;
    },
    logger,
    reconciliationIssues: reconciliationIssueRepo,
    now: () => clock.now(),
  });

  const processFillUseCase = new ProcessFillUseCase({
    orderStateStore: orderRepo,
    portfolioService,
    ledgerService,
    orderRepo,
    processedFillRepo,
    keyedMutex,
    eventBus,
    orderedEventOutbox,
    // Reservation journal — Fill потребляет held-резервацию (recovery-путь) вместо
    // повторного дебета available; ТОТ ЖЕ инстанс, что у PlaceOrderUseCase.
    submissions: orderSubmissionRepo,
    logger,
    // ORDER_PORTFOLIO_DESYNC теперь queryable, а не только лог/fill-статус.
    // clock — чтобы createdAt issue был детерминирован относительно приложения
    // (ReplayClock в бектесте, а не wall-clock).
    reconciliationIssues: reconciliationIssueRepo,
    clock,
  });

  return { processFillUseCase, portfolioService, orderedEventOutbox };
}

/**
 * Создаёт PlaceOrderUseCase + CancelOrderUseCase (шаг 3 для paper режима).
 *
 * @remarks
 * Вызывается ПОСЛЕ создания PaperExchangeClient, чтобы внедрить его
 * как exchangeClient. Пересоздаёт PortfolioService — это нормально,
 * так как он stateless (state в репозиториях).
 *
 * @param params - Зависимости
 * @returns Объект с placeOrderUseCase и cancelOrderUseCase
 */
export function buildOrderUseCases(params: BuildOrderUseCasesParams): OrderUseCases {
  const { infra, repos, exchangeClient, riskParams, orderedEventOutbox, marketCatalog } = params;
  const { clock, logger } = infra;
  const { orderRepo, portfolioStore, reconciliationIssueRepo, orderSubmissionRepo, keyedMutex } = repos;

  const portfolioService = new PortfolioService(portfolioStore, logger);
  // Валидируем RiskParams через иммутабельную RiskPolicy — невалидная конфигурация
  // (NaN/Infinity/отрицательные/дробные счётчики) fail-fast на старте, а не молча
  // в runtime.
  const policyResult = RiskPolicy.create(riskParams);
  if (!policyResult.ok) {
    throw new Error(`Invalid risk configuration (${policyResult.error.field}): ${policyResult.error.message}`);
  }
  const riskChecker = new OrderRiskChecker(policyResult.value, logger);

  const placeOrderUseCase = new PlaceOrderUseCase({
    riskChecker,
    orderRepo,
    portfolioService,
    exchangeClient,
    orderStateStore: orderRepo,
    // Сериализация reserve+submit+save относительно fills/cancels
    // по [account, instrument] (см. PlaceOrderUseCase doc).
    keyedMutex,
    // ТОТ ЖЕ outbox, что у ProcessFillUseCase — per-order FIFO Place↔Fill.
    orderedEventOutbox,
    clock,
    logger,
    // SUBMIT_UNKNOWN_OUTCOME / SUBMIT_FILLED_WITHOUT_FILL_DETAILS / EVENT_PUBLISH_FAILED.
    reconciliationIssues: reconciliationIssueRepo,
    // Guard от небезопасного повторного submit того же clientOrderId (обязателен).
    submissions: orderSubmissionRepo,
    // Источник expiresAt для expiry-gate (опционально; см. deps doc).
    ...(marketCatalog ? { marketCatalog } : {}),
  });

  const cancelOrderUseCase = new CancelOrderUseCase({
    portfolioService,
    orderRepo,
    orderStateStore: orderRepo,
    keyedMutex,
    exchangeClient,
    // Venue-first cancel: события через ТОТ ЖЕ outbox (per-order FIFO с Place/Fill),
    // journal release остатка резервации при подтверждённой отмене.
    orderedEventOutbox,
    submissions: orderSubmissionRepo,
    logger,
    // CANCEL_UNKNOWN_OUTCOME (NOT_FOUND / UNKNOWN_RETRY_NEEDED / transport) и
    // VENUE_LOCAL_ORDER_DESYNC. clock — детерминированный createdAt (ReplayClock).
    reconciliationIssues: reconciliationIssueRepo,
    clock,
  });

  return { placeOrderUseCase, cancelOrderUseCase };
}

/**
 * Создаёт все три use case сразу (для live режима).
 *
 * @remarks
 * В live режиме нет chicken-and-egg проблемы: exchangeClient известен сразу.
 *
 * @param params - Зависимости
 * @returns Объект со всеми тремя use cases
 */
export function buildAllUseCases(
  params: BuildProcessFillParams & {
    exchangeClient: IExchangeClient;
    riskParams: RiskParams;
    marketCatalog?: IMarketCatalog;
  },
): UseCases {
  const { processFillUseCase, portfolioService, orderedEventOutbox } = buildProcessFillUseCase(params);
  // ТОТ ЖЕ outbox прокидывается в order use-cases — per-order FIFO Place↔Fill.
  const orderCases = buildOrderUseCases({ ...params, orderedEventOutbox });

  return { processFillUseCase, portfolioService, ...orderCases };
}
