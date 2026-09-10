/**
 * Вторая ось исполнения: что говорит ПЛОЩАДКА.
 *
 * @remarks
 * ```text
 * status       APPLIED → CONFIRMED | REVERTED   что сделали МЫ с деньгами
 * venueStatus  MATCHED → MINED → CONFIRMED      что говорит ПЛОЩАДКА
 *                     ↘ RETRYING ↘ FAILED
 * ```
 *
 * Оси независимы, и это не оформление: `MATCHED` — исполнение сматчил матчер
 * Polymarket, `MINED` — расчётная транзакция попала в блок Polygon. Разные
 * системы, разный риск отката.
 *
 * Ключевой тест здесь — «MINED и RETRYING доезжают до состояния»: до этого
 * события их нечем было доставить, и они терялись целиком.
 */
import { describe, expect, it } from '@jest/globals';
import type { TradeStatus } from '@polymarket/fill';
import {
  AccountFillIdentityConflictError,
  AccountFillNotFoundError,
  AccountFillVenueStatusRegressionError,
  AccountNotInitializedError,
  TERMINAL_VENUE_STATUSES,
} from '../src/index.js';
import {
  VENUE,
  fill as makeFill,
  must,
  order,
  portfolio,
  ts,
  walletAccount,
  withFill,
} from './helpers/fixtures.js';
import { buildRuntime, publishErr, publishOk } from './helpers/runtime.js';
import type { AccountRuntime } from './helpers/runtime.js';

/** Рантайм с инициализированным аккаунтом и одним применённым исполнением. */
async function withAppliedFill(): Promise<
  AccountRuntime & { accountId: ReturnType<typeof walletAccount>; fillId: string }
> {
  const runtime = buildRuntime();
  const accountId = walletAccount();
  runtime.events.observeAt(1_000);
  await publishOk(
    runtime.bus,
    runtime.events.initialized({ accountId, portfolio: portfolio({ accountId }) }),
  );

  const fill = makeFill({ accountId });
  runtime.events.observeAt(2_000);
  await publishOk(
    runtime.bus,
    runtime.events.fillApplied({ fill, portfolio: portfolio({ accountId, available: 9_974 }) }),
  );
  return { ...runtime, accountId, fillId: fill.id };
}

describe('venue-ось доезжает до состояния', () => {
  it('до наблюдения venueStatus не задан — это норма, а не пропуск', async () => {
    const { view, accountId, fillId } = await withAppliedFill();
    const record = view.getAccount(VENUE, accountId)?.getFill(fillId as never);

    expect(record?.status).toBe('APPLIED');
    expect(record?.venueStatus).toBeUndefined();
    expect(record?.venueStatusAt).toBeUndefined();
  });

  it.each<TradeStatus>(['MATCHED', 'MINED', 'CONFIRMED', 'RETRYING', 'FAILED'])(
    'статус %s записывается вместе со временем наблюдения',
    async (venueStatus) => {
      const { bus, view, events, accountId, fillId } = await withAppliedFill();
      events.observeAt(3_000);

      await publishOk(bus, events.fillVenueStatus({ fill: makeFill({ accountId }), venueStatus }));

      const record = view.getAccount(VENUE, accountId)?.getFill(fillId as never);
      expect(record?.venueStatus).toBe(venueStatus);
      expect(record?.venueStatusAt?.equals(ts(3_000))).toBe(true);
    },
  );

  it('MINED и RETRYING не имеют экономических двойников — только это событие их и доставляет', async () => {
    const { bus, view, events, accountId, fillId } = await withAppliedFill();
    const account = () => view.getAccount(VENUE, accountId);
    const portfolioBefore = account()?.portfolio;

    events.observeAt(3_000);
    await publishOk(
      bus,
      events.fillVenueStatus({ fill: makeFill({ accountId }), venueStatus: 'MINED' }),
    );
    events.observeAt(3_500);
    await publishOk(
      bus,
      events.fillVenueStatus({ fill: makeFill({ accountId }), venueStatus: 'RETRYING' }),
    );

    const record = account()?.getFill(fillId as never);
    expect(record?.venueStatus).toBe('RETRYING');
    // Экономика не тронута: обе оси независимы.
    expect(account()?.portfolio).toBe(portfolioBefore);
    expect(record?.status).toBe('APPLIED');
    expect(record?.appliedAt.equals(ts(2_000))).toBe(true);
  });

  it('обе оси движутся независимо и не затирают друг друга', async () => {
    const { bus, view, events, accountId, fillId } = await withAppliedFill();

    events.observeAt(3_000);
    await publishOk(
      bus,
      events.fillVenueStatus({ fill: makeFill({ accountId }), venueStatus: 'MINED' }),
    );
    events.observeAt(4_000);
    await publishOk(bus, events.fillConfirmed({ fill: makeFill({ accountId }) }));

    const record = view.getAccount(VENUE, accountId)?.getFill(fillId as never);
    // Наш статус — CONFIRMED, статус площадки остался MINED: подтверждение
    // финальности НАШИМ рантаймом не переписывает наблюдение площадки.
    expect(record?.status).toBe('CONFIRMED');
    expect(record?.confirmedAt?.equals(ts(4_000))).toBe(true);
    expect(record?.venueStatus).toBe('MINED');
    expect(record?.venueStatusAt?.equals(ts(3_000))).toBe(true);
  });

  it('наблюдение — принятая мутация: обе версии растут на единицу', async () => {
    const { bus, view, events, accountId } = await withAppliedFill();
    const before = view.getAccount(VENUE, accountId)?.version;
    const globalBefore = view.getVersion();

    events.observeAt(3_000);
    await publishOk(
      bus,
      events.fillVenueStatus({ fill: makeFill({ accountId }), venueStatus: 'MINED' }),
    );

    expect(view.getAccount(VENUE, accountId)?.version).toBe((before ?? 0) + 1);
    expect(view.getVersion()).toBe(globalBefore + 1);
    expect(view.getAccount(VENUE, accountId)?.lastMutationAt.equals(ts(3_000))).toBe(true);
  });
});

describe('порядок наблюдений и терминальность', () => {
  it('повтор того же статуса — no-op', async () => {
    const { bus, view, events, accountId, fillId } = await withAppliedFill();
    events.observeAt(3_000);
    await publishOk(
      bus,
      events.fillVenueStatus({ fill: makeFill({ accountId }), venueStatus: 'MINED' }),
    );
    const version = view.getAccount(VENUE, accountId)?.version;

    events.observeAt(4_000);
    await publishOk(
      bus,
      events.fillVenueStatus({ fill: makeFill({ accountId }), venueStatus: 'MINED' }),
    );

    const record = view.getAccount(VENUE, accountId)?.getFill(fillId as never);
    expect(record?.venueStatusAt?.equals(ts(3_000))).toBe(true);
    expect(view.getAccount(VENUE, accountId)?.version).toBe(version);
  });

  it('нетерминальные переходы принимаются в любом порядке', async () => {
    const { bus, view, events, accountId, fillId } = await withAppliedFill();

    // Доставка может переставить наблюдения местами; жёсткий FSM отверг бы
    // законное наблюдение, пришедшее не по порядку.
    events.observeAt(3_000);
    await publishOk(
      bus,
      events.fillVenueStatus({ fill: makeFill({ accountId }), venueStatus: 'MINED' }),
    );
    events.observeAt(3_500);
    await publishOk(
      bus,
      events.fillVenueStatus({ fill: makeFill({ accountId }), venueStatus: 'MATCHED' }),
    );

    expect(view.getAccount(VENUE, accountId)?.getFill(fillId as never)?.venueStatus).toBe('MATCHED');
  });

  it('терминальными считаются ровно CONFIRMED и FAILED', () => {
    expect([...TERMINAL_VENUE_STATUSES].sort()).toEqual(['CONFIRMED', 'FAILED']);
  });

  it.each<[TradeStatus, TradeStatus]>([
    ['CONFIRMED', 'MINED'],
    ['CONFIRMED', 'FAILED'],
    ['FAILED', 'MATCHED'],
    ['FAILED', 'CONFIRMED'],
  ])('уход с терминального %s → %s отвергается', async (terminal, incoming) => {
    const { bus, view, events, accountId, fillId } = await withAppliedFill();
    events.observeAt(3_000);
    await publishOk(
      bus,
      events.fillVenueStatus({ fill: makeFill({ accountId }), venueStatus: terminal }),
    );
    const version = view.getAccount(VENUE, accountId)?.version;

    events.observeAt(4_000);
    const error = await publishErr(
      bus,
      events.fillVenueStatus({ fill: makeFill({ accountId }), venueStatus: incoming }),
    );

    expect(error).toBeInstanceOf(AccountFillVenueStatusRegressionError);
    expect((error as AccountFillVenueStatusRegressionError).current).toBe(terminal);
    expect((error as AccountFillVenueStatusRegressionError).incoming).toBe(incoming);
    const record = view.getAccount(VENUE, accountId)?.getFill(fillId as never);
    expect(record?.venueStatus).toBe(terminal);
    expect(record?.venueStatusAt?.equals(ts(3_000))).toBe(true);
    expect(view.getAccount(VENUE, accountId)?.version).toBe(version);
  });
});

describe('валидация наблюдения', () => {
  it('наблюдение по неизвестному аккаунту отвергается', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    events.observeAt(1_000);

    const error = await publishErr(
      bus,
      events.fillVenueStatus({ fill: makeFill({ accountId }), venueStatus: 'MINED' }),
    );

    expect(error).toBeInstanceOf(AccountNotInitializedError);
    expect((error as AccountNotInitializedError).action).toBe('FILL_VENUE_STATUS_OBSERVED');
    expect(view.getVersion()).toBe(0);
  });

  it('наблюдение по неизвестному исполнению не создаёт запись', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    events.observeAt(1_000);
    await publishOk(bus, events.initialized({ accountId, portfolio: portfolio({ accountId }) }));

    events.observeAt(2_000);
    const error = await publishErr(
      bus,
      events.fillVenueStatus({ fill: makeFill({ accountId }), venueStatus: 'MINED' }),
    );

    expect(error).toBeInstanceOf(AccountFillNotFoundError);
    expect((error as AccountFillNotFoundError).action).toBe('OBSERVE_VENUE_STATUS');
    expect(view.getAccount(VENUE, accountId)?.fills()).toHaveLength(0);
    expect(view.getVersion()).toBe(1);
  });

  it('наблюдение с другим фактом при том же FillId — конфликт', async () => {
    const { bus, view, events, accountId, fillId } = await withAppliedFill();
    events.observeAt(3_000);

    const error = await publishErr(
      bus,
      events.fillVenueStatus({ fill: makeFill({ accountId, price: 0.9 }), venueStatus: 'MINED' }),
    );

    expect(error).toBeInstanceOf(AccountFillIdentityConflictError);
    expect((error as AccountFillIdentityConflictError).action).toBe('OBSERVE_VENUE_STATUS');
    expect((error as AccountFillIdentityConflictError).difference.field).toBe('price');
    expect(view.getAccount(VENUE, accountId)?.getFill(fillId as never)?.venueStatus).toBeUndefined();
  });

  it('откат по-прежнему возможен из APPLIED при любом нетерминальном venue-статусе', async () => {
    const { bus, view, events, accountId, fillId } = await withAppliedFill();
    const open = must(order({ accountId }).accept());

    events.observeAt(3_000);
    await publishOk(
      bus,
      events.fillVenueStatus({ fill: makeFill({ accountId }), venueStatus: 'RETRYING' }),
    );
    events.observeAt(4_000);
    await publishOk(
      bus,
      events.fillReverted({
        fill: makeFill({ accountId }),
        portfolio: portfolio({ accountId, available: 10_000 }),
        order: withFill(open, { size: 40 }),
        reason: 'venue reported FAILED after retries',
      }),
    );

    const record = view.getAccount(VENUE, accountId)?.getFill(fillId as never);
    // Наш статус — REVERTED; статус площадки остался RETRYING, потому что
    // FAILED отдельным наблюдением не приезжал. Оси не синхронизируются.
    expect(record?.status).toBe('REVERTED');
    expect(record?.venueStatus).toBe('RETRYING');
  });
});
