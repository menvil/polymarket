/**
 * AutoRedeemer — periodic sweep trigger поверх общего executor.
 */
import type { ILogger } from '@polymarket/logger';
import {
  PolymarketRedeemExecutor,
  type RelayerRedeemerConfig,
} from './PolymarketRedeemExecutor.js';

/** Интервал проверки по умолчанию (5 минут) */
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface AutoRedeemerConfig extends RelayerRedeemerConfig {
  /** Интервал проверки в мс (по умолчанию 5 минут) */
  readonly checkIntervalMs?: number;
  /** Исторические поля, больше не используются */
  readonly clobApiKey?: string;
  readonly clobApiSecret?: string;
  readonly clobApiPassphrase?: string;
}

interface CheckResult {
  readonly marketsChecked: number;
  readonly marketsSettled: number;
  readonly redeemed: number;
  readonly errors: number;
}

export class AutoRedeemer {
  private readonly _executor: PolymarketRedeemExecutor;
  private readonly _logger: ILogger;
  private readonly _config: AutoRedeemerConfig;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  private constructor(
    executor: PolymarketRedeemExecutor,
    config: AutoRedeemerConfig,
    logger: ILogger,
  ) {
    this._executor = executor;
    this._config = config;
    this._logger = logger.child({ component: 'AutoRedeemer' });
  }

  public static create(config: AutoRedeemerConfig, logger: ILogger): AutoRedeemer {
    return new AutoRedeemer(PolymarketRedeemExecutor.create(config, logger), config, logger);
  }

  public static fromEnv(logger: ILogger): AutoRedeemer {
    const required = (key: string): string => {
      const val = process.env[key];
      if (!val) throw new Error(`Missing env var: ${key}`);
      return val;
    };

    return AutoRedeemer.create({
      privateKey:           required('PRIVATE_KEY'),
      funderAddress:        required('FUNDER_ADDRESS'),
      builderApiKey:        required('BUILDER_API_KEY'),
      builderApiSecret:     required('BUILDER_API_SECRET'),
      builderApiPassphrase: required('BUILDER_API_PASSPHRASE'),
      clobApiKey:           process.env['POLYMARKET_API_KEY'],
      clobApiSecret:        process.env['POLYMARKET_API_SECRET'],
      clobApiPassphrase:    process.env['POLYMARKET_API_PASSPHRASE'],
    }, logger);
  }

  public start(): void {
    if (this._running) return;
    this._running = true;

    const interval = this._config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this._logger.info('Auto-redeemer started', { intervalMs: interval });

    void this._checkAndRedeem();

    this._timer = setInterval(() => {
      void this._checkAndRedeem();
    }, interval);
  }

  public stop(): void {
    if (!this._running) return;
    this._running = false;

    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    this._logger.info('Auto-redeemer stopped');
  }

  public async checkOnce(): Promise<CheckResult> {
    return this._checkAndRedeem();
  }

  private async _checkAndRedeem(): Promise<CheckResult> {
    const result = { marketsChecked: 0, marketsSettled: 0, redeemed: 0, errors: 0 };

    try {
      const positions = await this._executor.getRedeemablePositions();
      result.marketsChecked = positions.length;
      result.marketsSettled = positions.length;

      this._logger.info('Auto-redeem cycle: checking positions', {
        redeemable: positions.length,
      });

      if (positions.length === 0) {
        this._logger.info('Auto-redeem cycle complete', result);
        return result;
      }

      const uniqueConditionIds = [...new Set(positions.map((p) => p.conditionId))];

      for (const conditionId of uniqueConditionIds) {
        const redeemResult = await this._executor.redeem(conditionId, {
          metadataPrefix: 'AutoRedeem',
          skipOraclePrecheck: false,
        });

        if (redeemResult.success) {
          result.redeemed++;
        } else {
          result.errors++;
          this._logger.info('Redeem deferred/failed — will retry in next cycle', {
            conditionId: conditionId.slice(0, 20),
            error: redeemResult.error,
          });
        }
      }

      this._logger.info('Auto-redeem cycle complete', result);
    } catch (err) {
      this._logger.info('Auto-redeem check failed — will retry in next cycle', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return result;
  }
}
