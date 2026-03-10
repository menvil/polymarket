import { Result } from '@polymarket/result';
import { ErrorSource, InvalidAssetQuantityError } from '@polymarket/errors';
import { AssetQuantity } from '../core/AssetQuantity.js';
/**
 * JSON контракт для AssetQuantity сериализации
 *
 * @remarks
 * Используется как:
 * - Контракт API (документация структуры)
 * - Return type для toJSON()
 * - Type hint при создании JSON
 *
 * При парсинге (fromJSON) НЕ полагайся на этот тип -
 * делай полную runtime валидацию с unknown!
 */
export interface AssetQuantityJSON {
    /**
     * Asset identifier в строковом формате
     * Examples:
     * - "CURRENCY:USDC"
     * - "OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc...:UP"
     */
    asset: string;
    /**
     * Amount as string (preserves precision)
     */
    amount: string;
}
/**
 * JSON сериализатор для AssetQuantity
 *
 * @remarks
 * ГРАНИЦА СИСТЕМЫ: принимает unknown, валидирует структуру.
 *
 * Отвечает за:
 * - Валидацию типов на границе (unknown → typed)
 * - Сериализацию/десериализацию JSON
 * - Читаемую диагностику через safeStringify
 *
 * Контракт:
 * - fromJSON НИКОГДА не доверяет типам, делает полную проверку
 * - toJSON ВСЕГДА возвращает валидный AssetQuantityJSON
 * - Все ошибки возвращаются через Result.Err
 *
 * @example
 * ```typescript
 * import { AssetQuantitySerializer } from '@polymarket/value-objects/asset-quantity';
 *
 * // Десериализация
 * const json = {
 *   asset: 'CURRENCY:USDC',
 *   amount: '100.5'
 * };
 * const result = AssetQuantitySerializer.fromJSON(json);
 * if (result.ok) {
 *   console.log(result.value.amount().toNumber()); // 100.5
 *   console.log(result.value.isCurrency()); // true
 * }
 *
 * // Сериализация
 * const assetQty = expectOk(AssetQuantityService.createUsdc(100.5));
 * const serialized = AssetQuantitySerializer.toJSON(assetQty);
 * // → { asset: 'CURRENCY:USDC', amount: '100.5' }
 * ```
 */
export declare class AssetQuantitySerializer {
    /**
     * Десериализует AssetQuantity из JSON
     *
     * @remarks
     * Принимает unknown - граница валидации типов.
     * Валидирует структуру JSON перед парсингом.
     *
     * Этапы валидации:
     * 1. Проверка что json это объект
     * 2. Проверка наличия обязательных полей (asset, amount)
     * 3. Парсинг asset через parseAssetId
     * 4. Парсинг amount как Decimal
     * 5. Создание AssetQuantity через AssetQuantityService.create
     *
     * @param json - JSON данные (unknown)
     * @param source - Источник ошибки (опционально)
     * @returns Result с AssetQuantity или InvalidAssetQuantityError
     *
     * @example
     * ```typescript
     * // ✅ Валидный пример (USDC)
     * AssetQuantitySerializer.fromJSON({
     *   asset: 'CURRENCY:USDC',
     *   amount: '100.5'
     * });
     *
     * // ✅ Валидный пример (OutcomeToken)
     * AssetQuantitySerializer.fromJSON({
     *   asset: 'OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc...:UP',
     *   amount: '50.25'
     * });
     *
     * // ❌ Структурные ошибки
     * AssetQuantitySerializer.fromJSON(null);                    // Err: expected object
     * AssetQuantitySerializer.fromJSON({});                      // Err: missing fields
     * AssetQuantitySerializer.fromJSON({ asset: 'invalid', amount: '100' }); // Err: invalid asset
     * ```
     */
    static fromJSON(json: unknown, source?: ErrorSource): Result<AssetQuantity, InvalidAssetQuantityError>;
    /**
     * Сериализует AssetQuantity в JSON объект
     *
     * @param assetQty - AssetQuantity для сериализации
     * @returns AssetQuantityJSON объект
     *
     * @remarks
     * Возвращает строго типизированный AssetQuantityJSON.
     * Гарантирует что все поля присутствуют и имеют правильные типы.
     *
     * Asset сериализуется через assetIdToString для компактности.
     * Amount сериализуется как строка для сохранения точности.
     *
     * @example
     * ```typescript
     * // USDC
     * const usdcQty = expectOk(AssetQuantityService.createUsdc(100.5));
     * const json = AssetQuantitySerializer.toJSON(usdcQty);
     * // → { asset: 'CURRENCY:USDC', amount: '100.5' }
     *
     * // OutcomeToken
     * const tokenQty = expectOk(AssetQuantityService.createOutcomeToken(conditionRef, BinaryOutcome.UP, 50));
     * const json2 = AssetQuantitySerializer.toJSON(tokenQty);
     * // → { asset: 'OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc...:UP', amount: '50' }
     * ```
     */
    static toJSON(assetQty: AssetQuantity): AssetQuantityJSON;
}
//# sourceMappingURL=AssetQuantitySerializer.d.ts.map