/**
 * Контекст исполнения (среда + аккаунт).
 */
export interface ExecutionContext {
  environment: 'LIVE' | 'SIMULATION' | string;
  accountId: string;
}
