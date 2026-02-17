import type { OnChainConditionRef } from './ConditionRef.js';
import type { OutcomeKey } from './OutcomeKey.js';
import type { SupportedCurrency } from './Currency.js';
import { KnownCurrencies, isSupportedCurrency } from './Currency.js';
import { parseOutcomeKey } from './OutcomeKey.js';
import { asOnChainProtocolId } from './ProtocolId.js';
import { parseConditionId } from './ConditionId.js';
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
 * Deep freeze AssetId для гарантии иммутабельности value object
 *
 * @param asset - AssetId для заморозки
 * @returns Замороженный AssetId
 *
 * @remarks
 * TypeScript `readonly` это только compile-time проверка.
 * В runtime JavaScript позволяет мутировать объекты через `as any` или `@ts-ignore`.
 *
 * Object.freeze() гарантирует иммутабельность в runtime:
 * - Для CURRENCY: замораживает сам AssetId
 * - Для OUTCOME_TOKEN: замораживает AssetId + вложенный conditionRef
 *
 * Это критично для value objects, чтобы предотвратить:
 * - Нарушение инвариантов
 * - Непредсказуемое поведение equals()
 * - Security issues (подмена conditionId)
 *
 * @internal
 */
function deepFreezeAssetId(asset: AssetId): AssetId {
  if (asset.type === 'CURRENCY') {
    // Currency AssetId не имеет вложенных объектов
    return Object.freeze(asset);
  }

  // OUTCOME_TOKEN: freeze conditionRef и сам AssetId
  Object.freeze(asset.conditionRef);
  return Object.freeze(asset);
}

/**
 * Вспомогательные функции для создания AssetId
 */
export const AssetId = {
  /**
   * Создать AssetId для currency
   *
   * @param currency - Поддерживаемая валюта (из SupportedCurrency)
   * @returns Замороженный (immutable) AssetId для currency
   *
   * @remarks
   * Возвращаемый AssetId защищен через Object.freeze() для гарантии
   * иммутабельности value object в runtime.
   *
   * @example
   * ```typescript
   * import { AssetIdHelpers, KnownCurrencies } from '@polymarket/ids';
   *
   * const usdc = AssetIdHelpers.fromCurrency(KnownCurrencies.USDC);
   * const usdt = AssetIdHelpers.fromCurrency('USDT'); // если добавлен в SUPPORTED_CURRENCIES
   *
   * // ❌ Попытка мутации не сработает в runtime:
   * // (usdc as any).currency = 'HACKED'; // Throws in strict mode
   * ```
   */
  fromCurrency(currency: SupportedCurrency): AssetId {
    return deepFreezeAssetId({
      type: 'CURRENCY',
      currency,
    });
  },

  /**
   * Создать AssetId для outcome token
   *
   * @param conditionRef - On-chain ссылка на condition
   * @param outcomeKey - Ключ outcome (BinaryOutcome.UP или BinaryOutcome.DOWN)
   * @returns Замороженный (immutable) AssetId для outcome token
   * @throws {Error} Если outcomeKey невалидный (не проходит parseOutcomeKey)
   *
   * @remarks
   * ⚠️ Только для on-chain protocols! Off-chain venues не поддерживаются.
   *
   * Валидация outcomeKey предотвращает создание AssetId с некорректным ключом
   * через `as OutcomeKey` casting.
   *
   * Возвращаемый AssetId защищен через Object.freeze() (включая вложенный
   * conditionRef) для гарантии иммутабельности value object в runtime.
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
   *
   * // ❌ Попытка мутации не сработает в runtime:
   * // (token as any).conditionRef.conditionId = 'HACKED'; // Throws in strict mode
   *
   * // Это throw ошибку:
   * // const invalid = AssetIdHelpers.fromOutcomeToken(onChainRef, 'INVALID' as OutcomeKey);
   * ```
   */
  fromOutcomeToken(conditionRef: OnChainConditionRef, outcomeKey: OutcomeKey): AssetId {
    // Централизованная валидация всех полей (DRY - единая точка правды)

    // Валидация outcomeKey
    const validatedOutcomeKey = parseOutcomeKey(outcomeKey);
    if (!validatedOutcomeKey) {
      throw new Error(
        `Invalid outcomeKey: "${outcomeKey}". Must be valid OutcomeKey (e.g., "UP", "DOWN").`
      );
    }

    // Валидация protocolId
    const validatedProtocolId = asOnChainProtocolId(conditionRef.protocolId);
    if (!validatedProtocolId) {
      throw new Error(
        `Invalid protocolId: "${conditionRef.protocolId}". Must be UPPERCASE_WITH_UNDERSCORES (e.g., "POLYMARKET_CTF").`
      );
    }

    // Валидация chainId
    const validatedChainId = parseChainId(String(conditionRef.chainId));
    if (!validatedChainId) {
      throw new Error(
        `Invalid chainId: ${conditionRef.chainId}. Must be positive integer (e.g., 137 for Polygon).`
      );
    }

    // Валидация conditionId
    const validatedConditionId = parseConditionId(conditionRef.conditionId);
    if (!validatedConditionId) {
      throw new Error(
        `Invalid conditionId: "${conditionRef.conditionId}". Must be 32-byte hex string (0x...).`
      );
    }

    // Deep freeze: создаем новый замороженный conditionRef с валидированными значениями
    const frozenConditionRef: OnChainConditionRef = Object.freeze({
      kind: 'ONCHAIN' as const,
      protocolId: validatedProtocolId,
      chainId: validatedChainId,
      conditionId: validatedConditionId,
    });

    return deepFreezeAssetId({
      type: 'OUTCOME_TOKEN',
      conditionRef: frozenConditionRef,
      outcomeKey: validatedOutcomeKey,
    });
  },

  /**
   * Константа для USDC currency asset
   *
   * @remarks
   * Защищена через Object.freeze() для гарантии иммутабельности.
   *
   * @example
   * ```typescript
   * import { AssetIdHelpers } from '@polymarket/ids';
   *
   * const usdcAsset = AssetIdHelpers.USDC;
   * const balance = getBalance(accountId, venueId, usdcAsset);
   *
   * // ❌ Попытка мутации не сработает в runtime:
   * // (usdcAsset as any).currency = 'HACKED'; // Throws in strict mode
   * ```
   */
  USDC: Object.freeze({
    type: 'CURRENCY' as const,
    currency: KnownCurrencies.USDC,
  }) as AssetId,

  /**
   * Проверяет равенство двух AssetId
   *
   * @param a - Первый AssetId
   * @param b - Второй AssetId
   * @returns true если AssetId представляют одинаковый актив
   *
   * @remarks
   * Два AssetId равны если:
   * - Их типы совпадают (CURRENCY или OUTCOME_TOKEN)
   * - Для CURRENCY: currency совпадает
   * - Для OUTCOME_TOKEN: conditionRef + outcomeKey совпадают
   *
   * **Зачем централизовать:**
   * - DRY: единая точка правды для логики сравнения
   * - Maintainability: если AssetId изменится, обновляем в одном месте
   * - Consistency: одинаковая логика во всех слоях
   *
   * @example
   * ```typescript
   * const usdc1 = AssetIdHelpers.USDC;
   * const usdc2 = AssetIdHelpers.fromCurrency(KnownCurrencies.USDC);
   * AssetIdHelpers.equals(usdc1, usdc2); // true
   *
   * const token1 = AssetIdHelpers.fromOutcomeToken(ref, BinaryOutcome.UP);
   * const token2 = AssetIdHelpers.fromOutcomeToken(ref, BinaryOutcome.DOWN);
   * AssetIdHelpers.equals(token1, token2); // false (different outcome)
   * ```
   */
  equals(a: AssetId, b: AssetId): boolean {
    // Проверка типа актива
    if (a.type !== b.type) {
      return false;
    }

    // Проверка равенства asset identifier
    if (a.type === 'CURRENCY') {
      return a.currency === (b as Extract<AssetId, { type: 'CURRENCY' }>).currency;
    }

    // OUTCOME_TOKEN
    const aToken = a as Extract<AssetId, { type: 'OUTCOME_TOKEN' }>;
    const bToken = b as Extract<AssetId, { type: 'OUTCOME_TOKEN' }>;

    // Сравниваем conditionRef
    const aRef = aToken.conditionRef;
    const bRef = bToken.conditionRef;

    if (
      aRef.kind !== bRef.kind ||
      aRef.protocolId !== bRef.protocolId ||
      aRef.chainId !== bRef.chainId ||
      aRef.conditionId !== bRef.conditionId
    ) {
      return false;
    }

    // Сравниваем outcomeKey
    return aToken.outcomeKey === bToken.outcomeKey;
  },
};

/**
 * Сравнение двух AssetId на равенство
 *
 * @param a - Первый AssetId
 * @param b - Второй AssetId
 * @returns true если AssetId идентичны
 *
 * @remarks
 * Делегирует к `AssetId.equals` во избежание дублирования логики.
 * При добавлении новых вариантов AssetId достаточно обновить только `AssetId.equals`.
 *
 * @example
 * ```typescript
 * const usdc1 = AssetIdHelpers.USDC;
 * const usdc2 = AssetIdHelpers.fromCurrency('USDC');
 * assetIdEquals(usdc1, usdc2); // → true
 * ```
 */
export function assetIdEquals(a: AssetId, b: AssetId): boolean {
  return AssetId.equals(a, b);
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
 * Возвращает глубоко замороженный (immutable) AssetId — как и все фабричные методы.
 * Это сохраняет контракт иммутабельности value object для всех путей получения AssetId.
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

    return deepFreezeAssetId({
      type: 'CURRENCY',
      currency,
    });
  }

  if (type === 'OUTCOME_TOKEN') {
    // Format: OUTCOME_TOKEN:ONCHAIN:protocolId:chainId:conditionId:outcomeKey
    if (parts.length !== 6) {
      return undefined;
    }

    const [, kind, protocolIdRaw, chainIdStr, conditionIdRaw, outcomeKeyStr] = parts;

    if (kind !== 'ONCHAIN') {
      return undefined;
    }

    // Валидация и парсинг OnChainProtocolId (поддерживает custom protocols)
    const protocolId = asOnChainProtocolId(protocolIdRaw);
    if (!protocolId) {
      return undefined;
    }

    // Валидация ChainId
    const validatedChainId = parseChainId(chainIdStr);
    if (!validatedChainId) {
      return undefined;
    }

    // Валидация и нормализация ConditionId (lowercase canonical form)
    const conditionId = parseConditionId(conditionIdRaw);
    if (!conditionId) {
      return undefined;
    }

    // Валидация OutcomeKey
    const validatedOutcomeKey = parseOutcomeKey(outcomeKeyStr);
    if (!validatedOutcomeKey) {
      return undefined;
    }

    return deepFreezeAssetId({
      type: 'OUTCOME_TOKEN',
      conditionRef: {
        kind: 'ONCHAIN',
        protocolId,
        chainId: validatedChainId,
        conditionId,
      },
      outcomeKey: validatedOutcomeKey,
    });
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
