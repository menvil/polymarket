import { describe, it, expect } from '@jest/globals';
import {
  type MarketDataSourceId,
  KnownMarketDataSources,
  isKnownMarketDataSource,
  asMarketDataSourceId,
  sourceToVenue,
  isLiveSource,
  isReplaySource,
} from '../src/index.js';

describe('Market Data IDs', () => {
  describe('MarketDataSourceId', () => {
    it('should have known sources', () => {
      const polymarketWs: MarketDataSourceId = KnownMarketDataSources.POLYMARKET_WS;
      const polymarketReplay: MarketDataSourceId = KnownMarketDataSources.POLYMARKET_REPLAY;

      expect(polymarketWs).toBe('POLYMARKET_WS');
      expect(polymarketReplay).toBe('POLYMARKET_REPLAY');
    });

    it('should map source to venue', () => {
      expect(sourceToVenue(KnownMarketDataSources.POLYMARKET_WS)).toBe('POLYMARKET');
      expect(sourceToVenue(KnownMarketDataSources.POLYMARKET_REPLAY)).toBe('POLYMARKET');
      expect(sourceToVenue(KnownMarketDataSources.KALSHI_WS)).toBe('KALSHI');
    });

    it('should detect live sources', () => {
      expect(isLiveSource(KnownMarketDataSources.POLYMARKET_WS)).toBe(true);
      expect(isLiveSource(KnownMarketDataSources.POLYMARKET_REST)).toBe(true);
      expect(isLiveSource(KnownMarketDataSources.POLYMARKET_REPLAY)).toBe(false);
    });

    it('should detect replay sources', () => {
      expect(isReplaySource(KnownMarketDataSources.POLYMARKET_REPLAY)).toBe(true);
      expect(isReplaySource(KnownMarketDataSources.KALSHI_REPLAY)).toBe(true);
      expect(isReplaySource(KnownMarketDataSources.POLYMARKET_WS)).toBe(false);
    });

    it('should validate known market data sources', () => {
      expect(isKnownMarketDataSource('POLYMARKET_WS')).toBe(true);
      expect(isKnownMarketDataSource('POLYMARKET_REST')).toBe(true);
      expect(isKnownMarketDataSource('POLYMARKET_REPLAY')).toBe(true);
      expect(isKnownMarketDataSource('KALSHI_WS')).toBe(true);
      expect(isKnownMarketDataSource('KALSHI_REPLAY')).toBe(true);
      expect(isKnownMarketDataSource('POLYGON_RPC')).toBe(true);
      expect(isKnownMarketDataSource('UNKNOWN_SOURCE')).toBe(false);
      expect(isKnownMarketDataSource('polymarket_ws')).toBe(false);
      expect(isKnownMarketDataSource('')).toBe(false);
    });

    it('should parse valid market data source IDs', () => {
      // Известные sources
      expect(asMarketDataSourceId('POLYMARKET_WS')).toBe('POLYMARKET_WS');
      expect(asMarketDataSourceId('KALSHI_REPLAY')).toBe('KALSHI_REPLAY');
      expect(asMarketDataSourceId('POLYGON_RPC')).toBe('POLYGON_RPC');

      // Custom sources с валидным форматом
      expect(asMarketDataSourceId('CUSTOM_SOURCE')).toBe('CUSTOM_SOURCE');
      expect(asMarketDataSourceId('MY_VENUE_WS')).toBe('MY_VENUE_WS');
      expect(asMarketDataSourceId('EXCHANGE_123_REST')).toBe('EXCHANGE_123_REST');
      expect(asMarketDataSourceId('_UNDERSCORE_WS')).toBe('_UNDERSCORE_WS');
    });

    it('should reject invalid market data source IDs', () => {
      // Lowercase
      expect(asMarketDataSourceId('polymarket_ws')).toBeUndefined();
      expect(asMarketDataSourceId('Polymarket_WS')).toBeUndefined();

      // Содержит недопустимые символы
      expect(asMarketDataSourceId('SOURCE-NAME')).toBeUndefined(); // дефис
      expect(asMarketDataSourceId('SOURCE.NAME')).toBeUndefined(); // точка
      expect(asMarketDataSourceId('SOURCE:NAME')).toBeUndefined(); // двоеточие
      expect(asMarketDataSourceId('SOURCE\\NAME')).toBeUndefined(); // обратный слеш
      expect(asMarketDataSourceId('SOURCE NAME')).toBeUndefined(); // пробел

      // Начинается с цифры
      expect(asMarketDataSourceId('123SOURCE')).toBeUndefined();
      expect(asMarketDataSourceId('1_SOURCE')).toBeUndefined();

      // Пустая строка или слишком длинная
      expect(asMarketDataSourceId('')).toBeUndefined();
      expect(asMarketDataSourceId('A'.repeat(65))).toBeUndefined(); // 65 символов (лимит 64)
    });

    it('should return undefined for unknown custom sources', () => {
      // Unknown sources не имеют mapping (эвристика убрана)
      const customSource = asMarketDataSourceId('MY_VENUE_WS');
      expect(customSource).toBeDefined();

      const venue = sourceToVenue(customSource!);
      expect(venue).toBeUndefined(); // Unknown source → undefined
    });

    it('should return undefined for unknown source without underscore', () => {
      // Unknown source без underscore
      const customSource = asMarketDataSourceId('CUSTOM');
      expect(customSource).toBeDefined();

      const venue = sourceToVenue(customSource!);
      expect(venue).toBeUndefined(); // Unknown source → undefined
    });

    it('should return undefined for RPC source venue mapping', () => {
      const venue = sourceToVenue(KnownMarketDataSources.POLYGON_RPC);
      expect(venue).toBeUndefined(); // RPC не привязан к venue
    });

    it('should return undefined for unknown sources live/replay check', () => {
      // Unknown sources не имеют metadata (эвристика убрана)
      const customLive = asMarketDataSourceId('MY_VENUE_WS')!;
      expect(isLiveSource(customLive)).toBeUndefined();
      expect(isReplaySource(customLive)).toBeUndefined();

      const customReplay = asMarketDataSourceId('MY_VENUE_REPLAY')!;
      expect(isLiveSource(customReplay)).toBeUndefined();
      expect(isReplaySource(customReplay)).toBeUndefined();
    });
  });
});
