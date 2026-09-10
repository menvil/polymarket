/**
 * Семантика версий и источник времени мутаций.
 *
 * @remarks
 * Метки `AK` и `AP` соответствуют плану MR.
 *
 * Версий две, и они отвечают на разные вопросы:
 *
 * ```text
 * AccountHotState.version      сколько приватных мутаций было ВСЕГО
 * AccountRuntimeState.version  сколько их было у ЭТОГО аккаунта
 * ```
 *
 * Время мутации берётся ТОЛЬКО из `metadata.createdAt` — ни из часов, ни из
 * `order.timestamp`, ни из `fill.timestamp`. Иначе replay той же ленты давал
 * бы другое состояние.
 */
import { describe, expect, it } from '@jest/globals';
import { OTHER_VENUE, VENUE, fill as makeFill, order, portfolio, ts, walletAccount } from './helpers/fixtures.js';
import { buildRuntime, publishOk } from './helpers/runtime.js';

describe('AK. глобальная и локальная версии', () => {
  it('каждая принятая мутация увеличивает обе ровно на единицу', async () => {
    const { bus, view, events } = buildRuntime();
    const a = walletAccount('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const b = walletAccount('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    events.observeAt(1_000);
    await publishOk(bus, events.initialized({ accountId: a, portfolio: portfolio({ accountId: a }) }));
    expect(view.getVersion()).toBe(1);
    expect(view.getAccount(VENUE, a)?.version).toBe(1);

    events.observeAt(1_100);
    await publishOk(bus, events.initialized({ accountId: b, portfolio: portfolio({ accountId: b }) }));
    expect(view.getVersion()).toBe(2);
    expect(view.getAccount(VENUE, a)?.version).toBe(1);
    expect(view.getAccount(VENUE, b)?.version).toBe(1);

    events.observeAt(2_000);
    await publishOk(
      bus,
      events.orderCommitted({
        accountId: a,
        order: order({ accountId: a }),
        portfolio: portfolio({ accountId: a }),
      }),
    );
    expect(view.getVersion()).toBe(3);
    expect(view.getAccount(VENUE, a)?.version).toBe(2);
    expect(view.getAccount(VENUE, b)?.version).toBe(1);

    events.observeAt(3_000);
    await publishOk(
      bus,
      events.fillApplied({ fill: makeFill({ accountId: a }), portfolio: portfolio({ accountId: a }) }),
    );
    expect(view.getVersion()).toBe(4);
    expect(view.getAccount(VENUE, a)?.version).toBe(3);
    expect(view.getAccount(VENUE, b)?.version).toBe(1);
  });

  it('версия одного аккаунта не растёт от мутаций другого', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();

    events.observeAt(1_000);
    await publishOk(bus, events.initialized({ accountId, portfolio: portfolio({ accountId }) }));
    events.observeAt(1_100);
    await publishOk(
      bus,
      events.initialized({
        venueId: OTHER_VENUE,
        accountId,
        portfolio: portfolio({ accountId, balanceVenueId: OTHER_VENUE }),
      }),
    );

    events.observeAt(2_000);
    await publishOk(
      bus,
      events.orderCommitted({
        accountId,
        order: order({ accountId }),
        portfolio: portfolio({ accountId }),
      }),
    );

    // Тот же кошелёк, но другая площадка — другой торговый аккаунт.
    expect(view.getAccount(VENUE, accountId)?.version).toBe(2);
    expect(view.getAccount(OTHER_VENUE, accountId)?.version).toBe(1);
    expect(view.getVersion()).toBe(3);
    expect(view.getAccount(OTHER_VENUE, accountId)?.lastMutationAt.equals(ts(1_100))).toBe(true);
  });
});

describe('AP. время мутации берётся из metadata.createdAt', () => {
  it('время заявки, время исполнения и время события — три разные величины', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    const ORDER_TIME = 1_700_000_000_000;
    const FILL_TIME = 1_700_000_111_111;
    const EVENT_TIME = 9_876_543;

    events.observeAt(1_000);
    await publishOk(bus, events.initialized({ accountId, portfolio: portfolio({ accountId }) }));

    events.observeAt(EVENT_TIME);
    const committed = order({ accountId, timestampMs: ORDER_TIME });
    await publishOk(
      bus,
      events.orderCommitted({ accountId, order: committed, portfolio: portfolio({ accountId }) }),
    );

    const applied = makeFill({ accountId, timestampMs: FILL_TIME });
    events.observeAt(EVENT_TIME + 1);
    await publishOk(bus, events.fillApplied({ fill: applied, portfolio: portfolio({ accountId }) }));

    const account = view.getAccount(VENUE, accountId);
    // Запись хранит ВРЕМЯ СОБЫТИЯ, а сама сущность — своё собственное.
    expect(account?.getOrder(committed.id)?.updatedAt.equals(ts(EVENT_TIME))).toBe(true);
    expect(account?.getOrder(committed.id)?.order.timestamp.equals(ts(ORDER_TIME))).toBe(true);
    expect(account?.getFill(applied.id)?.appliedAt.equals(ts(EVENT_TIME + 1))).toBe(true);
    expect(account?.getFill(applied.id)?.fill.timestamp.equals(ts(FILL_TIME))).toBe(true);
    expect(account?.lastMutationAt.equals(ts(EVENT_TIME + 1))).toBe(true);
  });

  it('время события, идущее вспять, не переписывается часами', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();

    events.observeAt(5_000);
    await publishOk(bus, events.initialized({ accountId, portfolio: portfolio({ accountId }) }));
    expect(view.getAccount(VENUE, accountId)?.lastMutationAt.equals(ts(5_000))).toBe(true);

    // Состояние не имеет часов и не «исправляет» время события: оно просто
    // берёт то, что в canonical envelope. Порядок доставки — забота шины.
    events.observeAt(4_000);
    await publishOk(
      bus,
      events.orderCommitted({
        accountId,
        order: order({ accountId }),
        portfolio: portfolio({ accountId }),
      }),
    );
    expect(view.getAccount(VENUE, accountId)?.lastMutationAt.equals(ts(4_000))).toBe(true);
  });
});
