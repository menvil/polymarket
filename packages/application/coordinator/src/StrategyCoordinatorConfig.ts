/**
 * Конфигурация StrategyCoordinator.
 *
 * @remarks
 * Определяет частоту обнаружения рынков и проверок политики,
 * а также лимиты на количество одновременно активных стратегий.
 */
import type { AccountId } from '@polymarket/ids';

/**
 * Параметры координатора стратегий.
 *
 * @example
 * ```typescript
 * const config: StrategyCoordinatorConfig = {
 *   discoverEveryNTicks: 50,
 *   policyCheckEveryNTicks: 10,
 *   maxStrategies: 5,
 *   accountId,
 * };
 * ```
 */
export interface StrategyCoordinatorConfig {
  /**
   * Каждые N тиков запускать обнаружение новых рынков.
   *
   * @remarks
   * Обнаружение вызывает `marketCatalog.getInstruments()` и
   * запускает `openMarketUseCase` для новых рынков.
   * По умолчанию: 50 тиков.
   */
  readonly discoverEveryNTicks: number;

  /**
   * Каждые N тиков проверять политику удаления рынков.
   *
   * @remarks
   * Проверка вызывает `removalPolicy.evaluate(activeMarkets)` и
   * закрывает рынки через `closeMarketUseCase`.
   * По умолчанию: 10 тиков.
   */
  readonly policyCheckEveryNTicks: number;

  /**
   * Максимальное количество одновременно активных стратегий.
   *
   * @remarks
   * Ограничивает количество рынков сверху.
   * Работает вместе с `BalanceAllocatorConfig.maxConcurrentMarkets`.
   */
  readonly maxStrategies: number;

  /**
   * ID аккаунта для всех операций координатора.
   */
  readonly accountId: AccountId;
}
