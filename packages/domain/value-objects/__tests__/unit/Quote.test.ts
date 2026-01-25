/**
 * Тесты для Quote value object
 */

import { describe, it, expect } from '@jest/globals';
import { unwrap } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';
import { Price } from '../../src/Price';
import { Quantity } from '../../src/Quantity';
import { Quote } from '../../src/Quote';

describe('Quote', () => {
  const createValidBid = () => unwrap(Price.fromValue(0.64));
  const createValidAsk = () => unwrap(Price.fromValue(0.66));
  const createValidBidSize = () => unwrap(Quantity.fromValue(100));
  const createValidAskSize = () => unwrap(Quantity.fromValue(100));

  describe('Factory Methods', () => {
    describe('create', () => {
      it('should create two-sided quote', () => {
        const bid = createValidBid();
        const ask = createValidAsk();
        const bidSize = createValidBidSize();
        const askSize = createValidAskSize();

        const result = Quote.create(bid, ask, bidSize, askSize);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid?.value).toBe(0.64);
          expect(result.value.ask?.value).toBe(0.66);
          expect(result.value.bidSize.value).toBe(100);
          expect(result.value.askSize.value).toBe(100);
        }
      });

      it('should create bid-only quote', () => {
        const bid = createValidBid();
        const bidSize = createValidBidSize();

        const result = Quote.create(bid, null, bidSize, Quantity.zero());

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isBidOnly()).toBe(true);
        }
      });

      it('should create ask-only quote', () => {
        const ask = createValidAsk();
        const askSize = createValidAskSize();

        const result = Quote.create(null, ask, Quantity.zero(), askSize);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isAskOnly()).toBe(true);
        }
      });

      it('should reject quote with no prices', () => {
        const result = Quote.create(null, null, Quantity.zero(), Quantity.zero());

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuoteError);
          expect(result.error.message).toContain('at least bid or ask');
        }
      });

      it('should reject bid >= ask', () => {
        const bid = unwrap(Price.fromValue(0.66));
        const ask = unwrap(Price.fromValue(0.64));
        const bidSize = createValidBidSize();
        const askSize = createValidAskSize();

        const result = Quote.create(bid, ask, bidSize, askSize);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuoteError);
          expect(result.error.message).toContain('must be less than');
        }
      });

      it('should reject bid equal to ask', () => {
        const price = unwrap(Price.fromValue(0.65));
        const bidSize = createValidBidSize();
        const askSize = createValidAskSize();

        const result = Quote.create(price, price, bidSize, askSize);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuoteError);
        }
      });

      it('should reject null bid with non-zero bidSize', () => {
        const ask = createValidAsk();
        const bidSize = createValidBidSize();
        const askSize = createValidAskSize();

        const result = Quote.create(null, ask, bidSize, askSize);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuoteError);
          expect(result.error.message).toContain('Bid size must be 0');
        }
      });

      it('should reject null ask with non-zero askSize', () => {
        const bid = createValidBid();
        const bidSize = createValidBidSize();
        const askSize = createValidAskSize();

        const result = Quote.create(bid, null, bidSize, askSize);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidQuoteError);
          expect(result.error.message).toContain('Ask size must be 0');
        }
      });

      it('should accept custom timestamp', () => {
        const bid = createValidBid();
        const ask = createValidAsk();
        const bidSize = createValidBidSize();
        const askSize = createValidAskSize();
        const timestamp = new Date('2024-01-01T00:00:00Z');

        const result = Quote.create(bid, ask, bidSize, askSize, timestamp);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.timestamp).toEqual(timestamp);
        }
      });
    });
  });

  describe('Metrics', () => {
    describe('getSpread', () => {
      it('should calculate spread for two-sided quote', () => {
        const quote = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        const result = quote.getSpread();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeCloseTo(0.02, 2);
        }
      });

      it('should return error for bid-only quote', () => {
        const quote = unwrap(
          Quote.create(createValidBid(), null, createValidBidSize(), Quantity.ZERO)
        );

        const result = quote.getSpread();

        expect(result.ok).toBe(false);
      });

      it('should return error for ask-only quote', () => {
        const quote = unwrap(
          Quote.create(null, createValidAsk(), Quantity.ZERO, createValidAskSize())
        );

        const result = quote.getSpread();

        expect(result.ok).toBe(false);
      });
    });

    describe('getMidPrice', () => {
      it('should calculate mid price for two-sided quote', () => {
        const quote = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        const result = quote.getMidPrice();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value).toBe(0.65);
        }
      });

      it('should return error for bid-only quote', () => {
        const quote = unwrap(
          Quote.create(createValidBid(), null, createValidBidSize(), Quantity.ZERO)
        );

        const result = quote.getMidPrice();

        expect(result.ok).toBe(false);
      });

      it('should return error for ask-only quote', () => {
        const quote = unwrap(
          Quote.create(null, createValidAsk(), Quantity.ZERO, createValidAskSize())
        );

        const result = quote.getMidPrice();

        expect(result.ok).toBe(false);
      });
    });
  });

  describe('Type Checks', () => {
    describe('isTwoSided', () => {
      it('should return true for two-sided quote', () => {
        const quote = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        expect(quote.isTwoSided()).toBe(true);
      });

      it('should return false for bid-only quote', () => {
        const quote = unwrap(
          Quote.create(createValidBid(), null, createValidBidSize(), Quantity.zero())
        );

        expect(quote.isTwoSided()).toBe(false);
      });

      it('should return false for ask-only quote', () => {
        const quote = unwrap(
          Quote.create(null, createValidAsk(), Quantity.zero(), createValidAskSize())
        );

        expect(quote.isTwoSided()).toBe(false);
      });
    });

    describe('isBidOnly', () => {
      it('should return true for bid-only quote', () => {
        const quote = unwrap(
          Quote.create(createValidBid(), null, createValidBidSize(), Quantity.zero())
        );

        expect(quote.isBidOnly()).toBe(true);
      });

      it('should return false for two-sided quote', () => {
        const quote = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        expect(quote.isBidOnly()).toBe(false);
      });

      it('should return false for ask-only quote', () => {
        const quote = unwrap(
          Quote.create(null, createValidAsk(), Quantity.zero(), createValidAskSize())
        );

        expect(quote.isBidOnly()).toBe(false);
      });
    });

    describe('isAskOnly', () => {
      it('should return true for ask-only quote', () => {
        const quote = unwrap(
          Quote.create(null, createValidAsk(), Quantity.zero(), createValidAskSize())
        );

        expect(quote.isAskOnly()).toBe(true);
      });

      it('should return false for two-sided quote', () => {
        const quote = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        expect(quote.isAskOnly()).toBe(false);
      });

      it('should return false for bid-only quote', () => {
        const quote = unwrap(
          Quote.create(createValidBid(), null, createValidBidSize(), Quantity.zero())
        );

        expect(quote.isAskOnly()).toBe(false);
      });
    });
  });

  describe('Market Crossing', () => {
    describe('crossesMarket', () => {
      it('should detect bid crossing orderbook ask', () => {
        // Our bid: 0.67, Market ask: 0.66
        const quote = unwrap(
          Quote.create(
            unwrap(Price.fromValue(0.67)),
            unwrap(Price.fromValue(0.68)),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        const marketBid = unwrap(Price.fromValue(0.65));
        const marketAsk = unwrap(Price.fromValue(0.66));

        expect(quote.crossesMarket(marketBid, marketAsk)).toBe(true);
      });

      it('should detect ask crossing orderbook bid', () => {
        // Our ask: 0.63, Market bid: 0.64
        const quote = unwrap(
          Quote.create(
            unwrap(Price.fromValue(0.62)),
            unwrap(Price.fromValue(0.63)),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        const marketBid = unwrap(Price.fromValue(0.64));
        const marketAsk = unwrap(Price.fromValue(0.66));

        expect(quote.crossesMarket(marketBid, marketAsk)).toBe(true);
      });

      it('should not cross when inside market spread', () => {
        const quote = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        const marketBid = unwrap(Price.fromValue(0.63));
        const marketAsk = unwrap(Price.fromValue(0.67));

        expect(quote.crossesMarket(marketBid, marketAsk)).toBe(false);
      });

      it('should not cross when at exact market prices', () => {
        const quote = unwrap(
          Quote.create(
            unwrap(Price.fromValue(0.64)),
            unwrap(Price.fromValue(0.66)),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        const marketBid = unwrap(Price.fromValue(0.64));
        const marketAsk = unwrap(Price.fromValue(0.66));

        expect(quote.crossesMarket(marketBid, marketAsk)).toBe(false);
      });

      it('should handle null market bid', () => {
        const quote = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        const marketAsk = unwrap(Price.fromValue(0.67));

        expect(quote.crossesMarket(null, marketAsk)).toBe(false);
      });

      it('should handle null market ask', () => {
        const quote = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        const marketBid = unwrap(Price.fromValue(0.63));

        expect(quote.crossesMarket(marketBid, null)).toBe(false);
      });

      it('should handle bid-only quote', () => {
        const quote = unwrap(
          Quote.create(
            unwrap(Price.fromValue(0.67)),
            null,
            createValidBidSize(),
            Quantity.zero()
          )
        );

        const marketBid = unwrap(Price.fromValue(0.65));
        const marketAsk = unwrap(Price.fromValue(0.66));

        expect(quote.crossesMarket(marketBid, marketAsk)).toBe(true);
      });

      it('should handle ask-only quote', () => {
        const quote = unwrap(
          Quote.create(
            null,
            unwrap(Price.fromValue(0.63)),
            Quantity.zero(),
            createValidAskSize()
          )
        );

        const marketBid = unwrap(Price.fromValue(0.64));
        const marketAsk = unwrap(Price.fromValue(0.66));

        expect(quote.crossesMarket(marketBid, marketAsk)).toBe(true);
      });
    });
  });

  describe('Operations', () => {
    describe('withAdjustment', () => {
      it('should widen spread (bid down, ask up)', () => {
        const quote = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        const adjusted = quote.withAdjustment(-0.01, 0.01);

        expect(adjusted.bid?.value).toBeCloseTo(0.63, 2);
        expect(adjusted.ask?.value).toBeCloseTo(0.67, 2);
      });

      it('should narrow spread (bid up, ask down)', () => {
        const quote = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        const adjusted = quote.withAdjustment(0.005, -0.005);

        expect(adjusted.bid?.value).toBeCloseTo(0.645, 3);
        expect(adjusted.ask?.value).toBeCloseTo(0.655, 3);
      });

      it('should skew quote (inventory management)', () => {
        const quote = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        // Lower both to discourage buys
        const adjusted = quote.withAdjustment(-0.01, -0.01);

        expect(adjusted.bid?.value).toBeCloseTo(0.63, 2);
        expect(adjusted.ask?.value).toBeCloseTo(0.65, 2);
      });

      it('should preserve sizes', () => {
        const quote = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        const adjusted = quote.withAdjustment(-0.01, 0.01);

        expect(adjusted.bidSize.value).toBe(100);
        expect(adjusted.askSize.value).toBe(100);
      });

      it('should handle bid-only quote', () => {
        const quote = unwrap(
          Quote.create(createValidBid(), null, createValidBidSize(), Quantity.zero())
        );

        const adjusted = quote.withAdjustment(-0.01, 0);

        expect(adjusted.bid?.value).toBeCloseTo(0.63, 2);
        expect(adjusted.ask).toBeNull();
      });

      it('should handle ask-only quote', () => {
        const quote = unwrap(
          Quote.create(null, createValidAsk(), Quantity.zero(), createValidAskSize())
        );

        const adjusted = quote.withAdjustment(0, 0.01);

        expect(adjusted.bid).toBeNull();
        expect(adjusted.ask?.value).toBeCloseTo(0.67, 2);
      });

      it('should update timestamp', () => {
        const oldTimestamp = new Date('2024-01-01T00:00:00Z');
        const quote = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize(),
            oldTimestamp
          )
        );

        const adjusted = quote.withAdjustment(0, 0);

        expect(adjusted.timestamp).not.toEqual(oldTimestamp);
      });
    });
  });

  describe('Utilities', () => {
    describe('toString', () => {
      it('should format two-sided quote', () => {
        const quote = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        const str = quote.toString();

        expect(str).toContain('0.6400');
        expect(str).toContain('0.6600');
        expect(str).toContain('(100)');
        expect(str).toContain('spread');
      });

      it('should format bid-only quote', () => {
        const quote = unwrap(
          Quote.create(createValidBid(), null, createValidBidSize(), Quantity.zero())
        );

        const str = quote.toString();

        expect(str).toContain('0.6400');
        expect(str).toContain('N/A');
        expect(str).not.toContain('spread');
      });

      it('should format ask-only quote', () => {
        const quote = unwrap(
          Quote.create(null, createValidAsk(), Quantity.zero(), createValidAskSize())
        );

        const str = quote.toString();

        expect(str).toContain('N/A');
        expect(str).toContain('0.6600');
        expect(str).not.toContain('spread');
      });
    });

    describe('equals', () => {
      it('should return true for equal two-sided quotes', () => {
        const q1 = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );
        const q2 = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        expect(q1.equals(q2)).toBe(true);
      });

      it('should return false for different bids', () => {
        const q1 = unwrap(
          Quote.create(
            unwrap(Price.fromValue(0.64)),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );
        const q2 = unwrap(
          Quote.create(
            unwrap(Price.fromValue(0.63)),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        expect(q1.equals(q2)).toBe(false);
      });

      it('should return false for different asks', () => {
        const q1 = unwrap(
          Quote.create(
            createValidBid(),
            unwrap(Price.fromValue(0.66)),
            createValidBidSize(),
            createValidAskSize()
          )
        );
        const q2 = unwrap(
          Quote.create(
            createValidBid(),
            unwrap(Price.fromValue(0.67)),
            createValidBidSize(),
            createValidAskSize()
          )
        );

        expect(q1.equals(q2)).toBe(false);
      });

      it('should return false for different sizes', () => {
        const q1 = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            unwrap(Quantity.fromValue(100)),
            createValidAskSize()
          )
        );
        const q2 = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            unwrap(Quantity.fromValue(200)),
            createValidAskSize()
          )
        );

        expect(q1.equals(q2)).toBe(false);
      });

      it('should ignore timestamps', () => {
        const q1 = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize(),
            new Date('2024-01-01T00:00:00Z')
          )
        );
        const q2 = unwrap(
          Quote.create(
            createValidBid(),
            createValidAsk(),
            createValidBidSize(),
            createValidAskSize(),
            new Date('2024-12-31T23:59:59Z')
          )
        );

        expect(q1.equals(q2)).toBe(true);
      });

      it('should handle null bids', () => {
        const q1 = unwrap(
          Quote.create(null, createValidAsk(), Quantity.zero(), createValidAskSize())
        );
        const q2 = unwrap(
          Quote.create(null, createValidAsk(), Quantity.zero(), createValidAskSize())
        );

        expect(q1.equals(q2)).toBe(true);
      });

      it('should handle null asks', () => {
        const q1 = unwrap(
          Quote.create(createValidBid(), null, createValidBidSize(), Quantity.zero())
        );
        const q2 = unwrap(
          Quote.create(createValidBid(), null, createValidBidSize(), Quantity.zero())
        );

        expect(q1.equals(q2)).toBe(true);
      });
    });
  });

  describe('Integration', () => {
    it('should handle complete market-making workflow', () => {
      // 1. Create base quote
      const baseQuote = unwrap(
        Quote.create(
          unwrap(Price.fromValue(0.64)),
          unwrap(Price.fromValue(0.66)),
          unwrap(Quantity.fromValue(100)),
          unwrap(Quantity.fromValue(100))
        )
      );

      // 2. Check if two-sided
      expect(baseQuote.isTwoSided()).toBe(true);

      // 3. Calculate metrics
      const spreadResult = baseQuote.getSpread();
      expect(spreadResult.ok).toBe(true);
      if (spreadResult.ok) {
        expect(spreadResult.value).toBeCloseTo(0.02, 2);
      }

      const midResult = baseQuote.getMidPrice();
      expect(midResult.ok).toBe(true);
      if (midResult.ok) {
        expect(midResult.value.value).toBe(0.65);
      }

      // 4. Check if would cross market
      const marketBid = unwrap(Price.fromValue(0.63));
      const marketAsk = unwrap(Price.fromValue(0.67));
      expect(baseQuote.crossesMarket(marketBid, marketAsk)).toBe(false);

      // 5. Adjust based on inventory (too much inventory, lower quotes)
      const adjusted = baseQuote.withAdjustment(-0.01, -0.01);
      const adjustedMidResult = adjusted.getMidPrice();
      expect(adjustedMidResult.ok).toBe(true);
      if (adjustedMidResult.ok) {
        expect(adjustedMidResult.value.value).toBeCloseTo(0.64, 2);
      }
    });

    it('should handle quote aging and refresh', () => {
      const oldTimestamp = new Date(Date.now() - 10000);
      const oldQuote = unwrap(
        Quote.create(
          createValidBid(),
          createValidAsk(),
          createValidBidSize(),
          createValidAskSize(),
          oldTimestamp
        )
      );

      // Check if stale (older than 5 seconds)
      const isStale = Date.now() - oldQuote.timestamp.getTime() > 5000;
      expect(isStale).toBe(true);

      // Refresh with same prices but new timestamp
      const refreshed = unwrap(
        Quote.create(
          oldQuote.bid,
          oldQuote.ask,
          oldQuote.bidSize,
          oldQuote.askSize
        )
      );

      expect(refreshed.equals(oldQuote)).toBe(true); // Equals ignores timestamp
      expect(refreshed.timestamp.getTime()).toBeGreaterThan(oldTimestamp.getTime());
    });
  });

  describe('Serialization', () => {
    describe('toJSON', () => {
      it('should serialize two-sided quote to JSON', () => {
        const quote = unwrap(
          Quote.create(
            unwrap(Price.fromValue(0.64)),
            unwrap(Price.fromValue(0.66)),
            unwrap(Quantity.fromValue(100)),
            unwrap(Quantity.fromValue(100))
          )
        );
        const json = quote.toJSON();

        expect(json.bid).toBe(0.64);
        expect(json.ask).toBe(0.66);
        expect(json.bidSize).toBe(100);
        expect(json.askSize).toBe(100);
        expect(typeof json.timestamp).toBe('string');
      });

      it('should serialize bid-only quote', () => {
        const quote = unwrap(
          Quote.create(
            unwrap(Price.fromValue(0.64)),
            null,
            unwrap(Quantity.fromValue(100)),
            Quantity.ZERO
          )
        );
        const json = quote.toJSON();

        expect(json.bid).toBe(0.64);
        expect(json.ask).toBeNull();
        expect(json.bidSize).toBe(100);
        expect(json.askSize).toBe(0);
      });

      it('should serialize ask-only quote', () => {
        const quote = unwrap(
          Quote.create(
            null,
            unwrap(Price.fromValue(0.66)),
            Quantity.ZERO,
            unwrap(Quantity.fromValue(100))
          )
        );
        const json = quote.toJSON();

        expect(json.bid).toBeNull();
        expect(json.ask).toBe(0.66);
        expect(json.bidSize).toBe(0);
        expect(json.askSize).toBe(100);
      });
    });

    describe('fromJSON', () => {
      it('should deserialize valid two-sided quote from JSON', () => {
        const json = {
          bid: 0.64,
          ask: 0.66,
          bidSize: 100,
          askSize: 100,
          timestamp: new Date().toISOString()
        };
        const result = Quote.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.bid?.value).toBe(0.64);
          expect(result.value.ask?.value).toBe(0.66);
          expect(result.value.bidSize.value).toBe(100);
          expect(result.value.askSize.value).toBe(100);
        }
      });

      it('should deserialize bid-only quote', () => {
        const json = {
          bid: 0.64,
          ask: null,
          bidSize: 100,
          askSize: 0,
          timestamp: new Date().toISOString()
        };
        const result = Quote.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isBidOnly()).toBe(true);
        }
      });

      it('should deserialize ask-only quote', () => {
        const json = {
          bid: null,
          ask: 0.66,
          bidSize: 0,
          askSize: 100,
          timestamp: new Date().toISOString()
        };
        const result = Quote.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isAskOnly()).toBe(true);
        }
      });

      it('should reject invalid bid price', () => {
        const json = {
          bid: 1.5,
          ask: 0.66,
          bidSize: 100,
          askSize: 100,
          timestamp: new Date().toISOString()
        };
        const result = Quote.fromJSON(json);

        expect(result.ok).toBe(false);
      });

      it('should reject invalid timestamp', () => {
        const json = {
          bid: 0.64,
          ask: 0.66,
          bidSize: 100,
          askSize: 100,
          timestamp: 'invalid-date'
        };
        const result = Quote.fromJSON(json);

        expect(result.ok).toBe(false);
      });

      it('should round-trip correctly', () => {
        const original = unwrap(
          Quote.create(
            unwrap(Price.fromValue(0.64)),
            unwrap(Price.fromValue(0.66)),
            unwrap(Quantity.fromValue(100)),
            unwrap(Quantity.fromValue(150))
          )
        );
        const json = original.toJSON();
        const deserialized = unwrap(Quote.fromJSON(json));

        expect(deserialized.equals(original)).toBe(true);
      });
    });
  });
});
