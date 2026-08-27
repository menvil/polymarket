/**
 * Идентичность CEX-наблюдения: площадка и инструмент.
 *
 * @remarks
 * Центральный инвариант набора — РАЗНЫЕ инструменты биржи не должны
 * схлопываться в один. Именно на этом ломался бы весь semantic-слой:
 * своп и спот с одинаковым символом делили бы книгу, верхушку и нумерацию.
 */
import { describe, expect, it } from '@jest/globals';
import { instrumentStateKey, resolveCexIdentity, toInstrumentId, toVenueId } from '../src/index.js';

describe('toVenueId', () => {
  it('поднимает регистр ccxt-идентификатора биржи до canonical VenueId', () => {
    expect(toVenueId('binance')).toBe('BINANCE');
    expect(toVenueId('okx')).toBe('OKX');
    expect(toVenueId('cryptocom')).toBe('CRYPTOCOM');
    expect(toVenueId('coinbase')).toBe('COINBASE');
    expect(toVenueId('kraken')).toBe('KRAKEN');
    expect(toVenueId('bybit')).toBe('BYBIT');
  });

  it('работает для любой биржи без таблицы соответствий', () => {
    // Новая биржа в конфиге обязана получить идентичность БЕЗ правок кода:
    // один адаптер обслуживает все настроенные площадки
    expect(toVenueId('hyperliquid')).toBe('HYPERLIQUID');
    expect(toVenueId('binanceusdm')).toBe('BINANCEUSDM');
    expect(toVenueId('gateio')).toBe('GATEIO');
  });

  it('отвергает идентификатор, не укладывающийся в canonical-формат', () => {
    // Формат VenueId запрещает первую цифру — суррогат не подставляется
    expect(toVenueId('1btcxe')).toBeUndefined();
    expect(toVenueId('')).toBeUndefined();
    expect(toVenueId('has-dash')).toBeUndefined();
  });
});

describe('toInstrumentId', () => {
  it('сохраняет vendor-символ дословно, добавляя тип рынка', () => {
    expect(toInstrumentId('spot', 'BTC/USDT')).toBe('spot:BTC/USDT');
    expect(toInstrumentId('swap', 'BTC/USDT:USDT')).toBe('swap:BTC/USDT:USDT');
    expect(toInstrumentId('future', 'BTC/USDT:USDT-260327')).toBe(
      'future:BTC/USDT:USDT-260327',
    );
  });

  it('НЕ схлопывает spot и swap с одинаковым vendor-символом', () => {
    // Ровно тот случай, ради которого тип рынка входит в идентичность:
    // биржа может не проставить суффикс расчётной валюты, и без marketType
    // своп стал бы неотличим от спота
    const spot = toInstrumentId('spot', 'BTC/USDT');
    const swap = toInstrumentId('swap', 'BTC/USDT');
    expect(spot).toBeDefined();
    expect(swap).toBeDefined();
    expect(spot).not.toBe(swap);
  });

  it('НЕ схлопывает разные контракты одного типа рынка', () => {
    expect(toInstrumentId('swap', 'BTC/USDT:USDT')).not.toBe(
      toInstrumentId('swap', 'BTC/USD:BTC'),
    );
    expect(toInstrumentId('future', 'BTC/USDT:USDT-260327')).not.toBe(
      toInstrumentId('future', 'BTC/USDT:USDT-260626'),
    );
  });

  it('не нормализует регистр и разделители символа', () => {
    // Любая «умная» нормализация схлопывала бы разные контракты в один
    expect(toInstrumentId('spot', 'BTC/USDT')).not.toBe(toInstrumentId('spot', 'btc/usdt'));
  });

  it('отвергает пустой символ', () => {
    expect(toInstrumentId('spot', '')).toBeUndefined();
    expect(toInstrumentId('spot', '   ')).toBeUndefined();
  });
});

describe('resolveCexIdentity', () => {
  it('выводит пару venue/instrument из routing-полей payload', () => {
    expect(
      resolveCexIdentity({ exchangeId: 'binance', marketType: 'spot', symbol: 'BTC/USDT' }),
    ).toEqual({ venueId: 'BINANCE', instrumentId: 'spot:BTC/USDT' });
  });

  it('не выводит частичную идентичность', () => {
    // Наблюдение с площадкой, но без инструмента опубликовать нельзя —
    // недостающая часть не выдумывается
    expect(
      resolveCexIdentity({ exchangeId: 'binance', marketType: 'spot', symbol: '' }),
    ).toBeUndefined();
    expect(
      resolveCexIdentity({ exchangeId: '1btcxe', marketType: 'spot', symbol: 'BTC/USDT' }),
    ).toBeUndefined();
  });
});

describe('instrumentStateKey', () => {
  it('различает одинаковый инструмент на разных площадках', () => {
    const binance = resolveCexIdentity({
      exchangeId: 'binance',
      marketType: 'spot',
      symbol: 'BTC/USDT',
    })!;
    const okx = resolveCexIdentity({
      exchangeId: 'okx',
      marketType: 'spot',
      symbol: 'BTC/USDT',
    })!;
    expect(instrumentStateKey(binance)).not.toBe(instrumentStateKey(okx));
  });

  it('различает spot и swap одной площадки', () => {
    const spot = resolveCexIdentity({
      exchangeId: 'binance',
      marketType: 'spot',
      symbol: 'BTC/USDT',
    })!;
    const swap = resolveCexIdentity({
      exchangeId: 'binance',
      marketType: 'swap',
      symbol: 'BTC/USDT',
    })!;
    expect(instrumentStateKey(spot)).not.toBe(instrumentStateKey(swap));
  });

  it('стабилен для одной и той же идентичности', () => {
    const a = resolveCexIdentity({
      exchangeId: 'binance',
      marketType: 'spot',
      symbol: 'BTC/USDT',
    })!;
    const b = resolveCexIdentity({
      exchangeId: 'binance',
      marketType: 'spot',
      symbol: 'BTC/USDT',
    })!;
    expect(instrumentStateKey(a)).toBe(instrumentStateKey(b));
  });
});
