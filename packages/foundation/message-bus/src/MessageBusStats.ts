/**
 * Диагностический снимок состояния MessageBus.
 *
 * @remarks
 * Дешёвые numeric-счётчики и флаги — НЕ hot-path-логирование. Снимок возвращается
 * `getStats()` и отражает состояние на момент вызова.
 *
 * ### Семантика счётчиков
 * - `publishedTotal` — количество успешно поставленных в очередь сообщений.
 *   `publishAll([A,B,C])` увеличивает на 3 только если batch принят целиком;
 *   отклонённый batch не увеличивает счётчик вовсе.
 * - `dispatchedTotal` — количество сообщений с завершённым fan-out. Сообщение без
 *   подписчиков тоже считается dispatched после прохождения drain; сообщение,
 *   fan-out которого завершился critical-ошибкой, тоже считается dispatched
 *   (оно обработано и не будет replay-иться).
 * - `handlerErrorsTotal` — все падения обработчиков (sync throw и async rejection),
 *   и critical, и non-critical.
 * - `rejectedPublicationsTotal` — количество отклонённых операций публикации
 *   (overflow или closed), а НЕ сообщений внутри отклонённого batch: один
 *   отклонённый `publishAll([100 сообщений])` увеличивает счётчик на 1.
 */
export interface MessageBusStats {
  /** Количество ожидающих сообщений; текущее in-flight сообщение не входит. */
  readonly queueSize: number;
  /** Количество типов сообщений, имеющих хотя бы одного активного подписчика. */
  readonly subscribedTypes: number;
  /** Идёт ли drain прямо сейчас. */
  readonly dispatching: boolean;
  /** Закрыт ли bus для новых публикаций (`close()` был вызван). */
  readonly closed: boolean;
  /** Успешно enqueue-нутые сообщения за всё время (см. remarks). */
  readonly publishedTotal: number;
  /** Сообщения с завершённым fan-out за всё время (см. remarks). */
  readonly dispatchedTotal: number;
  /** Все падения обработчиков за всё время (см. remarks). */
  readonly handlerErrorsTotal: number;
  /** Отклонённые операции публикации за всё время (см. remarks). */
  readonly rejectedPublicationsTotal: number;
}
