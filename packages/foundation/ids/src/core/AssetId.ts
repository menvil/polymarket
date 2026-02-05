import type { ConditionRef } from './ConditionRef.js';
import type { OutcomeIndex } from './OutcomeIndex.js';
import type { SupportedCurrency } from './Currency.js';
import { KnownCurrencies } from './Currency.js';

/**
 * AssetId - универсальный идентификатор актива
 *
 * @remarks
 * Может быть:
 * - Currency (USDC и другие из SupportedCurrency)
 * - OutcomeToken (YES/NO токен конкретного рынка)
 *
 * Используется в generic контейнерах (AssetQuantity, events, transfers).
 *
 * @example
 * ```typescript
 * // USDC asset
 * const usdcAsset: AssetId = {
 *   type: 'CURRENCY',
 *   currency: 'USDC'
 * };
 *
 * // Outcome token asset
 * const tokenAsset: AssetId = {
 *   type: 'OUTCOME_TOKEN',
 *   conditionRef: { ... },
 *   outcomeIndex: 1
 * };
 * ```
 */
export type AssetId =
  | {
      readonly type: 'CURRENCY';
      readonly currency: SupportedCurrency;
    }
  | {
      readonly type: 'OUTCOME_TOKEN';
      readonly conditionRef: ConditionRef;
      readonly outcomeIndex: OutcomeIndex;
    };

/**
 * Вспомогательные функции для создания AssetId
 */
export const AssetId = {
  /**
   * Создать AssetId для currency
   *
   * @param currency - Поддерживаемая валюта (из SupportedCurrency)
   * @returns AssetId для currency
   *
   * @example
   * ```typescript
   * import { AssetIdHelpers, KnownCurrencies } from '@polymarket/ids';
   *
   * const usdc = AssetIdHelpers.fromCurrency(KnownCurrencies.USDC);
   * const usdt = AssetIdHelpers.fromCurrency('USDT'); // если добавлен в SUPPORTED_CURRENCIES
   * ```
   */
  fromCurrency(currency: SupportedCurrency): AssetId {
    return {
      type: 'CURRENCY',
      currency,
    };
  },

  /**
   * Создать AssetId для outcome token
   *
   * @param conditionRef - Полная ссылка на condition
   * @param outcomeIndex - Индекс outcome (0 = NO, 1 = YES)
   * @returns AssetId для outcome token
   *
   * @example
   * ```typescript
   * import { AssetIdHelpers, OutcomeIndexValues } from '@polymarket/ids';
   *
   * const token = AssetIdHelpers.fromOutcomeToken(conditionRef, OutcomeIndexValues.YES);
   * ```
   */
  fromOutcomeToken(conditionRef: ConditionRef, outcomeIndex: OutcomeIndex): AssetId {
    return {
      type: 'OUTCOME_TOKEN',
      conditionRef,
      outcomeIndex,
    };
  },

  /**
   * Константа для USDC currency asset
   *
   * @example
   * ```typescript
   * import { AssetIdHelpers } from '@polymarket/ids';
   *
   * const usdcAsset = AssetIdHelpers.USDC;
   * const balance = getBalance(accountId, venueId, usdcAsset);
   * ```
   */
  USDC: {
    type: 'CURRENCY',
    currency: KnownCurrencies.USDC,
  } as const as AssetId,
};

/**
 * Сравнение двух AssetId на равенство
 */
export function assetIdEquals(a: AssetId, b: AssetId): boolean {
  if (a.type !== b.type) {
    return false;
  }

  if (a.type === 'CURRENCY' && b.type === 'CURRENCY') {
    return a.currency === b.currency;
  }

  if (a.type === 'OUTCOME_TOKEN' && b.type === 'OUTCOME_TOKEN') {
    return (
      a.conditionRef.protocolId === b.conditionRef.protocolId &&
      a.conditionRef.chainId === b.conditionRef.chainId &&
      a.conditionRef.conditionId === b.conditionRef.conditionId &&
      a.outcomeIndex === b.outcomeIndex
    );
  }

  return false;
}

/**
 * Преобразование AssetId в строку для логирования
 */
export function assetIdToString(asset: AssetId): string {
  if (asset.type === 'CURRENCY') {
    return `CURRENCY:${asset.currency}`;
  }

  return `TOKEN:${asset.conditionRef.protocolId}:${asset.conditionRef.chainId}:${asset.conditionRef.conditionId}:${asset.outcomeIndex}`;
}

/**
 * Type guards
 */
export function isCurrencyAsset(asset: AssetId): asset is Extract<AssetId, { type: 'CURRENCY' }> {
  return asset.type === 'CURRENCY';
}

export function isOutcomeTokenAsset(
  asset: AssetId
): asset is Extract<AssetId, { type: 'OUTCOME_TOKEN' }> {
  return asset.type === 'OUTCOME_TOKEN';
}
