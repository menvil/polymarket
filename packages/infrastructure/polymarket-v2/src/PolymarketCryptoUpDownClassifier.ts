/**
 * Технический классификатор семейства `CRYPTO_UP_DOWN` для рынков Polymarket.
 *
 * @remarks
 * ### Зачем он нужен
 *
 * Infrastructure обязана ответить на ОДИН технический вопрос:
 *
 * > способен ли текущий semantic/runtime-контур Polymarket вообще понимать
 * > этот vendor-рынок?
 *
 * Сегодня контур понимает ровно одно семейство — `CRYPTO_UP_DOWN`
 * («цена актива вырастет/упадёт за окно»). Футбол, погода, политика,
 * произвольные crypto `Yes/No` — это НЕ ошибка обхода и НЕ «плохие
 * данные», это `UNSUPPORTED`: рынки существуют, мы их просто не ведём.
 *
 * ### Три исхода, а не булево
 *
 * `isSupportedCryptoUpDown()` (булево) отвечает на вопрос «наше ли это
 * семейство», но разделять «не наше» и «наше, но поломанное» обязательно:
 * у них разные диагностические счётчики и разная реакция. Поэтому
 * основной API — {@link classifyPolymarketMarket}, возвращающий
 * дискриминированный union:
 *
 * - `CRYPTO_UP_DOWN` — семейство наше И все обязательные canonical-поля
 *   честно извлечены (они возвращаются вместе с классификацией, чтобы
 *   вызывающий не парсил vendor-запись второй раз);
 * - `UNSUPPORTED` — семейство не наше (не крипто / не Up-Down);
 * - `INVALID` — семейство наше, но обязательных данных нет: рынок нельзя
 *   представить canonical `Market` и выдумывать их запрещено.
 *
 * ### Почему НЕ generic classifier framework
 *
 * Семейство сейчас одно. Абстракция «правил классификации» на одном
 * правиле не даёт ничего, кроме лишнего слоя: её форму определит второе
 * семейство, когда оно появится, — тогда и появится развилка.
 *
 * ### Порядок проверок и почему он такой
 *
 * 1. **крипто?** — по `resolution.source` через существующий
 *    {@link derivePolymarketCryptoMeta} (единственный источник актива:
 *    угадывать актив по заголовку запрещено, vendor уже сказал его точно);
 * 2. **Up/Down-семантика?** — строго, две поддержанные vendor-формы (ниже);
 * 3. **структура и обязательные поля** — только после того, как рынок
 *    признан нашим: у чужого семейства «поломанность» нас не касается.
 */
import type { Market } from '@polymarket/bindings/gamma';
import { asInstrumentId, asMarketId } from '@polymarket/ids';
import type { MarketId } from '@polymarket/ids';
import { parseMarketSlug } from '@polymarket/market';
import type { MarketOutcome, MarketSlug, OutcomeIndex } from '@polymarket/market';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { derivePolymarketCryptoMeta } from './PolymarketRtdsFeeds.js';
import type { PolymarketCryptoMeta } from './PolymarketRtdsFeeds.js';

/**
 * Какая vendor-форма подтвердила Up/Down-семантику рынка.
 *
 * @remarks
 * Провенанс решения, а не украшение: по нему видно в логах и тестах,
 * какая именно форма сработала, и не сломала ли смена формы vendor-ом
 * распознавание всей серии.
 */
export type PolymarketUpDownSemantics = 'outcome-pair' | 'question-phrase';

/** Причина, по которой рынок не относится к поддержанному семейству. */
export type PolymarketUnsupportedReason =
  /** `resolution.source` не указывает на поддержанный крипто-источник. */
  | 'not-crypto'
  /** Крипто-рынок, но его исходы/вопрос не выражают Up/Down. */
  | 'not-up-down';

/** Причина, по которой рынок нашего семейства непригоден. */
export type PolymarketInvalidReason =
  /** Нет `conditionId` либо он не парсится в canonical `MarketId`. */
  | 'market-id'
  /** Пустой/отсутствующий `question`. */
  | 'question'
  /** Нет `endDate` либо он не конвертируется в canonical `Timestamp`. */
  | 'expiry'
  /** У исхода нет CLOB-токена либо он не парсится в `InstrumentId`. */
  | 'outcome-instrument'
  /** Пустая метка исхода либо совпадающие метки/инструменты обоих исходов. */
  | 'outcome-identity';

/**
 * Рынок относится к семейству `CRYPTO_UP_DOWN` и пригоден к маппингу.
 *
 * @remarks
 * Несёт УЖЕ извлечённые и провалидированные canonical-поля: классификация
 * и извлечение — один проход по vendor-записи. Расписание неполно
 * сознательно: `startsAt` в каталоге рынков отсутствует и добывается
 * отдельным точечным запросом события (см. Discovery).
 */
export interface PolymarketCryptoUpDownClassification {
  readonly kind: 'CRYPTO_UP_DOWN';
  /** Canonical id рынка (для Polymarket это conditionId). */
  readonly marketId: MarketId;
  /** Вопрос рынка как его опубликовала площадка. */
  readonly question: string;
  /** Слаг рынка — только если он канонический (иначе поля нет). */
  readonly slug?: MarketSlug;
  /** Запланированное окончание торгов из `state.endDate`. */
  readonly expiresAt: Timestamp;
  /** Оба исхода в РЕАЛЬНОМ vendor-порядке с canonical instrument identity. */
  readonly outcomes: readonly [MarketOutcome, MarketOutcome];
  /** Крипто-метаданные (актив, источник, RTDS-фиды, settlement-правило). */
  readonly crypto: PolymarketCryptoMeta;
  /** Форма, подтвердившая семантику (см. {@link PolymarketUpDownSemantics}). */
  readonly semantics: PolymarketUpDownSemantics;
}

/** Рынок не относится к поддержанному семейству. */
export interface PolymarketUnsupportedClassification {
  readonly kind: 'UNSUPPORTED';
  readonly reason: PolymarketUnsupportedReason;
}

/** Рынок нашего семейства, но без обязательных canonical-данных. */
export interface PolymarketInvalidClassification {
  readonly kind: 'INVALID';
  readonly reason: PolymarketInvalidReason;
}

/** Результат классификации vendor-записи рынка. */
export type PolymarketMarketClassification =
  | PolymarketCryptoUpDownClassification
  | PolymarketUnsupportedClassification
  | PolymarketInvalidClassification;

/**
 * Строгая фраза Up/Down в вопросе/заголовке рынка.
 *
 * @internal
 * @remarks
 * Границы слова заданы явными lookbehind/lookahead: иначе
 * `Group or Downtown` дал бы ложное срабатывание. `includes('up')` и любой
 * fuzzy-матчинг здесь запрещены — цена ошибки — чужой рынок, поехавший в
 * realtime-контур под видом нашего.
 *
 * Границы проверяются по ЮНИКОДНЫМ классам букв и цифр (`\p{L}`/`\p{N}`), а
 * не по ASCII-диапазону `[a-zA-Z0-9]`. Разница не теоретическая: с
 * ASCII-границей любая нелатинская буква считается «не буквой», то есть
 * пунктуацией, и заголовок вида `Биткоинup or down?` проходил бы как наша
 * серия. Vendor не обязан публиковать только латиницу, а односторонняя
 * ошибка здесь — чужой рынок в realtime-контуре.
 */
const UP_OR_DOWN_PHRASE = /(?<![\p{L}\p{N}])up\s+or\s+down(?![\p{L}\p{N}])/iu;

/** Канонические метки исходов Up/Down-рынка (lowercase). */
const UP_DOWN_LABELS: readonly string[] = ['up', 'down'];

/** Метки бинарного рынка общего вида (lowercase). */
const YES_NO_LABELS: readonly string[] = ['yes', 'no'];

/**
 * Совпадает ли пара меток с ожидаемой парой в ЛЮБОМ vendor-порядке.
 *
 * @param labels - Метки исходов в реальном vendor-порядке
 * @param expected - Ожидаемая пара (lowercase)
 * @returns `true`, если множества совпадают
 *
 * @internal
 * @remarks
 * Порядок исходов у площадки не гарантирован, поэтому сравниваются
 * МНОЖЕСТВА, а сами индексы дальше сохраняются в реальном vendor-порядке.
 */
function isLabelPair(labels: readonly [string, string], expected: readonly string[]): boolean {
  const normalized = [labels[0].trim().toLowerCase(), labels[1].trim().toLowerCase()];
  return normalized.length === new Set(normalized).size && expected.every((e) => normalized.includes(e));
}

/**
 * Содержит ли текст рынка явную фразу «Up or Down».
 *
 * @param market - Normalized Market Polymarket V2 bindings
 * @returns `true`, если фраза найдена в `question` либо `groupItemTitle`
 *
 * @internal
 * @remarks
 * Проверяются оба текстовых поля, которые площадка использует как
 * заголовок рынка: у серий Up/Down фраза живёт в `question`
 * (`Bitcoin Up or Down — 6:30PM ET?`), но у отдельных группировок
 * содержательный заголовок площадка кладёт в `groupItemTitle`.
 */
function hasUpOrDownPhrase(market: Market): boolean {
  const groupItemTitle: string | null | undefined = market.groupItemTitle;
  return (
    UP_OR_DOWN_PHRASE.test(market.question ?? '') ||
    UP_OR_DOWN_PHRASE.test(groupItemTitle ?? '')
  );
}

/**
 * Приводит vendor-исход к canonical {@link MarketOutcome}.
 *
 * @param vendorOutcome - Исход normalized Market bindings
 * @param index - Реальная позиция исхода у площадки
 * @returns Canonical исход либо причину непригодности
 *
 * @internal
 * @remarks
 * Возвращает причину, а не `undefined`: вызывающему нужно различать
 * «нет CLOB-токена» и «метка пуста» — это разные диагностические строки.
 */
function toCanonicalOutcome(
  vendorOutcome: { readonly label: string; readonly tokenId: string | null },
  index: OutcomeIndex,
): MarketOutcome | { readonly reason: PolymarketInvalidReason } {
  const tokenId = vendorOutcome.tokenId;
  if (tokenId === null) {
    return { reason: 'outcome-instrument' };
  }
  const instrumentId = asInstrumentId(String(tokenId));
  if (instrumentId === undefined) {
    return { reason: 'outcome-instrument' };
  }
  const label = vendorOutcome.label.trim();
  if (label === '') {
    return { reason: 'outcome-identity' };
  }
  return { index, label, instrumentId };
}

/**
 * Классифицирует vendor-запись рынка Polymarket.
 *
 * @param market - Normalized Market из `@polymarket/client` / `@polymarket/bindings`
 * @returns Дискриминированный результат (см. {@link PolymarketMarketClassification})
 * @throws Ничего не бросает: любая непригодность выражается результатом
 *
 * @remarks
 * Поддержанные формы Up/Down-семантики — ровно две, обе строгие:
 *
 * **A. Пара исходов `Up`/`Down`** (case-insensitive, любой vendor-порядок).
 * Индексы исходов при этом сохраняются в РЕАЛЬНОМ vendor-порядке — иначе
 * `outcomes[0]` перестал бы совпадать с тем, что площадка присылает в
 * realtime по этому инструменту.
 *
 * **B. Исходы `Yes`/`No` + явная фраза `Up or Down`** в вопросе/заголовке.
 * Одних `Yes`/`No` недостаточно: `Will Bitcoin be above $100,000 tomorrow?`
 * — тоже крипто-рынок с `Yes`/`No`, но это НЕ Up/Down-серия, и вести её
 * нашим контуром нельзя.
 *
 * Любая другая пара меток (`Over`/`Under`, три исхода, дубли) —
 * `UNSUPPORTED`, а не «почти Up/Down».
 *
 * @example
 * ```typescript
 * const result = classifyPolymarketMarket(market);
 * if (result.kind === 'CRYPTO_UP_DOWN') {
 *   console.log(result.crypto.asset, result.outcomes[0].label); // 'btc' 'Up'
 * }
 *
 * classifyPolymarketMarket(footballMarket);
 * // → { kind: 'UNSUPPORTED', reason: 'not-crypto' }
 *
 * classifyPolymarketMarket(btcAbove100kYesNo);
 * // → { kind: 'UNSUPPORTED', reason: 'not-up-down' }
 * ```
 */
export function classifyPolymarketMarket(market: Market): PolymarketMarketClassification {
  // ── 1. Крипто? Актив берём ТОЛЬКО из vendor resolution metadata ──────────
  const crypto = derivePolymarketCryptoMeta(market);
  if (crypto === undefined) {
    return { kind: 'UNSUPPORTED', reason: 'not-crypto' };
  }

  // ── 2. Up/Down-семантика: две строгие формы, без fuzzy-матчинга ──────────
  // Vendor mapping boundary: bindings именуют первый/второй исход binary-рынка
  // `yes`/`no` даже когда реальные метки — `Up`/`Down`; эти имена свойств
  // НЕ покидают данный модуль.
  const vendorOutcomes = [market.outcomes.yes, market.outcomes.no] as const;
  const labels: [string, string] = [vendorOutcomes[0].label, vendorOutcomes[1].label];

  let semantics: PolymarketUpDownSemantics;
  if (isLabelPair(labels, UP_DOWN_LABELS)) {
    semantics = 'outcome-pair';
  } else if (isLabelPair(labels, YES_NO_LABELS) && hasUpOrDownPhrase(market)) {
    semantics = 'question-phrase';
  } else {
    return { kind: 'UNSUPPORTED', reason: 'not-up-down' };
  }

  // ── 3. Обязательные canonical-поля рынка НАШЕГО семейства ────────────────
  const conditionId = market.conditionId;
  if (conditionId === null || conditionId === undefined) {
    return { kind: 'INVALID', reason: 'market-id' };
  }
  const marketId = asMarketId(String(conditionId));
  if (marketId === undefined) {
    return { kind: 'INVALID', reason: 'market-id' };
  }

  const question = market.question;
  if (question === null || question === undefined || question.trim() === '') {
    return { kind: 'INVALID', reason: 'question' };
  }

  const endDate = market.state.endDate;
  if (endDate === null || endDate === undefined) {
    return { kind: 'INVALID', reason: 'expiry' };
  }
  const endDateMs = Date.parse(endDate);
  if (Number.isNaN(endDateMs)) {
    return { kind: 'INVALID', reason: 'expiry' };
  }
  const expiresAtResult = TimestampService.create(endDateMs);
  if (!expiresAtResult.ok) {
    return { kind: 'INVALID', reason: 'expiry' };
  }

  // Индексы — РЕАЛЬНАЯ позиция исхода у площадки (0 = первый), а не
  // «Up всегда 0»: realtime-события адресуются тем же порядком.
  const first = toCanonicalOutcome(vendorOutcomes[0], 0);
  if (!('index' in first)) {
    return { kind: 'INVALID', reason: first.reason };
  }
  const second = toCanonicalOutcome(vendorOutcomes[1], 1);
  if (!('index' in second)) {
    return { kind: 'INVALID', reason: second.reason };
  }
  if (first.instrumentId === second.instrumentId || first.label === second.label) {
    return { kind: 'INVALID', reason: 'outcome-identity' };
  }

  const slug = market.slug !== null && market.slug !== undefined
    ? parseMarketSlug(market.slug)
    : undefined;

  return {
    kind: 'CRYPTO_UP_DOWN',
    marketId,
    question: question.trim(),
    ...(slug !== undefined ? { slug } : {}),
    expiresAt: expiresAtResult.value,
    outcomes: [first, second],
    crypto,
    semantics,
  };
}

/**
 * Предикат «рынок относится к поддержанному семейству и пригоден».
 *
 * @param market - Normalized Market Polymarket V2 bindings
 * @returns `true` только для полностью пригодного `CRYPTO_UP_DOWN`
 *
 * @remarks
 * Тонкая обёртка над {@link classifyPolymarketMarket} для мест, которым
 * нужен только ответ «да/нет». Там, где важна ПРИЧИНА отказа (диагностика
 * обхода), используйте сам `classifyPolymarketMarket`.
 *
 * @example
 * ```typescript
 * const supported = markets.filter(isSupportedCryptoUpDown);
 * ```
 */
export function isSupportedCryptoUpDown(market: Market): boolean {
  return classifyPolymarketMarket(market).kind === 'CRYPTO_UP_DOWN';
}
