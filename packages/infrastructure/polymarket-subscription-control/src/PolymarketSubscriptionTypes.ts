/**
 * Контракт контроллера подписок: владельцы, исходы приобретения и узкие
 * структурные зависимости V2.
 *
 * @remarks
 * ### Граница ACQUISITION / RETENTION
 *
 * ```text
 * Planner   → ACQUISITION: какие НОВЫЕ рынки ещё можно приобрести
 * Controller → RETENTION:  какие УЖЕ приобретённые рынки продолжают жить
 * ```
 *
 * Разделение — главный инвариант этого пакета. Исчезновение рынка из плана
 * (а он исчезает СРАЗУ после старта торгов, потому что приобретать его уже
 * поздно) не означает «отписаться»: план отвечает только на вопрос о
 * приобретении. После успешного приобретения жизнь claim-а от плана не
 * зависит вообще — она заканчивается явным `release`.
 *
 * ### Почему исходы — значения, а не исключения
 *
 * Непригодность рынка (чужая площадка, торги уже идут, vendor-подготовка
 * пропала) — обычный рантайм, а не дефект программы: контроллер вызывается
 * по плану, построенному РАНЬШЕ, и рассинхронизация ожидаема. Исключения
 * оставлены для дефектов вызывающего (пустой ключ владельца) и для отказов
 * транспорта, которые контроллер переводит в `failed` после полного отката.
 */
import type { IClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import type { MarketId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/timestamp';
import type { PolymarketMarketDiscovery, PolymarketSource } from '@polymarket/polymarket-v2';

/**
 * Стабильный ключ владельца подписки.
 *
 * @remarks
 * Непрозрачная identity: контроллер не разбирает префикс и не знает, что
 * значит `strategy` или `collector`. Примеры реальных значений —
 * `strategy:btc-5m-aggressive`, `collector:raw-crypto`.
 *
 * Отдельной иерархии владельцев (реестра, менеджера, типа инстанса) здесь
 * НЕТ намеренно: контроллеру нужно ровно одно свойство ключа — сравнимость.
 * Всё остальное про владельца знает тот, кто его создал.
 *
 * Ключ НЕ нормализуется (не обрезается): `'a'` и `'a '` — разные владельцы,
 * потому что нормализация молча склеила бы два разных claim-а в один.
 */
export type SubscriptionOwnerKey = string;

/**
 * Причина отказа приобретения.
 *
 * @remarks
 * - `wrong-venue` / `inactive` / `already-started` — рынок непригоден
 *   САМ ПО СЕБЕ; последняя причина проверяется по инжектированным часам, а
 *   не по возрасту плана;
 * - `not-prepared` — vendor-подготовки для этого canonical рынка больше
 *   нет: снимок discovery сменился, нужен свежий universe → план;
 * - `stale-preparation` — подготовка ЕСТЬ, но описывает другую версию
 *   записи (расписание/identity разошлись с canonical entry);
 * - `controller-closed` / `source-unavailable` — приобретать нечем.
 */
export type PolymarketAcquireRejection =
  | 'wrong-venue'
  | 'inactive'
  | 'already-started'
  | 'not-prepared'
  | 'stale-preparation'
  | 'controller-closed'
  | 'source-unavailable';

/**
 * Этап, на котором отказал транспорт при открытии.
 *
 * @remarks
 * Различие существенно для диагностики: отказ market-подписки означает, что
 * физических ресурсов рынка не появилось вовсе, а отказ RTDS — что
 * market-подписка была открыта и откачена.
 */
export type PolymarketAcquireFailureStage = 'market-subscription' | 'rtds-subscription';

/**
 * Исход приобретения рынка владельцем.
 *
 * @remarks
 * `opened` / `joined` / `already-held` различают ТРИ разные ситуации, и
 * склеивать их нельзя: первая означает «появился физический ресурс», вторая
 * — «ресурс уже был, добавился владелец», третья — «этот владелец уже
 * держит claim» (повторный вызов идемпотентен, claim не дублируется).
 *
 * @example
 * ```typescript
 * const result = await controller.acquire('strategy:A', entry);
 * if (result.status === 'rejected' && result.reason === 'already-started') {
 *   // план устарел — нужен свежий universe → plan
 * }
 * ```
 */
export type PolymarketAcquireResult =
  | { readonly status: 'opened'; readonly marketId: MarketId }
  | { readonly status: 'joined'; readonly marketId: MarketId }
  | { readonly status: 'already-held'; readonly marketId: MarketId }
  | {
      readonly status: 'rejected';
      readonly marketId: MarketId;
      readonly reason: PolymarketAcquireRejection;
    }
  | {
      readonly status: 'failed';
      readonly marketId: MarketId;
      readonly stage: PolymarketAcquireFailureStage;
    };

/**
 * Исход снятия claim-а.
 *
 * @remarks
 * - `not-held` — у владельца такого claim-а нет (в том числе если открытие
 *   рынка успело откатиться);
 * - `retained` — claim снят, физическая подписка живёт из-за других
 *   владельцев;
 * - `closed` — снят ПОСЛЕДНИЙ claim: подписка рынка закрыта, его ссылки на
 *   RTDS-фиды освобождены.
 */
export type PolymarketReleaseResult = 'not-held' | 'retained' | 'closed';

/**
 * Узкая структурная зависимость: подготовка рынка к подписке.
 *
 * @remarks
 * `Pick` от РЕАЛЬНОГО класса V2, а не новая vendor-абстракция: своя
 * обёртка над discovery завела бы второй контракт подготовки, который
 * пришлось бы синхронизировать вручную. Узость нужна ради тестовых
 * подделок и ради того, чтобы контроллер физически не мог позвать
 * `refresh()` — обходами universe управляет composition root.
 */
export type SubscriptionDiscovery = Pick<PolymarketMarketDiscovery, 'prepareMarket'>;

/**
 * Узкая структурная зависимость: открытие физических подписок V2.
 *
 * @remarks
 * Ровно то, чем контроллер пользуется: три метода подписки и два признака
 * состояния. `close()` СОЗНАТЕЛЬНО не входит в набор — source принадлежит
 * composition root и разделён с другими потребителями, поэтому закрыть его
 * контроллер не должен уметь даже случайно.
 */
export type SubscriptionSource = Pick<
  PolymarketSource,
  'subscribeMarket' | 'subscribeCryptoPrices' | 'subscribeChainlinkTwap' | 'hasFailed' | 'isClosed'
>;

/**
 * Зависимости контроллера.
 *
 * @remarks
 * Ни рекордера, ни шины, ни семантических адаптеров, ни Policy/Planner:
 * физическая подписка существует независимо от того, записывает ли её
 * кто-нибудь, и от того, почему владелец её захотел.
 */
export interface PolymarketSubscriptionControllerDependencies {
  /** Подготовка vendor-данных рынка (Infrastructure-only). */
  readonly discovery: SubscriptionDiscovery;
  /** Источник физических подписок V2. */
  readonly source: SubscriptionSource;
  /** Часы контура (live/replay/тест) — контроллер их не подменяет. */
  readonly clock: IClock;
  /** Логгер: контроллер управляет реальными ресурсами, и это наблюдаемо. */
  readonly logger: ILogger;
}

/**
 * Диагностика одного shared RTDS-фида.
 *
 * @remarks
 * `refCount` считает РЫНКИ, а не владельцев (см. TSDoc контроллера):
 * владельцев уже дедуплицировала одна физическая подписка рынка.
 */
export interface PolymarketSharedRtdsFeedStat {
  /** RTDS topic фида. */
  readonly topic: string;
  /** Символ фида. */
  readonly symbol: string;
  /** Окно усреднения — только у settlement-потока TWAP. */
  readonly windowSeconds?: number;
  /** Сколько РЫНКОВ держат ссылку на фид. */
  readonly refCount: number;
}

/**
 * Снимок состояния контроллера.
 *
 * @example
 * ```typescript
 * const stats = controller.getStats();
 * logger.info('subscriptions', { active: stats.activeMarkets, claims: stats.claims });
 * ```
 */
export interface PolymarketSubscriptionControllerStats {
  /** Рынки в процессе открытия. */
  readonly openingMarkets: number;
  /** Рынки с открытым физическим ресурсом. */
  readonly activeMarkets: number;
  /** Всего claim-ов владельцев по всем рынкам. */
  readonly claims: number;
  /** Shared RTDS-фиды с числом держащих их рынков. */
  readonly rtdsFeeds: readonly PolymarketSharedRtdsFeedStat[];
  /** Терминальный отказ источника (подписки больше не физически живы). */
  readonly sourceFailed: boolean;
  /** Контроллер остановлен: новые приобретения запрещены. */
  readonly closed: boolean;
}

/**
 * Снимок одной подписки рынка.
 *
 * @remarks
 * Только canonical-данные: vendor-записи (`SelectedPolymarketMarket`,
 * Gamma-модели, SDK-объекты) наружу не выходят вообще — они остаются
 * внутренним состоянием Infrastructure.
 */
export interface PolymarketSubscriptionSnapshot {
  /** Canonical id рынка. */
  readonly marketId: MarketId;
  /** Стадия физического ресурса. */
  readonly state: 'OPENING' | 'ACTIVE';
  /** Владельцы claim-ов, отсортированные лексикографически. */
  readonly ownerKeys: readonly SubscriptionOwnerKey[];
  /** Начало торгов рынка (canonical, из `Market`). */
  readonly startsAt: Timestamp;
  /** Сколько RTDS-фидов приобретено этим рынком. */
  readonly rtdsFeedCount: number;
}
