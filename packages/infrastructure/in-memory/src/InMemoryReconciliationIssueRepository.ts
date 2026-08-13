/**
 * InMemoryReconciliationIssueRepository — хранилище reconciliation issues в памяти.
 *
 * @remarks
 * Реализует интерфейс `IReconciliationIssueRepository` на основе
 * `Map<string, ReconciliationIssue>`.
 *
 * ### Гарантии контракта порта:
 * - `add()` идемпотентен по `issue.id`: если id уже есть — существующая issue
 *   НЕ перезаписывается (no-op). Детерминированные id
 *   (`reconciliation:fill:${fillId}:...`) позволяют retry-путям безопасно
 *   вызывать `add()` повторно.
 * - `listOpen()` возвращает только `status === 'OPEN'` — свежий readonly-массив,
 *   не live reference на внутреннее хранилище.
 * - `markResolved()` для неизвестного id или уже `RESOLVED` issue — no-op
 *   (первый `resolvedAt` сохраняется).
 * - Хранимые issues замораживаются (`Object.freeze`) при `add()`, а `get()` /
 *   `listOpen()` отдают СВЕЖИЙ snapshot с клонированными `Date` — наружу
 *   никогда не отдаётся мутабельная ссылка. `Object.freeze` не защищает
 *   внутреннее значение `Date` (`setTime()` работает на frozen-объекте),
 *   поэтому Date клонируется и на записи, и на каждом чтении.
 *
 * ### Отличие от production реализации:
 * Production использует PostgreSQL/Redis для персистентности и алертинга.
 * In-memory реализация подходит для бектеста, paper/live single-process
 * режима и юнит-тестов; при перезапуске все issues теряются.
 *
 * @example
 * ```typescript
 * const repo = new InMemoryReconciliationIssueRepository();
 * await repo.add(issue);
 * const open = await repo.listOpen();
 * await repo.markResolved(issue.id, new Date());
 * ```
 */
import type { IReconciliationIssueRepository, ReconciliationIssue } from '@polymarket/ports';

/**
 * In-memory реализация хранилища reconciliation issues.
 *
 * @remarks
 * Хранит замороженные snapshot-копии issues в `Map<string, ReconciliationIssue>`.
 * Не персистентна — при перезапуске бектеста/бота все issues теряются.
 */
export class InMemoryReconciliationIssueRepository implements IReconciliationIssueRepository {
  /** issue.id → замороженный snapshot issue */
  private readonly _issues = new Map<string, ReconciliationIssue>();

  /**
   * Создаёт замороженную snapshot-копию issue (включая `context` и `Date`).
   *
   * @param issue - Исходная issue
   * @returns Immutable-копия, безопасная для выдачи наружу
   *
   * @remarks
   * `createdAt`/`resolvedAt` клонируются: `Object.freeze` не защищает
   * внутреннее значение `Date` — caller мог бы мутировать хранимое время
   * через `issue.createdAt.setTime(...)`.
   */
  private _snapshot(issue: ReconciliationIssue): ReconciliationIssue {
    return Object.freeze({
      ...issue,
      createdAt: new Date(issue.createdAt.getTime()),
      ...(issue.resolvedAt !== undefined
        ? { resolvedAt: new Date(issue.resolvedAt.getTime()) }
        : {}),
      ...(issue.context !== undefined
        ? { context: Object.freeze({ ...issue.context }) }
        : {}),
    });
  }

  /**
   * Добавляет новую issue (идемпотентно по `issue.id`).
   *
   * @param issue - Issue с детерминированным `id`
   *
   * @remarks
   * Если issue с таким id уже существует — no-op: существующая запись
   * НЕ перезаписывается (защита от дублей при retry того же сценария).
   */
  public async add(issue: ReconciliationIssue): Promise<void> {
    if (this._issues.has(issue.id)) {
      return;
    }
    this._issues.set(issue.id, this._snapshot(issue));
  }

  /**
   * Возвращает все открытые (`status === 'OPEN'`) issues.
   *
   * @returns Свежий readonly-массив открытых issues — каждая issue пере-снапшотится
   *   (клонированные `Date`), мутация возвращённых объектов не влияет на хранилище
   */
  public async listOpen(): Promise<readonly ReconciliationIssue[]> {
    return [...this._issues.values()]
      .filter((issue) => issue.status === 'OPEN')
      .map((issue) => this._snapshot(issue));
  }

  /**
   * Возвращает issue по id.
   *
   * @param id - ID issue
   * @returns Свежий snapshot issue (клонированные `Date`) или `undefined`,
   *   если id неизвестен
   */
  public async get(id: string): Promise<ReconciliationIssue | undefined> {
    const issue = this._issues.get(id);
    return issue ? this._snapshot(issue) : undefined;
  }

  /**
   * Помечает issue как разрешённую (`RESOLVED` + `resolvedAt`).
   *
   * @param id - ID issue
   * @param resolvedAt - Момент разрешения
   *
   * @remarks
   * Неизвестный id — no-op (не бросает). Уже `RESOLVED` issue — тоже no-op:
   * первый `resolvedAt` сохраняется.
   */
  public async markResolved(id: string, resolvedAt: Date): Promise<void> {
    const existing = this._issues.get(id);
    if (!existing || existing.status !== 'OPEN') {
      return;
    }
    this._issues.set(id, this._snapshot({ ...existing, status: 'RESOLVED', resolvedAt }));
  }

  /**
   * Возвращает количество отслеживаемых issues (в любом статусе).
   *
   * @remarks
   * Вспомогательный метод для тестовых assertions.
   *
   * @returns Количество уникальных issue id в хранилище
   */
  public get size(): number {
    return this._issues.size;
  }

  /**
   * Очищает хранилище.
   *
   * @remarks
   * Используется в тестах для сброса состояния между тестами.
   *
   * @example
   * ```typescript
   * beforeEach(() => repo.clear());
   * ```
   */
  public clear(): void {
    this._issues.clear();
  }
}
