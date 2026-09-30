/**
 * Тесты canonical-равенства состояния портфеля.
 *
 * @remarks
 * Каждый портфель собирается заново — новым объектом с новыми картами.
 * Сравнение по ссылке дало бы `false` на ЛЮБОЙ паре, и тест «одинаковое
 * содержимое → true» доказывает именно то, что сравнение идёт по содержимому.
 */
import { describe, it, expect } from '@jest/globals';
import type { Position } from '@polymarket/position';
import { Balance } from '@polymarket/value-objects/balance';
import { TokenBalance } from '@polymarket/value-objects/token-balance';
import { MoneyService, QuantityService, type Money, type Quantity } from '@polymarket/value-objects';
import {
  asInstrumentId,
  type AccountId,
  type InstrumentId,
  type VenueId,
} from '@polymarket/ids';
import { Portfolio } from '../../src/Portfolio.js';
import { samePortfolioState } from '../../src/portfolioState.js';
import { asPortfolioId } from '../../src/value-objects/index.js';
import { position, positionAccount } from '../positionFixture.js';

const VENUE = 'POLYMARKET' as VenueId;

/** Разворачивает `Result` фикстуры: отказ здесь — дефект самого теста. */
function must<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!result.ok) throw new Error(`fixture failed: ${String(result.error)}`);
  return result.value as T;
}

/** Сумма в USDC. */
const usdc = (value: number): Money => must(MoneyService.create(value, 'USDC'));
/** Количество токенов. */
const tokens = (value: number): Quantity => must(QuantityService.create(value));
const UP = asInstrumentId('instrument-up') as InstrumentId;
const DOWN = asInstrumentId('instrument-down') as InstrumentId;

/** Параметры, которыми тест рассогласовывает ровно одно поле. */
interface Overrides {
  readonly id?: string;
  readonly accountId?: AccountId;
  readonly balanceVenueId?: VenueId;
  readonly available?: number;
  readonly reserved?: number;
  /** Позиции; для каждой собирается токенный баланс на то же количество */
  readonly positions?: readonly Position[];
  /** Сколько из количества позиции зарезервировано под SELL */
  readonly reservedTokens?: number;
}

/** Портфель, собранный заново: новые объекты, новые карты. */
function build(overrides: Overrides = {}): Portfolio {
  const accountId = overrides.accountId ?? positionAccount();
  const held = overrides.positions ?? [position(UP, { quantity: 40 })];
  const positions = new Map<InstrumentId, Position>();
  const tokenBalances = new Map<InstrumentId, TokenBalance>();
  for (const p of held) {
    positions.set(p.instrumentId, p);
    const reserved = overrides.reservedTokens ?? 0;
    tokenBalances.set(
      p.instrumentId,
      TokenBalance.of(
        p.instrumentId,
        tokens(p.quantity.toNumber() - reserved),
        tokens(reserved),
        p.accountId,
        overrides.balanceVenueId ?? VENUE,
      ),
    );
  }

  const created = Portfolio.create({
    id: asPortfolioId(overrides.id ?? 'portfolio-1'),
    accountId,
    balance: Balance.of(
      usdc(overrides.available ?? 1_000),
      usdc(overrides.reserved ?? 0),
      accountId,
      overrides.balanceVenueId ?? VENUE,
    ),
    positions,
    tokenBalances,
  });
  if (!created.ok) throw new Error(`fixture failed: ${created.error.message}`);
  return created.value;
}

describe('samePortfolioState', () => {
  it('два независимо собранных портфеля с одним содержимым равны', () => {
    const a = build();
    const b = build();
    expect(a).not.toBe(b);
    expect(a.positions).not.toBe(b.positions);
    expect(samePortfolioState(a, b)).toBe(true);
  });

  it('порядок вставки в карты не значим', () => {
    const up = position(UP, { quantity: 40 });
    const down = position(DOWN, { quantity: 10, id: 'position-2' });
    expect(samePortfolioState(build({ positions: [up, down] }), build({ positions: [down, up] }))).toBe(
      true,
    );
  });

  it('эквивалентный AccountId из другого объекта не делает портфели разными', () => {
    // Каждый вызов фикстуры парсит адрес заново — это новый объект с той же
    // canonical-идентичностью.
    const first = positionAccount('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    const second = positionAccount('0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD');
    expect(first).not.toBe(second);
    const a = build({ accountId: first, positions: [position(UP, { quantity: 40, accountId: first })] });
    const b = build({ accountId: second, positions: [position(UP, { quantity: 40, accountId: second })] });
    expect(samePortfolioState(a, b)).toBe(true);
  });

  it.each<[string, Overrides]>([
    ['id портфеля', { id: 'portfolio-2' }],
    ['available', { available: 999 }],
    ['reserved', { available: 900, reserved: 100 }],
    ['площадка баланса', { balanceVenueId: 'KALSHI' as VenueId }],
    ['количество позиции', { positions: [position(UP, { quantity: 41 })] }],
    ['цена входа позиции', { positions: [position(UP, { quantity: 40, entryPrice: 0.66 })] }],
    ['набор инструментов', { positions: [position(DOWN, { quantity: 40 })] }],
    ['число позиций', { positions: [] }],
    ['разложение токенов на available/reserved', { reservedTokens: 15 }],
  ])('расхождение в «%s» даёт false', (_field, overrides) => {
    expect(samePortfolioState(build(), build(overrides))).toBe(false);
  });

  it('другой владелец агрегата даёт false', () => {
    const other = positionAccount('0x9999999999999999999999999999999999999999');
    const foreign = build({ accountId: other, positions: [position(UP, { quantity: 40, accountId: other })] });
    expect(samePortfolioState(build(), foreign)).toBe(false);
  });

  it('портфель после операции считается изменённым', () => {
    const before = build();
    const reserved = before.reserveForOrder(usdc(10));
    if (!reserved.ok) throw reserved.error;
    expect(samePortfolioState(before, reserved.value)).toBe(false);
  });
});
