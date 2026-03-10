/**
 * Допустимые значения среды исполнения.
 *
 * @remarks
 * Используется `string & {}` для сохранения IDE-автодополнения для известных значений,
 * при этом допуская произвольные строки (расширяемость без потери подсказок).
 */
export type Environment = 'LIVE' | 'SIMULATION' | (string & {});

/**
 * Контекст исполнения (среда + аккаунт).
 */
export interface ExecutionContext {
  environment: Environment;
  accountId: string;
}
