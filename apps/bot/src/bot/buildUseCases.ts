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
import { OrderRiskChecker } from '@polymarket/risk';
import type { RiskParams } from '@polymarket/risk';
import type { IExchangeClient } from '@polymarket/ports';
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
}

/** Параметры для создания PlaceOrderUseCase + CancelOrderUseCase */
export interface BuildOrderUseCasesParams {
  readonly infra: CoreInfra;
  readonly repos: Repositories;
  readonly exchangeClient: IExchangeClient;
  readonly riskParams: RiskParams;
}

/** Результат: PlaceOrderUseCase + CancelOrderUseCase */
export interface OrderUseCases {
  readonly placeOrderUseCase: PlaceOrderUseCase;
  readonly cancelOrderUseCase: CancelOrderUseCase;
}

/** Полный набор use cases */
export interface UseCases extends ProcessFillBundle, OrderUseCases {}

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
  const { logger, eventBus } = infra;
  const { orderRepo, portfolioStore, processedFillRepo, keyedMutex } = repos;

  const portfolioService = new PortfolioService(portfolioStore, logger);
  const ledgerService = new LedgerService(logger);

  const processFillUseCase = new ProcessFillUseCase({
    orderStateStore: orderRepo,
    portfolioService,
    ledgerService,
    orderRepo,
    processedFillRepo,
    keyedMutex,
    eventBus,
    logger,
  });

  return { processFillUseCase, portfolioService };
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
  const { infra, repos, exchangeClient, riskParams } = params;
  const { clock, logger, eventBus } = infra;
  const { orderRepo, portfolioStore, keyedMutex } = repos;

  const portfolioService = new PortfolioService(portfolioStore, logger);
  const riskChecker = new OrderRiskChecker(riskParams, logger);

  const placeOrderUseCase = new PlaceOrderUseCase({
    riskChecker,
    orderRepo,
    portfolioService,
    exchangeClient,
    orderStateStore: orderRepo,
    eventBus,
    clock,
    logger,
  });

  const cancelOrderUseCase = new CancelOrderUseCase({
    portfolioService,
    orderRepo,
    orderStateStore: orderRepo,
    keyedMutex,
    exchangeClient,
    eventBus,
    logger,
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
  params: BuildProcessFillParams & { exchangeClient: IExchangeClient; riskParams: RiskParams },
): UseCases {
  const { processFillUseCase, portfolioService } = buildProcessFillUseCase(params);
  const orderCases = buildOrderUseCases(params);

  return { processFillUseCase, portfolioService, ...orderCases };
}
