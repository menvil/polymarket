/**
 * Type-contract тесты selected-market контрактов (follow-up N-003 PART 12).
 *
 * @remarks
 * Compile-time проверки (typecheck/ts-jest): identities выбранного рынка —
 * canonical branded IDs, а не plain strings; primitive-дубликаты
 * (`tokenIds`, `sourceMarketId`) и vendor yes/no-именование в наш контракт
 * не просачиваются. Runtime-ассерты минимальны.
 */
import { describe, it, expect } from '@jest/globals';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type {
  SelectedPolymarketMarket,
  SelectedPolymarketOutcome,
} from '../src/index.js';

/** Compile-time equality: `true` только когда A и B — один и тот же тип. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

describe('selected-market contracts: canonical IDs без primitive leakage', () => {
  it('SelectedPolymarketOutcome.instrumentId — InstrumentId, plain string отвергается', () => {
    const instrumentIsCanonical: Equal<
      SelectedPolymarketOutcome['instrumentId'],
      InstrumentId
    > = true;
    expect(instrumentIsCanonical).toBe(true);

    // @ts-expect-error plain string не является branded InstrumentId
    const badOutcome: SelectedPolymarketOutcome = { label: 'Up', instrumentId: 'plain-string' };
    expect(badOutcome.label).toBe('Up');
  });

  it('SelectedPolymarketMarket.marketId — MarketId; primitive-дубликаты identity удалены', () => {
    const marketIdIsCanonical: Equal<SelectedPolymarketMarket['marketId'], MarketId> = true;
    expect(marketIdIsCanonical).toBe(true);

    // Дублирующих primitive-коллекций/копий identity в контракте нет:
    // ids выводятся из outcomes[], conditionId == String(marketId)
    type LeakedKeys = Extract<
      keyof SelectedPolymarketMarket,
      'tokenIds' | 'sourceMarketId' | 'instrumentIds'
    >;
    const noLeakedKeys: Equal<LeakedKeys, never> = true;
    expect(noLeakedKeys).toBe(true);
  });

  it('vendor yes/no-именование не является частью нашего контракта', () => {
    type VendorKeys = Extract<
      keyof SelectedPolymarketMarket,
      'yesOutcome' | 'noOutcome' | 'yesTokenId' | 'noTokenId'
    >;
    const noVendorKeys: Equal<VendorKeys, never> = true;
    expect(noVendorKeys).toBe(true);

    // Инструменты выводимы из единственного source of truth
    const derive = (market: SelectedPolymarketMarket): readonly InstrumentId[] =>
      market.outcomes.map((outcome) => outcome.instrumentId);
    expect(typeof derive).toBe('function');
  });
});
