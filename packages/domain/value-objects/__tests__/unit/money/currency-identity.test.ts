/**
 * Валюта денег — идентичность токена: pUSD и USDC не смешиваются.
 *
 * @remarks
 * `pUSD` (Polymarket USD, collateral Polymarket CLOB V2) добавлен в
 * `SUPPORTED_CURRENCIES` как ОТДЕЛЬНАЯ валюта. Обе валюты номинированы в
 * долларах, но `Money(100, 'pUSD')` не означает владения 100 USDC: курса нет,
 * а арифметика, сравнения и операции баланса разных валют — отказ, а не
 * неявное приведение. Сериализация сохраняет валюту как есть.
 */
import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { AssetIdHelpers, KnownCurrencies, asSupportedCurrency, assetIdToString, currencyEquals, isSupportedCurrency, normalizeCurrency, parseAssetId } from '@polymarket/ids';
import { Money } from '../../../src/money/core/Money.js';
import { MoneyService } from '../../../src/money/facade/MoneyService.js';
import { MoneySerializer } from '../../../src/money/adapters/MoneySerializer.js';
import { BalanceService } from '../../../src/balance/facade/BalanceService.js';
import { BalanceSerializer } from '../../../src/balance/adapters/BalanceSerializer.js';
import type { Balance } from '../../../src/balance/core/Balance.js';
import { TEST_ACCOUNT_ID, TEST_VENUE_ID } from '../../helpers/balanceTestHelpers.js';

/** Деньги из строки в заданной валюте (падает, если тест сам собрал неверное). */
function money(amount: string, currency: 'USDC' | 'pUSD'): Money {
  const result = MoneyService.create(amount, currency);
  if (!result.ok) throw result.error;
  return result.value;
}

/** Баланс available/reserved в одной валюте. */
function balance(available: string, reserved: string, currency: 'USDC' | 'pUSD'): Balance {
  const result = BalanceService.create(money(available, currency), money(reserved, currency), TEST_ACCOUNT_ID, TEST_VENUE_ID);
  if (!result.ok) throw result.error;
  return result.value;
}

/** Снимок баланса для проверки «состояние не изменилось». */
function amounts(b: Balance): [string, string, string] {
  return [b.available().value().toString(), b.reserved().value().toString(), b.currency()];
}

describe('валюта pUSD: поддержка и каноническое написание', () => {
  it('pUSD и USDC — обе поддерживаемые валюты; написание каноническое при разборе', () => {
    expect(isSupportedCurrency('pUSD')).toBe(true);
    expect(isSupportedCurrency('USDC')).toBe(true);
    expect(isSupportedCurrency('PUSD')).toBe(false);
    expect(KnownCurrencies.pUSD).toBe('pUSD');
  });

  it('терпимый ввод приводится к каноническому написанию, а не к другой валюте', () => {
    expect(asSupportedCurrency('PUSD')).toBe('pUSD');
    expect(asSupportedCurrency(' pusd ')).toBe('pUSD');
    expect(asSupportedCurrency('usdc')).toBe('USDC');
    expect(normalizeCurrency('PUSD')).toBe('pUSD');
    expect(normalizeCurrency('eur')).toBe('EUR');
    expect(currencyEquals('pUSD', 'PUSD')).toBe(true);
    expect(currencyEquals('pUSD', 'USDC')).toBe(false);
  });

  it('CURRENCY:pUSD — отдельный актив, разбирается и печатается без потерь', () => {
    expect(assetIdToString(AssetIdHelpers.PUSD)).toBe('CURRENCY:pUSD');
    expect(AssetIdHelpers.equals(AssetIdHelpers.PUSD, AssetIdHelpers.USDC)).toBe(false);
    const parsed = parseAssetId('CURRENCY:pUSD');
    expect(parsed).toBeDefined();
    expect(AssetIdHelpers.equals(parsed!, AssetIdHelpers.PUSD)).toBe(true);
    expect(parseAssetId('CURRENCY:PUSD')).toBeUndefined();
  });
});

describe('Money: pUSD создаётся, USDC работает как раньше', () => {
  it('Money.of / MoneyService.create в pUSD', () => {
    const viaCore = Money.of(new Decimal(100), 'pUSD');
    expect(viaCore.currency()).toBe('pUSD');
    expect(money('100', 'pUSD').currency()).toBe('pUSD');
    expect(Money.ZERO.pUSD.currency()).toBe('pUSD');
    expect(Money.ZERO.pUSD.isZero()).toBe(true);
  });

  it('USDC продолжает работать, в том числе как историческое умолчание', () => {
    expect(money('100', 'USDC').currency()).toBe('USDC');
    const byDefault = MoneyService.create('100');
    expect(byDefault.ok && byDefault.value.currency()).toBe('USDC');
  });

  it('100 pUSD и 100 USDC — разные величины: не равны и несравнимы', () => {
    const pusd = money('100', 'pUSD');
    const usdc = money('100', 'USDC');
    expect(pusd.hasSameCurrency(usdc)).toBe(false);
    expect(MoneyService.equals(pusd, usdc).ok).toBe(false);
  });
});

describe('Money: операции в одной валюте работают, смешение — отказ', () => {
  it('100 pUSD + 20 pUSD = 120 pUSD; 100 USDC + 20 USDC = 120 USDC', () => {
    const pusd = MoneyService.add(money('100', 'pUSD'), money('20', 'pUSD'));
    const usdc = MoneyService.add(money('100', 'USDC'), money('20', 'USDC'));
    expect(pusd.ok && [pusd.value.value().toString(), pusd.value.currency()]).toEqual(['120', 'pUSD']);
    expect(usdc.ok && [usdc.value.value().toString(), usdc.value.currency()]).toEqual(['120', 'USDC']);
  });

  it('100 pUSD − 20 pUSD = 80 pUSD', () => {
    const diff = MoneyService.subtract(money('100', 'pUSD'), money('20', 'pUSD'));
    expect(diff.ok && [diff.value.value().toString(), diff.value.currency()]).toEqual(['80', 'pUSD']);
  });

  it.each<[string, () => { ok: boolean }]>([
    ['add pUSD + USDC', () => MoneyService.add(money('100', 'pUSD'), money('20', 'USDC'))],
    ['add USDC + pUSD', () => MoneyService.add(money('100', 'USDC'), money('20', 'pUSD'))],
    ['subtract pUSD − USDC', () => MoneyService.subtract(money('100', 'pUSD'), money('20', 'USDC'))],
    ['isLessThan', () => MoneyService.isLessThan(money('100', 'pUSD'), money('20', 'USDC'))],
    ['isLessThanOrEqual', () => MoneyService.isLessThanOrEqual(money('100', 'pUSD'), money('20', 'USDC'))],
    ['isGreaterThan', () => MoneyService.isGreaterThan(money('100', 'pUSD'), money('20', 'USDC'))],
    ['isGreaterThanOrEqual', () => MoneyService.isGreaterThanOrEqual(money('100', 'pUSD'), money('20', 'USDC'))],
    ['equals', () => MoneyService.equals(money('100', 'pUSD'), money('100', 'USDC'))],
  ])('%s → Err (нет неявного приведения)', (_label, run) => {
    expect(run().ok).toBe(false);
  });

  it('отказ смешения — CURRENCY_MISMATCH, обе валюты в контексте ошибки', () => {
    const mixed = MoneyService.add(money('100', 'pUSD'), money('20', 'USDC'));
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) {
      expect(mixed.error.message).toContain('different currencies');
      const context = JSON.stringify(mixed.error.context);
      expect(context).toContain('CURRENCY_MISMATCH');
      expect(context).toContain('"pUSD"');
      expect(context).toContain('"USDC"');
    }
  });
});

describe('Money: сериализация сохраняет валюту', () => {
  it.each<'USDC' | 'pUSD'>(['USDC', 'pUSD'])('%s → JSON → %s', (currency) => {
    const json = MoneySerializer.toJSON(money('12.345678', currency));
    expect(json.currency).toBe(currency);
    const restored = MoneySerializer.fromJSON(json);
    expect(restored.ok && [restored.value.value().toString(), restored.value.currency()]).toEqual(['12.345678', currency]);
  });

  it.each(['EUR', 'PUSD', 'usdc', ''])('неизвестная валюта %p → Err, без подстановки', (currency) => {
    expect(MoneySerializer.fromJSON({ amount: '1', currency }).ok).toBe(false);
  });
});

describe('Balance: pUSD available/reserved и операции только в своей валюте', () => {
  it('available и reserved в pUSD; смешанные валюты не собираются', () => {
    const b = balance('100', '5', 'pUSD');
    expect(b.currency()).toBe('pUSD');
    expect(b.available().currency()).toBe('pUSD');
    expect(b.reserved().currency()).toBe('pUSD');
    expect(BalanceService.create(money('100', 'pUSD'), money('5', 'USDC'), TEST_ACCOUNT_ID, TEST_VENUE_ID).ok).toBe(false);
  });

  it('reserve 20 pUSD → available 80, reserved 20; release 20 pUSD → обратно', () => {
    const reserved = BalanceService.reserve(balance('100', '0', 'pUSD'), money('20', 'pUSD'));
    expect(reserved.ok && amounts(reserved.value)).toEqual(['80', '20', 'pUSD']);
    if (!reserved.ok) return;
    const released = BalanceService.unfreezeReserved(reserved.value, money('20', 'pUSD'));
    expect(released.ok && amounts(released.value)).toEqual(['100', '0', 'pUSD']);
  });

  it('consumeReserved и credit в pUSD', () => {
    const consumed = BalanceService.consumeReserved(balance('80', '20', 'pUSD'), money('20', 'pUSD'));
    expect(consumed.ok && amounts(consumed.value)).toEqual(['80', '0', 'pUSD']);
    const credited = BalanceService.credit(balance('80', '0', 'pUSD'), money('10', 'pUSD'));
    expect(credited.ok && amounts(credited.value)).toEqual(['90', '0', 'pUSD']);
  });

  it.each<[string, (b: Balance) => { ok: boolean }]>([
    ['reserve 20 USDC', (b) => BalanceService.reserve(b, money('20', 'USDC'))],
    ['unfreezeReserved 5 USDC', (b) => BalanceService.unfreezeReserved(b, money('5', 'USDC'))],
    ['consumeReserved 5 USDC', (b) => BalanceService.consumeReserved(b, money('5', 'USDC'))],
    ['credit 10 USDC', (b) => BalanceService.credit(b, money('10', 'USDC'))],
    ['updateAvailable 50 USDC', (b) => BalanceService.updateAvailable(b, money('50', 'USDC'))],
  ])('баланс 100/5 pUSD: %s → Err, баланс не меняется', (_label, run) => {
    const before = balance('100', '5', 'pUSD');
    expect(run(before).ok).toBe(false);
    expect(amounts(before)).toEqual(['100', '5', 'pUSD']);
  });

  it('и наоборот: баланс USDC отвергает pUSD', () => {
    expect(BalanceService.reserve(balance('100', '0', 'USDC'), money('20', 'pUSD')).ok).toBe(false);
  });

  it.each<'USDC' | 'pUSD'>(['USDC', 'pUSD'])('сериализация баланса %s сохраняет валюту', (currency) => {
    const json = BalanceSerializer.toJSON(balance('100', '5', currency));
    expect([json.available.currency, json.reserved.currency]).toEqual([currency, currency]);
    const restored = BalanceSerializer.fromJSON(json);
    expect(restored.ok && amounts(restored.value)).toEqual(['100', '5', currency]);
  });

  it('JSON баланса с неизвестной валютой → Err', () => {
    const json = BalanceSerializer.toJSON(balance('100', '5', 'pUSD'));
    const tampered = { ...json, available: { ...json.available, currency: 'PUSD' }, reserved: { ...json.reserved, currency: 'PUSD' } };
    expect(BalanceSerializer.fromJSON(tampered).ok).toBe(false);
  });
});
