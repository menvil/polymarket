/**
 * Модель жизненного цикла УЖЕ НАЧАТОЙ записи рынка.
 *
 * @remarks
 * ### Что такое CollectionSession после cutover
 *
 * Это НЕ подписка и НЕ владение ресурсом. Физический рынок и его RTDS-фиды
 * принадлежат `PolymarketSubscriptionController`; сессия описывает ровно
 * одно: «датасет этого рынка пишется, вот его границы».
 *
 * ```text
 * claim collector:raw ДО открытия рынка      (subscription controller)
 *          ↓
 * первое CLOB-наблюдение → gate → recorder   (запись началась)
 *          ↓
 * CollectionSession ACTIVE                    (этот модуль)
 *          ↓ expiresAt
 * CollectionSession FINALIZING                (CLOB и spot больше не пишутся)
 *          ↓ settlement grace → seal → release claim
 * MarketFinalizer: Gamma → header → архив
 * ```
 *
 * ### Почему сессия не зависит от MarketUniverse
 *
 * Рынок исчезает из очередного снимка discovery СРАЗУ после истечения — как
 * раз тогда, когда его сессии предстоит самое важное (граничное наблюдение,
 * seal, резолюция). Привязка жизни сессии к присутствию в universe означала
 * бы, что датасет теряет свою границу ровно в момент, когда она определяется.
 * Поэтому после attach сессия живёт своей жизнью: её единственные внешние
 * входы — часы (`expiresAt`) и явные вызовы lifecycle.
 *
 * ### Обобщение по vendor-подготовке
 *
 * Пакет коллектора по границе контура не зависит от source-пакетов
 * (`polymarket-v2` тянет транспорт), поэтому подготовка рынка входит сюда
 * параметром типа. Lifecycle-слою от неё нужен ровно один факт — состав
 * RTDS-фидов ({@link CollectionMarketPreparation}); конкретный vendor-тип
 * знает composition root, и он же получает его обратно в снимках сессий —
 * без единого приведения типа.
 */
import type { MarketId } from '@polymarket/ids';
import type { MarketMeta } from '@polymarket/ports';
import type { Timestamp } from '@polymarket/timestamp';
import type { PolymarketRtdsFeedKey } from '@polymarket/external-message-recorder';

/**
 * Минимум vendor-подготовки рынка, нужный lifecycle-слою.
 *
 * @remarks
 * Ровно состав RTDS-фидов: из него выделяется settlement-поток, который
 * продолжает писаться после истечения рынка. Всё остальное содержимое
 * подготовки (Gamma-идентификаторы, правило расчёта, initial-снапшоты)
 * нужно финализатору, а не lifecycle — поэтому здесь не объявляется и
 * проходит сквозь параметр типа неизменённым.
 */
export interface CollectionMarketPreparation {
  /** RTDS-фиды рынка в точной canonical identity (topic + symbol + окно). */
  readonly rtdsFeeds: readonly PolymarketRtdsFeedKey[];
}

/**
 * Стадия collection-сессии.
 *
 * @remarks
 * Стадий ровно две, и обе про ДАННЫЕ, а не про транспорт:
 * - `ACTIVE` — датасет принимает CLOB, spot-RTDS и settlement-поток;
 * - `FINALIZING` — рынок истёк; в датасет идёт только settlement-поток, а
 *   после grace он замораживается (seal) и claim снимается.
 *
 * `OPENING` здесь нет намеренно: открытием физического ресурса владеет
 * subscription controller, и сессия появляется только тогда, когда данные
 * уже пишутся.
 */
export type CollectionSessionState = 'ACTIVE' | 'FINALIZING';

/**
 * Read-only снимок одной collection-сессии.
 *
 * @typeParam TPrepared - Тип vendor-подготовки рынка контура
 */
export interface CollectionSessionSnapshot<
  TPrepared extends CollectionMarketPreparation = CollectionMarketPreparation,
> {
  /** Canonical id рынка (== Polymarket conditionId). */
  readonly marketId: MarketId;
  /** Стадия сессии. */
  readonly state: CollectionSessionState;
  /** Вопрос рынка (диагностика). */
  readonly question: string;
  /** Момент первой записанной строки датасета. */
  readonly recordingStartedAt: Timestamp;
  /** Граница рынка: с этого момента CLOB в датасет не пишется. */
  readonly expiresAt: Timestamp;
  /** Immutable vendor-подготовка, полученная при приобретении рынка. */
  readonly selected: TPrepared;
}

/**
 * Immutable-снимок сессии, перешедшей в FINALIZING.
 *
 * @typeParam TPrepared - Тип vendor-подготовки рынка контура
 *
 * @remarks
 * Единственный контракт между lifecycle и финализатором: финализатор НЕ
 * зависит от mutable private-состояния lifecycle. Здесь есть всё, что нужно
 * для резолюции и записи финального header-а: подготовка рынка (Gamma id,
 * правило расчёта, initial-снапшоты, фиды), базовый canonical header
 * датасета и момент начала записи.
 */
export interface FinalizingCollectionSession<
  TPrepared extends CollectionMarketPreparation = CollectionMarketPreparation,
> {
  /** Canonical id рынка. */
  readonly marketId: MarketId;
  /** Момент первой записанной строки датасета. */
  readonly recordingStartedAt: Timestamp;
  /** Immutable vendor-подготовка рынка. */
  readonly selected: TPrepared;
  /** Регистрация рынка в storage (в ней — базовый canonical header). */
  readonly marketMeta: MarketMeta;
  /**
   * Момент перехода сессии в FINALIZING (epoch ms).
   *
   * @remarks
   * Момент ГРАНИЦЫ, а не момент подхвата финализатором. Переход совершает
   * тот, кто первым дошёл до `expiresAt` (точный таймер сессии, страховочный
   * проход lifecycle либо сам финализатор), а подхват может случиться на
   * следующем control-тике. Брать `now` в момент подхвата значило бы
   * записать в `finalization.startedAtMs` архива момент, который к границе
   * датасета отношения не имеет, и сдвинуть отсчёт бюджета ожидания.
   */
  readonly finalizingSinceMs: number;
}

/**
 * Вид наблюдаемого перехода collection lifecycle.
 *
 * @remarks
 * Операционное состояние СБОРА, а не доменный lifecycle рынка: события
 * рождаются там, где переход реально происходит, и не выводятся диффом
 * снимков (диффу не видны переходы короче тика).
 */
export type CollectionLifecycleKind = 'STARTED' | 'FINALIZING' | 'SEALED' | 'COMPLETED' | 'DROPPED';

/** Одно наблюдаемое событие collection lifecycle. */
export interface CollectionLifecycleEvent {
  /** Вид перехода. */
  readonly kind: CollectionLifecycleKind;
  /** Canonical id рынка. */
  readonly marketId: MarketId;
  /** Момент наблюдения перехода (epoch ms). */
  readonly atMs: number;
  /** Вопрос рынка. */
  readonly question: string;
  /** Граница рынка (epoch ms). */
  readonly expiresAtMs: number;
}

/** Слушатель переходов collection lifecycle. */
export type CollectionLifecycleListener = (event: CollectionLifecycleEvent) => void;
