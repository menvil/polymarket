/**
 * Порт провайдера баланса.
 *
 * @remarks
 * Разделяет фиатный USDC-баланс и балансы prediction-market токенов
 * на уровне типов: Money для USDC, AssetQuantity для outcome-токенов.
 */

import type { Money, AssetQuantity } from '@polymarket/value-objects';

/**
 * Интерфейс для получения баланса пользователя.
 *
 * @remarks
 * - `getAvailableBalance()` возвращает Money (USDC) — фиатный баланс доступный для торговли
 * - `getOutcomeBalance()` возвращает AssetQuantity — количество prediction-market токенов
 */
export interface IBalanceProvider {
  /**
   * Получить доступный баланс USDC (не заблокированный в открытых ордерах).
   *
   * @returns Money в USDC
   * @throws {ApiError} При ошибке вызова API
   */
  getAvailableBalance(): Promise<Money>;

  /**
   * Получить баланс outcome-токена для конкретного инструмента.
   *
   * @param tokenId - Числовой идентификатор токена из Polymarket API
   * @returns AssetQuantity с типом POLYMARKET_CTF_TOKEN
   * @throws {ApiError} При ошибке вызова API
   */
  getOutcomeBalance(tokenId: string): Promise<AssetQuantity>;
}
