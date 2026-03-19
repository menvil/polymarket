/**
 * Тесты фабрики стратегий.
 *
 * @remarks
 * Проверяет создание стратегий через фабрику и дефолтные конфигурации.
 */
import {
  createStrategy,
  DEFAULT_MARKET_MAKER_CONFIG,
  DEFAULT_MOMENTUM_CONFIG,
  DEFAULT_DUMB_CONFIG,
} from '../../src/strategyFactory.js';
import { SimpleMarketMaker } from '../../src/strategies/SimpleMarketMaker.js';
import { MomentumStrategy } from '../../src/strategies/MomentumStrategy.js';
import { DumbStrategy } from '../../src/strategies/DumbStrategy.js';

describe('createStrategy', () => {
  it('создаёт SimpleMarketMaker', () => {
    const strategy = createStrategy({
      type: 'market-maker',
      params: DEFAULT_MARKET_MAKER_CONFIG,
    });

    expect(strategy).toBeInstanceOf(SimpleMarketMaker);
    expect(strategy.name).toBe('SimpleMarketMaker');
  });

  it('создаёт SimpleMarketMaker с кастомным id', () => {
    const strategy = createStrategy({
      type: 'market-maker',
      id: 'custom-mm',
      params: DEFAULT_MARKET_MAKER_CONFIG,
    });

    expect(strategy.id).toBe('custom-mm');
  });

  it('создаёт MomentumStrategy', () => {
    const strategy = createStrategy({
      type: 'momentum',
      params: DEFAULT_MOMENTUM_CONFIG,
    });

    expect(strategy).toBeInstanceOf(MomentumStrategy);
    expect(strategy.name).toBe('MomentumStrategy');
  });

  it('создаёт MomentumStrategy с кастомным id', () => {
    const strategy = createStrategy({
      type: 'momentum',
      id: 'custom-momentum',
      params: DEFAULT_MOMENTUM_CONFIG,
    });

    expect(strategy.id).toBe('custom-momentum');
  });

  it('создаёт DumbStrategy', () => {
    const strategy = createStrategy({
      type: 'dumb',
      params: DEFAULT_DUMB_CONFIG,
    });

    expect(strategy).toBeInstanceOf(DumbStrategy);
    expect(strategy.name).toBe('DumbStrategy');
  });

  it('создаёт DumbStrategy с кастомным id', () => {
    const strategy = createStrategy({
      type: 'dumb',
      id: 'custom-dumb',
      params: DEFAULT_DUMB_CONFIG,
    });

    expect(strategy.id).toBe('custom-dumb');
  });

  it('бросает ошибку для неизвестного типа', () => {
    expect(() => {
      createStrategy({ type: 'unknown' as any, params: {} as any });
    }).toThrow('Unknown strategy type: unknown');
  });
});

describe('дефолтные конфигурации', () => {
  it('DEFAULT_MARKET_MAKER_CONFIG содержит корректные значения', () => {
    expect(DEFAULT_MARKET_MAKER_CONFIG.spreadOffset.toNumber()).toBe(0.02);
    expect(DEFAULT_MARKET_MAKER_CONFIG.minSpread.toNumber()).toBe(0.01);
    expect(DEFAULT_MARKET_MAKER_CONFIG.orderSize.toNumber()).toBe(10);
    expect(DEFAULT_MARKET_MAKER_CONFIG.exitThresholdMs).toBe(60_000);
  });

  it('DEFAULT_MOMENTUM_CONFIG содержит корректные значения', () => {
    expect(DEFAULT_MOMENTUM_CONFIG.entryThreshold.toNumber()).toBe(0.65);
    expect(DEFAULT_MOMENTUM_CONFIG.exitThreshold.toNumber()).toBe(0.40);
    expect(DEFAULT_MOMENTUM_CONFIG.orderSize.toNumber()).toBe(5);
  });

  it('DEFAULT_DUMB_CONFIG содержит корректные значения', () => {
    expect(DEFAULT_DUMB_CONFIG.orderSize.toNumber()).toBe(5);
    expect(DEFAULT_DUMB_CONFIG.buyOffsetPct.toNumber()).toBe(10);
    expect(DEFAULT_DUMB_CONFIG.profitMarginPct.toNumber()).toBe(5);
    expect(DEFAULT_DUMB_CONFIG.repriceThreshold.toNumber()).toBe(0.08);
  });
});
