/**
 * Граница «plain config → canonical Policy»: единственный разбор конфигурации.
 *
 * @remarks
 * ### Зачем эта граница нужна ОТДЕЛЬНО от фабрик
 *
 * `createPolymarketPolicy` принимает УЖЕ canonical policy. Значит без этого
 * модуля превращать `'btc'` в `CryptoAssetId`, `'5m'` в `MarketDuration`,
 * `'1000'` в `Money`, `'0.02'` в `Ratio` и ISO-строку в `Timestamp` обязан
 * каждый вызывающий сам — а вызывающих у policy заведомо несколько: runtime
 * бота, коллектор, загрузчик стратегий, backtest. Четыре ad-hoc парсера
 * разойдутся не в день написания, а в день, когда один из них начнёт
 * принимать `'300000'` как «пять минут». Поэтому разбор конфигурации — ОДНА
 * функция, и других быть не должно.
 *
 * ### Парсер и фабрика — разные ответственности, и обе сохраняются
 *
 * ```text
 * parse*Config()      plain primitives → canonical types
 *        ↓
 * create*Policy()     нормализация, кросс-полевая валидация, иммутабельность
 * ```
 *
 * Парсер отвечает на вопрос «можно ли ВООБЩЕ прочитать это значение как
 * `MarketDuration`». Фабрика — на вопрос «складывается ли из прочитанных
 * значений осмысленная policy»: дедупликация, схлопывание пустых списков,
 * противоречие `required`/`excluded`, невыполнимое окно, словарь
 * `marketTypes`, `orderbook || trades`, глубина стакана. Ни одно из этих
 * правил здесь НЕ дублируется — каждый парсер заканчивается вызовом фабрики.
 *
 * Так у canonical-валидации остаётся ровно один путь: программный вызывающий
 * идёт в фабрику напрямую, конфигурационный — через парсер в ту же фабрику.
 * Скопировать сюда хоть одно правило фабрики значило бы завести вторую
 * систему валидации, и первым же расхождением стало бы «через конфиг
 * проходит, из кода — нет».
 *
 * ### Почему используются safe-конструкторы, а не приведения типов
 *
 * Конфигурация — НЕДОВЕРЕННЫЙ источник: `unsafeCryptoAssetId` и
 * `as MarketDuration` здесь означали бы, что мусор из файла становится
 * canonical-значением, ни разу не будучи проверенным, и падает потом — в
 * сравнении с рынком, за несколько слоёв от места, где его завели. Поэтому
 * применяются только safe-варианты (`asCryptoAssetId`, `asMarketDuration`,
 * `isValidMarketFamily`, `isSupportedCurrency`) и `Result`-сервисы
 * (`MoneyService`, `RatioService`, `TimestampService`).
 *
 * ### Почему `throw`, а не `Result`
 *
 * Та же причина, что у фабрик: у вызывающего нет ветки «продолжить с
 * испорченной policy». Ошибка одна — {@link PolicyValidationError}, и её
 * `context` НАЗЫВАЕТ поле вместе с индексом элемента (`assets[1]`,
 * `durations[0]`): «policy невалидна» оставило бы читателю ровно ту задачу
 * поиска, ради устранения которой проверка и написана.
 *
 * @example
 * ```typescript
 * const policy = parsePolicyConfig({
 *   kind: 'POLYMARKET',
 *   family: 'CRYPTO_UP_DOWN',
 *   assets: ['btc', 'eth'],
 *   durations: ['5m', '15m'],
 *   minLiquidity: { amount: '1000', currency: 'USDC' },
 *   minSpread: '0.02',
 *   effectiveFrom: '2026-09-01T18:00:00Z',
 * });
 * ```
 */
import { SUPPORTED_CURRENCIES, asCryptoAssetId, isSupportedCurrency } from '@polymarket/ids';
import type { CryptoAssetId, SupportedCurrency } from '@polymarket/ids';
import { MARKET_FAMILY_VALUES, asMarketDuration, isValidMarketFamily } from '@polymarket/market';
import type { MarketDuration, MarketFamily } from '@polymarket/market';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { MoneyService, RatioService } from '@polymarket/value-objects';
import type { Money, Ratio } from '@polymarket/value-objects';
import type { CexPolicy } from './CexPolicy.js';
import type { Policy } from './Policy.js';
import type { PolicyWindow } from './PolicyWindow.js';
import type {
  PolymarketPolicy,
  PolymarketPolicyTitleSelectors,
} from './PolymarketPolicy.js';
import { POLICY_CONFIG_KIND_VALUES } from './PolicyConfig.js';
import type { CexPolicyConfig, PolicyConfig, PolymarketPolicyConfig } from './PolicyConfig.js';
import { PolicyValidationError, createCexPolicy, createPolymarketPolicy } from './createPolicy.js';

/**
 * Единицы измерения длительности и их вес в миллисекундах.
 *
 * @internal
 * @remarks
 * `Map`, а не объект-словарь: `get()` возвращает `number | undefined` без
 * единого приведения типа, тогда как индексация объекта произвольной строкой
 * потребовала бы `as`. Ровно из этой карты выводятся и регулярное выражение,
 * и текст ожидаемого формата в ошибке — иначе список поддержанных единиц
 * пришлось бы держать в трёх местах, и разошлись бы они на первой же новой
 * единице.
 *
 * Минуты и часы, и ничего сверх: номиналы серий Polymarket измеряются в них
 * (`5m`, `15m`, `1h`, `4h`). Секунды и сутки не добавлены не «на всякий
 * случай не хватило», а потому что серий такой длительности нет — а формат,
 * принимающий больше, чем существует, лишь расширяет пространство опечаток,
 * которые пройдут молча.
 */
const DURATION_UNIT_MS: ReadonlyMap<string, number> = new Map([
  ['m', 60_000],
  ['h', 60 * 60_000],
]);

/**
 * Допустимые единицы, перечисленные для регулярного выражения и сообщений.
 *
 * @internal
 */
const DURATION_UNITS = [...DURATION_UNIT_MS.keys()].join('|');

/**
 * Формат номинала серии: `<число><единица>`.
 *
 * @internal
 * @remarks
 * Якоря обязательны: без них `'5m and more'` совпало бы частично и превратило
 * бы мусор в валидную длительность.
 */
const DURATION_PATTERN = new RegExp(`^(\\d+)(${DURATION_UNITS})$`);

/**
 * Человекочитаемое описание формата для `context.expected`.
 *
 * @internal
 */
const DURATION_FORMAT = `<number><${DURATION_UNITS}>`;

/**
 * Требует, чтобы значение было ОБЪЕКТОМ-записью.
 *
 * @param value - Значение из недоверенного источника
 * @param field - Имя поля для сообщения об ошибке
 * @returns То же значение, суженное до записи
 * @throws {PolicyValidationError} Если значение не объект, `null` либо массив
 *
 * @internal
 * @remarks
 * Массив исключается отдельно: `typeof [] === 'object'`, и без этой проверки
 * `[]` прошёл бы как конфигурация, а чтение полей дало бы `undefined` —
 * то есть молча пустую policy вместо ошибки.
 */
function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PolicyValidationError('Policy config field must be an object', {
      context: { field, value, actualType: Array.isArray(value) ? 'array' : typeof value },
    });
  }
  return value as Record<string, unknown>;
}

/**
 * Требует, чтобы значение было МАССИВОМ.
 *
 * @param value - Значение из недоверенного источника
 * @param field - Имя поля для сообщения об ошибке
 * @returns То же значение, суженное до массива
 * @throws {PolicyValidationError} Если значение не массив
 *
 * @internal
 * @remarks
 * Без этой проверки строка в поле списка (`assets: 'btc'`) доходила бы до
 * `.map()` и давала нативный `TypeError` — ошибку без поля и без значения,
 * то есть ровно то, чего граница конфигурации существует, чтобы избежать.
 */
function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new PolicyValidationError('Policy config field must be an array', {
      context: { field, value, actualType: typeof value },
    });
  }
  return value;
}

/**
 * Требует, чтобы значение было БУЛЕВЫМ.
 *
 * @param value - Значение из недоверенного источника
 * @param field - Имя поля для сообщения об ошибке
 * @returns То же значение, суженное до `boolean`
 * @throws {PolicyValidationError} Если значение не `boolean`
 *
 * @internal
 * @remarks
 * Строгая проверка, а не приведение к истинности: `orderbook: 'no'` — строка
 * истинная, и мягкое приведение включило бы поток, который автор конфигурации
 * выключал. Ошибка здесь дешевле, чем лишняя подписка в проде.
 */
function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new PolicyValidationError('Policy config field must be a boolean', {
      context: { field, value, actualType: typeof value },
    });
  }
  return value;
}

/**
 * Требует, чтобы значение конфигурации было строкой.
 *
 * @param value - Значение как оно пришло из источника
 * @param field - Имя поля для сообщения об ошибке
 * @returns То же значение, суженное до `string`
 * @throws {PolicyValidationError} Если значение строкой не является
 *
 * @internal
 * @remarks
 * Типы {@link PolicyConfig} описывают ДОГОВОР, а не гарантию: конфигурация
 * приходит из `JSON.parse`, где в поле может оказаться число, `null` или
 * объект. Без этой проверки `.trim()` на таком значении дал бы `TypeError` —
 * ошибку, по которой не видно ни поля, ни того, что виноват конфиг.
 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new PolicyValidationError('Policy config field must be a string', {
      context: { field, value, actualType: typeof value },
    });
  }
  return value;
}

/**
 * Разбирает значение семейства рынков.
 *
 * @param raw - Значение поля `family`
 * @returns Проверенное {@link MarketFamily}
 * @throws {PolicyValidationError} Если значение не принадлежит
 *   {@link MARKET_FAMILY_VALUES}
 *
 * @internal
 * @remarks
 * Проверка идёт через `isValidMarketFamily` — единственный словарь семейств
 * живёт в домене, и заводить его копию здесь значило бы получить второй
 * список, который отстанет от первого.
 *
 * Окружающие пробелы срезаются (форматирование YAML смысла не несёт), а
 * регистр — нет: `'crypto_up_down'` может быть и опечаткой, и чужим
 * словарём, и молчаливое приведение скрыло бы расхождение вместо того, чтобы
 * показать его.
 */
function parseFamily(raw: unknown): MarketFamily {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  if (!isValidMarketFamily(value)) {
    throw new PolicyValidationError('Policy config family is not a supported market family', {
      context: { field: 'family', value: raw, allowed: [...MARKET_FAMILY_VALUES] },
    });
  }
  return value;
}

/**
 * Разбирает список строк недоверенной конфигурации.
 *
 * @param raw - Значение поля-списка
 * @param field - Имя поля для сообщения об ошибке
 * @returns Список строк
 * @throws {PolicyValidationError} Если значение не массив либо элемент не строка
 *
 * @internal
 * @remarks
 * Содержимое НЕ нормализуется и не проверяется по смыслу: обрезку,
 * дедупликацию, непустоту и принадлежность словарю делает фабрика. Здесь
 * только форма — иначе те же правила существовали бы в двух местах.
 */
function parseStringList(raw: unknown, field: string): readonly string[] {
  return requireArray(raw, field).map((value, index) =>
    requireString(value, `${field}[${index}]`),
  );
}

/**
 * Разбирает текстовые селекторы недоверенной конфигурации.
 *
 * @param raw - Значение поля `title`
 * @returns Селекторы либо `undefined`, если поля нет
 * @throws {PolicyValidationError} Если `title` не объект либо любой из его
 *   списков не массив строк
 *
 * @internal
 * @remarks
 * Раньше `title` передавался в фабрику КАК ЕСТЬ, и это был худший из
 * пропусков: `title: 'x'` не падало вовсе — строка не имеет полей
 * `required`/`anyOf`/`excluded`, все три читались как `undefined`, и policy
 * молча получалась БЕЗ текстовых селекторов. Конфигурация с опечаткой
 * выглядела бы рабочей и отбирала бы совсем не те рынки.
 *
 * Сами слова не трогаем: обрезку, дедупликацию и поиск противоречий делает
 * фабрика.
 */
function parseTitleSelectors(raw: unknown): PolymarketPolicyTitleSelectors | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const title = requireRecord(raw, 'title');
  const parseList = (key: 'required' | 'anyOf' | 'excluded'): readonly string[] | undefined =>
    title[key] === undefined ? undefined : parseStringList(title[key], `title.${key}`);

  const required = parseList('required');
  const anyOf = parseList('anyOf');
  const excluded = parseList('excluded');

  return {
    ...(required !== undefined ? { required } : {}),
    ...(anyOf !== undefined ? { anyOf } : {}),
    ...(excluded !== undefined ? { excluded } : {}),
  };
}

/**
 * Разбирает список тикеров базовых активов.
 *
 * @param raw - Значение поля `assets` (может отсутствовать)
 * @returns Список canonical-идентификаторов либо `undefined`, если поля нет
 * @throws {PolicyValidationError} Если хотя бы один элемент не проходит
 *   `asCryptoAssetId`
 *
 * @internal
 * @remarks
 * Ошибка называет ИНДЕКС элемента: список активов в конфиге длинный, и
 * сообщение «какой-то актив невалиден» заставило бы искать виновника
 * глазами.
 *
 * Пустой список НЕ схлопывается здесь — он передаётся фабрике, потому что
 * «пусто означает отсутствие ограничения» — правило policy, а не формата
 * записи, и жить оно должно в одном месте.
 */
function parseAssets(raw: unknown): readonly CryptoAssetId[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const items = requireArray(raw, 'assets');
  return items.map((value, index) => {
    const field = `assets[${index}]`;
    const asset = asCryptoAssetId(requireString(value, field));
    if (asset === undefined) {
      throw new PolicyValidationError('Policy config asset is not a valid crypto asset id', {
        context: { field, value },
      });
    }
    return asset;
  });
}

/**
 * Разбирает один номинал серии из записи вида `5m` / `1h`.
 *
 * @param raw - Значение элемента `durations`
 * @param field - Имя поля с индексом, например `durations[0]`
 * @returns Проверенный {@link MarketDuration} в миллисекундах
 * @throws {PolicyValidationError} Если запись не соответствует формату
 *   {@link DURATION_FORMAT} либо полученная длительность отвергнута
 *   `asMarketDuration`
 *
 * @internal
 * @remarks
 * ### Почему формат ровно один
 *
 * Принимать заодно `'5'` и `'300000'` означало бы, что парсер УГАДЫВАЕТ
 * единицу измерения по величине числа. Ровно так и появляется рынок,
 * подписанный на «пять миллисекунд»: `300000` в поле длительности одинаково
 * правдоподобно читается и как миллисекунды, и как перепутанные секунды.
 * Единица пишется явно — тогда угадывать нечего.
 *
 * ### Почему результат всё равно прогоняется через `asMarketDuration`
 *
 * Регулярное выражение подтверждает только ФОРМУ записи. `'0m'` ей
 * соответствует, но нулевой длительности не бывает; `'99999h'` соответствует
 * тоже, но это уже не номинал серии. Оба случая отсекает доменный
 * конструктор — и он же остаётся единственным местом, где эти границы
 * записаны.
 */
function parseDuration(raw: unknown, field: string): MarketDuration {
  const text = requireString(raw, field).trim();
  const match = DURATION_PATTERN.exec(text);
  if (match === null) {
    throw new PolicyValidationError('Policy config duration has an unsupported format', {
      context: { field, value: raw, expected: DURATION_FORMAT },
    });
  }
  const unitMs = DURATION_UNIT_MS.get(match[2] ?? '');
  const milliseconds = Number(match[1]) * (unitMs ?? Number.NaN);
  const duration = asMarketDuration(milliseconds);
  if (duration === undefined) {
    throw new PolicyValidationError('Policy config duration is not a valid market duration', {
      context: { field, value: raw, milliseconds },
    });
  }
  return duration;
}

/**
 * Разбирает список номиналов серий.
 *
 * @param raw - Значение поля `durations` (может отсутствовать)
 * @returns Список canonical-номиналов либо `undefined`, если поля нет
 * @throws {PolicyValidationError} Через {@link parseDuration}
 *
 * @internal
 */
function parseDurations(raw: unknown): readonly MarketDuration[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const items = requireArray(raw, 'durations');
  return items.map((value, index) => parseDuration(value, `durations[${index}]`));
}

/**
 * Разбирает валюту.
 *
 * @param raw - Значение поля валюты
 * @param field - Полное имя поля, например `minLiquidity.currency`
 * @returns Проверенная {@link SupportedCurrency}
 * @throws {PolicyValidationError} Если валюта вне `SUPPORTED_CURRENCIES`
 *
 * @internal
 * @remarks
 * Валюта проверяется ОТДЕЛЬНО от суммы, хотя `MoneyService.create` и сам
 * отверг бы неподдержанную: сообщение сервиса говорит про деньги в целом, а
 * автору конфига нужно знать, что виновата именно валюта и что допустимых
 * значений всего столько-то. Это не дубль правила — правило одно и живёт в
 * `SUPPORTED_CURRENCIES`, — а адресность ошибки на границе.
 */
function parseCurrency(raw: unknown, field: string): SupportedCurrency {
  const value = requireString(raw, field).trim();
  if (!isSupportedCurrency(value)) {
    throw new PolicyValidationError('Policy config currency is not supported', {
      context: { field, value: raw, allowed: [...SUPPORTED_CURRENCIES] },
    });
  }
  return value;
}

/**
 * Разбирает денежный порог.
 *
 * @param raw - Значение поля `minLiquidity`
 * @param field - Имя поля, например `minLiquidity`
 * @returns Canonical {@link Money}
 * @throws {PolicyValidationError} Если валюта не поддержана либо сумма не
 *   разбирается
 *
 * @internal
 * @remarks
 * Сумма создаётся через `MoneyService.create`, а не через `Decimal`: голый
 * `Decimal` — внутреннее представление value-objects, в этом пакете он даже
 * не рантайм-зависимость, и обходить сервис значило бы обходить его
 * инварианты (NaN, Infinity, предельная сумма).
 */
function parseMoney(
  raw: { readonly amount: string | number; readonly currency: string },
  field: string,
): Money {
  const currency = parseCurrency(raw.currency, `${field}.currency`);
  const created = MoneyService.create(raw.amount, currency);
  if (!created.ok) {
    throw new PolicyValidationError('Policy config money amount is not a valid amount', {
      context: {
        field: `${field}.amount`,
        value: raw.amount,
        currency,
        cause: created.error.message,
      },
    });
  }
  return created.value;
}

/**
 * Разбирает долю (спред) из десятичной дроби.
 *
 * @param raw - Значение поля, `'0.02'` — это 2 %
 * @param field - Имя поля, например `minSpread`
 * @returns Canonical {@link Ratio}
 * @throws {PolicyValidationError} Если значение не число, `NaN` либо `Infinity`
 *
 * @internal
 * @remarks
 * `fromDecimal`, а не `fromPercent`: `Ratio` внутри — дробь, и принимать в
 * конфиге проценты значило бы, что `0.02` в файле и `0.02` в коде означают
 * разное (2 % против 0.02 %). Проверку `NaN`/`Infinity`/нечисловой строки
 * делает сам сервис — здесь она не повторяется, только переводится в
 * доменную ошибку с именем поля.
 */
function parseRatio(raw: string | number, field: string): Ratio {
  const created = RatioService.fromDecimal(raw);
  if (!created.ok) {
    throw new PolicyValidationError('Policy config ratio is not a valid decimal fraction', {
      context: { field, value: raw, cause: created.error.message },
    });
  }
  return created.value;
}

/**
 * Разбирает момент времени из ISO-8601.
 *
 * @param raw - Значение поля, например `'2026-09-01T18:00:00Z'`
 * @param field - Имя поля, `effectiveFrom` либо `effectiveUntil`
 * @returns Canonical {@link Timestamp}
 * @throws {PolicyValidationError} Если строка не разбирается как ISO-8601
 *
 * @internal
 * @remarks
 * Только ISO-8601: эпоха в миллисекундах и эпоха в секундах в поле
 * конфигурации выглядят одинаково (`1767290400` против `1767290400000`
 * различает лишь длина), и принимать их означало бы угадывать единицу.
 */
function parseTimestamp(raw: unknown, field: string): Timestamp {
  const value = requireString(raw, field).trim();
  const parsed = TimestampService.fromISO(value);
  if (!parsed.ok) {
    throw new PolicyValidationError('Policy config timestamp is not a valid ISO-8601 instant', {
      context: { field, value: raw, expected: 'ISO-8601', cause: parsed.error.message },
    });
  }
  return parsed.value;
}

/**
 * Разбирает границы окна применимости.
 *
 * @param config - Конфигурация любого вида policy
 * @returns Окно с canonical-границами (отсутствующие поля опущены)
 * @throws {PolicyValidationError} Через {@link parseTimestamp}
 *
 * @internal
 * @remarks
 * Общий для обоих видов policy: окно описано одним и тем же `PolicyWindow`, и
 * два его разбора разошлись бы в первом же исправлении.
 *
 * СОГЛАСОВАННОСТЬ границ (`effectiveFrom < effectiveUntil`) здесь НЕ
 * проверяется — это правило policy, и живёт оно в фабриках.
 */
function parseWindow(config: PolicyConfig): PolicyWindow {
  return {
    ...(config.effectiveFrom !== undefined
      ? { effectiveFrom: parseTimestamp(config.effectiveFrom, 'effectiveFrom') }
      : {}),
    ...(config.effectiveUntil !== undefined
      ? { effectiveUntil: parseTimestamp(config.effectiveUntil, 'effectiveUntil') }
      : {}),
  };
}

/**
 * Превращает конфигурацию Polymarket-policy в canonical {@link PolymarketPolicy}.
 *
 * @param config - Plain-конфигурация из файла, env либо JSON
 * @returns Замороженная canonical policy
 * @throws {PolicyValidationError} Если поле не разбирается (`context.field`
 *   называет его вместе с индексом элемента) либо если собранная policy
 *   отвергнута `createPolymarketPolicy`
 *
 * @remarks
 * Заканчивается вызовом `createPolymarketPolicy`, и это не деталь реализации,
 * а суть: дедупликация активов, схлопывание пустых списков, нормализация
 * ключевых слов, противоречие `required`/`excluded` и проверка окна остаются
 * в фабрике. Парсер переводит примитивы в canonical-типы и не более того —
 * иначе правила отбора существовали бы в двух экземплярах и первым же
 * расхождением стало бы «через конфиг проходит, из кода — нет».
 *
 * `title` передаётся В ТОМ ВИДЕ, В КАКОМ ПРИШЁЛ: обрезка, отсев пустых слов и
 * дедупликация — работа фабрики, а не формата записи.
 *
 * Входная конфигурация не мутируется: `map` строит новые массивы, объект
 * собирается заново.
 *
 * @example
 * ```typescript
 * const policy = parsePolymarketPolicyConfig({
 *   kind: 'POLYMARKET',
 *   family: 'CRYPTO_UP_DOWN',
 *   assets: ['btc'],
 *   durations: ['5m'],
 * });
 *
 * policy.durations?.[0]; // → 300000 as MarketDuration
 * ```
 */
export function parsePolymarketPolicyConfig(config: PolymarketPolicyConfig): PolymarketPolicy {
  const root = requireRecord(config, 'config');
  const assets = parseAssets(root['assets']);
  const durations = parseDurations(root['durations']);
  const title = parseTitleSelectors(root['title']);

  return createPolymarketPolicy({
    kind: 'POLYMARKET',
    family: parseFamily(root['family']),
    ...(assets !== undefined ? { assets } : {}),
    ...(durations !== undefined ? { durations } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(config.minLiquidity !== undefined
      ? { minLiquidity: parseMoney(config.minLiquidity, 'minLiquidity') }
      : {}),
    ...(config.minSpread !== undefined
      ? { minSpread: parseRatio(config.minSpread, 'minSpread') }
      : {}),
    ...parseWindow(config),
  });
}

/**
 * Превращает конфигурацию CEX-policy в canonical {@link CexPolicy}.
 *
 * @param config - Plain-конфигурация из файла, env либо JSON
 * @returns Замороженная canonical policy
 * @throws {PolicyValidationError} Если границы окна не разбираются либо если
 *   собранная policy отвергнута `createCexPolicy` (пустой обязательный
 *   список, вид рынка вне словаря, ни одного запрошенного потока,
 *   некорректная глубина, невыполнимое окно)
 *
 * @remarks
 * Разбирать здесь почти нечего, и это ПРАВИЛЬНО: `exchangeIds` и `symbols` —
 * открытые множества строк в нотации биржи (canonical-типа для них нет и
 * быть не может), `orderbook`/`trades`/`orderbookDepth` — примитивы, а
 * `marketTypes` сужает сама фабрика (см. `CexPolicyInput`). Единственная
 * настоящая конверсия — окно применимости.
 *
 * Именно поэтому `marketTypes` НЕ проверяются здесь предикатом: словарь
 * `CEX_POLICY_MARKET_TYPE_VALUES` уже проверяется в фабрике, и вторая
 * проверка означала бы второе сообщение об ошибке про то же самое.
 *
 * @example
 * ```typescript
 * const policy = parseCexPolicyConfig({
 *   kind: 'CEX',
 *   exchangeIds: ['binance'],
 *   marketTypes: ['swap'],
 *   symbols: ['BTC/USDT:USDT'],
 *   orderbook: true,
 *   trades: false,
 *   orderbookDepth: 10,
 * });
 * ```
 */
export function parseCexPolicyConfig(config: CexPolicyConfig): CexPolicy {
  const root = requireRecord(config, 'config');

  return createCexPolicy({
    kind: 'CEX',
    exchangeIds: parseStringList(root['exchangeIds'], 'exchangeIds'),
    marketTypes: parseStringList(root['marketTypes'], 'marketTypes'),
    symbols: parseStringList(root['symbols'], 'symbols'),
    orderbook: requireBoolean(root['orderbook'], 'orderbook'),
    trades: requireBoolean(root['trades'], 'trades'),
    ...(root['orderbookDepth'] !== undefined
      ? { orderbookDepth: root['orderbookDepth'] as number }
      : {}),
    ...parseWindow(config),
  });
}

/**
 * Строит ошибку о неизвестном виде конфигурации.
 *
 * @param config - Значение, не совпавшее ни с одной ветвью `switch`
 * @returns Готовая к броску ошибка
 *
 * @internal
 * @remarks
 * Параметр типа `never` — компиляционная страховка: добавление третьего вида
 * в {@link PolicyConfig} без ветви в {@link parsePolicyConfig} перестанет
 * компилироваться, потому что `config` в `default` больше не сузится до
 * `never`. Та же функция закрывает и RUNTIME-случай: конфигурация приходит из
 * `JSON.parse`, где `kind` может оказаться `'WAT'`, и провалиться в `switch`
 * без ветви значило бы вернуть `undefined` вместо policy.
 */
function unknownPolicyConfigKind(config: never): PolicyValidationError {
  const { kind } = config as { readonly kind?: unknown };
  return new PolicyValidationError('Policy config has an unknown kind', {
    context: { field: 'kind', value: kind, allowed: [...POLICY_CONFIG_KIND_VALUES] },
  });
}

/**
 * Превращает plain-конфигурацию в canonical {@link Policy}.
 *
 * @param config - Конфигурация любого вида
 * @returns Замороженная canonical policy соответствующего вида
 * @throws {PolicyValidationError} При любой проблеме конфигурации: неизвестный
 *   `kind`, неразбираемое поле (`context.field` называет его вместе с индексом
 *   элемента) либо отказ фабрики
 *
 * @remarks
 * ЕДИНСТВЕННАЯ публичная точка входа для конфигурационных вызывающих. Разбор
 * и сборка policy разделены (см. TSDoc модуля), но снаружи это один вызов:
 * консументу конфигурации не нужно знать, что валидация двухэтапная, ему
 * нужно, чтобы мусор не доехал до отбора рынков.
 *
 * Fail-fast: возвращается либо полностью собранная policy, либо ошибка.
 * Частично собранной policy, `undefined` и `null` в контракте нет — «почти
 * правильная» policy означает, что consumer получит не то, что просил, и
 * заметит это по пустому результату фильтрации.
 *
 * @example
 * ```typescript
 * const policies = rawConfigs.map(parsePolicyConfig);
 *
 * try {
 *   parsePolicyConfig({ kind: 'WAT' } as unknown as PolicyConfig);
 * } catch (error) {
 *   (error as PolicyValidationError).context?.field; // → 'kind'
 * }
 * ```
 *
 * @remarks
 * Перегрузки сужают результат по виду конфига: разбор
 * `PolymarketPolicyConfig` возвращает `PolymarketPolicy`, а не union.
 * Без этого каждый вызывающий, передавший заведомо известный конфиг, был бы
 * обязан сузить результат сам — и `filter.filter(entries, policy, now)`,
 * ради которого разбор и делается, не скомпилировался бы без ручной
 * проверки `kind`. Union-перегрузка остаётся для случая, когда вид конфига
 * действительно неизвестен (например, конфиг пришёл из `JSON.parse`).
 */
export function parsePolicyConfig(config: PolymarketPolicyConfig): PolymarketPolicy;
export function parsePolicyConfig(config: CexPolicyConfig): CexPolicy;
export function parsePolicyConfig(config: PolicyConfig): Policy;
export function parsePolicyConfig(config: PolicyConfig): Policy {
  // Конфигурация приходит из `JSON.parse`, то есть ВНЕ системы типов:
  // `null` вместо объекта — обычный результат пустого файла, и без этой
  // проверки чтение `.kind` дало бы нативный TypeError без имени поля.
  requireRecord(config, 'config');

  switch (config.kind) {
    case 'POLYMARKET':
      return parsePolymarketPolicyConfig(config);
    case 'CEX':
      return parseCexPolicyConfig(config);
    default:
      throw unknownPolicyConfigKind(config);
  }
}
