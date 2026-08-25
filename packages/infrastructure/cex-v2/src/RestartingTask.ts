/**
 * RestartingTask — supervised-петля одной асинхронной сессии с рестартами.
 *
 * @remarks
 * Перенос production-проверенного супервизора из legacy CEX-коллектора
 * (`cex-market-data`) в V2-контур: новый contour не имеет права импортировать
 * legacy-пакет (dependency boundary N-005), а сам механизм — ровно тот
 * transport-supervision, который нужно сохранить:
 *
 * - нормальный return сессии = controlled restart (без backoff, но с
 *   минимальной паузой `controlledRestartDelayMs`);
 * - исключение сессии = restart с exponential backoff + jitter;
 * - {@link PermanentTaskError} = немедленная остановка петли без рестартов
 *   (причина не устраняется пересозданием сессии);
 * - серия быстрых отказов = cooldown-пауза;
 * - стабильная сессия (`stableResetMs`) сбрасывает счётчик отказов;
 * - `stop()` абортит текущую сессию и дожидается завершения петли;
 * - после `stop()` петля не может «воскреснуть».
 */
import type { ILogger } from '@polymarket/logger';

/**
 * Перманентный отказ supervised-задачи: рестарты бессмысленны.
 *
 * @remarks
 * Сессия бросает эту ошибку, когда причина отказа НЕ устраняется
 * пересозданием сессии (например, exchange-класс не поддерживает
 * запрошенную unified-capability — `has[...]` не изменится ни в одной
 * следующей сессии). Супервизор реагирует остановкой петли с error-логом
 * вместо бесконечного backoff/cooldown-цикла.
 */
export class PermanentTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentTaskError';
  }
}

const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_COOLDOWN_AFTER_FAILURES = 10;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_STABLE_RESET_MS = 60_000;
const DEFAULT_CONTROLLED_RESTART_DELAY_MS = 250;

/**
 * Параметры {@link RestartingTask}.
 */
export interface RestartingTaskOptions {
  /** Имя задачи для логов. */
  readonly name: string;
  /** Одна сессия задачи; получает AbortSignal остановки. */
  readonly run: (signal: AbortSignal) => Promise<void>;
  readonly logger: ILogger;
  /** Начальный backoff после отказа (ms). Default: 1000. */
  readonly initialBackoffMs?: number;
  /** Максимальный backoff (ms). Default: 60000. */
  readonly maxBackoffMs?: number;
  /** Доля jitter от backoff (±). Default: 0.2. */
  readonly jitterRatio?: number;
  /** Отказов подряд до cooldown. Default: 10. */
  readonly cooldownAfterFailures?: number;
  /** Длительность cooldown (ms). Default: 5 минут. */
  readonly cooldownMs?: number;
  /** Uptime сессии, после которого счётчик отказов сбрасывается (ms). Default: 60000. */
  readonly stableResetMs?: number;
  /**
   * Минимальная пауза между нормальным завершением сессии и её рестартом
   * (ms). Default: 250. Защита от tight-loop мгновенно завершающихся
   * сессий (controlled restart без backoff не должен монополизировать
   * event loop / плодить инстансы).
   */
  readonly controlledRestartDelayMs?: number;
  /** @internal Test hook для детерминированного jitter. */
  readonly random?: () => number;
}

/**
 * Запускает одну асинхронную сессию за раз и перезапускает её после
 * завершения/отказа.
 *
 * @remarks
 * Нормальный return сессии — controlled restart (например, плановый
 * перезапуск CCXT-инстанса). Брошенное исключение — restart с exponential
 * backoff и (после серии отказов) cooldown.
 *
 * @example
 * ```typescript
 * const task = new RestartingTask({
 *   name: 'binance:orderbook',
 *   run: (signal) => session(signal),
 *   logger,
 * });
 * task.start();
 * // ... shutdown:
 * await task.stop();
 * ```
 */
export class RestartingTask {
  private readonly _name: string;
  private readonly _run: (signal: AbortSignal) => Promise<void>;
  private readonly _logger: ILogger;
  private readonly _initialBackoffMs: number;
  private readonly _maxBackoffMs: number;
  private readonly _jitterRatio: number;
  private readonly _cooldownAfterFailures: number;
  private readonly _cooldownMs: number;
  private readonly _stableResetMs: number;
  private readonly _controlledRestartDelayMs: number;
  private readonly _random: () => number;

  private _stopped = true;
  private _loopPromise: Promise<void> | null = null;
  private _abortController: AbortController | null = null;

  /**
   * @param options - Параметры супервизии (см. {@link RestartingTaskOptions})
   */
  public constructor(options: RestartingTaskOptions) {
    this._name = options.name;
    this._run = options.run;
    this._logger = options.logger;
    this._initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this._maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this._jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
    this._cooldownAfterFailures = options.cooldownAfterFailures ?? DEFAULT_COOLDOWN_AFTER_FAILURES;
    this._cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this._stableResetMs = options.stableResetMs ?? DEFAULT_STABLE_RESET_MS;
    this._controlledRestartDelayMs =
      options.controlledRestartDelayMs ?? DEFAULT_CONTROLLED_RESTART_DELAY_MS;
    this._random = options.random ?? Math.random;
  }

  /**
   * Запускает supervised-петлю (идемпотентно: повторный вызов — no-op).
   */
  public start(): void {
    if (this._loopPromise) {
      this._logger.debug('Restarting task already running', { task: this._name });
      return;
    }

    this._stopped = false;
    this._loopPromise = this._runLoop().finally(() => {
      this._loopPromise = null;
      this._abortController = null;
      this._stopped = true;
    });
  }

  /**
   * Останавливает петлю: абортит текущую сессию и ждёт завершения.
   *
   * @returns Promise завершения петли (идемпотентен)
   */
  public async stop(): Promise<void> {
    this._stopped = true;
    this._abortController?.abort();
    await this._loopPromise;
  }

  /**
   * @returns true, пока supervised-петля жива
   */
  public isRunning(): boolean {
    return this._loopPromise !== null;
  }

  /**
   * Основная supervised-петля: сессия → анализ исхода → backoff/cooldown →
   * следующая сессия.
   */
  private async _runLoop(): Promise<void> {
    let consecutiveFailures = 0;

    this._logger.info('Restarting task started', { task: this._name });

    while (!this._stopped) {
      const controller = new AbortController();
      this._abortController = controller;
      const sessionStartedAt = Date.now();

      try {
        this._logger.info('Restarting task session started', { task: this._name });
        await this._run(controller.signal);

        if (this._stopped || controller.signal.aborted) break;

        consecutiveFailures = 0;
        this._logger.info('Restarting task session completed, restarting', {
          task: this._name,
          uptimeMs: Date.now() - sessionStartedAt,
          restartDelayMs: this._controlledRestartDelayMs,
        });
        // Минимальная пауза перед новой сессией: controlled restart без неё
        // превращал бы мгновенно завершающиеся сессии в tight-loop
        // (stop/abort прерывают паузу немедленно)
        await this._sleep(this._controlledRestartDelayMs, controller.signal);
      } catch (err) {
        if (this._stopped || controller.signal.aborted) break;

        if (err instanceof PermanentTaskError) {
          // Причина не устраняется рестартом — останавливаемся сразу,
          // наблюдаемо (error-лог + isRunning=false), без retry-loop
          this._logger.error('Restarting task failed permanently, stopping', {
            task: this._name,
            error: err.message,
          });
          break;
        }

        const uptimeMs = Date.now() - sessionStartedAt;
        if (uptimeMs >= this._stableResetMs) {
          consecutiveFailures = 0;
        }
        consecutiveFailures++;

        const error = err instanceof Error ? err.message : String(err);

        if (consecutiveFailures >= this._cooldownAfterFailures) {
          this._logger.warn('Restarting task entering cooldown', {
            task: this._name,
            error: error.slice(0, 300),
            failures: consecutiveFailures,
            uptimeMs,
            cooldownMs: this._cooldownMs,
          });

          await this._sleep(this._cooldownMs, controller.signal);
          consecutiveFailures = 0;

          if (!this._stopped && !controller.signal.aborted) {
            this._logger.info('Restarting task cooldown finished', { task: this._name });
          }
          continue;
        }

        const backoffMs = this._calculateBackoffMs(consecutiveFailures);
        this._logger.warn('Restarting task session failed, restarting', {
          task: this._name,
          error: error.slice(0, 300),
          failures: consecutiveFailures,
          uptimeMs,
          backoffMs,
        });

        await this._sleep(backoffMs, controller.signal);
      } finally {
        if (this._abortController === controller) {
          this._abortController = null;
        }
      }
    }

    this._logger.info('Restarting task stopped', { task: this._name });
  }

  /**
   * Вычисляет backoff с exponential-ростом и jitter.
   *
   * @param failures - Количество отказов подряд (>= 1)
   * @returns Задержка перед следующей сессией (ms)
   */
  private _calculateBackoffMs(failures: number): number {
    const exponent = Math.max(0, failures - 1);
    const baseBackoff = Math.min(
      this._initialBackoffMs * (2 ** exponent),
      this._maxBackoffMs,
    );
    const jitterRange = baseBackoff * this._jitterRatio;
    const jitter = ((this._random() * 2) - 1) * jitterRange;
    return Math.max(0, Math.round(baseBackoff + jitter));
  }

  /**
   * Abort-aware пауза: завершается по таймеру ИЛИ по сигналу остановки.
   *
   * @param ms - Длительность паузы
   * @param signal - Сигнал остановки петли
   */
  private _sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted || this._stopped) return Promise.resolve();

    return new Promise((resolve) => {
      let resolved = false;

      const finish = (): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };

      const timer: ReturnType<typeof setTimeout> = setTimeout(finish, ms);
      timer.unref?.();

      signal.addEventListener('abort', finish, { once: true });
    });
  }
}
