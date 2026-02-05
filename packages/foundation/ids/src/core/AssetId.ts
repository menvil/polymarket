import type { ConditionRef } from './ConditionRef.js';
import type { OutcomeIndex } from './OutcomeIndex.js';

/**
 * AssetId - универсальный идентификатор актива
 *
 * @remarks
 * Может быть:
 * - Currency (USDC, USDT, etc)
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
      readonly currency: string;
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
   */
  fromCurrency(currency: string): AssetId {
    return {
      type: 'CURRENCY',
      currency,
    };
  },

  /**
   * Создать AssetId для outcome token
   */
  fromOutcomeToken(conditionRef: ConditionRef, outcomeIndex: OutcomeIndex): AssetId {
    return {
      type: 'OUTCOME_TOKEN',
      conditionRef,
      outcomeIndex,
    };
  },

  /**
   * Константы для известных currencies
   */
  USDC: {
    type: 'CURRENCY',
    currency: 'USDC',
  } as const as AssetId,

  USDT: {
    type: 'CURRENCY',
    currency: 'USDT',
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
