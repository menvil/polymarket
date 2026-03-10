import type { OnChainConditionRef } from './ConditionRef.js';
import type { OutcomeKey } from './OutcomeKey.js';
import type { SupportedCurrency } from './Currency.js';
import type { Result } from '@polymarket/result';
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
export type AssetId = {
    readonly type: 'CURRENCY';
    readonly currency: SupportedCurrency;
} | {
    readonly type: 'OUTCOME_TOKEN';
    readonly conditionRef: OnChainConditionRef;
    readonly outcomeKey: OutcomeKey;
} | {
    /**
     * Сырой CTF-токен Polymarket (числовой идентификатор позиции в контракте CTF на Polygon).
     * Используется когда API возвращает только числовой asset_id без дополнительного контекста
     * (conditionId, outcomeKey). Гарантированно уникален на уровне Polymarket CTF contract.
     */
    readonly type: 'POLYMARKET_CTF_TOKEN';
    readonly tokenId: string;
};
/**
 * Вспомогательные функции для создания AssetId
 */
export declare const AssetId: {
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
    fromCurrency(currency: SupportedCurrency): AssetId;
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
    fromOutcomeToken(conditionRef: OnChainConditionRef, outcomeKey: OutcomeKey): Result<AssetId, AssetIdValidationError>;
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
    USDC: AssetId;
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
    equals(a: AssetId, b: AssetId): boolean;
};
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
export declare function assetIdToString(asset: AssetId): string;
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
export declare function parseAssetId(str: string): AssetId | undefined;
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
 * Ведущие нули автоматически убираются: '007' и '7' маппируются в одинаковый токен.
 *
 * @example
 * ```typescript
 * const token = asPolymarketCtfToken('62305814799875783974460176688386847666394972778903073967664089920408777315323');
 * // → { type: 'POLYMARKET_CTF_TOKEN', tokenId: '623...' }
 *
 * asPolymarketCtfToken('007').tokenId === asPolymarketCtfToken('7').tokenId; // → true (ведущие нули)
 * asPolymarketCtfToken('not-a-number'); // → undefined
 * asPolymarketCtfToken('0');            // → undefined
 * ```
 */
export declare function asPolymarketCtfToken(tokenId: string): AssetId | undefined;
/**
 * Type guards
 */
export declare function isCurrencyAsset(asset: AssetId): asset is Extract<AssetId, {
    type: 'CURRENCY';
}>;
export declare function isOutcomeTokenAsset(asset: AssetId): asset is Extract<AssetId, {
    type: 'OUTCOME_TOKEN';
}>;
export declare function isPolymarketCtfToken(asset: AssetId): asset is Extract<AssetId, {
    type: 'POLYMARKET_CTF_TOKEN';
}>;
//# sourceMappingURL=AssetId.d.ts.map