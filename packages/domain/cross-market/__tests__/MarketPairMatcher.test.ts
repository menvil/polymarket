import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { Timestamp } from '@polymarket/timestamp';
import { MarketPairMatcher } from '../src/MarketPairMatcher.js';
import type { MarketInfo } from '../src/types.js';
import { asInstrumentId } from '@polymarket/ids';

describe('MarketPairMatcher', () => {
  describe('parseTicker', () => {
    it('парсит BTC 15m ticker', () => {
      const r = MarketPairMatcher.parseTicker('btc-updown-15m-1774231200');
      expect(r).toEqual({
        asset: 'BTC',
        recurrence: '15m',
        startEpoch: 1774231200,
        endEpoch: 1774232100,
      });
    });

    it('парсит ETH hourly ticker', () => {
      const r = MarketPairMatcher.parseTicker('eth-updown-hourly-1774231200');
      expect(r).toEqual({
        asset: 'ETH',
        recurrence: 'hourly',
        startEpoch: 1774231200,
        endEpoch: 1774234800,
      });
    });

    it('парсит SOL 5m ticker', () => {
      const r = MarketPairMatcher.parseTicker('sol-updown-5m-1774231800');
      expect(r).toEqual({
        asset: 'SOL',
        recurrence: '5m',
        startEpoch: 1774231800,
        endEpoch: 1774232100,
      });
    });

    it('возвращает undefined для невалидного ticker', () => {
      expect(MarketPairMatcher.parseTicker('invalid')).toBeUndefined();
      expect(MarketPairMatcher.parseTicker('')).toBeUndefined();
      expect(MarketPairMatcher.parseTicker('btc-updown-3m-123')).toBeUndefined();
    });
  });

  describe('parseSnapshotMeta', () => {
    it('парсит валидную мета-строку', () => {
      const meta = {
        t: 'meta' as const,
        tokenIds: [
          '108038936235534562211272541592295195184893929481427466019651070223257905568509',
          '208038936235534562211272541592295195184893929481427466019651070223257905568509',
        ],
        m: {
          endDate: '2026-03-23T02:15:00Z',
          events: [{
            ticker: 'btc-updown-15m-1774231200',
            startTime: '2026-03-23T02:00:00Z',
            eventMetadata: { priceToBeat: '87250.5', finalPrice: 87275 },
          }],
        },
      };

      const result = MarketPairMatcher.parseSnapshotMeta(meta, '/path/to/file.jsonl.gz');

      expect(result).toBeDefined();
      expect(result!.asset).toBe('BTC');
      expect(result!.recurrence).toBe('15m');
      expect(result!.endDate).toBe('2026-03-23T02:15:00Z');
      expect(result!.startEpochMs?.toNumber()).toBe(Date.parse('2026-03-23T02:00:00Z'));
      expect(result!.endEpochMs.toNumber()).toBe(Date.parse('2026-03-23T02:15:00Z'));
      expect(result!.priceToBeat).toBe(87250.5);
      expect(result!.finalPrice).toBe(87275);
      expect(result!.downInstrumentId).toBeDefined();
      expect(result!.filePath).toBe('/path/to/file.jsonl.gz');
    });

    it('возвращает undefined без m', () => {
      const meta = { t: 'meta' as const, tokenIds: ['abc'] };
      expect(MarketPairMatcher.parseSnapshotMeta(meta, '')).toBeUndefined();
    });

    it('возвращает undefined без ticker', () => {
      const meta = {
        t: 'meta' as const,
        tokenIds: ['abc'],
        m: { endDate: '2026-03-23T02:15:00Z', events: [] },
      };
      expect(MarketPairMatcher.parseSnapshotMeta(meta, '')).toBeUndefined();
    });
  });

  describe('findPairs', () => {
    const matcher = new MarketPairMatcher();

    function mkMarket(asset: string, endDate: string, rec: '5m' | '15m' | 'hourly'): MarketInfo {
      return {
        asset,
        recurrence: rec,
        endDate,
        endEpochMs: Timestamp.of(new Decimal(new Date(endDate).getTime())),
        instrumentId: asInstrumentId(`token-${asset}-${rec}-${endDate}`)!,
        filePath: `/path/${asset}_${rec}_${endDate}.jsonl.gz`,
      };
    }

    it('находит пару 5m↔15m с одинаковым endDate', () => {
      const markets = [
        mkMarket('BTC', '2026-03-23T02:15:00Z', '5m'),
        mkMarket('BTC', '2026-03-23T02:15:00Z', '15m'),
      ];

      const pairs = matcher.findPairs(markets);

      expect(pairs).toHaveLength(1);
      expect(pairs[0].easy.recurrence).toBe('15m');
      expect(pairs[0].hard.recurrence).toBe('5m');
      expect(pairs[0].pairType).toBe('5m-15m');
    });

    it('находит 3 пары в тройной точке (:00)', () => {
      const markets = [
        mkMarket('BTC', '2026-03-23T03:00:00Z', '5m'),
        mkMarket('BTC', '2026-03-23T03:00:00Z', '15m'),
        mkMarket('BTC', '2026-03-23T03:00:00Z', 'hourly'),
      ];

      const pairs = matcher.findPairs(markets);

      expect(pairs).toHaveLength(3);
      const types = pairs.map(p => p.pairType).sort();
      expect(types).toEqual(['15m-hourly', '5m-15m', '5m-hourly']);
    });

    it('не создаёт пару из одного рынка', () => {
      const markets = [mkMarket('BTC', '2026-03-23T02:15:00Z', '5m')];
      expect(matcher.findPairs(markets)).toHaveLength(0);
    });

    it('не создаёт пару из рынков с разным endDate', () => {
      const markets = [
        mkMarket('BTC', '2026-03-23T02:15:00Z', '5m'),
        mkMarket('BTC', '2026-03-23T02:30:00Z', '15m'),
      ];
      expect(matcher.findPairs(markets)).toHaveLength(0);
    });

    it('не создаёт пару из рынков разных активов', () => {
      const markets = [
        mkMarket('BTC', '2026-03-23T02:15:00Z', '5m'),
        mkMarket('ETH', '2026-03-23T02:15:00Z', '15m'),
      ];
      expect(matcher.findPairs(markets)).toHaveLength(0);
    });

    it('easy всегда длиннее hard', () => {
      const markets = [
        mkMarket('ETH', '2026-03-23T03:00:00Z', 'hourly'),
        mkMarket('ETH', '2026-03-23T03:00:00Z', '5m'),
      ];

      const pairs = matcher.findPairs(markets);

      expect(pairs[0].easy.recurrence).toBe('hourly');
      expect(pairs[0].hard.recurrence).toBe('5m');
    });

    it('сортирует пары по endDate', () => {
      const markets = [
        mkMarket('BTC', '2026-03-23T04:00:00Z', '5m'),
        mkMarket('BTC', '2026-03-23T04:00:00Z', '15m'),
        mkMarket('BTC', '2026-03-23T02:00:00Z', '5m'),
        mkMarket('BTC', '2026-03-23T02:00:00Z', '15m'),
      ];

      const pairs = matcher.findPairs(markets);

      expect(pairs).toHaveLength(2);
      expect(pairs[0].easy.endDate).toBe('2026-03-23T02:00:00Z');
      expect(pairs[1].easy.endDate).toBe('2026-03-23T04:00:00Z');
    });
  });
});
