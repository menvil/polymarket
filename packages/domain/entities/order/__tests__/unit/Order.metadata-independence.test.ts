/**
 * Proof M-003 (Part 17): metadata НЕ является частью Domain state transition
 * semantics — изменение metadata при одинаковых `type` + `payload` не меняет
 * reconstructed Order state.
 */
import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { Price, Quantity } from '@polymarket/value-objects';
import { Timestamp } from '@polymarket/timestamp';
import type { AssetId, OrderId, FillId } from '@polymarket/ids';
import { unsafeRunId } from '@polymarket/ids';
import { MessageMetadataGenerator, FixedHighResolutionClock } from '@polymarket/messages';
import type { OrderEvent } from '@polymarket/order-events';
import type { FillData } from '@polymarket/fill';
import { replay } from '../helpers';

const ORDER_ID = 'order-meta-1' as unknown as OrderId;
const TEST_ASSET = { type: 'POLYMARKET_CTF_TOKEN', tokenId: '777' } as unknown as AssetId;

/** Строит один и тот же event-лог (type+payload идентичны), metadata — от переданного генератора. */
function buildLog(generator: MessageMetadataGenerator): readonly OrderEvent[] {
  const ts = Timestamp.now({ now: () => new Date('2024-01-01T00:00:00.000Z') });
  const fill: FillData = {
    id: 'fill-meta-1' as unknown as FillId,
    orderId: ORDER_ID,
    asset: TEST_ASSET,
    side: 'BUY',
    size: Quantity.of(new Decimal('100')),
    price: Price.of(new Decimal('0.65')),
  };
  return [
    {
      type: 'ORDER_CREATED',
      payload: {
        orderId: ORDER_ID,
        asset: TEST_ASSET,
        side: 'BUY',
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('100')),
        timestamp: ts,
      },
      metadata: generator.nextRoot(),
    },
    { type: 'ORDER_ACCEPTED', payload: { orderId: ORDER_ID }, metadata: generator.nextRoot() },
    {
      type: 'ORDER_FILLED',
      payload: { orderId: ORDER_ID, fill, averagePrice: Price.of(new Decimal('0.65')) },
      metadata: generator.nextChild(generator.nextRoot()),
    },
  ];
}

describe('Order replay — независимость от metadata (M-003 Part 17)', () => {
  it('разные metadata при одинаковых type+payload дают идентичный reconstructed state', () => {
    // Два «runtime» с разными runId, временем, sub-ms precision и causal-структурой
    const generatorA = new MessageMetadataGenerator({
      clock: { now: () => new Date('2024-01-01T00:00:00.000Z') },
      runId: unsafeRunId('runaaaa1'),
    });
    const generatorB = new MessageMetadataGenerator({
      clock: { now: () => new Date('2026-08-14T12:34:56.789Z') },
      highResolutionClock: new FixedHighResolutionClock(987_654n),
      runId: unsafeRunId('runbbbb2'),
    });

    const orderA = replay(buildLog(generatorA));
    const orderB = replay(buildLog(generatorB));

    // Полное совпадение доменного состояния — snapshot к snapshot-у
    expect(orderB.toSnapshot()).toEqual(orderA.toSnapshot());
    expect(orderA.status).toBe('FILLED');
    expect(orderB.status).toBe('FILLED');
    expect(orderB.filledSize.value().toNumber()).toBe(orderA.filledSize.value().toNumber());
  });
});
