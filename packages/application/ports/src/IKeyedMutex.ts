/**
 * Порт: keyed mutex для сериализации критичных мутаций Order/Portfolio.
 *
 * @remarks
 * ### Зачем:
 * `ProcessFillUseCase.execute(fill)` и `CancelOrderUseCase.execute(input)` оба
 * мутируют один и тот же Order/Portfolio/instrument-state, но раньше не были
 * защищены от конкурентного выполнения. Без сериализации возможен interleaving:
 * ```
 * ProcessFillUseCase:  read Order (OPEN) ──await──┐
 * CancelOrderUseCase:  read Order (OPEN) ──cancel()──save(CANCELED)──┘
 * ProcessFillUseCase:  ...resumes, saveSync(FILLED) ← перезаписывает CANCELED
 * ```
 * `runExclusive()` гарантирует, что для одного и того же набора ключей
 * (accountId + orderId + instrumentId) выполняется только ОДНА функция
 * единовременно — конкурирующие вызовы ставятся в очередь по ключам.
 *
 * ### Почему множество ключей, а не один:
 * Один вызов может затрагивать несколько «измерений» состояния одновременно
 * (аккаунт, ордер, инструмент) — блокировка по всем сразу предотвращает
 * гонки как между двумя fill-ами одного ордера, так и между fill и cancel
 * на разных ордерах того же инструмента/аккаунта.
 *
 * @example
 * ```typescript
 * const result = await mutex.runExclusive(
 *   [String(fill.accountId), String(fill.orderId), String(instrumentId)],
 *   () => processFillUseCase.executeLocked(fill),
 * );
 * ```
 */
export interface IKeyedMutex {
  /**
   * Выполняет `fn` эксклюзивно относительно любого другого `runExclusive()`
   * вызова, разделяющего хотя бы один ключ из `keys`.
   *
   * @param keys - Ключи блокировки (порядок не важен и не гарантируется реализацией;
   *   deadlock при пересекающихся наборах ключей исключается за счёт ожидания
   *   ВСЕХ ключей разом — без частичного захвата, а не за счёт сортировки)
   * @param fn - Функция для эксклюзивного выполнения
   * @returns Результат `fn`
   *
   * @remarks
   * Не бросает исключений сама по себе — если `fn` бросает, `runExclusive`
   * пробрасывает ту же ошибку дальше, но обязательно освобождает блокировку
   * (эквивалент `finally`).
   */
  // TODO(production): add timeoutMs / lockTtlMs options if this mutex is used
  // beyond single-process in-memory execution. Current contract relies on fn
  // completion and has no stale-lock protection.
  runExclusive<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T>;
}
