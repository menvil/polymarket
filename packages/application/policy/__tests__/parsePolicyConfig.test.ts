/**
 * Тесты границы «plain config → canonical Policy».
 *
 * @remarks
 * Проверяются три разных утверждения, и путать их нельзя:
 *
 * 1. КОНВЕРСИЯ состоялась — `'5m'` стал `MarketDuration`, а не остался
 *    строкой, похожей на длительность;
 * 2. МУСОР не проходит — и ошибка называет виновное поле вместе с индексом
 *    элемента, иначе разбор конфига из полусотни активов превращается в
 *    поиск глазами;
 * 3. ПРАВИЛА ФАБРИКИ действуют и через парсер — это защита от появления
 *    второй системы валидации, при которой «через конфиг проходит, а из кода
 *    нет».
 *
 * Branded-типы (`CryptoAssetId`, `MarketDuration`) в рантайме стираются,
 * поэтому «стал canonical-типом» доказывается ПРИСВОЕНИЕМ в типизированную
 * переменную (проверяет компилятор) плюс сравнением значения (проверяет
 * jest). По отдельности ни одно из двух утверждения не закрывает.
 */
import { describe, it, expect } from '@jest/globals';
import { asCryptoAssetId } from '@polymarket/ids';
import type { CryptoAssetId } from '@polymarket/ids';
import { asMarketDuration } from '@polymarket/market';
import type { MarketDuration } from '@polymarket/market';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { MoneyService, RatioService } from '@polymarket/value-objects';
import type { Money, Ratio } from '@polymarket/value-objects';
import { PolicyValidationError } from '../src/createPolicy.js';
import type { CexPolicy } from '../src/CexPolicy.js';
import type { PolymarketPolicy } from '../src/PolymarketPolicy.js';
import type { CexPolicyConfig, PolicyConfig, PolymarketPolicyConfig } from '../src/PolicyConfig.js';
import {
  parseCexPolicyConfig,
  parsePolicyConfig,
  parsePolymarketPolicyConfig,
} from '../src/parsePolicyConfig.js';

/**
 * Ловит {@link PolicyValidationError}, чтобы проверить ЕЁ КОНТЕКСТ.
 *
 * @param fn - Вызов парсера, который обязан бросить
 * @returns Пойманная ошибка
 * @throws {Error} Если вызов не бросил либо бросил ошибку другого класса
 *
 * @remarks
 * `expect(...).toThrow()` подтверждает только факт отказа. Половина ценности
 * этих тестов — в том, что ошибка НАЗЫВАЕТ поле: ради этого граница и
 * заведена, поэтому проверяется именно `context`.
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
 * Разбирает конфиг и сужает результат до Polymarket-policy.
 *
 * @param config - Конфигурация площадки Polymarket
 * @returns Canonical policy
 * @throws {Error} Если union вернул policy другого вида
 * @throws {PolicyValidationError} При некорректной конфигурации
 *
 * @remarks
 * Разбор идёт через ПУБЛИЧНУЮ точку входа `parsePolicyConfig`: тесты обязаны
 * проверять ту дверь, которой пользуются вызывающие, а не удобную внутреннюю.
 */
function parsePolymarket(config: PolymarketPolicyConfig): PolymarketPolicy {
  const policy = parsePolicyConfig(config);
  if (policy.kind !== 'POLYMARKET') {
    throw new Error(`expected POLYMARKET policy, got ${policy.kind}`);
  }
  return policy;
}

/**
 * Разбирает конфиг и сужает результат до CEX-policy.
 *
 * @param config - Конфигурация биржи
 * @returns Canonical policy
 * @throws {Error} Если union вернул policy другого вида
 * @throws {PolicyValidationError} При некорректной конфигурации
 */
function parseCex(config: CexPolicyConfig): CexPolicy {
  const policy = parsePolicyConfig(config);
  if (policy.kind !== 'CEX') {
    throw new Error(`expected CEX policy, got ${policy.kind}`);
  }
  return policy;
}

/**
 * Собирает эталонный {@link Money} для сравнения.
 *
 * @param amount - Сумма
 * @returns Money в USDC
 * @throws {Error} Если фикстура собрана неверно
 */
function money(amount: string): Money {
  const created = MoneyService.create(amount, 'USDC');
  if (!created.ok) throw new Error(`bad fixture money: ${amount}`);
  return created.value;
}

/**
 * Собирает эталонный {@link Ratio} для сравнения.
 *
 * @param value - Десятичная дробь
 * @returns Ratio
 * @throws {Error} Если фикстура собрана неверно
 */
function ratio(value: string): Ratio {
  const created = RatioService.fromDecimal(value);
  if (!created.ok) throw new Error(`bad fixture ratio: ${value}`);
  return created.value;
}

/**
 * Сравнивает деньги через сервис, а не по ссылке.
 *
 * @param actual - Значение из policy
 * @param expected - Эталон
 * @returns `true`, если суммы и валюты совпали
 * @throws {Error} Если сервис не смог сравнить значения
 *
 * @remarks
 * `toEqual` сравнил бы ВНУТРЕННЕЕ представление `Decimal`, а оно не входит в
 * контракт `Money`: тест начал бы падать от смены реализации, ничего не
 * сказав о policy.
 */
function moneyEquals(actual: Money, expected: Money): boolean {
  const result = MoneyService.equals(actual, expected);
  if (!result.ok) throw new Error(`money comparison failed: ${result.error.message}`);
  return result.value;
}

const POLYMARKET_CONFIG: PolymarketPolicyConfig = {
  kind: 'POLYMARKET',
  family: 'CRYPTO_UP_DOWN',
  assets: ['btc', 'eth'],
  durations: ['5m', '15m'],
  minLiquidity: { amount: 1000, currency: 'USDC' },
  minSpread: '0.02',
  effectiveFrom: '2026-09-01T18:00:00Z',
};

const CEX_CONFIG: CexPolicyConfig = {
  kind: 'CEX',
  exchangeIds: ['binance'],
  marketTypes: ['swap'],
  symbols: ['BTC/USDT:USDT'],
  orderbook: true,
  trades: true,
  orderbookDepth: 10,
  effectiveFrom: '2026-09-01T18:00:00Z',
  effectiveUntil: '2026-09-01T19:00:00Z',
};

describe('parsePolicyConfig: Polymarket, happy path', () => {
  it('переводит КАЖДОЕ поле конфига в его canonical-тип', () => {
    const policy = parsePolymarket(POLYMARKET_CONFIG);

    // Компилятор: поля имеют canonical-типы, а не примитивы конфига.
    const assets: readonly CryptoAssetId[] | undefined = policy.assets;
    const durations: readonly MarketDuration[] | undefined = policy.durations;
    const minLiquidity: Money | undefined = policy.minLiquidity;
    const minSpread: Ratio | undefined = policy.minSpread;
    const effectiveFrom: Timestamp | undefined = policy.effectiveFrom;

    expect(policy.family).toBe('CRYPTO_UP_DOWN');
    expect(assets).toEqual([asCryptoAssetId('btc'), asCryptoAssetId('eth')]);
    expect(durations).toEqual([asMarketDuration(300_000), asMarketDuration(900_000)]);
    expect(minLiquidity !== undefined && moneyEquals(minLiquidity, money('1000'))).toBe(true);
    expect(minSpread?.equals(ratio('0.02'))).toBe(true);
    expect(effectiveFrom?.toISO()).toBe('2026-09-01T18:00:00.000Z');
  });

  it('номинал серии измеряется в миллисекундах: 5m — это ровно 300000', () => {
    // Единица пишется в конфиге явно ИМЕННО чтобы её не пришлось угадывать:
    // 300000 одинаково правдоподобно читается и как мс, и как перепутанные с
    // ними секунды.
    const policy = parsePolymarket({ ...POLYMARKET_CONFIG, durations: ['5m', '30m', '1h', '4h'] });

    expect(policy.durations).toEqual([300_000, 1_800_000, 3_600_000, 14_400_000]);
  });

  it('minSpread читается как ДРОБЬ, а не как проценты', () => {
    const policy = parsePolymarket({ ...POLYMARKET_CONFIG, minSpread: 0.02 });

    expect(policy.minSpread?.toNumber()).toBe(0.02);
  });

  it('необязательные поля отсутствуют, а не становятся undefined-полями', () => {
    const policy = parsePolymarket({ kind: 'POLYMARKET', family: 'BINARY_OUTCOME' });

    expect(policy.family).toBe('BINARY_OUTCOME');
    expect('assets' in policy).toBe(false);
    expect('minLiquidity' in policy).toBe(false);
    expect('effectiveFrom' in policy).toBe(false);
  });

  it('не мутирует входную конфигурацию', () => {
    const assets = ['btc', 'btc'];
    const durations = ['5m'];
    const config: PolymarketPolicyConfig = {
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      assets,
      durations,
    };

    parsePolicyConfig(config);

    expect(assets).toEqual(['btc', 'btc']);
    expect(durations).toEqual(['5m']);
  });

  it('прямой вызов parsePolymarketPolicyConfig даёт тот же результат', () => {
    // Специализированная функция — не отдельный путь валидации, а та же
    // ветвь union-а без диспетчеризации по kind.
    expect(parsePolymarketPolicyConfig(POLYMARKET_CONFIG)).toEqual(
      parsePolicyConfig(POLYMARKET_CONFIG),
    );
  });
});

describe('parsePolicyConfig: CEX, happy path', () => {
  it('собирает policy с глубиной стакана и окном применимости', () => {
    const policy = parseCex(CEX_CONFIG);

    expect(policy.exchangeIds).toEqual(['binance']);
    expect(policy.marketTypes).toEqual(['swap']);
    expect(policy.symbols).toEqual(['BTC/USDT:USDT']);
    expect(policy.orderbook).toBe(true);
    expect(policy.trades).toBe(true);
    expect(policy.orderbookDepth).toBe(10);
    expect(policy.effectiveFrom?.toISO()).toBe('2026-09-01T18:00:00.000Z');
    expect(policy.effectiveUntil?.toISO()).toBe('2026-09-01T19:00:00.000Z');
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('marketTypes из конфига сужаются до union-а без единого приведения типа', () => {
    // Вход — `readonly string[]`, выход — `readonly CexPolicyMarketType[]`.
    // Сужение делает фабрика, поэтому вызывающему не нужен `as`.
    const marketTypes: readonly string[] = ['spot', 'future', 'swap'];
    const policy = parseCex({ ...CEX_CONFIG, marketTypes });

    const narrowed: CexPolicy['marketTypes'] = policy.marketTypes;
    expect(narrowed).toEqual(['spot', 'future', 'swap']);
  });

  it('прямой вызов parseCexPolicyConfig даёт тот же результат', () => {
    expect(parseCexPolicyConfig(CEX_CONFIG)).toEqual(parsePolicyConfig(CEX_CONFIG));
  });
});

describe('parsePolicyConfig: отказы по семейству рынков', () => {
  it('неизвестное семейство отвергается и ошибка перечисляет допустимые', () => {
    const error = captureError(() =>
      parsePolicyConfig({ kind: 'POLYMARKET', family: 'CRYPTO' }),
    );

    expect(error).toBeInstanceOf(PolicyValidationError);
    expect(error.context?.field).toBe('family');
    expect(error.context?.value).toBe('CRYPTO');
    expect(error.context?.allowed).toEqual(['CRYPTO_UP_DOWN', 'BINARY_OUTCOME']);
  });

  it('чужой регистр семейства не приводится молча', () => {
    expect(() => parsePolicyConfig({ kind: 'POLYMARKET', family: 'crypto_up_down' })).toThrow(
      PolicyValidationError,
    );
  });
});

describe('parsePolicyConfig: отказы по активам', () => {
  it('пустой актив отвергается, и ошибка называет ИНДЕКС элемента', () => {
    const error = captureError(() =>
      parsePolicyConfig({ kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN', assets: ['btc', ''] }),
    );

    expect(error.context?.field).toBe('assets[1]');
    expect(error.context?.value).toBe('');
  });

  it('актив из одних пробелов отвергается: молчаливой подстановки нет', () => {
    const error = captureError(() =>
      parsePolicyConfig({ kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN', assets: ['   '] }),
    );

    expect(error.context?.field).toBe('assets[0]');
  });

  it.each([
    ['управляющий символ', 'bt\u0000c'],
    ['слишком длинный тикер', 'x'.repeat(50)],
  ])('актив, не проходящий canonical-валидацию (%s), отвергается', (_name, value) => {
    const error = captureError(() =>
      parsePolicyConfig({ kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN', assets: [value] }),
    );

    expect(error).toBeInstanceOf(PolicyValidationError);
    expect(error.context?.field).toBe('assets[0]');
  });
});

describe('parsePolicyConfig: отказы по длительностям', () => {
  it.each([
    ['слово вместо длительности', 'five'],
    ['число без единицы', '5'],
    ['миллисекунды вместо номинала', '300000'],
    ['неподдержанная единица', '5d'],
    ['мусор после единицы', '5m and more'],
  ])('%s (%p) отвергается с указанием ожидаемого формата', (_name, value) => {
    const error = captureError(() =>
      parsePolicyConfig({ kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN', durations: [value] }),
    );

    expect(error).toBeInstanceOf(PolicyValidationError);
    expect(error.context?.field).toBe('durations[0]');
    expect(error.context?.value).toBe(value);
    expect(error.context?.expected).toBe('<number><m|h>');
  });

  it('форма записи верна, но длительности не бывает: 0m отвергает домен', () => {
    // Регулярное выражение подтверждает только ФОРМУ; границы номинала знает
    // asMarketDuration, и второй их копии здесь нет.
    const error = captureError(() =>
      parsePolicyConfig({ kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN', durations: ['0m'] }),
    );

    expect(error.context?.field).toBe('durations[0]');
    expect(error.context?.milliseconds).toBe(0);
  });

  it('номинал больше 365 суток отвергает тот же доменный конструктор', () => {
    const error = captureError(() =>
      parsePolicyConfig({ kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN', durations: ['9000h'] }),
    );

    expect(error.context?.field).toBe('durations[0]');
  });

  it('ошибка называет индекс виновного элемента, а не только факт отказа', () => {
    const error = captureError(() =>
      parsePolicyConfig({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        durations: ['5m', '15m', 'five'],
      }),
    );

    expect(error.context?.field).toBe('durations[2]');
  });
});

describe('parsePolicyConfig: отказы по деньгам', () => {
  it('нечисловая сумма отвергается', () => {
    const error = captureError(() =>
      parsePolicyConfig({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        minLiquidity: { amount: 'abc', currency: 'USDC' },
      }),
    );

    expect(error).toBeInstanceOf(PolicyValidationError);
    expect(error.context?.field).toBe('minLiquidity.amount');
    expect(error.context?.value).toBe('abc');
  });

  it('неподдержанная валюта даёт ошибку ИМЕННО ПРО ВАЛЮТУ, а не про деньги вообще', () => {
    const error = captureError(() =>
      parsePolicyConfig({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        minLiquidity: { amount: 1000, currency: 'EUR' },
      }),
    );

    expect(error.context?.field).toBe('minLiquidity.currency');
    expect(error.context?.value).toBe('EUR');
    expect(error.context?.allowed).toEqual(['USDC']);
  });
});

describe('parsePolicyConfig: отказы по доле', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['нечисловая строка', 'abc'],
  ])('минимальный спред %s отвергается', (_name, value) => {
    const error = captureError(() =>
      parsePolicyConfig({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        minSpread: value,
      }),
    );

    expect(error).toBeInstanceOf(PolicyValidationError);
    expect(error.context?.field).toBe('minSpread');
  });
});

describe('parsePolicyConfig: отказы по границам окна', () => {
  it('неразбираемая дата отвергается с указанием ожидаемого формата', () => {
    const error = captureError(() =>
      parsePolicyConfig({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        effectiveFrom: 'tomorrow',
      }),
    );

    expect(error).toBeInstanceOf(PolicyValidationError);
    expect(error.context?.field).toBe('effectiveFrom');
    expect(error.context?.value).toBe('tomorrow');
    expect(error.context?.expected).toBe('ISO-8601');
  });

  it('ошибка различает effectiveFrom и effectiveUntil', () => {
    const error = captureError(() =>
      parsePolicyConfig({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        effectiveFrom: '2026-09-01T18:00:00Z',
        effectiveUntil: 'never',
      }),
    );

    expect(error.context?.field).toBe('effectiveUntil');
  });

  it('окно CEX-policy разбирается тем же кодом', () => {
    const error = captureError(() => parsePolicyConfig({ ...CEX_CONFIG, effectiveFrom: 'soon' }));

    expect(error.context?.field).toBe('effectiveFrom');
  });
});

describe('parsePolicyConfig: отказы CEX', () => {
  it.each([
    ['вид рынка вне словаря', 'futures'],
    ['чужой регистр', 'SPOT'],
  ])('%s (%p) отвергается фабрикой с перечислением допустимых', (_name, value) => {
    const error = captureError(() => parsePolicyConfig({ ...CEX_CONFIG, marketTypes: [value] }));

    expect(error).toBeInstanceOf(PolicyValidationError);
    expect(error.context?.field).toBe('marketTypes');
    expect(error.context?.value).toBe(value);
    expect(error.context?.allowed).toEqual(['spot', 'future', 'swap']);
  });

  it('policy без единого запрошенного потока отвергается', () => {
    const error = captureError(() =>
      parsePolicyConfig({ ...CEX_CONFIG, orderbook: false, trades: false }),
    );

    expect(error).toBeInstanceOf(PolicyValidationError);
    expect(error.context?.orderbook).toBe(false);
    expect(error.context?.trades).toBe(false);
  });

  it.each([
    ['exchangeIds', { ...CEX_CONFIG, exchangeIds: [] }],
    ['marketTypes', { ...CEX_CONFIG, marketTypes: [] }],
    ['symbols', { ...CEX_CONFIG, symbols: [] }],
  ])('пустой обязательный список (%s) отвергается фабрикой', (name, config) => {
    const error = captureError(() => parsePolicyConfig(config));

    expect(error.context?.field).toBe(name);
  });

  it('некорректная глубина стакана отвергается фабрикой', () => {
    const error = captureError(() => parsePolicyConfig({ ...CEX_CONFIG, orderbookDepth: 0 }));

    expect(error).toBeInstanceOf(PolicyValidationError);
    expect(error.context?.orderbookDepth).toBe(0);
  });
});

describe('parsePolicyConfig: неизвестный вид конфигурации', () => {
  it('kind вне union-а даёт PolicyValidationError, а не проваливается в switch', () => {
    // Конфигурация приходит из JSON.parse, где `kind` может быть чем угодно;
    // ветка `default` — единственное, что отделяет такой вход от `undefined`
    // вместо policy.
    const error = captureError(() =>
      parsePolicyConfig({ kind: 'WAT' } as unknown as PolicyConfig),
    );

    expect(error).toBeInstanceOf(PolicyValidationError);
    expect(error.context?.field).toBe('kind');
    expect(error.context?.value).toBe('WAT');
    expect(error.context?.allowed).toEqual(['POLYMARKET', 'CEX']);
  });

  it('отсутствующий kind тоже отвергается', () => {
    const error = captureError(() => parsePolicyConfig({} as unknown as PolicyConfig));

    expect(error.context?.field).toBe('kind');
    expect(error.context?.value).toBeUndefined();
  });
});

describe('parsePolicyConfig: правила фабрики действуют и через конфиг', () => {
  // Этот блок защищает от появления ВТОРОЙ системы валидации. Если парсер
  // однажды перестанет заканчиваться вызовом фабрики, тесты ниже покажут это
  // раньше, чем расхождение «через конфиг проходит, из кода нет» доедет до
  // отбора рынков.

  it('противоречивые title.required и title.excluded отвергаются', () => {
    const error = captureError(() =>
      parsePolicyConfig({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        title: { required: ['BTC'], excluded: ['btc'] },
      }),
    );

    expect(error).toBeInstanceOf(PolicyValidationError);
    expect(error.context?.field).toBe('title.required');
    expect(error.context?.conflictingKeywords).toEqual(['BTC']);
  });

  it('excluded, покрывающий весь anyOf, отвергается', () => {
    const error = captureError(() =>
      parsePolicyConfig({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        title: { anyOf: ['btc'], excluded: ['btc', 'testnet'] },
      }),
    );

    expect(error.context?.field).toBe('title.anyOf');
  });

  it('ключевые слова обрезаются и дедуплицируются фабрикой', () => {
    const policy = parsePolymarket({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      title: { excluded: ['  testnet ', 'testnet', 'demo'] },
    });

    expect(policy.title?.excluded).toEqual(['testnet', 'demo']);
  });

  it('дубли активов и длительностей схлопываются фабрикой', () => {
    const policy = parsePolymarket({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      assets: ['btc', 'eth', 'btc'],
      durations: ['5m', '5m', '15m'],
    });

    expect(policy.assets).toEqual([asCryptoAssetId('btc'), asCryptoAssetId('eth')]);
    expect(policy.durations).toEqual([asMarketDuration(300_000), asMarketDuration(900_000)]);
  });

  it('пустые списки схлопываются в отсутствие селектора', () => {
    const policy = parsePolymarket({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      assets: [],
      durations: [],
    });

    expect(policy.assets).toBeUndefined();
    expect(policy.durations).toBeUndefined();
  });

  it('невыполнимое окно отвергается фабрикой, а не парсером', () => {
    // Обе границы разбираются безупречно; невыполнимы они только ВМЕСТЕ, и
    // знает об этом фабрика.
    const error = captureError(() =>
      parsePolicyConfig({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        effectiveFrom: '2026-09-01T19:00:00Z',
        effectiveUntil: '2026-09-01T18:00:00Z',
      }),
    );

    expect(error).toBeInstanceOf(PolicyValidationError);
    expect(error.context?.effectiveFrom).toBe('2026-09-01T19:00:00.000Z');
    expect(error.context?.effectiveUntil).toBe('2026-09-01T18:00:00.000Z');
  });

  it('результат заморожен фабрикой', () => {
    expect(Object.isFrozen(parsePolicyConfig(POLYMARKET_CONFIG))).toBe(true);
  });

  it('CEX-списки обрезаются и дедуплицируются фабрикой', () => {
    const policy = parseCex({
      ...CEX_CONFIG,
      exchangeIds: [' binance ', 'binance'],
      marketTypes: [' spot ', 'spot'],
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'BTC/USDT:USDT'],
    });

    expect(policy.exchangeIds).toEqual(['binance']);
    expect(policy.marketTypes).toEqual(['spot']);
    expect(policy.symbols).toEqual(['BTC/USDT:USDT', 'ETH/USDT:USDT']);
  });
});

describe('parsePolicyConfig: результат совпадает с прямой сборкой policy', () => {
  it('конфиг и canonical-объект дают одинаковую policy', () => {
    // Главное утверждение всей границы: конфигурационная дверь и программная
    // ведут в одну и ту же комнату.
    const fromConfig = parsePolymarket(POLYMARKET_CONFIG);
    const parsedFrom = TimestampService.fromISO('2026-09-01T18:00:00Z');
    if (!parsedFrom.ok) throw new Error('bad fixture timestamp');

    expect(fromConfig.assets).toEqual([asCryptoAssetId('btc'), asCryptoAssetId('eth')]);
    expect(fromConfig.durations).toEqual([asMarketDuration(300_000), asMarketDuration(900_000)]);
    expect(fromConfig.effectiveFrom?.equals(parsedFrom.value)).toBe(true);
  });
});

describe('устойчивость к недоверенному входу (форма конфига)', () => {
  // Конфигурация приходит из JSON.parse/env, то есть ВНЕ системы типов.
  // До этих проверок шесть таких входов давали нативный TypeError без имени
  // поля, а два принимались МОЛЧА: `title: 'x'` давал policy вообще без
  // текстовых селекторов, `orderbook: 'yes'` проходил как истина.
  const MALFORMED: ReadonlyArray<readonly [string, unknown, string]> = [
    ['корень null', null, 'config'],
    ['корень undefined', undefined, 'config'],
    ['корень строка', '{}', 'config'],
    ['корень массив', [], 'config'],
    ['assets не массив', { kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN', assets: 'btc' }, 'assets'],
    ['assets[0] не строка', { kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN', assets: [1] }, 'assets[0]'],
    ['durations не массив', { kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN', durations: 5 }, 'durations'],
    ['title не объект', { kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN', title: 'x' }, 'title'],
    [
      'title.required не массив',
      { kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN', title: { required: 'a' } },
      'title.required',
    ],
    [
      'title.excluded[0] не строка',
      { kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN', title: { excluded: [7] } },
      'title.excluded[0]',
    ],
    ['family не строка', { kind: 'POLYMARKET', family: 7 }, 'family'],
    [
      'CEX exchangeIds null',
      { kind: 'CEX', exchangeIds: null, marketTypes: ['swap'], symbols: ['S'], orderbook: true, trades: true },
      'exchangeIds',
    ],
    [
      'CEX symbols не массив',
      { kind: 'CEX', exchangeIds: ['b'], marketTypes: ['swap'], symbols: 'S', orderbook: true, trades: true },
      'symbols',
    ],
    [
      'CEX orderbook не boolean',
      { kind: 'CEX', exchangeIds: ['b'], marketTypes: ['swap'], symbols: ['S'], orderbook: 'yes', trades: false },
      'orderbook',
    ],
    [
      'CEX trades отсутствует',
      { kind: 'CEX', exchangeIds: ['b'], marketTypes: ['swap'], symbols: ['S'], orderbook: true },
      'trades',
    ],
  ];

  it.each(MALFORMED)('%s → PolicyValidationError с полем %s', (_name, input, field) => {
    let caught: unknown;
    try {
      parsePolicyConfig(input as never);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PolicyValidationError);
    expect((caught as PolicyValidationError).context).toMatchObject({ field });
  });

  it('строка вместо title больше не даёт МОЛЧА policy без селекторов', () => {
    // Худший из прежних пропусков: конфигурация с опечаткой выглядела рабочей
    // и отбирала совсем не те рынки
    expect(() =>
      parsePolicyConfig({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        title: 'excluded-testnet',
      } as never),
    ).toThrow(PolicyValidationError);
  });

  it('корректный конфиг с булевыми потоками по-прежнему принимается', () => {
    const policy = parsePolicyConfig({
      kind: 'CEX',
      exchangeIds: ['binance'],
      marketTypes: ['swap'],
      symbols: ['BTC/USDT:USDT'],
      orderbook: false,
      trades: true,
    });

    expect(policy.orderbook).toBe(false);
    expect(policy.trades).toBe(true);
  });
});
