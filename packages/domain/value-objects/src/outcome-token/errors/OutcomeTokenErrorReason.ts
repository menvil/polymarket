/**
 * Типизированные причины ошибок для OutcomeToken операций
 *
 * @remarks
 * Используется в InvalidOutcomeTokenError.context.reason для дифференциации ошибок
 * на уровне типов вместо строковых констант.
 *
 * Структура:
 * - Инварианты Core (NOT_ONCHAIN_CONDITION, INVALID_ASSET_ID_TYPE)
 * - Ошибки парсинга (INVALID_FORMAT)
 * - Ошибки компонентов (INVALID_CONDITION_REF, INVALID_OUTCOME_KEY)
 * - Неожиданные ошибки (UNEXPECTED)
 *
 * @example
 * ```typescript
 * import { OutcomeTokenErrorReason } from '@polymarket/value-objects/outcome-token';
 *
 * if (result.error.context?.reason === OutcomeTokenErrorReason.NOT_ONCHAIN_CONDITION) {
 *   console.error('OutcomeToken requires on-chain condition');
 * }
 * ```
 */
export enum OutcomeTokenErrorReason {
  /** ConditionRef не является OnChainConditionRef */
  NOT_ONCHAIN_CONDITION = 'NOT_ONCHAIN_CONDITION',

  /** Ошибка парсинга значения */
  INVALID_FORMAT = 'INVALID_FORMAT',

  /** Невалидный condition reference */
  INVALID_CONDITION_REF = 'INVALID_CONDITION_REF',

  /** Невалидный outcome key */
  INVALID_OUTCOME_KEY = 'INVALID_OUTCOME_KEY',

  /** AssetId имеет неправильный тип (не OUTCOME_TOKEN) */
  INVALID_ASSET_ID_TYPE = 'INVALID_ASSET_ID_TYPE',

  /** Неожиданная ошибка (внутренний баг или неизвестная причина) */
  UNEXPECTED = 'UNEXPECTED',
}
