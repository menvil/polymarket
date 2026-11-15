/**
 * Валюта денежного collateral аккаунта: принимается pUSD, подмены нет.
 *
 * @remarks
 * Polymarket CLOB V2 рассчитывается в pUSD, и приватное состояние обязано
 * принимать такой портфель так же, как USDC. Но валюта у аккаунта одна:
 * её задаёт портфель инициализации, и ни заявка, ни исполнение, ни сверка не
 * вправе молча заменить pUSD на USDC (или наоборот). Исполнение,
 * рассчитанное в чужой валюте, не может честно дать портфель события —
 * такое событие отвергается целиком, состояние не меняется.
 */
import { describe, expect, it } from '@jest/globals';
import { AssetIdHelpers } from '@polymarket/ids';
import { AccountPortfolioIdentityMismatchError } from '../src/index.js';
import { VENUE, fill as makeFill, must, order, portfolio, walletAccount, withFill } from './helpers/fixtures.js';
import { buildRuntime, publishErr, publishOk } from './helpers/runtime.js';

/** Рантайм с аккаунтом, инициализированным портфелем pUSD. */
async function pusdAccount() {
  const runtime = buildRuntime();
  const accountId = walletAccount();
  runtime.events.observeAt(1_000);
  await publishOk(runtime.bus, runtime.events.initialized({ accountId, portfolio: portfolio({ accountId, currency: 'pUSD' }) }));
  return { ...runtime, accountId };
}

/** Исполнение, рассчитанное в pUSD (как его даёт FillMapper для Polymarket CLOB V2). */
function pusdFill(accountId: ReturnType<typeof walletAccount>, overrides: { id?: string; orderId?: string } = {}) {
  return makeFill({ accountId, settlementAssetId: AssetIdHelpers.PUSD, feeAsset: AssetIdHelpers.PUSD, fee: 0.5, ...overrides });
}

describe('pUSD-портфель принимается приватным состоянием', () => {
  it('инициализация, заявка и исполнение в pUSD', async () => {
    const { bus, view, events, accountId } = await pusdAccount();
    expect(view.getAccount(VENUE, accountId)?.portfolio.balance.currency()).toBe('pUSD');

    const open = must(order({ id: 'order-1', accountId }).accept());
    events.observeAt(2_000);
    await publishOk(bus, events.orderCommitted({ accountId, order: open, portfolio: portfolio({ accountId, currency: 'pUSD', available: 9_350, reserved: 650 }) }));

    const fill = pusdFill(accountId, { id: 'fill-1', orderId: 'order-1' });
    const after = portfolio({ accountId, currency: 'pUSD', available: 9_349.5, reserved: 390 });
    events.observeAt(3_000);
    await publishOk(bus, events.fillApplied({ fill, order: withFill(open, { id: 'fill-1', size: 40 }), portfolio: after }));

    const account = view.getAccount(VENUE, accountId);
    expect(account?.portfolio).toBe(after);
    expect(account?.portfolio.balance.currency()).toBe('pUSD');
    expect(account?.getFill(fill.id)?.status).toBe('APPLIED');
  });

  it('прежний USDC-аккаунт с USDC-исполнением работает как раньше', async () => {
    const runtime = buildRuntime();
    const accountId = walletAccount();
    runtime.events.observeAt(1_000);
    await publishOk(runtime.bus, runtime.events.initialized({ accountId, portfolio: portfolio({ accountId }) }));
    runtime.events.observeAt(2_000);
    await publishOk(runtime.bus, runtime.events.fillApplied({ fill: makeFill({ accountId }), portfolio: portfolio({ accountId, available: 9_974 }) }));
    expect(runtime.view.getAccount(VENUE, accountId)?.portfolio.balance.currency()).toBe('USDC');
  });
});

describe('валюта аккаунта не подменяется', () => {
  it('исполнение в USDC при портфеле pUSD → отказ, состояние не изменено', async () => {
    const { bus, view, events, accountId } = await pusdAccount();
    const before = view.getAccount(VENUE, accountId);
    const versionBefore = before?.version;

    events.observeAt(2_000);
    const error = await publishErr(bus, events.fillApplied({ fill: makeFill({ accountId }), portfolio: portfolio({ accountId, currency: 'pUSD', available: 9_974 }) }));

    expect(error).toBeInstanceOf(AccountPortfolioIdentityMismatchError);
    expect(error).toMatchObject({ field: 'balanceCurrency', expected: 'USDC', actual: 'pUSD' });
    const account = view.getAccount(VENUE, accountId);
    expect(account?.version).toBe(versionBefore);
    expect(account?.portfolio.balance.available().value().toNumber()).toBe(10_000);
    expect(account?.getFill(makeFill({ accountId }).id)).toBeUndefined();
  });

  it('портфель USDC в событии исполнения pUSD-аккаунта → отказ (смена валюты)', async () => {
    const { bus, view, events, accountId } = await pusdAccount();
    events.observeAt(2_000);
    const error = await publishErr(bus, events.fillApplied({ fill: makeFill({ accountId }), portfolio: portfolio({ accountId, available: 9_974 }) }));
    expect(error).toMatchObject({ field: 'balanceCurrency', expected: 'pUSD', actual: 'USDC' });
    expect(view.getAccount(VENUE, accountId)?.portfolio.balance.currency()).toBe('pUSD');
  });

  it('заявка с портфелем USDC у pUSD-аккаунта → отказ', async () => {
    const { bus, view, events, accountId } = await pusdAccount();
    const open = must(order({ id: 'order-1', accountId }).accept());
    events.observeAt(2_000);
    const error = await publishErr(bus, events.orderCommitted({ accountId, order: open, portfolio: portfolio({ accountId, available: 9_350, reserved: 650 }) }));
    expect(error).toMatchObject({ field: 'balanceCurrency', expected: 'pUSD', actual: 'USDC' });
    expect(view.getAccount(VENUE, accountId)?.orders()).toHaveLength(0);
  });

  it('сверка не меняет валюту: снимок USDC для pUSD-аккаунта → отказ, НОЛЬ мутаций', async () => {
    const { bus, view, events, accountId } = await pusdAccount();
    const version = view.getAccount(VENUE, accountId)?.version ?? -1;
    events.observeAt(2_000);
    const error = await publishErr(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: version, portfolio: portfolio({ accountId, available: 10_000 }) }),
    );
    expect(error).toMatchObject({ field: 'balanceCurrency', expected: 'pUSD', actual: 'USDC' });
    const account = view.getAccount(VENUE, accountId);
    expect(account?.version).toBe(version);
    expect(account?.portfolio.balance.currency()).toBe('pUSD');
  });

  it('сверка с новым USDC-исполнением у pUSD-аккаунта → отказ, НОЛЬ мутаций', async () => {
    // Портфель коррекции в pUSD проходит проверку валюты, но исполнение
    // рассчитано в USDC: через сверку оно не может войти как CONFIRMED.
    const { bus, view, events, accountId } = await pusdAccount();
    const before = view.getAccount(VENUE, accountId);
    const version = before?.version ?? -1;
    const usdcFill = makeFill({ accountId, id: 'fill-usdc' });
    const okFill = pusdFill(accountId, { id: 'fill-pusd' });
    events.observeAt(2_000);

    const error = await publishErr(
      bus,
      events.reconciled({
        accountId,
        expectedAccountVersion: version,
        portfolio: portfolio({ accountId, currency: 'pUSD', available: 8_000 }),
        fills: [okFill, usdcFill],
      }),
    );

    expect(error).toBeInstanceOf(AccountPortfolioIdentityMismatchError);
    expect(error).toMatchObject({ field: 'balanceCurrency', expected: 'USDC', actual: 'pUSD' });
    const account = view.getAccount(VENUE, accountId);
    expect(account?.version).toBe(version);
    expect(account?.portfolio).toBe(before?.portfolio);
    expect(account?.getFill(okFill.id)).toBeUndefined();
    expect(account?.getFill(usdcFill.id)).toBeUndefined();
  });

  it('сверка в той же валюте применяется', async () => {
    const { bus, view, events, accountId } = await pusdAccount();
    const version = view.getAccount(VENUE, accountId)?.version ?? -1;
    events.observeAt(2_000);
    await publishOk(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: version, portfolio: portfolio({ accountId, currency: 'pUSD', available: 8_000 }) }),
    );
    expect(view.getAccount(VENUE, accountId)?.portfolio.balance.available().value().toNumber()).toBe(8_000);
  });

  it('сверка с pUSD-исполнением у pUSD-аккаунта применяется как CONFIRMED', async () => {
    const { bus, view, events, accountId } = await pusdAccount();
    const version = view.getAccount(VENUE, accountId)?.version ?? -1;
    const fill = pusdFill(accountId, { id: 'fill-pusd' });
    events.observeAt(2_000);
    await publishOk(
      bus,
      events.reconciled({ accountId, expectedAccountVersion: version, portfolio: portfolio({ accountId, currency: 'pUSD', available: 8_000 }), fills: [fill] }),
    );
    expect(view.getAccount(VENUE, accountId)?.getFill(fill.id)?.status).toBe('CONFIRMED');
  });
});
