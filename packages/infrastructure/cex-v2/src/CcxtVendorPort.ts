/**
 * Vendor-граница CCXT / CCXT Pro: узкий структурный порт инстанса биржи и
 * фабрика реальных инстансов.
 *
 * @remarks
 * Порт описывает ТОЛЬКО те возможности CCXT Pro, которые использует
 * `CexSource` (public market data: стакан + сделки + lifecycle закрытия).
 * Полный API CCXT сюда сознательно не копируется: это структурный
 * `Pick`-подход к vendor-типизации вместо production `any`.
 *
 * Здесь же живут transport-compatibility таблицы, перенесённые из
 * production-поведения legacy-коллектора:
 *
 * - whitelist допустимых depth для спотовых стаканов бирж, которые падают
 *   на валидации произвольной глубины;
 * - keep-alive override-ы для бирж с агрессивными WS-дефолтами ccxt.pro.
 *
 * Это совместимость с транспортом конкретных vendor-ов, а НЕ семантическая
 * нормализация данных.
 */
import type { CexMarketType } from './CexExternalMessage.js';

/**
 * Сырой unified стакан, который возвращают `watchOrderBook*`/`fetchOrderBook`.
 *
 * @remarks
 * Живой объект внутреннего кэша CCXT Pro — мутируется vendor-ом после
 * возврата, поэтому перед публикацией source обязан снять снапшот
 * (см. `snapshotOrderBook`). Поля читаются транспортом только для routing
 * (`symbol`) и health-проверок (`bids`/`asks`).
 */
export interface CcxtRawOrderBook {
  readonly [field: string]: unknown;
  readonly symbol?: string | undefined;
  readonly bids?: ReadonlyArray<readonly (number | null | undefined)[]> | undefined;
  readonly asks?: ReadonlyArray<readonly (number | null | undefined)[]> | undefined;
}

/**
 * Сырая unified сделка, которую возвращают `watchTrades*`.
 *
 * @remarks
 * Транспорт читает только `symbol` (routing); остальное уходит в снапшот
 * payload как есть.
 */
export interface CcxtRawTrade {
  readonly [field: string]: unknown;
  readonly symbol?: string | undefined;
}

/**
 * WS-клиент ccxt.pro (структурно): закрывается при shutdown инстанса.
 */
export interface CcxtProClientLike {
  readonly close?: (() => Promise<unknown> | unknown) | undefined;
  readonly connection?: { readonly close?: (() => Promise<unknown> | unknown) | undefined } | undefined;
}

/**
 * Узкий структурный порт инстанса биржи ccxt.pro, используемый `CexSource`.
 *
 * @remarks
 * Все watch/fetch-методы опциональны — реальная поддержка проверяется через
 * `has`-capability map CCXT (как в legacy-коллекторе). Реальный инстанс
 * `new ccxt.pro.binance({...})` удовлетворяет порту структурно, без кастов.
 */
export interface CcxtProExchangeInstance {
  /** Capability-map CCXT: `has['watchOrderBookForSymbols']` и т.п. */
  readonly has?: Readonly<Record<string, unknown>> | undefined;
  /** Мультиплексная подписка на стаканы нескольких символов. */
  readonly watchOrderBookForSymbols?:
    | ((symbols: string[], limit?: number) => Promise<CcxtRawOrderBook>)
    | undefined;
  /** Подписка на стакан одного символа. */
  readonly watchOrderBook?: ((symbol: string, limit?: number) => Promise<CcxtRawOrderBook>) | undefined;
  /** REST-получение стакана одного символа. */
  readonly fetchOrderBook?: ((symbol: string, limit?: number) => Promise<CcxtRawOrderBook>) | undefined;
  /** Мультиплексная подписка на сделки нескольких символов. */
  readonly watchTradesForSymbols?: ((symbols: string[]) => Promise<readonly CcxtRawTrade[]>) | undefined;
  /** Подписка на сделки одного символа. */
  readonly watchTrades?: ((symbol: string) => Promise<readonly CcxtRawTrade[]>) | undefined;
  /** Открытые WS-клиенты инстанса (закрываются при shutdown). */
  readonly clients?: Readonly<Record<string, CcxtProClientLike | undefined>> | undefined;
  /** Закрытие инстанса (WS-соединения + внутренние ресурсы). */
  readonly close?: (() => Promise<unknown>) | undefined;
  /**
   * Внутренние кэши наблюдений CCXT Pro.
   *
   * @remarks
   * Объявлены в порту с единственной целью — ОСВОБОЖДАТЬ их у брошенного
   * инстанса (см. {@link releaseVendorCaches}). Читать их нельзя: источник
   * работает со значениями, которые возвращает сам `watch*`, а не с этими
   * мутабельными структурами.
   */
  readonly trades?: unknown;
  readonly orderbooks?: unknown;
  readonly myTrades?: unknown;
  readonly orders?: unknown;
}

/**
 * Параметры создания одного CCXT Pro инстанса.
 */
export interface CcxtProExchangeFactoryParams {
  /** Идентификатор биржи в ccxt.pro (напр. `binance`). */
  readonly exchangeId: string;
  /** Тип рынка (`options.defaultType`). */
  readonly marketType: CexMarketType;
  /** Эффективная глубина стакана (уже нормализованная по whitelist). */
  readonly depth: number;
}

/**
 * Фабрика инстансов биржи: production-реализация —
 * {@link createCcxtProExchange}; тесты инъецируют fake.
 */
export type CcxtProExchangeFactory = (
  params: CcxtProExchangeFactoryParams,
) => CcxtProExchangeInstance | Promise<CcxtProExchangeInstance>;

/**
 * Whitelist допустимых значений `depth` для спотового стакана по биржам.
 *
 * @remarks
 * Некоторые биржи принимают только фиксированные значения глубины и падают
 * на валидации при других. Для них запрошенное значение приводится к
 * ближайшему допустимому (не меньше). Например, bybit spot принимает
 * `[1, 50, 200, 1000]`, поэтому `depth=10` транслируется в `50`.
 * Перенесено из production-поведения legacy-коллектора.
 */
const SPOT_DEPTH_WHITELIST: Readonly<Record<string, readonly number[]>> = {
  bybit: [1, 50, 200, 1000],
  coinbase: [50],
};

/**
 * Переопределения keep-alive параметров для бирж с агрессивными дефолтами
 * ccxt.pro.
 *
 * @remarks
 * Базовый `Client` ccxt.pro таймаутит WS по формуле
 * `lastPong + keepAlive * maxPingPongMisses < now`; дефолты (18s × 2 = 36s)
 * на нестабильной сети приводят к ложным реконнектам. Override-ы уходят в
 * `options.ws` инстанса. Перенесено из production-поведения legacy-коллектора.
 */
interface KeepAliveOverride {
  /** Интервал между ping-ами клиента (ms). */
  readonly keepAlive?: number;
  /** Множитель таймаута на потерянные pong-и. */
  readonly maxPingPongMisses?: number;
}

const KEEP_ALIVE_OVERRIDES: Readonly<Record<string, KeepAliveOverride>> = {
  bybit: { keepAlive: 20_000, maxPingPongMisses: 3 },
  okx: { keepAlive: 20_000, maxPingPongMisses: 3 },
};

/** REST/WS timeout инстанса (ms) — как в legacy-коллекторе. */
const INSTANCE_TIMEOUT_MS = 30_000;

/**
 * Приводит запрошенную глубину стакана к допустимой для биржи.
 *
 * @param exchangeId - Идентификатор биржи в ccxt
 * @param marketType - Тип рынка (whitelist применяется только к spot)
 * @param depth - Запрошенная глубина
 * @returns Эффективная глубина: ближайшее допустимое значение не меньше
 *   запрошенного (или максимальное допустимое, если запрошено больше)
 *
 * @example
 * ```typescript
 * normalizeOrderbookDepth('bybit', 'spot', 10); // → 50
 * normalizeOrderbookDepth('binance', 'spot', 10); // → 10 (нет ограничений)
 * ```
 */
export function normalizeOrderbookDepth(
  exchangeId: string,
  marketType: CexMarketType,
  depth: number,
): number {
  if (marketType !== 'spot') return depth;
  const allowed = SPOT_DEPTH_WHITELIST[exchangeId];
  if (!allowed) return depth;
  for (const candidate of allowed) {
    if (candidate >= depth) return candidate;
  }
  return allowed[allowed.length - 1]!;
}

/** Кэш динамически загруженного модуля ccxt (модуль тяжёлый, грузим один раз). */
let ccxtModulePromise: Promise<typeof import('ccxt')> | null = null;

function loadCcxt(): Promise<typeof import('ccxt')> {
  if (!ccxtModulePromise) {
    ccxtModulePromise = import('ccxt');
  }
  return ccxtModulePromise;
}

/** Аргументы конструктора CCXT-инстанса, собранные фабрикой. */
export interface CcxtInstanceConstructorArgs {
  /** Встроенный rate-limiter CCXT включён. */
  readonly enableRateLimit: boolean;
  /**
   * REST/WS timeout инстанса (ms) — TOP-LEVEL свойство конструктора CCXT
   * (`this.timeout`); внутри `options` этот ключ инертен и не применяется.
   */
  readonly timeout: number;
  /** `options` инстанса (defaultType/newUpdates/watchOrderBook/ws). */
  readonly options: Readonly<Record<string, unknown>>;
}

/**
 * Собирает аргументы конструктора CCXT-инстанса для заданных параметров.
 *
 * @param params - Идентификатор биржи, тип рынка и эффективная глубина
 * @returns Аргументы `new ccxt.pro[exchangeId](...)`
 *
 * @remarks
 * Чистая функция, выделенная из {@link createCcxtProExchange} ради
 * детерминированной проверки контракта БЕЗ сети и без загрузки vendor-модуля:
 * `marketType` уходит в `options.defaultType` КАК ЕСТЬ — V2 говорит на
 * нативной unified-терминологии CCXT (`spot`/`future`/`swap`), никакой
 * скрытой конверсии `future → futures` нет.
 */
export function buildCcxtInstanceOptions(
  params: CcxtProExchangeFactoryParams,
): CcxtInstanceConstructorArgs {
  const keepAlive = KEEP_ALIVE_OVERRIDES[params.exchangeId];
  const wsOptions: Record<string, unknown> = {};
  if (keepAlive?.keepAlive !== undefined) wsOptions['keepAlive'] = keepAlive.keepAlive;
  if (keepAlive?.maxPingPongMisses !== undefined) {
    wsOptions['maxPingPongMisses'] = keepAlive.maxPingPongMisses;
  }

  const options: Record<string, unknown> = {
    defaultType: params.marketType,
    newUpdates: true,
    watchOrderBook: { checksum: false, limit: params.depth },
  };
  if (Object.keys(wsOptions).length > 0) options['ws'] = wsOptions;

  return { enableRateLimit: true, timeout: INSTANCE_TIMEOUT_MS, options };
}

/**
 * Production-фабрика: создаёт реальный CCXT Pro инстанс биржи.
 *
 * @param params - Идентификатор биржи, тип рынка и эффективная глубина
 * @returns Инстанс, структурно удовлетворяющий {@link CcxtProExchangeInstance}
 * @throws {Error} Если биржа не найдена в ccxt.pro
 *
 * @remarks
 * Аргументы инстанса:
 * - `timeout: 30s` — top-level свойство конструктора (в `options` он инертен);
 * - `options.defaultType` — тип рынка;
 * - `watchOrderBook: { checksum: false, limit }` — как в legacy;
 * - `newUpdates: true` — ЯВНОЕ закрепление контракта «watchTrades возвращает
 *   только новые сделки с прошлого вызова» (дефолт ccxt 4.x, пиним от
 *   будущих изменений дефолта);
 * - keep-alive override-ы для бирж из {@link KEEP_ALIVE_OVERRIDES}.
 *
 * @example
 * ```typescript
 * const instance = await createCcxtProExchange({
 *   exchangeId: 'binance',
 *   marketType: 'swap',
 *   depth: 10,
 * });
 * ```
 */
export async function createCcxtProExchange(
  params: CcxtProExchangeFactoryParams,
): Promise<CcxtProExchangeInstance> {
  const ccxt = await loadCcxt();
  // Vendor boundary: словарь классов ccxt.pro индексируется динамическим
  // exchangeId, статический тип const-объекта такого доступа не даёт.
  const proNamespace = ccxt.pro as unknown as Readonly<
    Record<string, (new (config: Record<string, unknown>) => CcxtProExchangeInstance) | undefined>
  >;
  const ExchangeClass = proNamespace[params.exchangeId];
  if (!ExchangeClass) {
    throw new Error(`Exchange '${params.exchangeId}' not found in ccxt.pro`);
  }

  const constructorArgs = buildCcxtInstanceOptions(params);
  return new ExchangeClass({
    enableRateLimit: constructorArgs.enableRateLimit,
    timeout: constructorArgs.timeout,
    options: { ...constructorArgs.options },
  });
}

/**
 * Освобождает одну структуру `ArrayCache` ccxt.pro.
 *
 * @param cache - Массив-кэш vendor-а
 * @returns `true`, если что-то было освобождено
 *
 * @remarks
 * `length = 0` НЕДОСТАТОЧНО. `ArrayCache` наследует `Array`, но подклассы
 * (`ArrayCacheBySymbolById`, `ArrayCacheBySymbolBySide`) держат ещё и
 * `hashmap` — индекс `symbol → id → item`, через который ссылки на объекты
 * переживают опустошение массива.
 *
 * При штатной работе `hashmap` чистится вытеснением: `append` удаляет из него
 * запись вытесненного элемента по достижении `maxSize`. Но `length = 0`
 * обходит `append` целиком, поэтому после него в индексе остаётся до
 * `maxSize` объектов на символ — у сделок это `tradesLimit`, то есть тысяча.
 *
 * Показательно, что и собственный `BaseCache.clear()` ccxt делает только
 * `length = 0`: полагаться на «вендор сам всё освободит» здесь нельзя.
 *
 * Ссылка на сам массив НЕ заменяется — у него собственный `append`, и подмена
 * сломала бы vendor-код (ловушка, найденная legacy откатом `d47fb7f6`).
 */
function releaseArrayCache(cache: unknown[]): boolean {
  const hashmap: unknown = (cache as unknown as Record<string, unknown>)['hashmap'];
  let released = cache.length > 0;
  cache.length = 0;
  if (hashmap !== null && typeof hashmap === 'object') {
    const index = hashmap as Record<string, unknown>;
    for (const key of Object.keys(index)) {
      delete index[key];
      released = true;
    }
  }
  return released;
}

/** Кэши CCXT Pro, которые освобождаются у брошенного инстанса. */
const VENDOR_CACHE_PROPERTIES = ['trades', 'orderbooks', 'myTrades', 'orders'] as const;

/**
 * Освобождает внутренние кэши наблюдений брошенного CCXT-инстанса.
 *
 * @param instance - Инстанс, который источник больше не использует
 * @returns Сколько кэш-структур было опустошено (для диагностики)
 *
 * @remarks
 * ### Зачем
 *
 * Инстансы переоткрываются планово (раз в 15 минут на пул) и аварийно.
 * Закрытие сокета НЕ освобождает накопленные `trades`/`orderbooks`: это
 * обычные объекты на самом инстансе, и они живут ровно столько, сколько
 * живёт ссылка на него. Пока `instance.close()` не завершился — а он может
 * зависнуть, ровно от этого защищает `closeTimeoutMs`, — инстанс жив вместе
 * со всеми своими стаканами.
 *
 * ### Почему не в `finally` закрытия, как было в legacy
 *
 * Legacy-сборщик чистил кэши в `.finally()` операции закрытия. Для нас этого
 * мало: интересующий случай — ЗАВИСШЕЕ закрытие, а у зависшего промиса
 * `finally` не выполняется никогда. Поэтому освобождение привязано к моменту
 * «мы перестали ждать», а не «закрытие завершилось».
 *
 * ### Почему `.length = 0`, а не переприсваивание
 *
 * `instance.trades[symbol]` — это `ArrayCache`, наследник `Array` с
 * собственным `append`. Замена ссылки на новый массив сломала бы vendor-код,
 * если он ещё держит эту структуру. Ту же ловушку legacy обнаружил откатом
 * (`fix: revert ccxt.pro trades cache reset — ArrayCache not a plain array`),
 * и повторять её не нужно.
 *
 * Идемпотентна: повторный вызов на уже очищенном инстансе безвреден.
 *
 * @example
 * ```typescript
 * releaseVendorCaches(instance); // → 2 (trades и orderbooks были непусты)
 * ```
 */
export function releaseVendorCaches(instance: CcxtProExchangeInstance): number {
  let released = 0;
  for (const property of VENDOR_CACHE_PROPERTIES) {
    const cache: unknown = (instance as Record<string, unknown>)[property];
    if (cache === null || typeof cache !== 'object') {
      continue;
    }
    if (Array.isArray(cache)) {
      if (releaseArrayCache(cache)) {
        released += 1;
      }
      continue;
    }
    // Карта «символ → ArrayCache»: опустошаем каждую запись НА МЕСТЕ, затем
    // снимаем сами ключи — сокращается и содержимое, и сама карта.
    const map = cache as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      const entry: unknown = map[key];
      if (Array.isArray(entry)) {
        releaseArrayCache(entry);
      }
      delete map[key];
      released += 1;
    }
  }
  return released;
}
