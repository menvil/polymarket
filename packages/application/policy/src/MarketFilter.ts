/**
 * Применение owner policy к записям universe: подходит рынок или нет.
 *
 * @remarks
 * ### Что здесь решается и что НЕ решается
 *
 * Фильтр отвечает ровно на один вопрос — «хочет ли ЭТА policy ВОТ ЭТОТ
 * рынок в ЭТОТ момент». Он ничего не ранжирует (это `MarketScorer`), ничего
 * не считает (top-N выбирает потребитель через `ranked.slice(0, n)`) и не
 * знает про подписки, lead-time и жизненный цикл рынка — это Subscription
 * Planner следующего этапа.
 *
 * ### Почему `matches()` — основной API, а `filter()` — оболочка
 *
 * Массовый отбор («что подходит прямо сейчас») — не единственный вопрос к
 * policy. Планировщику подписок нужен другой: «будет ли policy действовать
 * в момент старта ВОТ ЭТОГО рынка» — то есть `matches(entry, policy,
 * entry.market.startsAt)`. Поэтому момент оценки приходит АРГУМЕНТОМ и
 * никогда не берётся из самого рынка: зашитый внутрь `market.startsAt`
 * ответил бы только на второй вопрос и молча сломал бы первый.
 *
 * ### Чего фильтр сознательно не делает
 *
 * - **не дедуплицирует.** Идентичность `venueId + marketId` — инвариант
 *   `PolymarketMarketDiscovery` и `MarketUniverse`. Фильтр получает записи
 *   готового universe, и «на всякий случай» чинить source of truth второй
 *   раз означало бы поддерживать два места, где живёт одно правило;
 * - **не бросает.** Одна структурно несогласованная запись (рынок
 *   `CRYPTO_UP_DOWN` без crypto-спецификации, ликвидность в чужой валюте)
 *   отклоняется, а не роняет отбор всего universe: цена исключения одного
 *   рынка — один рынок, цена исключения обхода — пустой отбор.
 *
 * ### Порядок проверок
 *
 * От дешёвых к дорогим: окно policy → семейство → актив → номинал серии →
 * ликвидность → спред → ключевые слова. Первые четыре — сравнения
 * примитивов, последняя — прогон регулярных выражений по тексту, и на
 * реальном universe она отсекает меньше всего.
 */
import type { MarketDiscoveryEntry } from '@polymarket/ports';
import type { Timestamp } from '@polymarket/timestamp';
import { MoneyService } from '@polymarket/value-objects';
import { isPolicyEffectiveAt } from './PolicyWindow.js';
import type { PolymarketPolicy, PolymarketPolicyTitleSelectors } from './PolymarketPolicy.js';

/**
 * Спецсимволы регулярных выражений, требующие экранирования.
 *
 * @internal
 * @remarks
 * Ключевые слова приходят из конфигурации как обычный текст: `$50`, `c++`,
 * `a.b`, `foo(bar)` — законные селекторы, а не паттерны. Без экранирования
 * `c++` был бы синтаксически невалидным regex, а `a.b` совпал бы с `axb`.
 *
 * Набор совместим с флагом `u`: под ним разрешены identity-escape только
 * для синтаксических символов, и здесь экранируются ровно они (дефис,
 * слэш и прочая пунктуация остаются как есть — под `u` их экранирование
 * было бы ошибкой).
 */
const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

/**
 * Пустой список регексов — общий immutable-синглтон.
 *
 * @internal
 */
const NO_REGEXES: readonly RegExp[] = Object.freeze([]);

/**
 * Компилирует ключевые слова в регексы с ЮНИКОДНЫМИ границами слова.
 *
 * @param keywords - Список ключевых слов (может отсутствовать/быть пустым)
 * @returns Массив скомпилированных регексов (пустой — ограничения нет)
 * @throws Ничего не бросает: спецсимволы экранируются до компиляции
 *
 * @internal
 * @remarks
 * Границы заданы явными lookbehind/lookahead, а НЕ `\b`: `\b` работает по
 * классу `[A-Za-z0-9_]`, поэтому в текстах площадки с апострофами, дефисами
 * и подчёркиваниями его поведение непредсказуемо (`covid` внутри `COVID-19`
 * — совпадение, `war` внутри `reward` — нет, но объяснить это по `\b`
 * нельзя). Lookaround говорит правило прямо: ключевое слово не должно быть
 * частью более длинного буквенно-цифрового токена.
 *
 * Класс границы — `[\p{L}\p{N}\p{M}]` под флагами `iu`, а не ASCII
 * `[a-zA-Z0-9]`, ровно по тем же причинам, что и в
 * `PolymarketCryptoUpDownClassifier`:
 *
 * - `\p{L}`/`\p{N}` — с ASCII-классом любая нелатинская буква считалась бы
 *   пунктуацией, и `Биткоинup` дал бы совпадение по слову `up`, хотя `up`
 *   там — часть чужого слова. Vendor не обязан публиковать латиницу;
 * - `\p{M}` — комбинирующие знаки. Одна и та же строка представима слитно
 *   (NFC) и разложенно (NFD), нормализацию площадка не гарантирует, и в
 *   разложенной форме последним символом слова оказывается комбинирующий
 *   знак, а не буква. Без `\p{M}` он читался бы как разделитель — тот же
 *   дефект, просто уровнем ниже.
 *
 * Флаг `i` даёт регистронезависимость (в том числе для нелатиницы), поэтому
 * `toLowerCase()` над вопросом не нужен. Флаг `g` НЕ ставится сознательно:
 * с ним `RegExp.test` тащит `lastIndex` между вызовами, и один и тот же
 * регекс, переиспользованный по списку рынков, давал бы разные ответы.
 */
function compileKeywords(keywords: readonly string[] | undefined): readonly RegExp[] {
  if (keywords === undefined || keywords.length === 0) {
    return NO_REGEXES;
  }
  return keywords.map((keyword) => {
    const escaped = keyword.replace(REGEX_SPECIAL_CHARS, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escaped}(?![\\p{L}\\p{N}\\p{M}])`, 'iu');
  });
}

/**
 * Скомпилированные текстовые селекторы policy.
 *
 * @internal
 * @remarks
 * Существует ровно ради одного: компиляция регексов стоит на порядок
 * дороже прогона, и на обходе universe она обязана произойти ОДИН раз, а не
 * на каждой записи. При этом `MarketFilter.matches()` должен работать
 * самостоятельно — значит, общее место для «скомпилировать» и «проверить»
 * нужно обоим, иначе правило матчинга существовало бы в двух копиях.
 *
 * Публичной абстракцией не является и из пакета не экспортируется: снаружи
 * контур знает только `MarketFilter`, а появление второго публичного типа
 * («матчер») означало бы, что policy можно применять в обход фильтра.
 */
class KeywordMatcher {
  private constructor(
    private readonly _required: readonly RegExp[],
    private readonly _anyOf: readonly RegExp[],
    private readonly _excluded: readonly RegExp[],
  ) {}

  /**
   * Компилирует селекторы policy в переиспользуемый матчер.
   *
   * @param selectors - Текстовые селекторы policy (могут отсутствовать)
   * @returns Матчер; при отсутствии селекторов пропускает любой текст
   * @throws Ничего не бросает
   *
   * @internal
   */
  public static compile(selectors: PolymarketPolicyTitleSelectors | undefined): KeywordMatcher {
    return new KeywordMatcher(
      compileKeywords(selectors?.required),
      compileKeywords(selectors?.anyOf),
      compileKeywords(selectors?.excluded),
    );
  }

  /**
   * Удовлетворяет ли текст рынка всем трём селекторам.
   *
   * @param question - Вопрос рынка КАК ЕСТЬ (регистр не важен, флаг `i`)
   * @returns `true`, если все `required` найдены, хотя бы одно `anyOf`
   *   найдено и ни одно `excluded` не найдено
   * @throws Ничего не бросает
   *
   * @internal
   * @remarks
   * Пустой список любого из трёх селекторов означает «ограничения нет» —
   * та же семантика пустоты, что и у самой policy: конфигурация приходит из
   * файлов и переменных окружения, где пустой список — обычный способ
   * выключить фильтр.
   */
  public matches(question: string): boolean {
    if (!this._required.every((regex) => regex.test(question))) {
      return false;
    }
    if (this._anyOf.length > 0 && !this._anyOf.some((regex) => regex.test(question))) {
      return false;
    }
    if (this._excluded.some((regex) => regex.test(question))) {
      return false;
    }
    return true;
  }
}

/**
 * Отбор записей universe по owner policy Polymarket.
 *
 * @remarks
 * Stateless: экземпляр не хранит ничего между вызовами, поэтому один
 * фильтр безопасно разделять между несколькими policy и потребителями.
 *
 * @example
 * ```typescript
 * const filter = new MarketFilter();
 * const wanted = filter.filter(universe.getAll(), policy, clock.nowTimestamp());
 * ```
 */
export class MarketFilter {
  /**
   * Подходит ли ОДНА запись universe под policy в указанный момент.
   *
   * @param entry - Запись universe: canonical рынок + наблюдения по нему
   * @param policy - Owner policy площадки Polymarket
   * @param evaluationTime - Момент, НА который оценивается policy
   * @returns `true`, если рынок удовлетворяет всем селекторам policy
   * @throws Ничего не бросает: любая несогласованность записи — это `false`
   *
   * @remarks
   * Атомарный API контура. Отдельный от `filter()` он нужен потому, что
   * вопрос «действует ли policy» задаётся на РАЗНЫЕ моменты: runtime
   * спрашивает про «сейчас», планировщик подписок — про `entry.market.startsAt`
   * конкретного рынка, backtest — про момент из архива. Момент выбирает
   * вызывающий, и рынок свой момент оценки себе не назначает.
   *
   * Порядок проверок — от дешёвых к дорогим (см. TSDoc модуля); первым идёт
   * окно policy, потому что недействующая policy не подходит НИКАКОМУ рынку
   * и остальные сравнения были бы работой впустую.
   *
   * @example
   * ```typescript
   * // «Хотим ли мы этот рынок сейчас?»
   * filter.matches(entry, policy, now);
   *
   * // «Будет ли policy действовать, когда этот рынок откроется?»
   * filter.matches(entry, policy, entry.market.startsAt);
   * ```
   */
  public matches(
    entry: MarketDiscoveryEntry,
    policy: PolymarketPolicy,
    evaluationTime: Timestamp,
  ): boolean {
    if (!this._matchesNonTitleSelectors(entry, policy, evaluationTime)) {
      return false;
    }
    // Компиляция выполняется ТОЛЬКО если запись дошла до текстовых
    // селекторов: на одной записи это дешевле, а на списке компиляцию
    // выносит наружу filter().
    return KeywordMatcher.compile(policy.title).matches(entry.market.question);
  }

  /**
   * Отбирает записи universe, подходящие под policy в указанный момент.
   *
   * @param entries - Записи universe (вход не мутируется)
   * @param policy - Owner policy площадки Polymarket
   * @param evaluationTime - Момент, НА который оценивается policy
   * @returns Новый массив подошедших записей В ПОРЯДКЕ ВХОДА
   * @throws Ничего не бросает
   *
   * @remarks
   * Оболочка над {@link matches}: результат поэлементно совпадает с
   * применением `matches()` к каждой записи — свойство, зафиксированное
   * тестом, потому что именно оно позволяет планировщику пользоваться
   * атомарным API, не рискуя получить другой отбор.
   *
   * Порядок входа сохраняется: `entries` приходят в детерминированном
   * ТЕХНИЧЕСКОМ порядке discovery, и переупорядочивание здесь молча
   * подменяло бы ранжирование, которым фильтр не занимается.
   *
   * Регексы текстовых селекторов компилируются ОДИН раз на вызов, а не на
   * каждую запись: на обходе universe в несколько сотен рынков разница
   * между «скомпилировать один раз» и «скомпилировать на каждой записи» —
   * это вся стоимость фильтрации.
   *
   * @example
   * ```typescript
   * const wanted = filter.filter(snapshot.entries, policy, snapshot.observedAt);
   * console.log(`Policy selected ${wanted.length} of ${snapshot.entries.length} markets`);
   * ```
   */
  public filter(
    entries: readonly MarketDiscoveryEntry[],
    policy: PolymarketPolicy,
    evaluationTime: Timestamp,
  ): MarketDiscoveryEntry[] {
    const keywords = KeywordMatcher.compile(policy.title);
    return entries.filter(
      (entry) =>
        this._matchesNonTitleSelectors(entry, policy, evaluationTime) &&
        keywords.matches(entry.market.question),
    );
  }

  /**
   * Проверяет все селекторы, кроме текстовых.
   *
   * @param entry - Запись universe
   * @param policy - Owner policy
   * @param evaluationTime - Момент оценки policy
   * @returns `true`, если запись прошла проверки 1–6
   *
   * @internal
   * @remarks
   * Вынесено отдельно, чтобы `matches()` и `filter()` использовали ОДНУ
   * реализацию правил, отличаясь только тем, где компилируются регексы.
   */
  private _matchesNonTitleSelectors(
    entry: MarketDiscoveryEntry,
    policy: PolymarketPolicy,
    evaluationTime: Timestamp,
  ): boolean {
    // 1. Окно policy: недействующая policy не подходит никакому рынку.
    if (!isPolicyEffectiveAt(policy, evaluationTime)) {
      return false;
    }

    // 2. Семейство: селекторы ниже осмысленны только внутри своего семейства.
    if (policy.family !== entry.market.family) {
      return false;
    }

    // 3–4. Предметная спецификация семейства CRYPTO_UP_DOWN.
    if (!this._passesAssetSelector(entry, policy)) {
      return false;
    }
    if (!this._passesDurationSelector(entry, policy)) {
      return false;
    }

    // 5–6. Наблюдения площадки рядом с рынком.
    if (!this._passesLiquiditySelector(entry, policy)) {
      return false;
    }
    return this._passesSpreadSelector(entry, policy);
  }

  /**
   * Проверяет базовый криптоактив рынка.
   *
   * @param entry - Запись universe
   * @param policy - Owner policy
   * @returns `true`, если селектор выключен либо актив рынка в списке
   *
   * @internal
   * @remarks
   * Отсутствие `market.crypto` даёт `false`, а не пропуск: до этой проверки
   * семейство уже совпало, и если policy спрашивает про актив, то рынок —
   * `CRYPTO_UP_DOWN`, у которого спецификация обязательна по инварианту
   * `Market.create()`. Её отсутствие означает структурно несогласованную
   * запись, и «пропустить» такую значило бы отдать потребителю рынок с
   * неизвестным активом под видом запрошенного.
   */
  private _passesAssetSelector(entry: MarketDiscoveryEntry, policy: PolymarketPolicy): boolean {
    const assets = policy.assets;
    if (assets === undefined || assets.length === 0) {
      return true;
    }
    const asset = entry.market.crypto?.asset;
    if (asset === undefined) {
      return false;
    }
    return assets.includes(asset);
  }

  /**
   * Проверяет НОМИНАЛ серии рынка.
   *
   * @param entry - Запись universe
   * @param policy - Owner policy
   * @returns `true`, если селектор выключен либо номинал серии в списке
   *
   * @internal
   * @remarks
   * Сравнивается `market.crypto.duration` — номинал серии, и НИКОГДА
   * `market.duration()`. Это разные величины: номинал — классификация
   * («рынок 5-минутной серии»), `duration()` — фактическое окно
   * `expiresAt - startsAt`, которое площадка вправе сдвинуть (задержка
   * публикации, выравнивание по TWAP-окну). Селектор по фактическому окну
   * выбрасывал бы из своей же серии рынок, у которого окно оказалось
   * 4 минуты вместо 5, — и делал бы это молча и невоспроизводимо.
   */
  private _passesDurationSelector(entry: MarketDiscoveryEntry, policy: PolymarketPolicy): boolean {
    const durations = policy.durations;
    if (durations === undefined || durations.length === 0) {
      return true;
    }
    const duration = entry.market.crypto?.duration;
    if (duration === undefined) {
      return false;
    }
    return durations.includes(duration);
  }

  /**
   * Проверяет ликвидность рынка.
   *
   * @param entry - Запись universe
   * @param policy - Owner policy
   * @returns `true`, если порога нет либо `liquidity >= minLiquidity`
   *
   * @internal
   * @remarks
   * Сравнение идёт через `MoneyService.isGreaterThanOrEqual`, а не через
   * голые `Decimal`: сервис САМ проверяет совместимость валют, и обойти его
   * означало бы молча сравнить USDC с чем-то другим как числа.
   *
   * При несовместимых валютах (`!result.ok`) рынок отклоняется. Выбор между
   * тремя вариантами здесь неочевиден, поэтому явно:
   *
   * - **бросить** — уронило бы отбор ВСЕГО universe из-за одной записи с
   *   чужой валютой, хотя остальные рынки в порядке;
   * - **пропустить** (`true`) — отдало бы потребителю рынок, про который
   *   порог ликвидности НЕ проверен, под видом проверенного: это ровно то
   *   молчаливое сравнение разных валют, от которого защищает сервис;
   * - **отклонить** (`true` → `false`) — запись, ликвидность которой нельзя
   *   сопоставить с порогом, не считается удовлетворяющей порогу. Ошибка
   *   односторонняя и безопасная: потребитель получает меньше рынков, а не
   *   рынок с непроверенным условием.
   */
  private _passesLiquiditySelector(entry: MarketDiscoveryEntry, policy: PolymarketPolicy): boolean {
    const minLiquidity = policy.minLiquidity;
    if (minLiquidity === undefined) {
      return true;
    }
    const comparison = MoneyService.isGreaterThanOrEqual(entry.metrics.liquidity, minLiquidity);
    if (!comparison.ok) {
      return false;
    }
    return comparison.value;
  }

  /**
   * Проверяет спред рынка.
   *
   * @param entry - Запись universe
   * @param policy - Owner policy
   * @returns `true`, если порога нет, спред НЕ наблюдался либо
   *   `spread >= minSpread`
   *
   * @internal
   * @remarks
   * Отсутствующий спред НЕ отклоняет рынок — поведение мигрировано из
   * старого фильтра НАМЕРЕННО, а не по инерции. `undefined` означает «в
   * этом наблюдении площадка спред не отдала», и это не то же самое, что
   * «спред нулевой»: подставив ноль, мы сравнили бы порог с выдуманным
   * значением и отбрасывали бы рынки за отсутствие данных у площадки, а не
   * за их содержание. Порог ликвидности ведёт себя иначе только потому, что
   * там `undefined` невозможен по контракту `MarketDiscoveryMetrics`
   * (необъявленная ликвидность — это честный ноль).
   */
  private _passesSpreadSelector(entry: MarketDiscoveryEntry, policy: PolymarketPolicy): boolean {
    const minSpread = policy.minSpread;
    if (minSpread === undefined) {
      return true;
    }
    const spread = entry.metrics.spread;
    if (spread === undefined) {
      return true;
    }
    return spread.toDecimal().greaterThanOrEqualTo(minSpread.toDecimal());
  }
}
