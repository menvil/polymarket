import { describe, it, expect } from '@jest/globals';
import {
  type MarketDataSourceId,
  KnownMarketDataSources,
  isKnownMarketDataSource,
  asMarketDataSourceId,
  sourceToVenue,
  isLiveSource,
  isReplaySource,
  asInstrumentId,
} from '../src/index.js';

describe('Market Data IDs', () => {
  describe('MarketDataSourceId', () => {
    it('should have known sources', () => {
      const polymarketWs: MarketDataSourceId = KnownMarketDataSources.POLYMARKET_WS;
      const polymarketReplay: MarketDataSourceId = KnownMarketDataSources.POLYMARKET_REPLAY;

      expect(polymarketWs).toBe('POLYMARKET_WS');
      expect(polymarketReplay).toBe('POLYMARKET_REPLAY');
    });

    it('should use known sources in real API scenarios', () => {
      // Сценарий 1: Routing market data по типу источника
      const wsSource = KnownMarketDataSources.POLYMARKET_WS;
      const replaySource = KnownMarketDataSources.POLYMARKET_REPLAY;
      const restSource = KnownMarketDataSources.POLYMARKET_REST;

      // Live sources требуют WebSocket/REST соединения
      expect(isLiveSource(wsSource)).toBe(true);
      expect(isLiveSource(restSource)).toBe(true);

      // Replay sources читают из архива
      expect(isReplaySource(replaySource)).toBe(true);
      expect(isReplaySource(wsSource)).toBe(false);

      // Сценарий 2: Получение venue для роутинга данных
      const venue = sourceToVenue(wsSource);
      expect(venue).toBe('POLYMARKET');

      // Можем использовать venue для создания off-chain condition ref
      if (venue) {
        expect(isKnownMarketDataSource(wsSource)).toBe(true);
      }

      // Сценарий 3: Различение sources одного venue
      // WS и REST - оба live, но разные протоколы
      expect(isLiveSource(KnownMarketDataSources.POLYMARKET_WS)).toBe(true);
      expect(isLiveSource(KnownMarketDataSources.POLYMARKET_REST)).toBe(true);

      // Replay - для бэктестинга
      expect(isLiveSource(KnownMarketDataSources.POLYMARKET_REPLAY)).toBe(false);
      expect(isReplaySource(KnownMarketDataSources.POLYMARKET_REPLAY)).toBe(true);
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

    it('should accept source ID at max length', () => {
      const maxLenId = 'A'.repeat(64);
      expect(asMarketDataSourceId(maxLenId)).toBe(maxLenId);
    });

    it('should accept consecutive underscores', () => {
      expect(asMarketDataSourceId('SOURCE__NAME')).toBe('SOURCE__NAME');
    });

    it('should accept ending with underscore', () => {
      expect(asMarketDataSourceId('SOURCE_')).toBe('SOURCE_');
    });

    it('should return undefined for unknown custom sources', () => {
      // Unknown sources не имеют mapping (эвристика убрана)
      const withUnderscore = asMarketDataSourceId('MY_VENUE_WS')!;
      const withoutUnderscore = asMarketDataSourceId('CUSTOM')!;

      expect(sourceToVenue(withUnderscore)).toBeUndefined();
      expect(sourceToVenue(withoutUnderscore)).toBeUndefined();
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

  describe('InstrumentId', () => {
    it('should parse valid instrument IDs', () => {
      expect(asInstrumentId('BTC-USD')).toBe('BTC-USD');
      expect(asInstrumentId('ETH_USDC')).toBe('ETH_USDC');
      expect(asInstrumentId('market-123')).toBe('market-123');
      expect(asInstrumentId('INSTRUMENT.v2')).toBe('INSTRUMENT.v2');
    });

    it('should trim whitespace', () => {
      expect(asInstrumentId('  BTC-USD  ')).toBe('BTC-USD');
      expect(asInstrumentId('\tETH-USD\n')).toBe('ETH-USD');
    });

    it('should reject empty strings', () => {
      expect(asInstrumentId('')).toBeUndefined();
      expect(asInstrumentId('  ')).toBeUndefined();
      expect(asInstrumentId('\t\n')).toBeUndefined();
    });

    it('should reject strings exceeding max length', () => {
      const maxLength = 'x'.repeat(128);
      const tooLong = 'x'.repeat(129);

      expect(asInstrumentId(maxLength)).toBe(maxLength);
      expect(asInstrumentId(tooLong)).toBeUndefined();
    });

    it('should reject control characters', () => {
      expect(asInstrumentId('BTC\x00USD')).toBeUndefined(); // null
      expect(asInstrumentId('BTC\x01USD')).toBeUndefined(); // start of heading
      expect(asInstrumentId('BTC\x1FUSD')).toBeUndefined(); // unit separator
      expect(asInstrumentId('BTC\x7FUSD')).toBeUndefined(); // delete
      expect(asInstrumentId('BTC\x9FUSD')).toBeUndefined(); // application program command
    });

    it('should accept various formats', () => {
      // Типичные форматы instrument IDs
      expect(asInstrumentId('BTC-USD')).toBe('BTC-USD');
      expect(asInstrumentId('BTC_USD')).toBe('BTC_USD');
      expect(asInstrumentId('BTC/USD')).toBe('BTC/USD');
      expect(asInstrumentId('BTCUSD')).toBe('BTCUSD');
      expect(asInstrumentId('btc-usd')).toBe('btc-usd'); // lowercase OK
      expect(asInstrumentId('BTC-USD-PERP')).toBe('BTC-USD-PERP');
      expect(asInstrumentId('Market:123')).toBe('Market:123');
    });
  });
});
