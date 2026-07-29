/**
 * Типизированная ошибка `StrategyScheduler.unregister()` / `stopAll()`.
 *
 * @remarks
 * ### Зачем typed error, а не `Promise<void>`:
 * Прежний контракт `unregister(): Promise<void>` не мог сообщить caller-у,
 * что stop-flow НЕ завершился безопасно (например, обычный execution ещё не
 * закончился, либо final cleanup не подтверждён). Caller либо ошибочно считал
 * стратегию остановленной, либо не имел способа узнать, что нужно повторить
 * попытку. Typed `Result` делает эти состояния явными и retryable.
 *
 * @example
 * ```typescript
 * const result = await scheduler.unregister('strategy-1');
 * if (!result.ok) {
 *   if (result.error.code === 'EXECUTION_STILL_RUNNING') {
 *     // повторить позже — обычный execution ещё не завершился
 *   }
 * }
 * ```
 */
export type StopStrategyErrorCode =
  | 'STRATEGY_NOT_FOUND'
  | 'EXECUTION_STILL_RUNNING'
  | 'EXECUTION_TIMED_OUT'
  | 'FINAL_CLEANUP_UNCONFIRMED'
  | 'STOP_HOOK_FAILED'
  | 'UNSAFE_FINAL_INTENT'
  | 'REGISTRATION_CANCELLED'
  | 'DISPOSE_FAILED'
  | 'OTHER';

/**
 * Типизированная ошибка остановки стратегии.
 *
 * @remarks
 * - `STRATEGY_NOT_FOUND` — ID неизвестен (не зарегистрирован и не pending).
 * - `EXECUTION_STILL_RUNNING` — обычный execution ещё выполняется; повторите
 *   unregister позже (никакие final intents не запускались).
 * - `EXECUTION_TIMED_OUT` — watchdog уже пометил execution как зависший
 *   (стратегия `FAULTED`), и hung promise ещё не разрешился; final cleanup
 *   НЕ запускается, пока promise не завершится — повторите unregister позже.
 * - `FINAL_CLEANUP_UNCONFIRMED` — final intents исполнены, но исход небезопасен
 *   (см. `metadata.report`), authoritative post-check нашёл живые ордера, либо
 *   `metadata.commitments` содержит unresolved submission/reservation/fill
 *   commitments (см. `IStrategyCommitmentReader`) — entry НЕ удалена,
 *   lifecycle остаётся `STOPPING`/`FAULTED`, повторите unregister.
 * - `STOP_HOOK_FAILED` — `strategy.stop()` бросил исключение: это НЕ считается
 *   успешным вызовом (в отличие от пустого `[]`) — final intents НЕ
 *   исполнялись, `entry.finalIntents` НЕ закэширован, следующий unregister
 *   вызовет `strategy.stop()` заново (см. `metadata.cause`).
 * - `UNSAFE_FINAL_INTENT` — `strategy.stop()` вернул intent, отличный от
 *   CANCEL/CANCEL_ALL (например, PLACE) — programming/configuration error;
 *   final batch НЕ исполнялся вообще.
 * - `REGISTRATION_CANCELLED` — unregister пришёл во время `initialize()`;
 *   регистрация отменена, ACTIVE entry никогда не была создана (`dispose()`
 *   вызван и завершился успешно).
 * - `DISPOSE_FAILED` — регистрация была отменена во время `initialize()`, и
 *   `strategy.dispose()` бросил либо вернул `Err` — неторговые ресурсы могли
 *   остаться не освобождены (см. `metadata.cause`).
 * - `OTHER` — необработанное исключение в stop-flow.
 */
export class StopStrategyError extends Error {
  /**
   * @param code - Типизированный код (см. {@link StopStrategyErrorCode})
   * @param strategyId - ID стратегии
   * @param message - Человекочитаемое описание (English)
   * @param metadata - Доп. контекст (например, `{ report: ExecutionReport }`)
   */
  constructor(
    public readonly code: StopStrategyErrorCode,
    public readonly strategyId: string,
    message: string,
    public readonly metadata?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StopStrategyError';
  }
}
