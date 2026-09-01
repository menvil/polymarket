/**
 * Тесты фабрик policy: нормализация селекторов и отказ на противоречивой
 * конфигурации.
 *
 * @remarks
 * Проверяется главным образом то, ЧТО НЕ должно тихо проходить: policy,
 * которая не действует никогда, и селектор, который совпадает со всем.
 * Оба дефекта без проверки выглядят как «фильтр почему-то не работает».
 */
import { describe, it, expect } from '@jest/globals';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { unsafeCryptoAssetId } from '@polymarket/ids';
import { asMarketDuration } from '@polymarket/market';
import { MoneyService } from '@polymarket/value-objects';
import {
  CEX_POLICY_MARKET_TYPE_VALUES,
  PolicyValidationError,
  createCexPolicy,
  createPolymarketPolicy,
} from '../src/createPolicy.js';
import type { CexPolicy } from '../src/CexPolicy.js';

function at(iso: string): Timestamp {
  const result = TimestampService.fromISO(iso);
  if (!result.ok) throw new Error(`bad fixture timestamp: ${iso}`);
  return result.value;
}

/**
 * Ловит {@link PolicyValidationError}, чтобы проверить ЕЁ КОНТЕКСТ.
 *
 * @param fn - Вызов фабрики, который обязан бросить
 * @returns Пойманная ошибка
 * @throws {Error} Если вызов не бросил либо бросил ошибку другого класса
 *
 * @remarks
 * `expect(...).toThrow()` подтверждает только факт отказа, а половина
 * ценности этих проверок — в том, что ошибка НАЗЫВАЕТ виновное слово:
 * сообщение «policy невалидна» оставляет ровно ту задачу поиска, ради
 * устранения которой проверка и добавлена.
 */
function captureError(fn: () => unknown): PolicyValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof PolicyValidationError) return error;
    throw error;
  }
  throw new Error('expected PolicyValidationError, but nothing was thrown');
}

/**
 * Изображает значение, пришедшее из конфигурационного файла.
 *
 * @param values - Сырые строки, каким бы мусором они ни были
 * @returns Те же строки в типе поля policy
 *
 * @remarks
 * Приведение здесь НЕ обход проверки, а воспроизведение сценария, ради
 * которого проверка существует: TypeScript ограничивает только
 * типизированных вызывающих, а policy собирают из JSON и переменных
 * окружения, где `marketTypes` — обычный `string[]`.
 */
function fromConfig(values: readonly string[]): CexPolicy['marketTypes'] {
  return values as CexPolicy['marketTypes'];
}

const BTC = unsafeCryptoAssetId('btc');
const ETH = unsafeCryptoAssetId('eth');
const FIVE_MIN = asMarketDuration(5 * 60_000)!;
const FIFTEEN_MIN = asMarketDuration(15 * 60_000)!;
const T18 = at('2026-09-01T18:00:00.000Z');
const T19 = at('2026-09-01T19:00:00.000Z');

describe('createPolymarketPolicy: нормализация', () => {
  it('дедуплицирует активы и длительности, сохраняя порядок первого появления', () => {
    const policy = createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      assets: [BTC, ETH, BTC],
      durations: [FIVE_MIN, FIVE_MIN, FIFTEEN_MIN],
    });

    expect(policy.assets).toEqual([BTC, ETH]);
    expect(policy.durations).toEqual([FIVE_MIN, FIFTEEN_MIN]);
  });

  it('пустой список схлопывается в отсутствие селектора: это одно утверждение', () => {
    const policy = createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      assets: [],
      durations: [],
    });

    expect(policy.assets).toBeUndefined();
    expect(policy.durations).toBeUndefined();
    expect('assets' in policy).toBe(false);
  });

  it('обрезает ключевые слова и убирает дубликаты', () => {
    const policy = createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      title: { excluded: ['  testnet ', 'testnet', 'demo'] },
    });

    expect(policy.title?.excluded).toEqual(['testnet', 'demo']);
  });

  it('title без единого непустого селектора схлопывается целиком', () => {
    const policy = createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      title: { required: [], anyOf: [], excluded: [] },
    });

    expect(policy.title).toBeUndefined();
  });

  it('не мутирует входные массивы', () => {
    const assets = [BTC, BTC];
    const excluded = ['  testnet  '];
    createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      assets,
      title: { excluded },
    });

    expect(assets).toEqual([BTC, BTC]);
    expect(excluded).toEqual(['  testnet  ']);
  });

  it('результат заморожен', () => {
    const policy = createPolymarketPolicy({ kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN' });

    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('сохраняет canonical-пороги как есть', () => {
    const created = MoneyService.create(1000, 'USDC');
    if (!created.ok) throw new Error('bad fixture money');
    const minLiquidity = created.value;
    const policy = createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      minLiquidity,
      effectiveFrom: T18,
      effectiveUntil: T19,
    });

    expect(policy.minLiquidity).toBe(minLiquidity);
    expect(policy.effectiveFrom).toBe(T18);
  });
});

describe('createPolymarketPolicy: отказы', () => {
  it('окно, которое не действует никогда, отвергается', () => {
    expect(() =>
      createPolymarketPolicy({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        effectiveFrom: T19,
        effectiveUntil: T18,
      }),
    ).toThrow(PolicyValidationError);
  });

  it('совпадающие границы тоже отвергаются: интервал полуоткрыт, множество пусто', () => {
    expect(() =>
      createPolymarketPolicy({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        effectiveFrom: T18,
        effectiveUntil: T18,
      }),
    ).toThrow(PolicyValidationError);
  });

  it('селектор из одних пробелов — дефект конфигурации, а не выключенный фильтр', () => {
    expect(() =>
      createPolymarketPolicy({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        title: { excluded: ['   ', ''] },
      }),
    ).toThrow(PolicyValidationError);
  });
});

describe('createPolymarketPolicy: противоречивые текстовые селекторы', () => {
  /**
   * Собирает policy с одними лишь текстовыми селекторами.
   *
   * @param title - Селекторы по тексту рынка
   * @returns Готовая policy
   * @throws {PolicyValidationError} При противоречии либо мусоре в селекторах
   */
  function withTitle(title: {
    required?: readonly string[];
    anyOf?: readonly string[];
    excluded?: readonly string[];
  }) {
    return createPolymarketPolicy({ kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN', title });
  }

  it('одно и то же слово в required и excluded не совпадёт ни с чем — отказ', () => {
    expect(() => withTitle({ required: ['bitcoin'], excluded: ['bitcoin'] })).toThrow(
      PolicyValidationError,
    );
  });

  it('регистр не спасает: матчинг идёт под флагом i, BTC и btc — одно слово', () => {
    expect(() => withTitle({ required: ['BTC'], excluded: ['btc'] })).toThrow(
      PolicyValidationError,
    );
  });

  it('пробелы не спасают: противоречие ищется ПОСЛЕ нормализации', () => {
    expect(() => withTitle({ required: ['  btc  '], excluded: ['btc'] })).toThrow(
      PolicyValidationError,
    );
  });

  it('ошибка называет конкретное конфликтующее слово, а не только факт отказа', () => {
    const error = captureError(() =>
      withTitle({ required: ['Ethereum', 'up'], excluded: ['ETHEREUM'] }),
    );

    expect(error.context?.field).toBe('title.required');
    expect(error.context?.conflictingKeywords).toEqual(['Ethereum']);
  });

  it('anyOf целиком внутри excluded невыполним — отказ', () => {
    expect(() => withTitle({ anyOf: ['btc', 'eth'], excluded: ['ETH', 'btc'] })).toThrow(
      PolicyValidationError,
    );
  });

  it('ошибка про anyOf называет слова именно этого селектора', () => {
    const error = captureError(() => withTitle({ anyOf: ['btc'], excluded: ['btc', 'testnet'] }));

    expect(error.context?.field).toBe('title.anyOf');
    expect(error.context?.conflictingKeywords).toEqual(['btc']);
  });

  it('ЧАСТИЧНОЕ пересечение anyOf и excluded — не ошибка: сработает другое слово', () => {
    const policy = withTitle({ anyOf: ['btc', 'eth'], excluded: ['eth'] });

    expect(policy.title?.anyOf).toEqual(['btc', 'eth']);
    expect(policy.title?.excluded).toEqual(['eth']);
  });

  it('required ∩ anyOf — избыточность, а не противоречие: policy создаётся', () => {
    const policy = withTitle({ required: ['btc'], anyOf: ['btc', 'eth'] });

    expect(policy.title?.required).toEqual(['btc']);
    expect(policy.title?.anyOf).toEqual(['btc', 'eth']);
  });

  it('непересекающиеся селекторы всех трёх видов проходят', () => {
    const policy = withTitle({ required: ['btc'], anyOf: ['up', 'down'], excluded: ['testnet'] });

    expect(policy.title).toEqual({
      required: ['btc'],
      anyOf: ['up', 'down'],
      excluded: ['testnet'],
    });
  });
});

describe('createCexPolicy', () => {
  const VALID = {
    kind: 'CEX' as const,
    exchangeIds: ['binance'],
    marketTypes: ['swap' as const],
    symbols: ['BTC/USDT:USDT'],
    orderbook: true,
    trades: true,
  };

  it('собирает валидную policy и замораживает её', () => {
    const policy = createCexPolicy({ ...VALID, orderbookDepth: 10 });

    expect(policy.exchangeIds).toEqual(['binance']);
    expect(policy.orderbookDepth).toBe(10);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('дедуплицирует и обрезает списки', () => {
    const policy = createCexPolicy({
      ...VALID,
      exchangeIds: [' binance ', 'binance'],
      symbols: ['BTC/USDT:USDT', 'BTC/USDT:USDT', 'ETH/USDT:USDT'],
    });

    expect(policy.exchangeIds).toEqual(['binance']);
    expect(policy.symbols).toEqual(['BTC/USDT:USDT', 'ETH/USDT:USDT']);
  });

  it.each([
    ['exchangeIds', { ...VALID, exchangeIds: [] }],
    ['marketTypes', { ...VALID, marketTypes: [] }],
    ['symbols', { ...VALID, symbols: [] }],
    ['symbols из пробелов', { ...VALID, symbols: ['  '] }],
  ])('пустой обязательный список (%s) отвергается', (_name, input) => {
    expect(() => createCexPolicy(input)).toThrow(PolicyValidationError);
  });

  it('policy без единого запрошенного потока отвергается', () => {
    // Подписка, не просящая ни стакана, ни сделок, описывает подписку без данных
    expect(() => createCexPolicy({ ...VALID, orderbook: false, trades: false })).toThrow(
      PolicyValidationError,
    );
  });

  it.each([0, -1, 1.5, Number.NaN])('некорректная глубина стакана (%p) отвергается', (depth) => {
    expect(() => createCexPolicy({ ...VALID, orderbookDepth: depth })).toThrow(
      PolicyValidationError,
    );
  });

  it('окно проверяется теми же правилами, что у Polymarket-policy', () => {
    expect(() => createCexPolicy({ ...VALID, effectiveFrom: T19, effectiveUntil: T18 })).toThrow(
      PolicyValidationError,
    );
  });

  describe('marketTypes: принадлежность union-у проверяется в runtime', () => {
    it.each([...CEX_POLICY_MARKET_TYPE_VALUES])('допустимое значение %s принимается', (value) => {
      const policy = createCexPolicy({ ...VALID, marketTypes: [value] });

      expect(policy.marketTypes).toEqual([value]);
    });

    it('список допустимых значений совпадает с union-ом CexPolicyMarketType', () => {
      expect([...CEX_POLICY_MARKET_TYPE_VALUES]).toEqual(['spot', 'future', 'swap']);
    });

    it('значение вне union-а отвергается: транспорт не смог бы его отобразить', () => {
      expect(() =>
        createCexPolicy({ ...VALID, marketTypes: fromConfig(['futures']) }),
      ).toThrow(PolicyValidationError);
    });

    it('чужой регистр отвергается: смена регистра меняет сам токен', () => {
      expect(() => createCexPolicy({ ...VALID, marketTypes: fromConfig(['SPOT']) })).toThrow(
        PolicyValidationError,
      );
    });

    it('пустая строка отвергается как пустой обязательный список', () => {
      expect(() => createCexPolicy({ ...VALID, marketTypes: fromConfig(['']) })).toThrow(
        PolicyValidationError,
      );
    });

    it('окружающие пробелы срезаются: они не несут смысла', () => {
      const policy = createCexPolicy({ ...VALID, marketTypes: fromConfig([' spot ']) });

      expect(policy.marketTypes).toEqual(['spot']);
    });

    it('недопустимое значение проверяется ПОКАЗАТЕЛЬНО: пробелы не маскируют его', () => {
      expect(() => createCexPolicy({ ...VALID, marketTypes: fromConfig([' futures ']) })).toThrow(
        PolicyValidationError,
      );
    });

    it('ошибка называет недопустимое значение и полный список допустимых', () => {
      const error = captureError(() =>
        createCexPolicy({ ...VALID, marketTypes: fromConfig(['swap', 'SPOT']) }),
      );

      expect(error.context?.field).toBe('marketTypes');
      expect(error.context?.value).toBe('SPOT');
      expect(error.context?.allowed).toEqual(['spot', 'future', 'swap']);
    });
  });
});
