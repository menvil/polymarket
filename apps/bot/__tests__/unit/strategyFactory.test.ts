/**
 * Тесты фабрики стратегий.
 *
 * @remarks
 * Проверяет создание стратегий через фабрику и дефолтные конфигурации.
 */
import {
  createStrategy,
  DEFAULT_DUMB_CONFIG,
  DEFAULT_AS_CONFIG,
} from '../../src/strategyFactory.js';
import { DumbStrategy } from '../../src/strategies/DumbStrategy.js';
import { AvellanedaStoikovStrategy } from '../../src/strategies/AvellanedaStoikovStrategy.js';
import { CexLeadLagStrategy } from '../../src/strategies/CexLeadLagStrategy.js';
import { PairedCexCrowdStrategy } from '../../src/strategies/PairedCexCrowdStrategy.js';

describe('createStrategy', () => {
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

  it('создаёт AvellanedaStoikovStrategy', () => {
    const strategy = createStrategy({
      type: 'avellaneda-stoikov',
      params: DEFAULT_AS_CONFIG,
    });

    expect(strategy).toBeInstanceOf(AvellanedaStoikovStrategy);
    expect(strategy.name).toBe('AvellanedaStoikovStrategy');
  });

  it('создаёт AvellanedaStoikovStrategy с кастомным id', () => {
    const strategy = createStrategy({
      type: 'avellaneda-stoikov',
      id: 'custom-as',
      params: DEFAULT_AS_CONFIG,
    });

    expect(strategy.id).toBe('custom-as');
  });

  it('создаёт CexLeadLagStrategy', () => {
    const strategy = createStrategy({
      type: 'cex-lead-lag',
      params: {
        orderSize: DEFAULT_DUMB_CONFIG.orderSize,
        qMax: 2,
      },
    });

    expect(strategy).toBeInstanceOf(CexLeadLagStrategy);
    expect(strategy.name).toBe('CexLeadLagStrategy');
  });

  it('создаёт PairedCexCrowdStrategy', () => {
    const strategy = createStrategy({
      type: 'paired-cex-crowd',
      params: {
        edgeTablePath: 'tables/edge-table-5min.json',
      },
    });

    expect(strategy).toBeInstanceOf(PairedCexCrowdStrategy);
    expect(strategy.name).toBe('PairedCexCrowdStrategy');
  });

  it('бросает ошибку для неизвестного типа', () => {
    expect(() => {
      createStrategy({ type: 'unknown' as any, params: {} as any });
    }).toThrow('Unknown strategy type: unknown');
  });
});

describe('дефолтные конфигурации', () => {
  it('DEFAULT_DUMB_CONFIG содержит корректные значения', () => {
    expect(DEFAULT_DUMB_CONFIG.orderSize.toNumber()).toBe(5);
    expect(DEFAULT_DUMB_CONFIG.buyOffsetPct.toNumber()).toBe(10);
    expect(DEFAULT_DUMB_CONFIG.profitMarginPct.toNumber()).toBe(5);
    expect(DEFAULT_DUMB_CONFIG.repriceThreshold.toNumber()).toBe(0.08);
  });

  it('DEFAULT_AS_CONFIG содержит корректные значения', () => {
    expect(DEFAULT_AS_CONFIG.gamma.toNumber()).toBe(0.05);
    expect(DEFAULT_AS_CONFIG.qMax).toBe(5);
    expect(DEFAULT_AS_CONFIG.orderSize.toNumber()).toBe(10);
  });
});
