/**
 * InMemoryKeyedMutex — keyed mutex на Promise-цепочках, single-process.
 *
 * @remarks
 * Реализует `IKeyedMutex` через `Map<string, Promise<void>>`: для каждого ключа
 * хранится promise текущего «держателя» блокировки. `runExclusive()` ждёт
 * завершения ТЕКУЩИХ держателей всех запрошенных ключей, затем синхронно
 * (до await) регистрирует себя как новый держатель для каждого ключа — это
 * гарантирует, что конкурирующий вызов, попавший в тот же tick event loop,
 * встанет в очередь именно за нами, а не проскочит мимо.
 *
 * ### Почему без deadlock при пересекающихся наборах ключей:
 * Нет частичного захвата (acquire one key at a time) — `runExclusive` ждёт
 * ВСЕ ключи разом (`Promise.all`), поэтому классический deadlock «A держит 1,
 * хочет 2; B держит 2, хочет 1» невозможен: между регистрацией себя во всех
 * ключах и стартом ожидания нет await, значит нет окна для чужой регистрации
 * между «захватить key1» и «захватить key2».
 *
 * ### Ограничения:
 * Только single-process (Node.js event loop). Для multi-process нужен
 * distributed lock (Redis Redlock, Postgres advisory lock) — не в scope этого
 * пакета.
 *
 * @example
 * ```typescript
 * const mutex = new InMemoryKeyedMutex();
 * const result = await mutex.runExclusive(
 *   [String(accountId), String(orderId), String(instrumentId)],
 *   async () => processFillUseCase.executeLocked(fill),
 * );
 * ```
 */
import type { IKeyedMutex } from '@polymarket/ports';

export class InMemoryKeyedMutex implements IKeyedMutex {
  /** Ключ → promise текущего держателя блокировки (resolve при освобождении) */
  private readonly _chains = new Map<string, Promise<void>>();

  /**
   * Выполняет `fn` эксклюзивно относительно любого другого `runExclusive()`
   * вызова, разделяющего хотя бы один ключ.
   *
   * @param keys - Ключи блокировки
   * @param fn - Функция для эксклюзивного выполнения
   * @returns Результат `fn`
   */
  public async runExclusive<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    // Дедуп (без сортировки — не нужна, см. IKeyedMutex.runExclusive doc):
    // предотвращает регистрацию одного и того же ключа дважды в рамках
    // одного вызова.
    const uniqueKeys = [...new Set(keys)];

    // Ждём завершения ТЕКУЩИХ держателей всех запрошенных ключей.
    const waitFor = uniqueKeys.map((key) => this._chains.get(key) ?? Promise.resolve());
    const gate = Promise.all(waitFor);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Регистрируем себя как нового держателя СРАЗУ (синхронно, до await),
    // чтобы конкурирующий вызов, вошедший в этот же tick, встал в очередь за нами.
    for (const key of uniqueKeys) {
      this._chains.set(key, held);
    }

    await gate;
    try {
      return await fn();
    } finally {
      release();
      // Очищаем запись, только если она всё ещё указывает на нас — иначе
      // затрём регистрацию более нового держателя, вставшего в очередь после нас.
      for (const key of uniqueKeys) {
        if (this._chains.get(key) === held) {
          this._chains.delete(key);
        }
      }
    }
  }
}
