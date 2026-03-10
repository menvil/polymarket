/**
 * Shared-функция полной валидации структуры AssetId для Fee
 *
 * @remarks
 * Используется в FeeService.create() и FeeSerializer.fromUnknown()
 * для единообразной валидации с предсказуемым reason=INVALID_ASSET.
 *
 * Порядок проверок для OUTCOME_TOKEN/ONCHAIN:
 * 1. Наличие conditionRef, outcomeKey
 * 2. conditionRef — object (не null)
 * 3. conditionRef.kind — строка и === 'ONCHAIN'
 * 4. protocolId — string, non-empty, валидный формат (нет '-', ':', '\'...)
 * 5. chainId — положительное безопасное целое число (Number.isSafeInteger && > 0)
 * 6. conditionId — string, non-empty, hex-формат (0x + 64 hex-символа)
 * 7. outcomeKey — string, non-empty, без управляющих символов
 */
import type { Result } from '@polymarket/result';
import { InvalidFeeError } from '@polymarket/errors';
/**
 * Параметры контекста для сообщений об ошибках валидации
 */
interface ValidationContext {
    /** Имя сервиса для поля context.service */
    readonly service: string;
    /** Название операции для поля context.op */
    readonly op: string;
}
/**
 * Полная валидация структуры AssetId для Fee.
 *
 * @param asset - Значение для валидации
 * @param ctx   - Контекст: имя сервиса и операции (для error context)
 * @returns Ok(undefined) если asset корректен, иначе Err(InvalidFeeError)
 *
 * @remarks
 * Все ошибки возвращаются с reason=INVALID_ASSET, source=INPUT_VALIDATION.
 * Функция никогда не бросает исключений.
 *
 * @example
 * ```typescript
 * const result = validateFeeAsset(asset, { service: 'FeeService', op: 'create' });
 * if (!result.ok) return result;
 * ```
 */
export declare function validateFeeAsset(asset: unknown, ctx: ValidationContext): Result<undefined, InvalidFeeError>;
export {};
//# sourceMappingURL=validateFeeAsset.d.ts.map