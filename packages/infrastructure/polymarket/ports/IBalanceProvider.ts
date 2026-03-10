/**
 * Порт провайдера баланса.
 */

/**
 * Интерфейс для получения баланса пользователя.
 */
export interface IBalanceProvider {
  /** Доступный баланс USDC (не заблокированный в ордерах) */
  getAvailableBalance(): Promise<number>;
  /** Баланс outcome-токена */
  getOutcomeBalance(tokenId: string): Promise<number>;
}
