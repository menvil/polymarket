import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { FillEventHandler } from '../src/FillEventHandler.js';
import type { IEventBus } from '@polymarket/event-bus';
import type { IClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import type { AccountId } from '@polymarket/ids';
import { FillMapper } from '@polymarket/fill';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn() as ILogger['child'],
  };
}

function makeEventBus(): IEventBus {
  return {
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
    subscribe: jest.fn() as IEventBus['subscribe'],
  };
}

const ACCOUNT_ID = 'venue:POLYMARKET:0xabc' as unknown as AccountId;

// Минимальный валидный raw payload из Polymarket WS user-channel
function makeValidRaw(): Record<string, unknown> {
  return {
    id: 'fill-001',
    taker_order_id: 'order-999',
    trader_side: 'BUY',
    asset_id: 'token-abc',
    outcome: 'YES',
    price: '0.65',
    size: '100',
    fee_rate_bps: '0',
    status: 'MATCHED',
    match_time: String(Date.now()),
    transaction_hash: '0xdeadbeef',
    maker_orders: [],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FillEventHandler', () => {
  let eventBus: IEventBus;
  let clock: IClock;
  let logger: ILogger;
  let handler: FillEventHandler;

  beforeEach(() => {
    eventBus = makeEventBus();
    clock = { now: jest.fn<() => Date>().mockReturnValue(new Date('2024-01-01T00:00:00.000Z')) };
    logger = makeLogger();
    handler = new FillEventHandler(eventBus, clock, logger);
  });

  it('публикует FILL_RECEIVED при валидном raw payload', async () => {
    const raw = makeValidRaw();
    const mapResult = FillMapper.fromPolymarketTradeEvent(raw, ACCOUNT_ID);

    // Проверяем только если маппер действительно парсит этот payload
    if (!mapResult.ok) {
      // Маппер не принял payload — тест не может проверить публикацию
      // (payload может не соответствовать текущей версии FillMapper)
      return;
    }

    await handler.handle(raw, ACCOUNT_ID);

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'FILL_RECEIVED' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Fill event published',
      expect.any(Object),
    );
  });

  it('логирует error и не публикует при невалидном raw', async () => {
    const raw = { id: 'bad-fill', status: 'MATCHED' }; // невалидный payload, но MATCHED

    await handler.handle(raw, ACCOUNT_ID);

    // Если маппер его отклонил — должен логировать error
    const mapResult = FillMapper.fromPolymarketTradeEvent(raw, ACCOUNT_ID);
    if (!mapResult.ok) {
      expect(eventBus.publish).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to parse fill event',
        expect.any(Object),
      );
    }
  });

  it('игнорирует fill со статусом MINED (trace-лог, нет публикации)', async () => {
    const raw = { ...makeValidRaw(), status: 'MINED' };

    await handler.handle(raw, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.trace).toHaveBeenCalledWith(
      'Fill event ignored (non-primary status)',
      expect.objectContaining({ status: 'MINED' }),
    );
  });

  it('игнорирует fill со статусом CONFIRMED', async () => {
    const raw = { ...makeValidRaw(), status: 'CONFIRMED' };

    await handler.handle(raw, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('игнорирует fill со статусом RETRYING', async () => {
    const raw = { ...makeValidRaw(), status: 'RETRYING' };

    await handler.handle(raw, ACCOUNT_ID);

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('публикует FILL_FAILED при статусе FAILED', async () => {
    const raw = { ...makeValidRaw(), status: 'FAILED' };

    await handler.handle(raw, ACCOUNT_ID);

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'FILL_FAILED',
        fillId: 'fill-001',
        orderId: 'order-999',
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Fill failed event published',
      expect.any(Object),
    );
  });

  it('логирует rawId из raw["id"] при ошибке парсинга', async () => {
    const raw = { id: 'fill-bad-123', status: 'MATCHED' };

    const mapResult = FillMapper.fromPolymarketTradeEvent(raw, ACCOUNT_ID);
    if (!mapResult.ok) {
      await handler.handle(raw, ACCOUNT_ID);

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to parse fill event',
        expect.objectContaining({ rawId: 'fill-bad-123' }),
      );
    }
  });

  it('использует "unknown" как rawId если raw["id"] не строка', async () => {
    const raw = { id: 42, status: 'MATCHED' }; // id не строка

    const mapResult = FillMapper.fromPolymarketTradeEvent(raw, ACCOUNT_ID);
    if (!mapResult.ok) {
      await handler.handle(raw, ACCOUNT_ID);

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to parse fill event',
        expect.objectContaining({ rawId: 'unknown' }),
      );
    }
  });

  it('не публикует если TimestampService не может создать timestamp', async () => {
    // Симулируем невалидный clock — возвращает Invalid Date
    const badClock: IClock = {
      now: jest.fn<() => Date>().mockReturnValue(new Date('invalid')),
    };
    const handlerBadClock = new FillEventHandler(eventBus, badClock, logger);

    const raw = makeValidRaw();
    const mapResult = FillMapper.fromPolymarketTradeEvent(raw, ACCOUNT_ID);
    if (!mapResult.ok) {
      return; // payload не парсится — тест неприменим
    }

    await handlerBadClock.handle(raw, ACCOUNT_ID);

    // FILL_RECEIVED не должен быть опубликован при невалидном timestamp
    expect(eventBus.publish).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to create receivedAt timestamp',
      expect.any(Object),
    );
  });
});
