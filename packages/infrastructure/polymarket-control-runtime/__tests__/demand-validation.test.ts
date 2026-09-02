/**
 * Проверка спроса: дефект вызывающего останавливает проход ДО побочных
 * эффектов.
 *
 * @remarks
 * Главное утверждение этих тестов — не «бросили ValidationError», а «не
 * успели ничего сделать». Проверка, выполненная после обхода каталога или,
 * хуже, после приобретений первых владельцев, оставила бы проход
 * наполовину выполненным: вызывающий получил бы исключение и не знал бы,
 * какая часть тика всё-таки состоялась.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { ValidationError } from '@polymarket/errors';
import type { PolymarketSubscriptionDemand } from '../src/index.js';
import { AT_1757_MS, AT_1800_MS, makeEntry, policyOf } from './helpers/fakes.js';
import { makeHarness } from './helpers/harness.js';

describe('валидация спроса', () => {
  /** Недопустимые значения лимита приобретения и почему они недопустимы. */
  const INVALID_LIMITS: ReadonlyArray<readonly [string, number]> = [
    ['ноль — «выключенный» владелец спрос не подаёт', 0],
    ['отрицательное', -1],
    ['дробное', 1.5],
    ['NaN — slice() молча дал бы пустой срез', Number.NaN],
    ['Infinity — «весь план» должен быть написан числом', Number.POSITIVE_INFINITY],
  ];

  it.each(INVALID_LIMITS)('acquireLimit отвергается: %s', async (_reason, acquireLimit) => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage([makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS })], AT_1757_MS);
    const acquireSpy = jest.spyOn(harness.controller, 'acquire');

    await expect(
      harness.runtime.runOnce([
        { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);

    // Fail-fast: ни сети, ни физических действий
    expect(harness.discovery.refreshCalls).toBe(0);
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it('лимит 1 — минимальное допустимое значение', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage([makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS })], AT_1757_MS);

    const result = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 1 },
    ]);

    expect(result.owners[0]?.acquisitions[0]?.status).toBe('opened');
  });

  it('дубликат владельца в одном проходе — ValidationError без побочных эффектов', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage([makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS })], AT_1757_MS);
    const acquireSpy = jest.spyOn(harness.controller, 'acquire');

    await expect(
      harness.runtime.runOnce([
        { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 1 },
        { ownerKey: 'strategy:A', policy: policyOf('xrp', '5m'), acquireLimit: 2 },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(harness.discovery.refreshCalls).toBe(0);
    expect(acquireSpy).not.toHaveBeenCalled();
  });

  it('пустой ключ владельца отвергается до обхода каталога', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage([makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS })], AT_1757_MS);

    await expect(
      harness.runtime.runOnce([
        { ownerKey: '   ', policy: policyOf('btc', '5m'), acquireLimit: 1 },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(harness.discovery.refreshCalls).toBe(0);
  });

  it('невалидный спрос ОДНОГО владельца отменяет проход целиком', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage([makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS })], AT_1757_MS);
    const acquireSpy = jest.spyOn(harness.controller, 'acquire');

    await expect(
      harness.runtime.runOnce([
        { ownerKey: 'collector:raw', policy: policyOf('btc', '5m'), acquireLimit: 1 },
        { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 0 },
      ]),
    ).rejects.toBeInstanceOf(ValidationError);

    // Первый владелец валиден и в порядке обработки идёт РАНЬШЕ — но не
    // приобрёл ничего: валидация проходит по всему спросу до действий.
    expect(acquireSpy).not.toHaveBeenCalled();
    expect(harness.controller.getStats().claims).toBe(0);
  });

  it('входной массив спроса не мутируется', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage([makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS })], AT_1757_MS);

    const policy = policyOf('btc', '5m');
    // Порядок ОБРАТЕН порядку обработки: рантайм обязан отсортировать копию.
    const demands: PolymarketSubscriptionDemand[] = [
      { ownerKey: 'strategy:A', policy, acquireLimit: 1 },
      { ownerKey: 'collector:raw', policy, acquireLimit: 1 },
    ];
    const before = [...demands];

    await harness.runtime.runOnce(demands);

    expect(demands).toEqual(before);
    expect(demands[0]?.ownerKey).toBe('strategy:A');
    expect(demands[1]?.ownerKey).toBe('collector:raw');
  });

  it('пустой спрос — законный проход: каталог обновлён, claim-ов нет', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage([makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS })], AT_1757_MS);

    const result = await harness.runtime.runOnce([]);

    expect(harness.discovery.refreshCalls).toBe(1);
    expect(result.universeEntries).toBe(1);
    expect(result.owners).toEqual([]);
    expect(result.controller.claims).toBe(0);
  });
});
