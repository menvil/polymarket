import type { OnChainConditionRef } from './ConditionRef.js';
import type { OutcomeKey } from './OutcomeKey.js';
import type { SupportedCurrency } from './Currency.js';
import type { ConditionId } from './ConditionId.js';
import { KnownCurrencies, isSupportedCurrency } from './Currency.js';
import { parseOutcomeKey } from './OutcomeKey.js';
import { isKnownOnChainProtocol } from './ProtocolId.js';
import { isValidConditionId } from './ConditionId.js';
import { parseChainId } from './ChainId.js';

/**
 * AssetId - универсальный идентификатор актива
 *
 * @remarks
 * Может быть:
 * - Currency (USDC и другие из SupportedCurrency)
 * - OutcomeToken (UP/DOWN токен on-chain рынка)
 *
 * ⚠️ ВАЖНО: OutcomeToken только для on-chain protocols!
 * Off-chain venues (KALSHI, PREDICTIT) не имеют tokenized positions.
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
 * // On-chain outcome token asset (Polymarket)
 * const tokenAsset: AssetId = {
 *   type: 'OUTCOME_TOKEN',
 *   conditionRef: {
 *     kind: 'ONCHAIN',
 *     protocolId: 'POLYMARKET_CTF',
 *     chainId: 137,
 *     conditionId: '0xabc123...'
 *   },
 *   outcomeKey: BinaryOutcome.UP
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
      readonly conditionRef: OnChainConditionRef;
      readonly outcomeKey: OutcomeKey;
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
   * @param conditionRef - On-chain ссылка на condition
   * @param outcomeKey - Ключ outcome (BinaryOutcome.UP или BinaryOutcome.DOWN)
   * @returns AssetId для outcome token
   *
   * @remarks
   * ⚠️ Только для on-chain protocols! Off-chain venues не поддерживаются.
   *
   * @example
   * ```typescript
   * import { AssetIdHelpers, BinaryOutcome } from '@polymarket/ids';
   *
   * const onChainRef: OnChainConditionRef = {
   *   kind: 'ONCHAIN',
   *   protocolId: 'POLYMARKET_CTF',
   *   chainId: 137,
   *   conditionId: '0xabc123...'
   * };
   *
   * const token = AssetIdHelpers.fromOutcomeToken(onChainRef, BinaryOutcome.UP);
   * ```
   */
  fromOutcomeToken(conditionRef: OnChainConditionRef, outcomeKey: OutcomeKey): AssetId {
    return {
      type: 'OUTCOME_TOKEN',
      conditionRef,
      outcomeKey,
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
 *
 * @param a - Первый AssetId
 * @param b - Второй AssetId
 * @returns true если AssetId идентичны
 *
 * @example
 * ```typescript
 * const usdc1 = AssetIdHelpers.USDC;
 * const usdc2 = AssetIdHelpers.fromCurrency('USDC');
 * assetIdEquals(usdc1, usdc2); // → true
 * ```
 */
export function assetIdEquals(a: AssetId, b: AssetId): boolean {
  if (a.type !== b.type) {
    return false;
  }

  if (a.type === 'CURRENCY' && b.type === 'CURRENCY') {
    return a.currency === b.currency;
  }

  if (a.type === 'OUTCOME_TOKEN' && b.type === 'OUTCOME_TOKEN') {
    // Both are OnChainConditionRef, так что можно сравнивать напрямую
    return (
      a.conditionRef.kind === b.conditionRef.kind &&
      a.conditionRef.protocolId === b.conditionRef.protocolId &&
      a.conditionRef.chainId === b.conditionRef.chainId &&
      a.conditionRef.conditionId === b.conditionRef.conditionId &&
      a.outcomeKey === b.outcomeKey
    );
  }

  return false;
}

/**
 * Преобразование AssetId в строку для логирования и сериализации
 *
 * @param asset - AssetId для преобразования
 * @returns Строковое представление
 *
 * @example
 * ```typescript
 * const usdc = AssetIdHelpers.USDC;
 * assetIdToString(usdc);
 * // → 'CURRENCY:USDC'
 *
 * const token = AssetIdHelpers.fromOutcomeToken(onChainRef, BinaryOutcome.UP);
 * assetIdToString(token);
 * // → 'OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc123:UP'
 * ```
 */
export function assetIdToString(asset: AssetId): string {
  if (asset.type === 'CURRENCY') {
    return `CURRENCY:${asset.currency}`;
  }

  // OUTCOME_TOKEN всегда имеет OnChainConditionRef
  const ref = asset.conditionRef;
  return `OUTCOME_TOKEN:${ref.kind}:${ref.protocolId}:${ref.chainId}:${ref.conditionId}:${asset.outcomeKey}`;
}

/**
 * Парсинг AssetId из строки
 *
 * @param str - Строка в формате assetIdToString()
 * @returns AssetId или undefined если формат неверный
 *
 * @remarks
 * Обратная функция для assetIdToString(). Гарантирует round-trip:
 * parseAssetId(assetIdToString(id)) === id
 *
 * Поддерживаемые форматы:
 * - 'CURRENCY:USDC'
 * - 'OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc123:UP'
 *
 * @example
 * ```typescript
 * const usdc = parseAssetId('CURRENCY:USDC');
 * // → { type: 'CURRENCY', currency: 'USDC' }
 *
 * const token = parseAssetId('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc123:UP');
 * // → { type: 'OUTCOME_TOKEN', conditionRef: {...}, outcomeKey: 'UP' }
 *
 * const invalid = parseAssetId('INVALID:FORMAT');
 * // → undefined
 * ```
 */
export function parseAssetId(str: string): AssetId | undefined {
  const parts = str.split(':');

  if (parts.length < 2) {
    return undefined;
  }

  const type = parts[0];

  if (type === 'CURRENCY') {
    if (parts.length !== 2) {
      return undefined;
    }

    const currency = parts[1];
    if (!isSupportedCurrency(currency)) {
      return undefined;
    }

    return {
      type: 'CURRENCY',
      currency,
    };
  }

  if (type === 'OUTCOME_TOKEN') {
    // Format: OUTCOME_TOKEN:ONCHAIN:protocolId:chainId:conditionId:outcomeKey
    if (parts.length !== 6) {
      return undefined;
    }

    const [, kind, protocolId, chainIdStr, conditionId, outcomeKeyStr] = parts;

    if (kind !== 'ONCHAIN') {
      return undefined;
    }

    // Валидация ChainId
    const validatedChainId = parseChainId(chainIdStr);
    if (!validatedChainId) {
      return undefined;
    }

    // Валидация OnChainProtocolId
    if (!isKnownOnChainProtocol(protocolId)) {
      return undefined;
    }

    // Валидация ConditionId
    if (!isValidConditionId(conditionId)) {
      return undefined;
    }

    // Валидация OutcomeKey
    const validatedOutcomeKey = parseOutcomeKey(outcomeKeyStr);
    if (!validatedOutcomeKey) {
      return undefined;
    }

    return {
      type: 'OUTCOME_TOKEN',
      conditionRef: {
        kind: 'ONCHAIN',
        protocolId,
        chainId: validatedChainId,
        conditionId: conditionId as ConditionId,
      },
      outcomeKey: validatedOutcomeKey,
    };
  }

  return undefined;
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
