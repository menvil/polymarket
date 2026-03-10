import { Result } from '@polymarket/result';
import { ErrorSource, InvalidOutcomeTokenError } from '@polymarket/errors';
import { OutcomeToken } from '../core/OutcomeToken.js';
/**
 * JSON контракт для OutcomeToken сериализации
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
export interface OutcomeTokenJSON {
    /**
     * On-chain condition reference
     */
    conditionRef: {
        kind: 'ONCHAIN';
        protocolId: string;
        chainId: number;
        conditionId: string;
    };
    /**
     * Outcome key (UP, DOWN, etc)
     */
    outcomeKey: string;
}
/**
 * JSON сериализатор для OutcomeToken
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
 * - toJSON ВСЕГДА возвращает валидный OutcomeTokenJSON
 * - Все ошибки возвращаются через Result.Err
 *
 * @example
 * ```typescript
 * import { OutcomeTokenSerializer } from '@polymarket/value-objects/outcome-token';
 *
 * // Десериализация
 * const json = {
 *   conditionRef: {
 *     kind: 'ONCHAIN',
 *     protocolId: 'POLYMARKET_CTF',
 *     chainId: 137,
 *     conditionId: '0xabc...'
 *   },
 *   outcomeKey: 'UP'
 * };
 * const result = OutcomeTokenSerializer.fromJSON(json);
 * if (result.ok) {
 *   console.log(result.value.outcomeKey()); // 'UP'
 * }
 *
 * // Сериализация
 * const token = expectOk(OutcomeTokenService.create(onChainRef, BinaryOutcome.UP));
 * const serialized = OutcomeTokenSerializer.toJSON(token);
 * ```
 */
export declare class OutcomeTokenSerializer {
    private static readonly SERVICE_NAME;
    /**
     * Десериализует OutcomeToken из JSON
     *
     * @remarks
     * Принимает unknown - граница валидации типов.
     * Валидирует структуру JSON перед парсингом.
     *
     * Этапы валидации:
     * 1. Проверка что json это объект
     * 2. Проверка наличия обязательных полей (conditionRef, outcomeKey)
     * 3. Проверка структуры conditionRef
     * 4. Делегирование OutcomeTokenService.create для создания
     *
     * @param json - JSON данные (unknown)
     * @param source - Источник ошибки (опционально)
     * @returns Result с OutcomeToken или InvalidOutcomeTokenError
     *
     * @example
     * ```typescript
     * // ✅ Валидный пример
     * OutcomeTokenSerializer.fromJSON({
     *   conditionRef: { kind: 'ONCHAIN', protocolId: '...', chainId: 137, conditionId: '0x...' },
     *   outcomeKey: 'UP'
     * });
     *
     * // ❌ Структурные ошибки
     * OutcomeTokenSerializer.fromJSON(null);                    // Err: expected object
     * OutcomeTokenSerializer.fromJSON({});                      // Err: missing fields
     * OutcomeTokenSerializer.fromJSON({ conditionRef: {} });    // Err: invalid conditionRef
     * ```
     */
    static fromJSON(json: unknown, source?: ErrorSource): Result<OutcomeToken, InvalidOutcomeTokenError>;
    /**
     * Сериализует OutcomeToken в JSON объект
     *
     * @param token - OutcomeToken для сериализации
     * @returns OutcomeTokenJSON объект
     *
     * @remarks
     * Возвращает строго типизированный OutcomeTokenJSON.
     * Гарантирует что все поля присутствуют и имеют правильные типы.
     *
     * @example
     * ```typescript
     * const token = expectOk(OutcomeTokenService.create(onChainRef, BinaryOutcome.UP));
     * const json = OutcomeTokenSerializer.toJSON(token);
     * // → {
     * //   conditionRef: { kind: 'ONCHAIN', ... },
     * //   outcomeKey: 'UP'
     * // }
     * ```
     */
    static toJSON(token: OutcomeToken): OutcomeTokenJSON;
}
//# sourceMappingURL=OutcomeTokenSerializer.d.ts.map