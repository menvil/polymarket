/**
 * Контракт прямой оркестрации control-plane Polymarket: спрос владельцев на
 * приобретение, зависимости прохода и его отчёт.
 *
 * @remarks
 * ### Что описывает `demand`, а что — нет
 *
 * ```text
 * demand = «этот владелец с этой policy хочет попытаться приобрести
 *           первые N будущих рынков ТЕКУЩЕГО плана»
 *
 * demand ≠ «полный desired-state уже приобретённых рынков владельца»
 * ```
 *
 * Различие — главный инвариант пакета, и оно же объясняет, почему у
 * рантайма нет ни одного вызова `release`. Спрос описывает ПРИОБРЕТЕНИЕ;
 * удержание уже приобретённого от спроса не зависит вообще (см.
 * {@link PolymarketSubscriptionDemand.acquireLimit} и TSDoc
 * `PolymarketControlRuntime`).
 *
 * ### Почему отчёт не отдаёт vendor-данных
 *
 * Наружу выходят только canonical `MarketId`, счётчики плана и исходы
 * контроллера. Ни `SelectedPolymarketMarket`, ни Gamma-моделей, ни
 * внутренностей снимка discovery: рантайм — композиция, а не второй канал
 * доступа к vendor-слою. Всё, что понадобится потребителю отчёта, он
 * получает из идентичности рынка.
 */
import type { ILogger } from '@polymarket/logger';
import type { MarketId } from '@polymarket/ids';
import type { IClock } from '@polymarket/time';
import type { Timestamp } from '@polymarket/timestamp';
import type { MarketUniverse } from '@polymarket/market-discovery';
import type { PolymarketPolicy } from '@polymarket/policy';
import type {
  PolymarketSubscriptionPlanDiagnostics,
  PolymarketSubscriptionPlanner,
} from '@polymarket/subscription-planning';
import type {
  PolymarketAcquireResult,
  PolymarketSubscriptionController,
  PolymarketSubscriptionControllerStats,
  SubscriptionOwnerKey,
} from '@polymarket/polymarket-subscription-control';
import type { PolymarketMarketDiscovery } from '@polymarket/polymarket-v2';

/**
 * Спрос одного владельца на один проход рантайма.
 *
 * @remarks
 * Ровно три поля: КТО хочет, ЧТО он считает подходящим и СКОЛЬКО первых
 * кандидатов текущего плана обработать. Ни расписания, ни cadence, ни
 * состояния прошлых проходов здесь нет — спрос действует на один тик и
 * приходит аргументом (см. `PolymarketControlRuntime.runOnce`).
 *
 * @example
 * ```typescript
 * const demand: PolymarketSubscriptionDemand = {
 *   ownerKey: 'strategy:btc-5m',
 *   policy: btc5mPolicy,
 *   acquireLimit: 1,
 * };
 * ```
 */
export interface PolymarketSubscriptionDemand {
  /**
   * Стабильный непрозрачный ключ владельца.
   *
   * @remarks
   * Тот же тип, что у контроллера: рантайм ключ не разбирает и не
   * нормализует — он только сравнивает его при поиске дублей и передаёт
   * дальше как есть.
   */
  readonly ownerKey: SubscriptionOwnerKey;
  /** Owner policy площадки: что этот владелец считает подходящим рынком. */
  readonly policy: PolymarketPolicy;
  /**
   * Сколько ПЕРВЫХ рынков текущего плана попытаться приобрести.
   *
   * @remarks
   * Это НЕ верхняя граница числа claim-ов владельца и не «сколько рынков
   * держать». Уже начавшиеся удерживаемые рынки в этот лимит не входят,
   * потому что их нет в плане: планировщик отвечает на вопрос о
   * ПРИОБРЕТЕНИИ, а рынок исчезает из плана сразу после старта торгов.
   *
   * ```text
   * 17:57  план: [BTC 18:00, BTC 18:05]   limit 1 → приобретаем BTC 18:00
   * 18:00  план: [BTC 18:05, BTC 18:10]   limit 1 → приобретаем BTC 18:05
   *        при этом BTC 18:00 всё ещё удерживается тем же владельцем
   * ```
   *
   * Имя `maxActiveMarkets` было бы прямой ложью: под ним ровно этот
   * сценарий читался бы как «лимит исчерпан, следующий рынок брать
   * нельзя», и владелец переставал бы приобретать рынки навсегда после
   * первой же покупки.
   *
   * Допустимое значение — целое `>= 1`; иначе `ValidationError` ДО любых
   * побочных эффектов прохода.
   */
  readonly acquireLimit: number;
}

/**
 * Узкая структурная зависимость: обход каталога и его снимок.
 *
 * @remarks
 * `Pick` от РЕАЛЬНОГО класса V2 — тот же приём, что у контроллера
 * (`SubscriptionDiscovery`). Второй интерфейс discovery ради DI завёл бы
 * второй контракт обхода, который пришлось бы синхронизировать вручную;
 * узость же нужна для тестовой подделки vendor-границы и для того, чтобы
 * рантайм физически не мог позвать `prepareMarket()` — vendor-подготовка
 * принадлежит контроллеру, а не композиции над ним.
 */
export type ControlRuntimeDiscovery = Pick<PolymarketMarketDiscovery, 'refresh' | 'getSnapshot'>;

/**
 * Зависимости прохода.
 *
 * @remarks
 * Все пять компонентов — РЕАЛЬНЫЕ типы контура, а не новые интерфейсы
 * `IMarketUniverse`/`ISubscriptionPlanner`/`ISubscriptionController`.
 * Интерфейс без второй реализации не даёт инверсии зависимости, он даёт
 * лишний контракт, который расходится с настоящим при первом же изменении.
 * Инверсия сделана ТАМ, где нужна, — на vendor-границе
 * ({@link ControlRuntimeDiscovery}).
 *
 * Чего здесь СОЗНАТЕЛЬНО нет: реестра владельцев, реестра policy, шины
 * событий, рекордера, коллектора и источника. Владельцев рантайм получает
 * аргументом каждого прохода, а физическими ресурсами владеет контроллер.
 */
export interface PolymarketControlRuntimeDependencies {
  /** Обход каталога площадки и его последний успешный снимок. */
  readonly discovery: ControlRuntimeDiscovery;
  /** Application source of truth текущего universe. */
  readonly universe: MarketUniverse;
  /** Планировщик приобретения: policy + universe + `now` → кандидаты. */
  readonly planner: PolymarketSubscriptionPlanner;
  /** Владелец физических подписок: claim-ы, ref-count, транзакции. */
  readonly controller: PolymarketSubscriptionController;
  /** Часы контура (live/replay/тест) — момент прохода читается отсюда. */
  readonly clock: IClock;
  /** Логгер: проход управляет реальными ресурсами, и это наблюдаемо. */
  readonly logger: ILogger;
}

/**
 * Сводка плана одного владельца.
 *
 * @remarks
 * Кандидаты НЕ отдаются целиком: их идентичность уже есть в
 * {@link PolymarketOwnerRuntimeResult.selectedMarketIds}, а остальные —
 * рынки, которые этот проход не трогал. Отдавать весь план значило бы
 * протащить наружу записи universe (вместе с доменными `Market`) ради
 * диагностики, которой достаточно числа.
 */
export interface PolymarketOwnerPlanSummary {
  /** Сколько рынков признано пригодными к приобретению. */
  readonly candidateCount: number;
  /** Разбор прогона планировщика по причинам отказа (заморожен планировщиком). */
  readonly diagnostics: PolymarketSubscriptionPlanDiagnostics;
}

/**
 * Отчёт по одному владельцу за проход.
 *
 * @remarks
 * Инвариант позиций: `selectedMarketIds[i]` соответствует
 * `acquisitions[i]`. Оба массива строятся из одного и того же среза плана в
 * одном цикле, поэтому сопоставить исход с рынком можно по индексу, без
 * поиска по `marketId`.
 *
 * @example
 * ```typescript
 * owner.selectedMarketIds.forEach((marketId, i) => {
 *   logger.info('acquisition', {
 *     marketId: String(marketId),
 *     status: owner.acquisitions[i]?.status,
 *   });
 * });
 * ```
 */
export interface PolymarketOwnerRuntimeResult {
  /** Ключ владельца из спроса. */
  readonly ownerKey: SubscriptionOwnerKey;
  /** Лимит приобретения из спроса (для читаемости отчёта). */
  readonly acquireLimit: number;
  /** Сводка плана этого владельца на момент прохода. */
  readonly plan: PolymarketOwnerPlanSummary;
  /** Отобранные рынки в порядке кандидатов планировщика. */
  readonly selectedMarketIds: readonly MarketId[];
  /** Исходы контроллера, позиционно соответствующие отобранным рынкам. */
  readonly acquisitions: readonly PolymarketAcquireResult[];
}

/**
 * Отчёт одного прохода рантайма.
 *
 * @remarks
 * Заморожен целиком — сам отчёт, массив владельцев, каждый отчёт владельца,
 * его отобранные рынки и исходы. Отчёт уезжает в логи, метрики и (позже) в
 * composition root; править его им незачем, а сделать это случайно —
 * легко.
 *
 * `controller` — снимок состояния контроллера ПОСЛЕ прохода, а не копия
 * его внутренних claim-ов: source of truth владения — контроллер, и второго
 * реестра рантайм не ведёт.
 *
 * @example
 * ```typescript
 * const result = await runtime.runOnce([demand]);
 *
 * result.discoveryRefreshed;          // false → шли по last-good universe
 * result.universeEntries;             // размер universe, по которому строился план
 * result.controller.activeMarkets;    // физических подписок после прохода
 * ```
 */
export interface PolymarketControlRuntimeResult {
  /**
   * Момент, НА который выполнен проход.
   *
   * @remarks
   * Ровно тот `now`, что получили все вызовы планировщика этого прохода:
   * одно чтение часов на тик (см. TSDoc `PolymarketControlRuntime`).
   */
  readonly ranAt: Timestamp;
  /**
   * Обновился ли снимок каталога в этом проходе.
   *
   * @remarks
   * `false` НЕ означает отказа прохода: universe сохраняет last-good
   * состояние, и планирование по нему продолжается. Признак существует
   * затем, чтобы «мы планировали по свежим данным» и «мы планировали по
   * прошлым» различались в отчёте, а не только в логах.
   */
  readonly discoveryRefreshed: boolean;
  /** Размер universe, по которому строились планы этого прохода. */
  readonly universeEntries: number;
  /** Отчёты владельцев, отсортированные по `ownerKey` ASC. */
  readonly owners: readonly PolymarketOwnerRuntimeResult[];
  /** Снимок состояния контроллера после прохода. */
  readonly controller: PolymarketSubscriptionControllerStats;
}
