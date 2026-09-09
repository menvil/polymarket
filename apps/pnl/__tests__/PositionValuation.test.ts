/**
 * Оценка позиции: живая котировка против итога резолюции.
 *
 * @remarks
 * Ветка `OPEN` не проверяется боевым прогоном — у счёта, на котором
 * сверялся отчёт, открытых позиций нет. Поэтому она покрыта здесь: без
 * этого половина объединения существовала бы только на бумаге.
 */
import { PnlCalculator } from '../src/core/PnlCalculator.js';
import { hasWon, redemptionPrice } from '../src/types.js';
import type { PositionPnl, PositionValuation } from '../src/types.js';
import { money, price, quantity, timestamp } from '../src/core/vo.js';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as unknown as ConstructorParameters<typeof PnlCalculator>[0];

/** Позиция-заготовка: параметры, кроме оценки, для теста не важны. */
function positionWith(valuation: PositionValuation, realizedPnl: number): PositionPnl {
  return {
    conditionId: '0xabc',
    title: 'Bitcoin Up or Down',
    outcome: 'Up',
    outcomeIndex: 0,
    avgPrice: price(0.5),
    totalBought: quantity(10),
    valuation,
    realizedPnl: money(realizedPnl),
    closed: valuation.state === 'SETTLED',
    closedAt: timestamp(1780272000_000),
  };
}

describe('redemptionPrice()', () => {
  it('выигравший исход погашается по 1', () => {
    expect(redemptionPrice({ state: 'SETTLED', won: true })).toBe(1);
  });

  it('проигравший исход погашается по 0', () => {
    expect(redemptionPrice({ state: 'SETTLED', won: false })).toBe(0);
  });

  it('открытая позиция оценивается по текущей котировке', () => {
    expect(redemptionPrice({ state: 'OPEN', price: price(0.62) })).toBeCloseTo(0.62, 6);
  });
});

describe('hasWon()', () => {
  it('открытая позиция не выиграла: до резолюции такого факта нет', () => {
    // Цена 0.98 близка к единице, но исход ещё не определён — «почти
    // выиграла» не является выигрышем.
    expect(hasWon({ state: 'OPEN', price: price(0.98) })).toBe(false);
  });

  it('разрешённый рынок отдаёт свой исход', () => {
    expect(hasWon({ state: 'SETTLED', won: true })).toBe(true);
    expect(hasWon({ state: 'SETTLED', won: false })).toBe(false);
  });
});

describe('PnlCalculator: выплата по оценке позиции', () => {
  const calc = new PnlCalculator(silentLogger);
  const period = { fromDate: '2026-06-01', toDate: '2026-06-06' };

  it('открытая позиция оценивается по котировке, а не по 1/0', () => {
    const report = calc.compute({
      positions: [positionWith({ state: 'OPEN', price: price(0.62) }, 1.2)],
      fills: [],
      ...period,
    });

    const market = report.markets[0];
    expect(market).toBeDefined();
    expect(market?.valuation.state).toBe('OPEN');
    // Сделок нет → остаток нулевой → выплата нулевая. Проверяем, что
    // открытая позиция не подставила выплату 1.0 просто потому, что
    // котировка высокая.
    expect(market?.redeemValue.toNumber()).toBe(0);
  });

  it('netPnl берётся у площадки, а не выводится из оценки', () => {
    const report = calc.compute({
      positions: [positionWith({ state: 'SETTLED', won: false }, -3.1)],
      fills: [],
      ...period,
    });

    // Исход проигрышный, но realizedPnl площадки — единственный источник
    // числа: выводить PnL из выигрыша/проигрыша нельзя.
    expect(report.netPnl.toNumber()).toBeCloseTo(-3.1, 6);
    expect(report.markets[0]?.profitable).toBe(false);
  });

  it('прибыльность считается по PnL, а не по выигрышу исхода', () => {
    // Исход проиграл, но позицию успели продать в плюс.
    const report = calc.compute({
      positions: [positionWith({ state: 'SETTLED', won: false }, 0.4)],
      fills: [],
      ...period,
    });

    expect(hasWon(report.markets[0]!.valuation)).toBe(false);
    expect(report.markets[0]?.profitable).toBe(true);
  });
});
