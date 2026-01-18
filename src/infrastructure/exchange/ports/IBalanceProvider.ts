/**
 * Общий интерфейс провайдера балансов
 *
 * @remarks
 * Провайдер балансов абстрагирует доступ к данным о балансах.
 * Это легковесный интерфейс для запроса балансов пользователя.
 *
 * Реализации должны использовать REST клиенты или другие источники данных
 * для получения информации о балансах.
 *
 * **Варианты использования**:
 * - Проверка доступных USDC перед размещением ордера
 * - Проверка баланса outcome токенов перед продажей
 * - Отображение сводки портфеля
 * - Валидация торговых операций
 *
 * @example
 * ```typescript
 * const provider = new PolymarketBalanceProvider(balanceClient, mapper, logger);
 *
 * const usdcBalance = await provider.getAvailableBalance();
 * console.log(`Available: ${usdcBalance} USDC`);
 *
 * const outcomeBalance = await provider.getOutcomeBalance('0x123');
 * console.log(`Outcome tokens: ${outcomeBalance}`);
 * ```
 */

/**
 * Общий интерфейс провайдера балансов
 */
export interface IBalanceProvider {
  /**
   * Получить доступный баланс USDC
   *
   * @returns Доступный баланс USDC (НЕ заблокированный в открытых ордерах)
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Должен возвращать баланс, доступный для торговли.
   * Заблокированный баланс в открытых ордерах должен быть исключён.
   *
   * @example
   * ```typescript
   * const balance = await provider.getAvailableBalance();
   * console.log(`Available: ${balance} USDC`);
   * ```
   */
  getAvailableBalance(): Promise<number>;

  /**
   * Получить баланс outcome токенов для конкретного токена
   *
   * @param tokenId - ID токена (asset ID, market ID или символ)
   * @returns Баланс outcome токенов
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Возвращает баланс outcome токенов для конкретного рынка.
   * Используется при продаже outcome токенов.
   *
   * @example
   * ```typescript
   * const balance = await provider.getOutcomeBalance('0x123');
   * console.log(`Outcome tokens: ${balance}`);
   * ```
   */
  getOutcomeBalance(tokenId: string): Promise<number>;

  /**
   * Получить заблокированный баланс (в открытых ордерах)
   *
   * @returns Заблокированный баланс USDC
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Опциональный метод. Возвращает баланс, заблокированный в открытых ордерах.
   * Общий баланс = доступный + заблокированный.
   */
  getLockedBalance?(): Promise<number>;

  /**
   * Получить общий баланс (доступный + заблокированный)
   *
   * @returns Общий баланс USDC
   * @throws {ApiError} Если вызов API завершился неудачей
   *
   * @remarks
   * Опциональный метод. Возвращает общий баланс включая заблокированные средства.
   */
  getTotalBalance?(): Promise<number>;
}