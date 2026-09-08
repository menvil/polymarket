import type { ILogger } from '@polymarket/logger';
import type { IDecisionJournal } from '@polymarket/ports';
import type { StrategyId } from '@polymarket/ids';
import { unsafeStrategyId } from '@polymarket/ids';
import { CalibratedCrowdStrategy, type CalibratedCrowdConfig } from './CalibratedCrowdStrategy.js';

/**
 * Experimental wrapper for the relaxed crowd + CEX not-adverse setup.
 *
 * Keeps the production `calibrated-crowd` strategy type on its existing
 * table-signal semantics, while this strategy type opts into raw UP edge and
 * the offline linear CEX signal used by `scripts/backtest-cex-crowd.ts`.
 */
export interface CexCrowdNotAdverseConfig extends CalibratedCrowdConfig {}

export class CexCrowdNotAdverseStrategy extends CalibratedCrowdStrategy {
  constructor(
    config: CexCrowdNotAdverseConfig,
    strategyId: StrategyId = unsafeStrategyId('cex-crowd-not-adverse-1'),
    logger?: ILogger,
    journal?: IDecisionJournal,
  ) {
    super({
      crowdGate: 'relaxed',
      relaxedEntrySide: 'up',
      cexFilterMode: 'not-adverse',
      cexSignalId: 'cex_chainlink_linear_lead_lag',
      ...config,
    }, strategyId, logger, journal);
  }
}
