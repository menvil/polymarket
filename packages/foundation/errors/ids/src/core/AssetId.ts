import type { OnChainConditionRef } from './ConditionRef.js';
import type { OutcomeKey } from './OutcomeKey.js';
import type { SupportedCurrency } from './Currency.js';
import { KnownCurrencies, isSupportedCurrency } from './Currency.js';
import { parseOutcomeKey } from './OutcomeKey.js';
import { asOnChainProtocolId } from './ProtocolId.js';
import { parseConditionId } from './ConditionId.js';
import { parseChainId, isValidChainId } from './ChainId.js';
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { AssetIdValidationError } from '@polymarket/errors';

export { AssetIdValidationError };

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
    }
  | {
      /**
       * Сырой CTF-токен Polymarket (числовой идентификатор позиции в контракте CTF на Polygon).
       * Используется когда API возвращает только числовой asset_id без дополнительного контекста
       * (conditionId, outcomeKey). Гарантированно уникален на уровне Polymarket CTF contract.
       */
      readonly type: 'POLYMARKET_CTF_TOKEN';
      readonly tokenId: string;
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

  if (asset.type === 'POLYMARKET_CTF_TOKEN') {
    // POLYMARKET_CTF_TOKEN не имеет вложенных объектов
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
   * Создать AssetId для outcome token (safe-контракт: возвращает Result)
   *
   * @param conditionRef - On-chain ссылка на condition
   * @param outcomeKey - Ключ outcome (BinaryOutcome.UP или BinaryOutcome.DOWN)
   * @returns `Ok(AssetId)` при успехе или `Err(AssetIdValidationError)` при
   *   невалидном значении любого из полей
   *
   * @remarks
   * ⚠️ Только для on-chain protocols! Off-chain venues не поддерживаются.
   *
   * Тотальная функция — никогда не бросает исключений.
   * Валидация выполняется для всех полей: outcomeKey → protocolId → chainId → conditionId.
   * Первое невалидное поле порождает `Err(AssetIdValidationError)`.
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
   * const result = AssetIdHelpers.fromOutcomeToken(onChainRef, BinaryOutcome.UP);
   * if (result.ok) {
   *   const token = result.value;
   *   // ❌ Попытка мутации не сработает в runtime:
   *   // (token as any).conditionRef.conditionId = 'HACKED'; // Throws in strict mode
   * } else {
   *   console.error('Validation failed:', result.error.message);
   * }
   *
   * // Невалидный outcomeKey → Err, а не throw:
   * const invalid = AssetIdHelpers.fromOutcomeToken(onChainRef, 'INVALID' as OutcomeKey);
   * console.log(invalid.ok); // false
   * ```
   */
  fromOutcomeToken(
    conditionRef: OnChainConditionRef,
    outcomeKey: OutcomeKey
  ): Result<AssetId, AssetIdValidationError> {
    // Защита от corrupted runtime-ввода (as any): conditionRef должен быть объектом.
    // null проверяется явно, т.к. typeof null === 'object'; undefined отбрасывается
    // через typeof !== 'object' (typeof undefined === 'undefined').
    const conditionRefRaw = conditionRef as unknown;
    if (conditionRefRaw === null || typeof conditionRefRaw !== 'object') {
      return Err(new AssetIdValidationError(
        () => `Invalid conditionRef: must be an OnChainConditionRef object, got ${conditionRefRaw === null ? 'null' : typeof conditionRefRaw}.`,
        { context:{ field: 'conditionRef', value: String(conditionRefRaw) } }
      ));
    }

    // Валидация outcomeKey
    const validatedOutcomeKey = parseOutcomeKey(outcomeKey);
    if (!validatedOutcomeKey) {
      return Err(new AssetIdValidationError(
        (ctx: Record<string, unknown>) =>
          `Invalid outcomeKey: "${ctx.value}". Must be valid OutcomeKey (e.g., "UP", "DOWN").`,
        { context:{ field: 'outcomeKey', value: String(outcomeKey) } }
      ));
    }

    // Валидация protocolId
    const validatedProtocolId = asOnChainProtocolId(conditionRef.protocolId);
    if (!validatedProtocolId) {
      return Err(new AssetIdValidationError(
        (ctx: Record<string, unknown>) =>
          `Invalid protocolId: "${ctx.value}". Must be UPPERCASE_WITH_UNDERSCORES (e.g., "POLYMARKET_CTF").`,
        { context:{ field: 'protocolId', value: String(conditionRef.protocolId) } }
      ));
    }

    // Валидация chainId
    if (!isValidChainId(conditionRef.chainId)) {
      return Err(new AssetIdValidationError(
        (ctx: Record<string, unknown>) =>
          `Invalid chainId: ${ctx.value}. Must be positive integer (e.g., 137 for Polygon).`,
        { context:{ field: 'chainId', value: conditionRef.chainId } }
      ));
    }

    // Валидация conditionId
    const validatedConditionId = parseConditionId(conditionRef.conditionId);
    if (!validatedConditionId) {
      return Err(new AssetIdValidationError(
        (ctx: Record<string, unknown>) =>
          `Invalid conditionId: "${ctx.value}". Must be 32-byte hex string (0x...).`,
        { context:{ field: 'conditionId', value: String(conditionRef.conditionId) } }
      ));
    }

    // deepFreezeAssetId заморозит conditionRef и сам AssetId — не нужен явный Object.freeze здесь
    return Ok(deepFreezeAssetId({
      type: 'OUTCOME_TOKEN',
      conditionRef: {
        kind: 'ONCHAIN' as const,
        protocolId: validatedProtocolId,
        chainId: conditionRef.chainId,
        conditionId: validatedConditionId,
      },
      outcomeKey: validatedOutcomeKey,
    }));
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
  USDC: deepFreezeAssetId({
    type: 'CURRENCY' as const,
    currency: KnownCurrencies.USDC,
  }),

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
   * const r1 = AssetIdHelpers.fromOutcomeToken(ref, BinaryOutcome.UP);
   * const r2 = AssetIdHelpers.fromOutcomeToken(ref, BinaryOutcome.DOWN);
   * if (r1.ok && r2.ok) {
   *   AssetIdHelpers.equals(r1.value, r2.value); // false (different outcome)
   * }
   * ```
   */
  equals(a: AssetId, b: AssetId): boolean {
    // Проверка типа актива
    if (a.type !== b.type) {
      return false;
    }

    // Проверка равенства asset identifier
    if (a.type === 'CURRENCY') {
      // Явная проверка b позволяет TypeScript сузить тип b без type cast
      /* c8 ignore next */
      if (b.type !== 'CURRENCY') return false;
      return a.currency === b.currency;
    }

    // POLYMARKET_CTF_TOKEN
    if (a.type === 'POLYMARKET_CTF_TOKEN') {
      /* c8 ignore next */
      if (b.type !== 'POLYMARKET_CTF_TOKEN') return false;
      return a.tokenId === b.tokenId;
    }

    // OUTCOME_TOKEN: явная проверка b сужает его тип без type cast
    /* c8 ignore next */
    if (b.type !== 'OUTCOME_TOKEN') return false;

    // Сравниваем conditionRef
    const aRef = a.conditionRef;
    const bRef = b.conditionRef;

    if (
      aRef.kind !== bRef.kind ||
      aRef.protocolId !== bRef.protocolId ||
      aRef.chainId !== bRef.chainId ||
      aRef.conditionId !== bRef.conditionId
    ) {
      return false;
    }

    // Сравниваем outcomeKey
    return a.outcomeKey === b.outcomeKey;
  },
};

// Замораживаем namespace объект, чтобы его члены (fromCurrency, fromOutcomeToken,
// equals, USDC) нельзя было перезаписать в runtime через as any / monkey-patching.
// deepFreezeAssetId отдельно заморозит значения AssetId (применяется к экземплярам).
Object.freeze(AssetId);

/**
 * Преобразование AssetId в строку для логирования и сериализации
 *
 * @param asset - AssetId для преобразования
 * @returns Строковое представление
 *
 * @remarks
 * Использует ':' как разделитель без экранирования.
 * Инвариант: все поля AssetId (currency, protocolId, conditionId, outcomeKey)
 * гарантированно не содержат ':' — это enforced валидаторами при создании
 * (isSupportedCurrency, asOnChainProtocolId, parseConditionId, parseOutcomeKey).
 * Это обеспечивает корректный round-trip: parseAssetId(assetIdToString(id)) === id.
 *
 * @example
 * ```typescript
 * const usdc = AssetIdHelpers.USDC;
 * assetIdToString(usdc);
 * // → 'CURRENCY:USDC'
 *
 * const tokenResult = AssetIdHelpers.fromOutcomeToken(onChainRef, BinaryOutcome.UP);
 * if (tokenResult.ok) {
 *   assetIdToString(tokenResult.value);
 *   // → 'OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc123:UP'
 * }
 * ```
 */
export function assetIdToString(asset: AssetId): string {
  if (asset.type === 'CURRENCY') {
    return `CURRENCY:${asset.currency}`;
  }

  if (asset.type === 'POLYMARKET_CTF_TOKEN') {
    return `POLYMARKET_CTF_TOKEN:${asset.tokenId}`;
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
 * - 'POLYMARKET_CTF_TOKEN:<numericId>' (сериализованный формат)
 * - '<numericId>' (сырой числовой id из Polymarket API, например asset_id в last_trade_price)
 *
 * @example
 * ```typescript
 * const usdc = parseAssetId('CURRENCY:USDC');
 * // → { type: 'CURRENCY', currency: 'USDC' }
 *
 * const token = parseAssetId('OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc123:UP');
 * // → { type: 'OUTCOME_TOKEN', conditionRef: {...}, outcomeKey: 'UP' }
 *
 * // Сырой числовой asset_id из Polymarket last_trade_price события
 * const ctf = parseAssetId('62305814799875783974460176688386847666394972778903073967664089920408777315323');
 * // → { type: 'POLYMARKET_CTF_TOKEN', tokenId: '623...' }
 *
 * const invalid = parseAssetId('INVALID:FORMAT');
 * // → undefined
 * ```
 */
export function parseAssetId(str: string): AssetId | undefined {
  // Защита от non-string runtime-ввода через as any
  if (typeof str !== 'string') {
    return undefined;
  }

  // Сырой числовой id (asset_id из Polymarket API) — до split, чтобы не путать с другими форматами
  if (/^\d+$/.test(str.trim())) {
    return asPolymarketCtfToken(str.trim());
  }

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

  if (type === 'POLYMARKET_CTF_TOKEN') {
    if (parts.length !== 2) {
      return undefined;
    }
    return asPolymarketCtfToken(parts[1]);
  }

  return undefined;
}

/**
 * Создаёт AssetId для сырого числового CTF-токена Polymarket
 *
 * @param tokenId - Числовой идентификатор токена из Polymarket API (строка с цифрами)
 * @returns Замороженный AssetId типа POLYMARKET_CTF_TOKEN, или undefined если tokenId невалидный
 *
 * @remarks
 * Используется когда Polymarket API возвращает `asset_id` как большое целое число (строку),
 * например в событиях `last_trade_price`:
 * ```json
 * { "asset_id": "62305814799875783974460176688386847666394972778903073967664089920408777315323" }
 * ```
 * Принимает только непустые строки из цифр (не 0).
 *
 * @example
 * ```typescript
 * const token = asPolymarketCtfToken('62305814799875783974460176688386847666394972778903073967664089920408777315323');
 * // → { type: 'POLYMARKET_CTF_TOKEN', tokenId: '623...' }
 *
 * asPolymarketCtfToken('not-a-number'); // → undefined
 * asPolymarketCtfToken('0');            // → undefined
 * ```
 */
export function asPolymarketCtfToken(tokenId: string): AssetId | undefined {
  if (typeof tokenId !== 'string') {
    return undefined;
  }
  const normalized = tokenId.trim();
  if (!/^\d+$/.test(normalized) || normalized === '0') {
    return undefined;
  }
  return deepFreezeAssetId({ type: 'POLYMARKET_CTF_TOKEN', tokenId: normalized });
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

export function isPolymarketCtfToken(
  asset: AssetId
): asset is Extract<AssetId, { type: 'POLYMARKET_CTF_TOKEN' }> {
  return asset.type === 'POLYMARKET_CTF_TOKEN';
}
