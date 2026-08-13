import type { ILogger } from '@polymarket/logger';

const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_COOLDOWN_AFTER_FAILURES = 10;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_STABLE_RESET_MS = 60_000;

export interface RestartingTaskOptions {
  readonly name: string;
  readonly run: (signal: AbortSignal) => Promise<void>;
  readonly logger: ILogger;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly jitterRatio?: number;
  readonly cooldownAfterFailures?: number;
  readonly cooldownMs?: number;
  readonly stableResetMs?: number;
  readonly random?: () => number;
}

/**
 * Runs one async task session at a time and restarts it after failures.
 *
 * A normal session return is treated as a controlled restart. A thrown error
 * is restarted with exponential backoff and optional cooldown.
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
  private readonly _random: () => number;

  private _stopped = true;
  private _loopPromise: Promise<void> | null = null;
  private _abortController: AbortController | null = null;

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
    this._random = options.random ?? Math.random;
  }

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

  public async stop(): Promise<void> {
    this._stopped = true;
    this._abortController?.abort();
    await this._loopPromise;
  }

  public isRunning(): boolean {
    return this._loopPromise !== null;
  }

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
        });
      } catch (err) {
        if (this._stopped || controller.signal.aborted) break;

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
