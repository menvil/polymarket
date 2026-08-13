/**
 * Допустимые значения среды исполнения.
 *
 * @remarks
 * Используется `string & {}` для сохранения IDE-автодополнения для известных значений,
 * при этом допуская произвольные строки (расширяемость без потери подсказок).
 */
export type Environment = 'LIVE' | 'SIMULATION' | (string & {}); // eslint-disable-line @typescript-eslint/ban-types -- намеренно (см. @remarks выше), не пустой объект

/**
 * Контекст исполнения (среда + аккаунт).
 */
export interface ExecutionContext {
  environment: Environment;
  accountId: string;
}
