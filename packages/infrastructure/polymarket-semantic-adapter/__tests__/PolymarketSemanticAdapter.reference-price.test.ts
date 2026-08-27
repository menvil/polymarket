/**
 * Semantic-выход референсных цен внешних активов (RTDS).
 *
 * @remarks
 * Главный инвариант файла: цена базового актива НЕ проходит через `Price`
 * рынка предсказаний. `Price` ограничен `[0.0001, 0.9999]` и обязан
 * отвергнуть `79341.36`, поэтому «случайно заработавший» маппинг здесь
 * невозможен — он бы просто не публиковал события.
 */
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { PriceService } from '@polymarket/value-objects';
import {
  POLYMARKET_RTDS_BINANCE_SOURCE,
  POLYMARKET_RTDS_CHAINLINK_SOURCE,
  POLYMARKET_RTDS_CHAINLINK_TWAP_SOURCE,
} from '../src/index.js';
import { createHarness, publishReferencePrice, type Harness } from './support/fixtures.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

afterEach(() => {
  h.adapter.close();
});

describe('Binance spot', () => {
  it('публикует наблюдение с провенансом Binance и точным значением', async () => {
    await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_BINANCE',
      symbol: 'btcusdt',
      value: '79341.36626633028',
      timestamp: 1_787_751_721_000,
    });

    const events = h.eventsOfType('REFERENCE_PRICE_UPDATED');
    expect(events).toHaveLength(1);

    const payload = events[0]!.payload;
    expect(payload.sourceId).toBe(POLYMARKET_RTDS_BINANCE_SOURCE);
    expect(payload.symbol).toBe('btcusdt');
    expect(payload.feed).toEqual({ kind: 'SPOT' });
    expect(payload.value.value().toString()).toBe('79341.36626633028');
    expect(payload.venueTimestamp.toNumber()).toBe(1_787_751_721_000);
    expect(h.adapter.getStats().referenceBinance).toBe(1);
  });
});

describe('Chainlink spot', () => {
  it('отличается источником от Binance и сохраняет нативный символ', async () => {
    await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_CHAINLINK',
      symbol: 'btc/usd',
      value: '79338.5',
    });

    const payload = h.eventsOfType('REFERENCE_PRICE_UPDATED')[0]!.payload;
    expect(payload.sourceId).toBe(POLYMARKET_RTDS_CHAINLINK_SOURCE);
    expect(payload.sourceId).not.toBe(POLYMARKET_RTDS_BINANCE_SOURCE);
    // Символ НЕ нормализуется — иначе наблюдение не сопоставить с raw-архивом
    expect(payload.symbol).toBe('btc/usd');
    expect(h.adapter.getStats().referenceChainlink).toBe(1);
  });

  it('одинаковый символ у разных источников остаётся различимым', async () => {
    await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_BINANCE',
      symbol: 'btcusdt',
      value: '79341.1',
    });
    await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_CHAINLINK',
      symbol: 'btc/usd',
      value: '79338.5',
    });

    const sources = h.eventsOfType('REFERENCE_PRICE_UPDATED').map((e) => e.payload.sourceId);
    expect(new Set(sources).size).toBe(2);
  });
});

describe('Chainlink TWAP', () => {
  it('сохраняет окно усреднения в идентичности потока', async () => {
    await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
      symbol: 'btc/usd',
      value: '78376.356031481042173952',
      windowSeconds: 60,
    });

    const payload = h.eventsOfType('REFERENCE_PRICE_UPDATED')[0]!.payload;
    expect(payload.sourceId).toBe(POLYMARKET_RTDS_CHAINLINK_TWAP_SOURCE);
    expect(payload.feed).toEqual({ kind: 'TWAP', windowSeconds: 60 });
    expect(payload.value.value().toString()).toBe('78376.356031481042173952');
    expect(h.adapter.getStats().referenceTwap).toBe(1);
  });

  it('TWAP 30 и TWAP 60 семантически РАЗНЫЕ наблюдения', async () => {
    await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
      symbol: 'btc/usd',
      value: '78376.35',
      windowSeconds: 30,
    });
    await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
      symbol: 'btc/usd',
      value: '78380.11',
      windowSeconds: 60,
    });

    const feeds = h.eventsOfType('REFERENCE_PRICE_UPDATED').map((e) => e.payload.feed);
    expect(feeds).toEqual([
      { kind: 'TWAP', windowSeconds: 30 },
      { kind: 'TWAP', windowSeconds: 60 },
    ]);
    expect(feeds[0]).not.toEqual(feeds[1]);
  });

  it('TWAP отличается от Chainlink spot по источнику и виду потока', async () => {
    await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_CHAINLINK',
      symbol: 'btc/usd',
      value: '79338.5',
    });
    await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
      symbol: 'btc/usd',
      value: '79330.2',
      windowSeconds: 60,
    });

    const [spot, twap] = h.eventsOfType('REFERENCE_PRICE_UPDATED');
    expect(spot!.payload.sourceId).not.toBe(twap!.payload.sourceId);
    expect(spot!.payload.feed.kind).toBe('SPOT');
    expect(twap!.payload.feed.kind).toBe('TWAP');
  });
});

describe('референсная цена НЕ использует Price рынка предсказаний', () => {
  it('79341.36 отвергается Price, но успешно проходит через ReferencePrice', () => {
    // Доказательство «в лоб»: canonical prediction Price такое значение
    // принять НЕ МОЖЕТ, поэтому маппинг через него был бы невозможен
    expect(PriceService.create('79341.36').ok).toBe(false);
  });

  it('крупные цены активов публикуются без ошибок диапазона', async () => {
    for (const value of ['79341.36626633028', '3021.5', '0.00000123', '1']) {
      await publishReferencePrice(h, {
        channel: 'POLYMARKET_CRYPTO_BINANCE',
        symbol: 'btcusdt',
        value,
      });
    }

    const values = h
      .eventsOfType('REFERENCE_PRICE_UPDATED')
      .map((e) => e.payload.value.value().toString());
    expect(values).toEqual(['79341.36626633028', '3021.5', '0.00000123', '1']);
    expect(h.adapter.getStats().invalidPayloads).toBe(0);
  });
});

describe('окно TWAP вне vendor-домена', () => {
  it('наблюдение с неподдержанным окном НЕ публикуется', async () => {
    await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
      symbol: 'btc/usd',
      value: '78376.35',
      // Тип обещает 30|60, но окно приходит по проводу — расширение домена
      // vendor-ом не должно молча смешать ряды разных окон
      windowSeconds: 45 as unknown as 30,
    });

    expect(h.eventsOfType('REFERENCE_PRICE_UPDATED')).toHaveLength(0);
    expect(h.adapter.getStats().referenceTwap).toBe(0);
    expect(h.adapter.getStats().invalidPayloads).toBe(1);
  });

  it('отсутствующее окно тоже отвергается', async () => {
    await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
      symbol: 'btc/usd',
      value: '78376.35',
      // windowSeconds не передан вовсе
    });

    expect(h.eventsOfType('REFERENCE_PRICE_UPDATED')).toHaveLength(0);
    expect(h.adapter.getStats().invalidPayloads).toBe(1);
  });

  it('поддержанные окна проходят', async () => {
    for (const windowSeconds of [30, 60] as const) {
      await publishReferencePrice(h, {
        channel: 'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
        symbol: 'btc/usd',
        value: '78376.35',
        windowSeconds,
      });
    }
    expect(h.adapter.getStats().referenceTwap).toBe(2);
  });
});

describe('невалидные наблюдения', () => {
  it('неположительное значение отвергается', async () => {
    await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_BINANCE',
      symbol: 'btcusdt',
      value: '0',
    });

    expect(h.eventsOfType('REFERENCE_PRICE_UPDATED')).toHaveLength(0);
    expect(h.adapter.getStats().invalidPayloads).toBe(1);
  });

  it('нечисловое значение отвергается и не роняет поток', async () => {
    await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_CHAINLINK',
      symbol: 'btc/usd',
      value: 'not-a-number',
    });
    await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_CHAINLINK',
      symbol: 'btc/usd',
      value: '79338.5',
    });

    expect(h.eventsOfType('REFERENCE_PRICE_UPDATED')).toHaveLength(1);
    expect(h.adapter.getStats().invalidPayloads).toBe(1);
  });
});

describe('два времени наблюдения', () => {
  it('venueTimestamp и receivedAt различаются и не подменяют друг друга', async () => {
    const raw = await publishReferencePrice(h, {
      channel: 'POLYMARKET_CRYPTO_BINANCE',
      symbol: 'btcusdt',
      value: '79341.36',
      timestamp: 1_700_000_000_000,
    });

    const payload = h.eventsOfType('REFERENCE_PRICE_UPDATED')[0]!.payload;
    expect(payload.venueTimestamp.toNumber()).toBe(1_700_000_000_000);
    expect(payload.receivedAt.toNumber()).toBe(raw.metadata.createdAt.toNumber());
    expect(payload.receivedAt.toNumber()).not.toBe(payload.venueTimestamp.toNumber());
  });
});
