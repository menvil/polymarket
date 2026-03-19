/**
 * Построитель paper/backtest режима.
 *
 * @remarks
 * Создаёт компоненты симуляции торговли без реального обмена с биржей.
 *
 * ### Порядок инициализации (решение chicken-and-egg):
 * ProcessFillUseCase не вызывает exchangeClient — он обрабатывает входящий fill.
 * Это позволяет создать компоненты в следующем порядке:
 *
 * 1. `MockExchangeClient` — хранит ордера in-memory
 * 2. `ProcessFillUseCase` — обрабатывает fills (не зависит от exchangeClient)
 * 3. `PaperFillSimulator` — симулирует fills через ProcessFillUseCase
 * 4. `PaperExchangeClient` — при submitOrder() вызывает simulator.trackOrder()
 * 5. `PlaceOrderUseCase` + `CancelOrderUseCase` — используют PaperExchangeClient
 *
 * ### Два компонента для создания в разное время:
 * - `buildPaperInfra()` — создаёт MockExchangeClient (нужен до use cases)
 * - `buildPaperSimulator()` — создаёт Simulator + PaperExchangeClient (после ProcessFillUseCase)
 *
 * @example
 * ```typescript
 * // Шаг 1: создаём MockExchangeClient
 * const { mockClient } = buildPaperInfra({ clock });
 *
 * // Шаг 2: создаём ProcessFillUseCase (с mockClient или без — он его не вызывает)
 * const processFillUseCase = buildProcessFill({ repos, infra });
 *
 * // Шаг 3: создаём симулятор и PaperExchangeClient
 * const { simulator, exchangeClient } = buildPaperSimulator({
 *   mockClient, processFillUseCase, infra, instrumentId, marketId, accountId, asset, config
 * });
 * simulator.start();
 *
 * // Шаг 4: создаём оставшиеся use cases с PaperExchangeClient
 * const { placeOrderUseCase, cancelOrderUseCase } = buildOrderUseCases({
 *   exchangeClient, ...
 * });
 * ```
 */

import { MockExchangeClient } from '@polymarket/backtesting';
import { PaperFillSimulator } from '../paper/PaperFillSimulator.js';
import { PaperExchangeClient } from '../paper/PaperExchangeClient.js';
import type { ProcessFillUseCase } from '@polymarket/use-cases';
import type { IClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { InstrumentId, MarketId, AccountId, AssetId } from '@polymarket/ids';
import type { PaperConfig } from '../config/BotConfig.js';

// ── Шаг 1: MockExchangeClient ────────────────────────────────────────────────

/** Параметры для создания MockExchangeClient */
export interface BuildPaperInfraParams {
  readonly clock: IClock;
}

/** Результат построения базовой paper инфраструктуры */
export interface PaperInfra {
  readonly mockClient: MockExchangeClient;
}

/**
 * Создаёт MockExchangeClient для paper режима.
 *
 * @remarks
 * Вызывается ДО buildUseCases(). MockExchangeClient используется напрямую
 * для ProcessFillUseCase (который его не вызывает), а также как база
 * для PaperExchangeClient.
 *
 * @param params - Зависимости
 * @returns Объект с mockClient
 */
export function buildPaperInfra(params: BuildPaperInfraParams): PaperInfra {
  return { mockClient: new MockExchangeClient(params.clock) };
}

// ── Шаг 2: Simulator + PaperExchangeClient ───────────────────────────────────

/** Параметры для создания симулятора и PaperExchangeClient */
export interface BuildPaperSimulatorParams {
  readonly mockClient: MockExchangeClient;
  readonly processFillUseCase: ProcessFillUseCase;
  readonly eventBus: IEventBus;
  readonly clock: IClock;
  readonly logger: ILogger;
  readonly instrumentId: InstrumentId;
  readonly marketId: MarketId;
  readonly accountId: AccountId;
  readonly asset: AssetId;
  readonly config: PaperConfig;
}

/** Результат построения симулятора */
export interface PaperSimulator {
  readonly simulator: PaperFillSimulator;
  readonly exchangeClient: PaperExchangeClient;
}

/**
 * Создаёт PaperFillSimulator и PaperExchangeClient.
 *
 * @remarks
 * Вызывается ПОСЛЕ создания ProcessFillUseCase.
 * Полученный `exchangeClient` передаётся в PlaceOrderUseCase и CancelOrderUseCase.
 *
 * @param params - Зависимости
 * @returns Объект с simulator и exchangeClient
 */
export function buildPaperSimulator(params: BuildPaperSimulatorParams): PaperSimulator {
  const { mockClient, processFillUseCase, eventBus, clock, logger, config, ...ids } = params;

  const simulator = new PaperFillSimulator({
    processFillUseCase,
    eventBus,
    clock,
    logger,
    config,
  });

  const exchangeClient = new PaperExchangeClient({
    mock: mockClient,
    simulator,
    instrumentId: ids.instrumentId,
    marketId: ids.marketId,
    accountId: ids.accountId,
    asset: ids.asset,
  });

  return { simulator, exchangeClient };
}
