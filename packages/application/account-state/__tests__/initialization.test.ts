/**
 * Инициализация торгового аккаунта — единственный способ создать его состояние.
 *
 * @remarks
 * Метки `A`…`H` соответствуют плану MR. Проверяется: создание аккаунта,
 * запрет повторной инициализации, ключевание по canonical-строке (а не по
 * ссылке на объект), изоляция площадок и все три места, где идентичность
 * портфеля обязана совпасть с идентичностью аккаунта.
 */
import { describe, expect, it } from '@jest/globals';
import {
  AccountAlreadyInitializedError,
  AccountIdentityMismatchError,
  AccountPortfolioIdentityMismatchError,
} from '../src/index.js';
import {
  OTHER_VENUE,
  VENUE,
  portfolio,
  ts,
  venueAccount,
  venueSubaccount,
  walletAccount,
} from './helpers/fixtures.js';
import { buildRuntime, publishErr, publishOk } from './helpers/runtime.js';

describe('A. инициализация создаёт состояние аккаунта', () => {
  it('аккаунт появляется с версией 1 и временем события', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    const owned = portfolio({ accountId, available: 7_500 });
    events.observeAt(1_000);

    await publishOk(bus, events.initialized({ accountId, portfolio: owned }));

    const account = view.getAccount(VENUE, accountId);
    expect(account).toBeDefined();
    expect(account?.venueId).toBe(VENUE);
    expect(account?.accountId).toBe(accountId);
    // Портфель кладётся тем же экземпляром: он immutable, копировать нечего.
    expect(account?.portfolio).toBe(owned);
    expect(account?.portfolio.balance.available().value().toNumber()).toBe(7_500);
    expect(account?.version).toBe(1);
    expect(view.getVersion()).toBe(1);
    expect(account?.lastMutationAt.equals(ts(1_000))).toBe(true);
    expect(view.accountIdentities()).toEqual([{ venueId: VENUE, accountId }]);
  });

  it('до инициализации аккаунта нет, а версия равна нулю', () => {
    const { view } = buildRuntime();
    expect(view.getAccount(VENUE, walletAccount())).toBeUndefined();
    expect(view.getVersion()).toBe(0);
    expect(view.accountIdentities()).toEqual([]);
  });
});

describe('B. повторная инициализация — ошибка lifecycle, а не идемпотентность', () => {
  it('второй INITIALIZED отвергается и ничего не меняет', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    events.observeAt(1_000);
    await publishOk(
      bus,
      events.initialized({ accountId, portfolio: portfolio({ accountId, available: 10_000 }) }),
    );

    events.observeAt(2_000);
    const error = await publishErr(
      bus,
      // Другой портфель: если бы повтор молча применялся, баланс сменился бы.
      events.initialized({ accountId, portfolio: portfolio({ accountId, available: 1 }) }),
    );

    expect(error).toBeInstanceOf(AccountAlreadyInitializedError);
    const account = view.getAccount(VENUE, accountId);
    expect(account?.portfolio.balance.available().value().toNumber()).toBe(10_000);
    expect(account?.version).toBe(1);
    expect(view.getVersion()).toBe(1);
    expect(account?.lastMutationAt.equals(ts(1_000))).toBe(true);
  });
});

describe('C. эквивалентные AccountId находят один аккаунт', () => {
  it('поиск другим объектом с той же canonical-идентичностью попадает в тот же аккаунт', async () => {
    const { bus, view, events } = buildRuntime();
    const created = walletAccount();
    const lookup = walletAccount();

    // Доказательство, что это РАЗНЫЕ объекты: иначе тест ничего не проверял бы.
    expect(lookup).not.toBe(created);

    events.observeAt(1_000);
    await publishOk(
      bus,
      events.initialized({ accountId: created, portfolio: portfolio({ accountId: created }) }),
    );

    expect(view.getAccount(VENUE, lookup)).toBe(view.getAccount(VENUE, created));
  });

  it('регистр hex-адреса не создаёт второй аккаунт', async () => {
    const { bus, view, events } = buildRuntime();
    const lower = walletAccount('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    const upper = walletAccount('0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD');

    events.observeAt(1_000);
    await publishOk(
      bus,
      events.initialized({ accountId: lower, portfolio: portfolio({ accountId: lower }) }),
    );

    expect(view.getAccount(VENUE, upper)).toBeDefined();
    expect(view.accountIdentities()).toHaveLength(1);
  });
});

describe('D. площадки не склеиваются', () => {
  it('один и тот же кошелёк на двух площадках — два аккаунта', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();

    events.observeAt(1_000);
    await publishOk(
      bus,
      events.initialized({
        venueId: VENUE,
        accountId,
        portfolio: portfolio({ accountId, available: 10_000 }),
      }),
    );

    events.observeAt(2_000);
    await publishOk(
      bus,
      events.initialized({
        venueId: OTHER_VENUE,
        accountId,
        portfolio: portfolio({ accountId, balanceVenueId: OTHER_VENUE, available: 250 }),
      }),
    );

    expect(view.getAccount(VENUE, accountId)?.portfolio.balance.available().value().toNumber()).toBe(
      10_000,
    );
    expect(
      view.getAccount(OTHER_VENUE, accountId)?.portfolio.balance.available().value().toNumber(),
    ).toBe(250);
    expect(view.accountIdentities()).toHaveLength(2);
    // Инициализация каждого аккаунта — своя мутация: глобально их две.
    expect(view.getVersion()).toBe(2);
    expect(view.getAccount(VENUE, accountId)?.version).toBe(1);
    expect(view.getAccount(OTHER_VENUE, accountId)?.version).toBe(1);
  });
});

describe('E–G. идентичность портфеля обязана совпасть с идентичностью аккаунта', () => {
  it('E. portfolio.accountId чужой — отказ', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    const stranger = walletAccount('0x9999999999999999999999999999999999999999');
    events.observeAt(1_000);

    const error = await publishErr(
      bus,
      events.initialized({ accountId, portfolio: portfolio({ accountId: stranger }) }),
    );

    expect(error).toBeInstanceOf(AccountPortfolioIdentityMismatchError);
    expect((error as AccountPortfolioIdentityMismatchError).field).toBe('accountId');
    expect(view.getAccount(VENUE, accountId)).toBeUndefined();
    expect(view.getVersion()).toBe(0);
  });

  it('F. владелец агрегата верный, а владелец баланса — нет', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    const stranger = walletAccount('0x9999999999999999999999999999999999999999');
    events.observeAt(1_000);

    const error = await publishErr(
      bus,
      events.initialized({
        accountId,
        portfolio: portfolio({ accountId, balanceAccountId: stranger }),
      }),
    );

    expect(error).toBeInstanceOf(AccountPortfolioIdentityMismatchError);
    expect((error as AccountPortfolioIdentityMismatchError).field).toBe('balanceAccountId');
    expect(view.getAccount(VENUE, accountId)).toBeUndefined();
    expect(view.getVersion()).toBe(0);
  });

  it('G. площадка баланса не совпадает с площадкой аккаунта', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    events.observeAt(1_000);

    const error = await publishErr(
      bus,
      events.initialized({
        venueId: VENUE,
        accountId,
        portfolio: portfolio({ accountId, balanceVenueId: OTHER_VENUE }),
      }),
    );

    expect(error).toBeInstanceOf(AccountPortfolioIdentityMismatchError);
    expect((error as AccountPortfolioIdentityMismatchError).field).toBe('balanceVenueId');
    expect(view.getAccount(VENUE, accountId)).toBeUndefined();
    expect(view.getVersion()).toBe(0);
  });
});

describe('H. venue-bound AccountId сверяется с площадкой payload', () => {
  it('VENUE-аккаунт чужой площадки отвергается', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = venueAccount(OTHER_VENUE, 'user-1');
    events.observeAt(1_000);

    const error = await publishErr(
      bus,
      events.initialized({
        venueId: VENUE,
        accountId,
        portfolio: portfolio({ accountId, balanceVenueId: VENUE }),
      }),
    );

    expect(error).toBeInstanceOf(AccountIdentityMismatchError);
    expect((error as AccountIdentityMismatchError).subject).toBe('VENUE_BOUND_ACCOUNT');
    expect(view.getVersion()).toBe(0);
  });

  it('SUBACCOUNT наследует площадку корня и тоже сверяется', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = venueSubaccount(OTHER_VENUE, 'trading');
    events.observeAt(1_000);

    const error = await publishErr(
      bus,
      events.initialized({
        venueId: VENUE,
        accountId,
        portfolio: portfolio({ accountId, balanceVenueId: VENUE }),
      }),
    );

    expect(error).toBeInstanceOf(AccountIdentityMismatchError);
    expect((error as AccountIdentityMismatchError).subject).toBe('VENUE_BOUND_ACCOUNT');
    expect(view.getVersion()).toBe(0);
  });

  it('совпавшая встроенная площадка проходит — и для VENUE, и для SUBACCOUNT', async () => {
    const { bus, view, events } = buildRuntime();
    const direct = venueAccount(VENUE, 'user-1');
    const sub = venueSubaccount(VENUE, 'trading');

    events.observeAt(1_000);
    await publishOk(
      bus,
      events.initialized({ accountId: direct, portfolio: portfolio({ accountId: direct }) }),
    );
    events.observeAt(2_000);
    await publishOk(
      bus,
      events.initialized({ accountId: sub, portfolio: portfolio({ accountId: sub }) }),
    );

    expect(view.getAccount(VENUE, direct)).toBeDefined();
    expect(view.getAccount(VENUE, sub)).toBeDefined();
    expect(view.getVersion()).toBe(2);
  });

  it('WALLET-аккаунт не отвергается за отсутствие встроенной площадки', async () => {
    const { bus, view, events } = buildRuntime();
    const accountId = walletAccount();
    events.observeAt(1_000);

    // Один и тот же кошелёк торгует на нескольких площадках — venue ему
    // задаёт payload, и требовать embedded venue было бы неверно.
    await publishOk(
      bus,
      events.initialized({
        venueId: OTHER_VENUE,
        accountId,
        portfolio: portfolio({ accountId, balanceVenueId: OTHER_VENUE }),
      }),
    );

    expect(view.getAccount(OTHER_VENUE, accountId)).toBeDefined();
    expect(view.getVersion()).toBe(1);
  });
});
