/**
 * Проектор реагирует ТОЛЬКО на приватный контур нового рантайма.
 *
 * @remarks
 * Метки `AN` и `AO` соответствуют плану MR.
 *
 * Это не формальность. Старые события описывают ВХОД обработки:
 *
 * ```text
 * FILL_RECEIVED           исполнение получено и ЕЩЁ должно быть обработано
 * FILL_FAILED             откат считает подписчик
 * ORDER_UPDATE_RECEIVED   сырое venue-обновление, БЕЗ Order и Portfolio
 * ORDER_* (Domain)        переход агрегата, БЕЗ Portfolio
 * ```
 *
 * Подписаться на них значило бы принять факт до того, как посчитана его
 * экономика, — и получить состояние, в котором исполнение есть, а деньги за
 * него не списаны.
 *
 * События здесь публикуются через НАСТОЯЩУЮ шину: проверяется реальное
 * отсутствие подписки, а не отсутствие строки в коде.
 */
import { describe, expect, it } from '@jest/globals';
import type { EventBusEvent } from '@polymarket/event-bus';
import type {
  FillFailedEvent,
  FillReceivedEvent,
  OrderUpdateReceivedEvent,
} from '@polymarket/application-events';
import type { OrderEvent } from '@polymarket/order-events';
import { AccountStateProjector } from '../src/index.js';
import {
  VENUE,
  fill as makeFill,
  order,
  portfolio,
  ts,
  walletAccount,
} from './helpers/fixtures.js';
import { buildRuntime, publishOk } from './helpers/runtime.js';

describe('AN. старые application-события игнорируются', () => {
  it('FILL_RECEIVED / FILL_FAILED / ORDER_UPDATE_RECEIVED не меняют приватное состояние', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();

    events.observeAt(1_000);
    await publishOk(bus, events.initialized({ accountId, portfolio: portfolio({ accountId }) }));
    const before = {
      version: view.getVersion(),
      accountVersion: view.getAccount(VENUE, accountId)?.version,
      lastMutationAt: view.getAccount(VENUE, accountId)?.lastMutationAt.toISO(),
    };

    const fill = makeFill({ accountId });
    const metadata = events.initialized({ accountId, portfolio: portfolio({ accountId }) }).metadata;

    const legacy: readonly EventBusEvent[] = [
      {
        type: 'FILL_RECEIVED',
        payload: { fill, receivedAt: ts(2_000) },
        metadata,
      } satisfies FillReceivedEvent,
      {
        type: 'FILL_FAILED',
        payload: {
          fillId: fill.id,
          orderId: fill.orderId,
          receivedAt: ts(2_100),
          fills: [fill],
        },
        metadata,
      } satisfies FillFailedEvent,
      {
        type: 'ORDER_UPDATE_RECEIVED',
        payload: {
          update: { type: 'CANCELLED', orderId: order({ accountId }).id, reason: 'venue halt' },
          accountId,
          receivedAt: ts(2_200),
        },
        metadata,
      } satisfies OrderUpdateReceivedEvent,
    ];

    for (const event of legacy) {
      await publishOk(bus, event);
    }

    const account = view.getAccount(VENUE, accountId);
    expect(view.getVersion()).toBe(before.version);
    expect(account?.version).toBe(before.accountVersion);
    expect(account?.lastMutationAt.toISO()).toBe(before.lastMutationAt);
    expect(account?.orders()).toHaveLength(0);
    expect(account?.fills()).toHaveLength(0);
  });

  it('ни один старый тип не входит в список проецируемых', () => {
    const projected = AccountStateProjector.projectedEventTypes();
    for (const legacyType of [
      'FILL_RECEIVED',
      'FILL_CONFIRMED',
      'FILL_FAILED',
      'DIRECT_FILL_APPLIED',
      'ORDER_UPDATE_RECEIVED',
    ]) {
      expect(projected).not.toContain(legacyType);
    }
    expect([...projected].sort()).toEqual([
      'TRADING_ACCOUNT_FILL_APPLIED',
      'TRADING_ACCOUNT_FILL_CONFIRMED',
      'TRADING_ACCOUNT_FILL_REVERTED',
      'TRADING_ACCOUNT_FILL_VENUE_STATUS_OBSERVED',
      'TRADING_ACCOUNT_INITIALIZED',
      'TRADING_ACCOUNT_ORDER_COMMITTED',
    ]);
  });
});

describe('AO. Domain OrderEvent игнорируются', () => {
  it('переходы агрегата Order не проецируются напрямую', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();

    events.observeAt(1_000);
    await publishOk(bus, events.initialized({ accountId, portfolio: portfolio({ accountId }) }));

    const created = order({ accountId });
    const metadata = events.initialized({ accountId, portfolio: portfolio({ accountId }) }).metadata;

    const domainEvents: readonly OrderEvent[] = [
      {
        type: 'ORDER_CREATED',
        payload: {
          orderId: created.id,
          asset: created.asset,
          side: created.side,
          price: created.price,
          size: created.size,
          timestamp: created.timestamp,
        },
        metadata,
      },
      {
        type: 'ORDER_ACCEPTED',
        payload: { orderId: created.id },
        metadata,
      },
      {
        type: 'ORDER_CANCELLED',
        payload: { orderId: created.id, reason: 'strategy exit' },
        metadata,
      },
    ];

    for (const event of domainEvents) {
      await publishOk(bus, event);
    }

    const account = view.getAccount(VENUE, accountId);
    // Домен сообщил о заявке, но БЕЗ портфеля — принять её значило бы
    // показать обязательство, под которое деньги ещё не зарезервированы.
    expect(account?.orders()).toHaveLength(0);
    expect(account?.version).toBe(1);
    expect(view.getVersion()).toBe(1);
  });

  it('ни один Domain-тип не входит в список проецируемых', () => {
    const projected = AccountStateProjector.projectedEventTypes();
    for (const domainType of [
      'ORDER_CREATED',
      'ORDER_ACCEPTED',
      'ORDER_PARTIALLY_FILLED',
      'ORDER_FILLED',
      'ORDER_CANCELLED',
      'ORDER_REJECTED',
      'ORDER_EXPIRED',
    ]) {
      expect(projected).not.toContain(domainType);
    }
  });
});
