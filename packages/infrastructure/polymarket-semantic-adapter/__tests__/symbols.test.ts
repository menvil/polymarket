/**
 * Разбор vendor-символов в canonical-пару.
 *
 * @remarks
 * Главный инвариант: `USDT` НЕ приводится к `USD`. Это разные котировки с
 * разными ценами, и решение считать ли их взаимозаменяемыми принадлежит
 * стратегии, а не границе наблюдения.
 */
import { describe, expect, it } from '@jest/globals';
import { parseAssetPair } from '../src/index.js';

describe('разделённый формат (Chainlink)', () => {
  it('разбирает btc/usd', () => {
    expect(parseAssetPair('btc/usd')).toEqual({ baseAsset: 'btc', quoteAsset: 'usd' });
  });

  it('понимает дефис как разделитель', () => {
    expect(parseAssetPair('eth-usd')).toEqual({ baseAsset: 'eth', quoteAsset: 'usd' });
  });

  it('нормализует регистр и пробелы', () => {
    expect(parseAssetPair('  BTC/USD  ')).toEqual({ baseAsset: 'btc', quoteAsset: 'usd' });
  });

  it('отвергает более двух частей', () => {
    expect(parseAssetPair('btc/usd/perp')).toBeUndefined();
  });
});

describe('слитный формат (Binance)', () => {
  it('разбирает btcusdt по самому длинному подходящему суффиксу', () => {
    // Критично: 'usdt' обязан проверяться РАНЬШЕ 'usd', иначе база
    // получилась бы 'btcu' — тихо испорченная идентичность пары
    expect(parseAssetPair('btcusdt')).toEqual({ baseAsset: 'btc', quoteAsset: 'usdt' });
  });

  it('разбирает остальные пары контура', () => {
    expect(parseAssetPair('ethusdt')).toEqual({ baseAsset: 'eth', quoteAsset: 'usdt' });
    expect(parseAssetPair('solusdt')).toEqual({ baseAsset: 'sol', quoteAsset: 'usdt' });
    expect(parseAssetPair('dogeusdt')).toEqual({ baseAsset: 'doge', quoteAsset: 'usdt' });
  });

  it('понимает не-USDT котировки', () => {
    expect(parseAssetPair('ethbtc')).toEqual({ baseAsset: 'eth', quoteAsset: 'btc' });
  });

  it('отвергает символ с неизвестной котировкой, а не угадывает', () => {
    expect(parseAssetPair('weirdpair')).toBeUndefined();
  });

  it('отвергает символ, состоящий из одной котировки', () => {
    expect(parseAssetPair('usdt')).toBeUndefined();
  });

  it('отвергает пустую строку', () => {
    expect(parseAssetPair('')).toBeUndefined();
    expect(parseAssetPair('   ')).toBeUndefined();
  });
});

describe('USDT НЕ приводится к USD', () => {
  it('btcusdt и btc/usd дают РАЗНЫЕ пары', () => {
    const binance = parseAssetPair('btcusdt');
    const chainlink = parseAssetPair('btc/usd');

    expect(binance?.baseAsset).toBe(chainlink?.baseAsset); // база одна
    expect(binance?.quoteAsset).toBe('usdt');
    expect(chainlink?.quoteAsset).toBe('usd');
    // Именно котировка их различает — схлопывать её нельзя
    expect(binance?.quoteAsset).not.toBe(chainlink?.quoteAsset);
  });
});
