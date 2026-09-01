/**
 * Тесты MarketDuration — номинальная длительность серии рынков
 *
 * @remarks
 * Проверяет инварианты парсера: положительное целое число миллисекунд
 * в разумных пределах.
 */

import { describe, it, expect } from '@jest/globals';
import { asMarketDuration } from '../../../src/value-objects/MarketDuration.js';

describe('asMarketDuration() — принимает', () => {
  it.each([
    ['5-минутную серию', 5 * 60_000],
    ['часовую серию', 60 * 60_000],
    ['суточную серию', 24 * 60 * 60_000],
    ['минимальное значение', 1],
    ['365 суток — верхнюю границу', 365 * 24 * 60 * 60 * 1000],
  ])('%s', (_label, ms) => {
    expect(asMarketDuration(ms)).toBe(ms);
  });
});

describe('asMarketDuration() — отклоняет', () => {
  it.each([
    ['ноль', 0],
    ['отрицательное значение', -1],
    ['дробное значение', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['больше 365 суток', 366 * 24 * 60 * 60 * 1000],
  ])('%s', (_label, ms) => {
    expect(asMarketDuration(ms)).toBeUndefined();
  });

  it('нечисловое значение, пришедшее через as-каст', () => {
    expect(asMarketDuration('300000' as unknown as number)).toBeUndefined();
    expect(asMarketDuration(null as unknown as number)).toBeUndefined();
  });
});
