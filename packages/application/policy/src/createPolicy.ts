/**
 * Фабрики owner policy: нормализация и проверка при СОЗДАНИИ.
 *
 * @remarks
 * ### Почему проверка на входе, а не при применении
 *
 * Policy — программная конфигурация: её собирает разработчик или загрузчик
 * конфига, а не внешний недоверенный источник. Противоречивое окно
 * (`effectiveFrom >= effectiveUntil`) или пустой строковый селектор — это
 * дефект настройки, и обнаружить его нужно там, где его можно исправить:
 * при сборке policy. Отложить до применения значило бы получить не ошибку,
 * а тихо пустой результат фильтрации — симптом, по которому причину не
 * найти.
 *
 * ### Почему `throw`, а не `Result`
 *
 * Fail-fast: у вызывающего нет ветки «продолжить с испорченной policy» —
 * такая policy означает, что consumer получит не то, что просил. Заводить
 * ради этого отдельную иерархию ошибок не за что: подходит существующий
 * `ValidationError` контура.
 *
 * ### Что делает нормализация
 *
 * Снимает у селекторов различия, не несущие смысла: дубликаты в списках и
 * окружающие пробелы у ключевых слов. Пустые после обрезки строки
 * выбрасываются — селектор `''` совпал бы с любым текстом и незаметно
 * превратил бы «фильтр по слову» в «пропустить всё».
 *
 * Входные массивы не мутируются: policy собирают из общих констант, и
 * править их на месте значило бы менять чужую конфигурацию.
 *
 * ### Почему проверяются ещё и ПРОТИВОРЕЧИЯ МЕЖДУ полями
 *
 * Отдельно валидное поле не делает валидной policy. Окно
 * `effectiveFrom >= effectiveUntil` собрано из двух безупречных
 * `Timestamp`, и невыполнимо оно только вместе; ровно так же слово,
 * попавшее и в `required`, и в `excluded`, безупречно как слово и
 * невыполнимо как пара. Класс дефекта один, симптом один — пустой
 * результат фильтрации без единого признака причины, — поэтому и проверка
 * одна по смыслу: отвергнуть селектор, который не совпадёт НИКОГДА, там,
 * где ещё видно, из чего он собран.
 *
 * ### Почему union-значения проверяются в runtime
 *
 * Ограничения TypeScript действуют только на типизированных вызывающих, а
 * policy собирают из конфигурационных файлов и переменных окружения, где
 * `marketTypes` — обычный `string[]`. Значение `'futures'` прошло бы
 * fail-fast валидацию и дало бы policy, которую граница транспорта не
 * сможет отобразить: тихий отказ на шаг дальше от места, где его завели.
 * Поэтому union проверяется по списку значений, а не по вере в типы
 * вызывающего.
 */
import { ValidationError } from '@polymarket/errors';
import type { CryptoAssetId } from '@polymarket/ids';
import type { MarketDuration } from '@polymarket/market';
import type { PolicyWindow } from './PolicyWindow.js';
import type { CexPolicy, CexPolicyMarketType } from './CexPolicy.js';
import type { PolymarketPolicy, PolymarketPolicyTitleSelectors } from './PolymarketPolicy.js';

/**
 * Ошибка некорректной policy.
 *
 * @remarks
 * Отдельный класс, а не голый `Error`: по нему загрузчик конфигурации
 * отличает «policy собрана неверно» от любой другой ошибки запуска.
 */
export class PolicyValidationError extends ValidationError {}

/**
 * Список всех допустимых значений {@link CexPolicyMarketType}.
 *
 * @remarks
 * Union существует только на этапе компиляции, а policy приходит из
 * конфигурации: чтобы отвергнуть `'futures'` в runtime, нужно
 * МАТЕРИАЛИЗОВАННОЕ множество допустимых значений. Конвенция повторяет
 * `MARKET_FAMILY_VALUES` из `@polymarket/market` — там же, где тип, лежит
 * его runtime-словарь, и он же служит списком «допустимо вот это» в
 * сообщении об ошибке.
 *
 * Аннотация `readonly CexPolicyMarketType[]` не декоративна: она делает
 * расхождение списка с union-ом ошибкой компиляции, поэтому добавление
 * четвёртого вида рынка не может забыть про этот файл.
 *
 * @example
 * ```typescript
 * CEX_POLICY_MARKET_TYPE_VALUES.includes('spot'); // → true
 * ```
 */
export const CEX_POLICY_MARKET_TYPE_VALUES: readonly CexPolicyMarketType[] = [
  'spot',
  'future',
  'swap',
] as const;

/**
 * Проверяет согласованность окна применимости.
 *
 * @param window - Окно policy
 * @throws {PolicyValidationError} Если `effectiveFrom >= effectiveUntil`
 *
 * @internal
 * @remarks
 * Окно, у которого начало не раньше конца, не действует НИКОГДА: интервал
 * полуоткрыт, поэтому даже равные границы дают пустое множество моментов.
 * Это всегда опечатка, и молча принять её значило бы отдать policy,
 * которая не совпадёт ни с одним рынком без единого признака почему.
 */
function assertValidWindow(window: PolicyWindow): void {
  const { effectiveFrom, effectiveUntil } = window;
  if (effectiveFrom === undefined || effectiveUntil === undefined) {
    return;
  }
  if (!effectiveFrom.isBefore(effectiveUntil)) {
    throw new PolicyValidationError('Policy effectiveFrom must be before effectiveUntil', {
      context: {
        effectiveFrom: effectiveFrom.toISO(),
        effectiveUntil: effectiveUntil.toISO(),
      },
    });
  }
}

/**
 * Убирает дубликаты, сохраняя порядок первого появления.
 *
 * @param values - Исходный список
 * @returns Новый список без дубликатов
 *
 * @internal
 */
function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * Нормализует список ключевых слов: обрезка, отсев пустых, дедупликация.
 *
 * @param keywords - Исходный список (может отсутствовать)
 * @returns Нормализованный список либо `undefined`, если селектора нет
 * @throws {PolicyValidationError} Если после обрезки список стал пустым,
 *   хотя во входе были строки
 *
 * @internal
 * @remarks
 * Разница между «селектора нет» и «селектор состоит из мусора» существенна:
 * первое — осознанное «фильтр выключен», второе — дефект конфигурации
 * (`excluded: ['   ']`), который без проверки превратился бы в тихо
 * выключенный фильтр.
 */
function normalizeKeywords(
  keywords: readonly string[] | undefined,
  field: string,
): readonly string[] | undefined {
  if (keywords === undefined || keywords.length === 0) {
    return undefined;
  }
  const trimmed = distinct(keywords.map((keyword) => keyword.trim()).filter((k) => k !== ''));
  if (trimmed.length === 0) {
    throw new PolicyValidationError('Policy keyword selector contains only blank keywords', {
      context: { field, keywords: [...keywords] },
    });
  }
  return Object.freeze(trimmed);
}

/**
 * Приводит ключевое слово к форме, в которой его сравнивает матчинг.
 *
 * @param keyword - Нормализованное ключевое слово
 * @returns Слово в нижнем регистре
 *
 * @internal
 * @remarks
 * `MarketFilter` компилирует ключевые слова в регексы под флагами `iu`,
 * то есть `BTC` и `btc` для матчинга — ОДНО слово. Сравнивать селекторы
 * побайтово значило бы пропустить ровно то противоречие, которое матчинг
 * потом увидит.
 *
 * `toLowerCase()`, а не `toLocaleLowerCase()`: флаг `i` не зависит от
 * локали процесса, и локале-зависимое приведение (турецкое `I` → `ı`)
 * разошлось бы с поведением, которое проверка призвана предсказать.
 */
function foldKeyword(keyword: string): string {
  return keyword.toLowerCase();
}

/**
 * Отвергает текстовые селекторы, которые не совпадут ни с одним рынком.
 *
 * @param required - Нормализованные обязательные слова (либо `undefined`)
 * @param anyOf - Нормализованные альтернативы (либо `undefined`)
 * @param excluded - Нормализованные запрещённые слова (либо `undefined`)
 * @throws {PolicyValidationError} Если `required` пересекается с `excluded`
 *   либо `excluded` покрывает ВЕСЬ `anyOf`
 *
 * @internal
 * @remarks
 * Правила выведены из семантики матчинга, а не назначены:
 *
 * - `required` требует ПРИСУТСТВИЯ каждого слова, `excluded` — отсутствия
 *   каждого. Общее слово даёт условие «есть и нет одновременно»:
 *   невыполнимо ВСЕГДА, ни для какого текста;
 * - `anyOf` требует присутствия ХОТЯ БЫ ОДНОГО слова. Пересечение с
 *   `excluded` само по себе безобидно — сработает любое другое слово
 *   списка, — но если запрещено КАЖДОЕ, выполнимых альтернатив не
 *   остаётся, и селектор снова пуст всегда;
 * - `required ∩ anyOf` — ИЗБЫТОЧНОСТЬ, а не противоречие: обязательное
 *   слово попутно закрывает и требование «хотя бы одно». Такая policy
 *   работает и совпадает с рынками, поэтому отвергать её значило бы
 *   запрещать корректную конфигурацию за стилистику.
 *
 * Проверка идёт ПОСЛЕ нормализации: до неё `' btc '` и `'btc'` — разные
 * строки, и противоречие между ними осталось бы незамеченным.
 *
 * Ошибка называет конкретные слова: сообщение «policy невалидна» оставило
 * бы читателю ровно ту задачу поиска, ради устранения которой проверка и
 * добавлена.
 */
function assertNonContradictorySelectors(
  required: readonly string[] | undefined,
  anyOf: readonly string[] | undefined,
  excluded: readonly string[] | undefined,
): void {
  if (excluded === undefined) {
    return;
  }
  const forbidden = new Set(excluded.map(foldKeyword));

  if (required !== undefined) {
    const conflicting = required.filter((keyword) => forbidden.has(foldKeyword(keyword)));
    if (conflicting.length > 0) {
      throw new PolicyValidationError(
        'Policy title selector both requires and excludes the same keyword',
        {
          context: {
            field: 'title.required',
            conflictingKeywords: conflicting,
            excluded: [...excluded],
          },
        },
      );
    }
  }

  // `length > 0` — не мёртвая ветка при пустом `anyOf`: `[].every()` даёт
  // `true`, и без явной проверки отсутствующий селектор объявлялся бы
  // невыполнимым. (`normalizeKeywords` пустых списков не возвращает, но
  // корректность этой проверки не должна зависеть от чужого инварианта.)
  if (
    anyOf !== undefined &&
    anyOf.length > 0 &&
    anyOf.every((keyword) => forbidden.has(foldKeyword(keyword)))
  ) {
    throw new PolicyValidationError('Policy title selector excludes every anyOf keyword', {
      context: {
        field: 'title.anyOf',
        conflictingKeywords: [...anyOf],
        excluded: [...excluded],
      },
    });
  }
}

/**
 * Нормализует селекторы по тексту рынка.
 *
 * @param title - Исходные селекторы
 * @returns Нормализованные селекторы либо `undefined`, если ни один не задан
 * @throws {PolicyValidationError} Через {@link normalizeKeywords} — при
 *   мусорном селекторе; через {@link assertNonContradictorySelectors} — при
 *   межполевом противоречии
 *
 * @internal
 */
function normalizeTitle(
  title: PolymarketPolicyTitleSelectors | undefined,
): PolymarketPolicyTitleSelectors | undefined {
  if (title === undefined) {
    return undefined;
  }
  const required = normalizeKeywords(title.required, 'title.required');
  const anyOf = normalizeKeywords(title.anyOf, 'title.anyOf');
  const excluded = normalizeKeywords(title.excluded, 'title.excluded');
  if (required === undefined && anyOf === undefined && excluded === undefined) {
    return undefined;
  }
  assertNonContradictorySelectors(required, anyOf, excluded);
  return Object.freeze({
    ...(required !== undefined ? { required } : {}),
    ...(anyOf !== undefined ? { anyOf } : {}),
    ...(excluded !== undefined ? { excluded } : {}),
  });
}

/**
 * Собирает проверенную и нормализованную {@link PolymarketPolicy}.
 *
 * @param input - Желаемая policy (входные массивы не мутируются)
 * @returns Замороженная policy с нормализованными селекторами
 * @throws {PolicyValidationError} При противоречивом окне, мусорных ключевых
 *   словах либо невыполнимых текстовых селекторах (одно слово в `required` и
 *   `excluded`; весь `anyOf` внутри `excluded`)
 *
 * @remarks
 * Пустые списки `assets`/`durations` схлопываются в `undefined` — это одно и
 * то же утверждение «ограничения нет», и хранить два его представления
 * значило бы заставлять каждого потребителя проверять оба.
 *
 * Текстовые селекторы проверяются не только поодиночке, но и НА ПАРУ: см.
 * {@link assertNonContradictorySelectors}. Регистр при этом не важен —
 * матчинг регистронезависим, поэтому `BTC` и `btc` конфликтуют.
 *
 * @example
 * ```typescript
 * const policy = createPolymarketPolicy({
 *   kind: 'POLYMARKET',
 *   family: 'CRYPTO_UP_DOWN',
 *   assets: [btc, btc],                  // → [btc]
 *   title: { excluded: [' testnet ', ''] }, // → ['testnet']
 * });
 *
 * // Невыполнимо всегда: слово требуется и запрещено одновременно.
 * createPolymarketPolicy({
 *   kind: 'POLYMARKET',
 *   family: 'CRYPTO_UP_DOWN',
 *   title: { required: ['BTC'], excluded: ['btc'] },
 * }); // → PolicyValidationError
 * ```
 */
export function createPolymarketPolicy(input: PolymarketPolicy): PolymarketPolicy {
  assertValidWindow(input);

  const assets: readonly CryptoAssetId[] | undefined =
    input.assets === undefined || input.assets.length === 0
      ? undefined
      : Object.freeze(distinct(input.assets));
  const durations: readonly MarketDuration[] | undefined =
    input.durations === undefined || input.durations.length === 0
      ? undefined
      : Object.freeze(distinct(input.durations));
  const title = normalizeTitle(input.title);

  return Object.freeze({
    kind: 'POLYMARKET' as const,
    family: input.family,
    ...(assets !== undefined ? { assets } : {}),
    ...(durations !== undefined ? { durations } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(input.minLiquidity !== undefined ? { minLiquidity: input.minLiquidity } : {}),
    ...(input.minSpread !== undefined ? { minSpread: input.minSpread } : {}),
    ...(input.effectiveFrom !== undefined ? { effectiveFrom: input.effectiveFrom } : {}),
    ...(input.effectiveUntil !== undefined ? { effectiveUntil: input.effectiveUntil } : {}),
  });
}

/**
 * Собирает проверенную и нормализованную {@link CexPolicy}.
 *
 * @param input - Желаемая policy (входные массивы не мутируются)
 * @returns Замороженная policy с дедуплицированными списками
 * @throws {PolicyValidationError} При пустом обязательном списке, виде рынка
 *   вне {@link CEX_POLICY_MARKET_TYPE_VALUES}, отсутствии запрошенных данных,
 *   некорректной глубине либо противоречивом окне
 *
 * @remarks
 * `marketTypes` проверяется по значениям, а не по типу вызывающего: policy
 * приходит из конфигурации, где union ничего не гарантирует (см.
 * {@link normalizeMarketTypes}). Регистр значим — `'SPOT'` отвергается.
 *
 * В отличие от Polymarket-policy, здесь списки ОБЯЗАТЕЛЬНЫ и пустыми быть
 * не могут: `assets: []` у Polymarket означает «любой актив из технически
 * доступных», а `symbols: []` у биржи не означает «все символы» — оно не
 * означает ничего, потому что подписаться «на всё» у CEX нельзя. То же с
 * `orderbook`/`trades`: policy, не запросившая ни одного потока, описывает
 * подписку без данных.
 *
 * @example
 * ```typescript
 * const policy = createCexPolicy({
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
export function createCexPolicy(input: CexPolicy): CexPolicy {
  assertValidWindow(input);

  const exchangeIds = normalizeRequiredList(input.exchangeIds, 'exchangeIds');
  const marketTypes = normalizeMarketTypes(input.marketTypes);
  const symbols = normalizeRequiredList(input.symbols, 'symbols');

  if (!input.orderbook && !input.trades) {
    throw new PolicyValidationError('CEX policy must request orderbook, trades, or both', {
      context: { orderbook: input.orderbook, trades: input.trades },
    });
  }

  if (input.orderbookDepth !== undefined) {
    const depth = input.orderbookDepth;
    if (!Number.isInteger(depth) || depth <= 0) {
      throw new PolicyValidationError('CEX policy orderbookDepth must be a positive integer', {
        context: { orderbookDepth: depth },
      });
    }
  }

  return Object.freeze({
    kind: 'CEX' as const,
    exchangeIds,
    marketTypes,
    symbols,
    orderbook: input.orderbook,
    trades: input.trades,
    ...(input.orderbookDepth !== undefined ? { orderbookDepth: input.orderbookDepth } : {}),
    ...(input.effectiveFrom !== undefined ? { effectiveFrom: input.effectiveFrom } : {}),
    ...(input.effectiveUntil !== undefined ? { effectiveUntil: input.effectiveUntil } : {}),
  });
}

/**
 * Нормализует обязательный непустой список.
 *
 * @param values - Исходный список
 * @param field - Имя поля для сообщения об ошибке
 * @returns Замороженный список без дубликатов
 * @throws {PolicyValidationError} Если список пуст либо состоит из пустых строк
 *
 * @internal
 */
function normalizeRequiredList<T extends string>(values: readonly T[], field: string): readonly T[] {
  const normalized = distinct(values.map((v) => v.trim() as T).filter((v) => v !== ''));
  if (normalized.length === 0) {
    throw new PolicyValidationError('CEX policy list selector must not be empty', {
      context: { field, values: [...values] },
    });
  }
  return Object.freeze(normalized);
}

/**
 * Type guard: допустимый ли это вид рынка CEX.
 *
 * @param value - Проверяемая строка (обычно из конфигурации)
 * @returns `true`, если значение принадлежит union-у
 * @throws Ничего не бросает
 *
 * @internal
 * @example
 * ```typescript
 * isCexPolicyMarketType('swap');    // → true
 * isCexPolicyMarketType('futures'); // → false
 * ```
 */
function isCexPolicyMarketType(value: string): value is CexPolicyMarketType {
  return (CEX_POLICY_MARKET_TYPE_VALUES as readonly string[]).includes(value);
}

/**
 * Нормализует и проверяет `marketTypes` на принадлежность union-у.
 *
 * @param values - Виды рынков как они пришли (в типе поля, но не обязательно
 *   в его значениях)
 * @returns Замороженный список без дубликатов, каждый элемент которого
 *   ДОКАЗАННО принадлежит {@link CexPolicyMarketType}
 * @throws {PolicyValidationError} Если список пуст после обрезки либо
 *   содержит значение вне union-а
 *
 * @internal
 * @remarks
 * ### Почему обрезка пробелов — да, а приведение регистра — нет
 *
 * Обрезка однозначна: `' spot '` и `'spot'` — одно и то же значение,
 * записанное с форматированием YAML/CSV, пробелы вокруг токена смысла не
 * несут и восстанавливать по ним нечего. Смена регистра меняет САМ токен:
 * приняв `'SPOT'`, мы бы решили за автора конфигурации, что он имел в виду
 * `'spot'`, — а `'SPOT'` может быть и опечаткой, и чужим словарём (у
 * vendor-ов виды рынков пишутся по-разному), и тогда молчаливое приведение
 * скроет расхождение словарей вместо того, чтобы показать его. Поэтому
 * решение — ОТВЕРГАТЬ: ровно так же строг `isValidMarketFamily`, и
 * единственный словарь допустимых написаний дешевле двух похожих.
 *
 * ### Почему это не generic-ветка `normalizeRequiredList`
 *
 * У `exchangeIds` и `symbols` множество значений ОТКРЫТО: список бирж и
 * символов задаёт vendor, и захардкодить его здесь было бы враньём. У
 * `marketTypes` оно закрыто и объявлено union-ом — разная природа полей, а
 * не разная строгость к одному и тому же.
 *
 * Возврат строится накоплением, а не приведением типа: guard сужает каждый
 * элемент по отдельности, и результат типизирован потому, что проверен, а
 * не потому, что так написано в `as`.
 */
function normalizeMarketTypes(values: readonly string[]): readonly CexPolicyMarketType[] {
  const normalized = normalizeRequiredList(values, 'marketTypes');
  const checked: CexPolicyMarketType[] = [];
  for (const value of normalized) {
    if (!isCexPolicyMarketType(value)) {
      throw new PolicyValidationError('CEX policy marketTypes contains an unsupported value', {
        context: {
          field: 'marketTypes',
          value,
          allowed: [...CEX_POLICY_MARKET_TYPE_VALUES],
        },
      });
    }
    checked.push(value);
  }
  return Object.freeze(checked);
}
