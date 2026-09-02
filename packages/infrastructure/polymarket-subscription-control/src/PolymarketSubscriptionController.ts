/**
 * Контроллер общих подписок Polymarket: claim-ы владельцев поверх ОДНОЙ
 * физической подписки рынка и ref-counted RTDS-фидов.
 *
 * @remarks
 * ### Что здесь появляется впервые в контуре
 *
 * ```text
 * ownerKey + MarketDiscoveryEntry
 *          ↓
 * PolymarketSubscriptionController
 *          ├── claim-ы владельцев
 *          ├── OPENING-резервация
 *          ├── prepareMarket() — vendor-подготовка
 *          ├── ОДНА подписка рынка
 *          ├── shared RTDS refs
 *          └── транзакционный откат
 *          ↓
 *   PolymarketSource → ExternalMessageBus
 * ```
 *
 * Это первый слой, который управляет ФИЗИЧЕСКИМИ ресурсами, — потому он и
 * живёт в Infrastructure: здесь уже видно `prepareMarket()`, `PolymarketSource`
 * и vendor RTDS-фиды, которых Application знать не должен.
 *
 * ### ACQUISITION ≠ RETENTION (главный инвариант)
 *
 * ```text
 * Planner    → какие НОВЫЕ рынки ещё можно приобрести
 * Controller → какие УЖЕ приобретённые рынки продолжают жить
 * ```
 *
 * Контроллер НЕ сверяется с планом ни на одном тике. Рынок исчезает из
 * плана сразу после старта торгов — просто потому, что приобретать его уже
 * поздно, — и трактовать это как «отписаться» означало бы рвать подписку
 * ровно в тот момент, когда она наконец начала приносить данные. Никакого
 * автоматического reconcile с текущим планом в этом контуре нет: claim
 * снимается только явным `release`/`releaseOwner`/`close()` либо
 * реконсиляцией терминального отказа источника.
 *
 * ### Два разных вопроса про старт торгов
 *
 * - **новый владелец** обязан успеть ДО старта: `now < startsAt`, иначе
 *   `already-started` — даже если физическая подписка рынка уже открыта
 *   чьим-то чужим claim-ом. Иначе стратегия «присоединилась» бы к рынку,
 *   первую часть которого она не видела, и не отличила бы этот случай от
 *   честной подписки с самого начала;
 * - **существующий владелец** после старта остаётся владельцем: повторный
 *   `acquire` — идемпотентное `already-held`, а не отказ. Порядок проверок
 *   поэтому именно такой: сперва «держит ли уже», потом строгий гейт.
 *
 * ### Почему pre-open проверяется ещё раз ПОСЛЕ каждого await
 *
 * План строится раньше вызова, а транспорт отвечает не мгновенно:
 *
 * ```text
 * 17:59:59.500  subscribeMarket() отправлен
 * 18:00:00.200  SDK ответил → рынок уже стартовал
 * ```
 *
 * Зафиксировать такую подписку как ACTIVE значило бы отдать владельцу
 * ресурс, который нарушает его же инвариант. Поэтому полный физический
 * bundle (подписка рынка + все RTDS-фиды) обязан быть готов ДО старта, и
 * проверка повторяется после каждой асинхронной границы, а всё открытое
 * откатывается.
 *
 * ### RTDS-ссылки принадлежат РЫНКУ, а не владельцам
 *
 * ```text
 * Market X ── owner A
 *          └─ owner B      →  RTDS btc/usd refCount = 1
 *
 * Market X, Market Y (оба на btc/usd) → refCount = 2
 * ```
 *
 * Владельцев уже дедуплицировала одна физическая подписка рынка. Считать
 * ссылки ещё и по владельцам значило бы связать два уровня ref-count без
 * причины: результат тот же, а инвариант «сколько рынков держит фид»
 * перестал бы читаться из счётчика.
 *
 * ### Чего здесь нет намеренно
 *
 * Ни Policy/Planner/universe, ни рекордера и сессий сбора, ни событий на
 * шине, ни таймеров истечения и финализации. Физическая подписка
 * существует независимо от того, записывает ли её кто-нибудь; lifecycle
 * истечения появится вместе с cutover сборщика.
 */
import { ValidationError } from '@polymarket/errors';
import { KnownVenues } from '@polymarket/ids';
import type { MarketId } from '@polymarket/ids';
import type { MarketDiscoveryEntry } from '@polymarket/ports';
import { Timestamp } from '@polymarket/timestamp';
import { isTwapRtdsFeed, rtdsFeedKey } from '@polymarket/polymarket-v2';
import type {
  PolymarketOpenSubscription,
  PolymarketRtdsFeed,
  SelectedPolymarketMarket,
} from '@polymarket/polymarket-v2';
import type { IClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';
import type {
  PolymarketAcquireFailureStage,
  PolymarketAcquireRejection,
  PolymarketAcquireResult,
  PolymarketReleaseResult,
  PolymarketSharedRtdsFeedStat,
  PolymarketSubscriptionControllerDependencies,
  PolymarketSubscriptionControllerStats,
  PolymarketSubscriptionSnapshot,
  SubscriptionDiscovery,
  SubscriptionOwnerKey,
  SubscriptionSource,
} from './PolymarketSubscriptionTypes.js';

/**
 * Исход транзакции открытия — общий для всех, кто её ждёт.
 *
 * @internal
 * @remarks
 * Разделяется между первым владельцем и всеми, кто присоединился во время
 * OPENING: физическое приобретение происходит ОДИН раз, значит и его исход
 * должен быть один. Свой исход каждый ожидающий переводит в собственный
 * `PolymarketAcquireResult` (`opened` против `joined` против `already-held`).
 */
type OpenTransactionOutcome =
  | { readonly status: 'opened' }
  | { readonly status: 'rejected'; readonly reason: PolymarketAcquireRejection }
  | { readonly status: 'failed'; readonly stage: PolymarketAcquireFailureStage };

/**
 * Состояние одной физической подписки рынка.
 *
 * @internal
 * @remarks
 * `owners` — множество: повторный claim того же владельца не удваивается,
 * а `owners.size === 0` служит единственным условием teardown-а.
 *
 * Ресурсы (`marketSubscription`, `rtdsFeedKeys`) записываются в состояние
 * ПО МЕРЕ приобретения, а не на commit: только так безопасная сетка
 * `_rollback()` знает, что именно нужно закрыть, если транзакция сорвалась
 * посередине. Во время OPENING состояние принадлежит транзакции — все
 * остальные операции (`release`, `close`, реконсиляция) сначала ждут
 * `opening`.
 */
interface MarketSubscriptionState {
  /** Canonical id рынка (ключ карты — `String(marketId)`). */
  readonly marketId: MarketId;
  /** Canonical запись, по которой рынок приобретался. */
  readonly entry: MarketDiscoveryEntry;
  /** Стадия физического ресурса. */
  state: 'OPENING' | 'ACTIVE';
  /** Владельцы claim-ов. */
  readonly owners: Set<SubscriptionOwnerKey>;
  /** Исход транзакции открытия (никогда не отклоняется). */
  readonly opening: Promise<OpenTransactionOutcome>;
  /** Резолвер `opening` — вызывается ровно один раз владельцем транзакции. */
  readonly settle: (outcome: OpenTransactionOutcome) => void;
  /** Vendor-подготовка рынка; наружу не отдаётся никогда. */
  selected?: SelectedPolymarketMarket;
  /** Физическая подписка рынка. */
  marketSubscription?: PolymarketOpenSubscription;
  /** Ключи приобретённых RTDS-фидов (для release). */
  rtdsFeedKeys: readonly string[];
}

/**
 * Shared RTDS-фид: одна подписка источника на все держащие её рынки.
 *
 * @internal
 */
interface SharedRtdsFeed {
  /** Дескриптор фида. */
  readonly feed: PolymarketRtdsFeed;
  /** Ключи РЫНКОВ, держащих ссылку. */
  readonly refs: Set<string>;
  /** Открытие подписки — общее для всех ожидающих. */
  readonly pending: Promise<PolymarketOpenSubscription>;
}

/**
 * Читаемая метка фида для логов.
 *
 * @param feed - Фид рынка
 * @returns Компактное описание, различающее окно settlement-потока
 *
 * @internal
 * @remarks
 * Идентичность фида даёт `rtdsFeedKey` из `@polymarket/polymarket-v2` —
 * ЕДИНОЕ правило на весь контур. Эта функция нужна только людям и в
 * сопоставлении не участвует.
 */
function rtdsFeedLabel(feed: PolymarketRtdsFeed): string {
  return isTwapRtdsFeed(feed)
    ? `${feed.topic}:${feed.symbol}@${String(feed.windowSeconds)}s`
    : `${feed.topic}:${feed.symbol}`;
}

/**
 * Проверяет ключ владельца.
 *
 * @param ownerKey - Ключ владельца
 * @throws {ValidationError} Если ключ пуст или состоит из пробелов
 *
 * @internal
 * @remarks
 * Fail-fast, а не исход-значение: пустой ключ — дефект ВЫЗЫВАЮЩЕГО, а не
 * свойство рынка. Молча принятый, он собрал бы claim-ы разных владельцев
 * под одной пустой identity, и первый же `release` снял бы чужой claim.
 *
 * Ключ при этом НЕ нормализуется: обрезка склеила бы `'a'` и `'a '` —
 * два разных, с точки зрения вызывающего, владельца.
 */
function assertOwnerKey(ownerKey: SubscriptionOwnerKey): void {
  if (typeof ownerKey !== 'string' || ownerKey.trim() === '') {
    throw new ValidationError('Subscription owner key must be a non-blank string', {
      context: { ownerKey: String(ownerKey) },
    });
  }
}

/**
 * Совпадает ли vendor-подготовка с canonical записью, по которой строился план.
 *
 * @param selected - Vendor-подготовка текущего снимка discovery
 * @param entry - Canonical запись, поданная вызывающим
 * @returns `true`, если identity и расписание совпадают
 *
 * @internal
 * @remarks
 * Между `plan()` и `acquire()` discovery мог обновить снимок, и
 * `prepareMarket()` уже описывает ДРУГУЮ версию записи. Молча подписаться
 * по новой vendor-записи поверх старого canonical плана нельзя: владелец
 * получил бы рынок с другим расписанием, чем тот, который выбирал. Чинить
 * `entry` на месте — тоже нельзя: canonical запись принадлежит снимку
 * universe, а не контроллеру. Правильный ответ — отказ и свежий проход
 * discovery → universe → plan.
 *
 * Сравниваются identity и ОБЕ границы расписания: их достаточно, чтобы
 * отличить «та же самая запись» от «другая версия того же рынка».
 */
function isPreparationConsistent(
  selected: SelectedPolymarketMarket,
  entry: MarketDiscoveryEntry,
): boolean {
  return (
    String(selected.marketId) === String(entry.market.id) &&
    selected.eventStartsAt.equals(entry.market.startsAt) &&
    selected.expiresAt.equals(entry.market.expiresAt)
  );
}

/**
 * Контроллер общих подписок Polymarket.
 *
 * @example
 * ```typescript
 * const controller = new PolymarketSubscriptionController({
 *   discovery, source, clock, logger,
 * });
 *
 * await controller.acquire('collector:raw', entry);   // → opened
 * await controller.acquire('strategy:btc-5m', entry); // → joined
 *
 * await controller.release('strategy:btc-5m', entry.market.id); // → retained
 * await controller.release('collector:raw', entry.market.id);   // → closed
 * ```
 */
export class PolymarketSubscriptionController {
  private readonly _discovery: SubscriptionDiscovery;
  private readonly _source: SubscriptionSource;
  private readonly _clock: IClock;
  private readonly _logger: ILogger;

  /** Физические подписки рынков по `String(marketId)`. */
  private readonly _markets = new Map<string, MarketSubscriptionState>();
  /** Shared RTDS-фиды по `rtdsFeedKey(feed)`. */
  private readonly _rtdsFeeds = new Map<string, SharedRtdsFeed>();

  private _closed = false;
  private _closePromise: Promise<void> | null = null;

  /**
   * Создаёт контроллер.
   *
   * @param dependencies - Подготовка рынков, источник подписок, часы, логгер
   *
   * @example
   * ```typescript
   * const controller = new PolymarketSubscriptionController({ discovery, source, clock, logger });
   * ```
   */
  public constructor(dependencies: PolymarketSubscriptionControllerDependencies) {
    this._discovery = dependencies.discovery;
    this._source = dependencies.source;
    this._clock = dependencies.clock;
    this._logger = dependencies.logger;
  }

  /**
   * Остановлен ли контроллер.
   *
   * @returns `true` после {@link PolymarketSubscriptionController.close}
   */
  public get isClosed(): boolean {
    return this._closed;
  }

  /**
   * Приобретает рынок для владельца (claim + при необходимости физический ресурс).
   *
   * @param ownerKey - Стабильный непрозрачный ключ владельца
   * @param entry - Canonical запись рынка (из плана вызывающего)
   * @returns Исход приобретения (см. {@link PolymarketAcquireResult})
   * @throws {ValidationError} Если ключ владельца пуст
   *
   * @remarks
   * Первый владелец рынка СИНХРОННО — до первого `await` — резервирует
   * состояние `OPENING` и кладёт его в карту. Только благодаря этому два
   * одновременных `acquire` одного рынка не открывают две физические
   * подписки: второй вызов видит уже существующую резервацию, добавляет
   * свой claim и ждёт ТОТ ЖЕ `opening`.
   *
   * Порядок проверок для НОВОГО владельца: контроллер закрыт → источник
   * недоступен → площадка → состояние рынка → строгий pre-open. Владелец,
   * уже держащий claim, проверок расписания не проходит вовсе — его
   * удержание идемпотентно (см. TSDoc класса).
   *
   * @example
   * ```typescript
   * const result = await controller.acquire('strategy:A', entry);
   * if (result.status === 'failed') {
   *   // транспорт отказал, всё открытое откачено — рынок можно ретраить
   * }
   * ```
   */
  public async acquire(
    ownerKey: SubscriptionOwnerKey,
    entry: MarketDiscoveryEntry,
  ): Promise<PolymarketAcquireResult> {
    assertOwnerKey(ownerKey);
    const marketId = entry.market.id;
    const key = String(marketId);

    const existing = this._markets.get(key);
    if (existing !== undefined) {
      return this._joinExisting(ownerKey, entry, existing);
    }

    // ── Синхронная секция: никаких await до резервации ─────────────────────
    if (this._closed) {
      return { status: 'rejected', marketId, reason: 'controller-closed' };
    }
    if (this._source.isClosed) {
      return { status: 'rejected', marketId, reason: 'source-unavailable' };
    }
    if (this._source.hasFailed) {
      // Резервации ещё нет, поэтому await безопасен: сначала снимаем
      // устаревшее состояние отказавшего источника, потом отвечаем отказом.
      await this.reconcileSourceFailure();
      return { status: 'rejected', marketId, reason: 'source-unavailable' };
    }
    const ineligible = this._checkEligibility(entry);
    if (ineligible !== undefined) {
      this._logger.debug('Acquisition rejected before reservation', {
        marketId: key,
        ownerKey,
        reason: ineligible,
      });
      return { status: 'rejected', marketId, reason: ineligible };
    }

    let settle: (outcome: OpenTransactionOutcome) => void = () => undefined;
    const opening = new Promise<OpenTransactionOutcome>((resolve) => {
      settle = resolve;
    });
    const state: MarketSubscriptionState = {
      marketId,
      entry,
      state: 'OPENING',
      owners: new Set([ownerKey]),
      opening,
      settle,
      rtdsFeedKeys: [],
    };
    this._markets.set(key, state); // резервация OPENING + первый claim

    this._logger.info('Market subscription opening', { marketId: key, ownerKey });

    const outcome = await this._runOpenTransaction(state).catch(async (error: unknown) => {
      // Сетка безопасности: неожиданное исключение вне собственных catch-веток
      // транзакции не должно оставить вечную OPENING-резервацию и открытые
      // ресурсы. Всё, что транзакция успела приобрести, лежит в состоянии.
      await this._rollback(state);
      this._logger.error('Open transaction failed unexpectedly, reservation released', {
        marketId: key,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'failed', stage: 'market-subscription' } as const;
    });
    state.settle(outcome);

    if (outcome.status === 'opened') {
      return { status: 'opened', marketId };
    }
    return this._toAcquireResult(outcome, marketId);
  }

  /**
   * Снимает claim владельца; последний claim закрывает физический ресурс.
   *
   * @param ownerKey - Ключ владельца
   * @param marketId - Canonical id рынка
   * @returns `not-held` | `retained` | `closed` (см. {@link PolymarketReleaseResult})
   * @throws {ValidationError} Если ключ владельца пуст
   *
   * @remarks
   * Если рынок ещё в `OPENING`, вызов ДОЖИДАЕТСЯ исхода транзакции: снимать
   * claim с ресурса, который сейчас открывается, нельзя — иначе владелец
   * «отпустил» бы рынок, который через миллисекунду станет ACTIVE и
   * останется без хозяина. Если транзакция откатилась, состояния уже нет и
   * ответ честный — `not-held`.
   *
   * После ожидания состояние сверяется ПО ОБЪЕКТУ, а не по id: за время
   * ожидания транзакция могла откатиться, а повторный `acquire` — поставить
   * под тем же ключом НОВОЕ состояние. Закрыть его этим release означало бы
   * снести чужой, только что открытый ресурс.
   *
   * @example
   * ```typescript
   * await controller.release('strategy:A', marketId); // 'retained' — держит коллектор
   * ```
   */
  public async release(
    ownerKey: SubscriptionOwnerKey,
    marketId: MarketId,
  ): Promise<PolymarketReleaseResult> {
    assertOwnerKey(ownerKey);
    const key = String(marketId);
    const reserved = this._markets.get(key);
    if (reserved === undefined || !reserved.owners.has(ownerKey)) {
      return 'not-held';
    }

    await reserved.opening;

    const current = this._markets.get(key);
    if (current !== reserved || !current.owners.has(ownerKey)) {
      return 'not-held'; // транзакция откатилась либо claim уже снят
    }

    current.owners.delete(ownerKey);
    if (current.owners.size > 0) {
      this._logger.info('Owner released claim, market subscription retained', {
        marketId: key,
        ownerKey,
        remainingOwners: current.owners.size,
      });
      return 'retained';
    }

    // Синхронно до первого await: второй release/acquire увидит пустой ключ
    this._markets.delete(key);
    this._logger.info('Last owner released claim, closing market subscription', {
      marketId: key,
      ownerKey,
    });
    await this._closePhysicalResources(current);
    return 'closed';
  }

  /**
   * Снимает ВСЕ claim-ы владельца.
   *
   * @param ownerKey - Ключ владельца
   * @returns Сколько claim-ов было снято
   * @throws {ValidationError} Если ключ владельца пуст
   *
   * @remarks
   * Нужен, когда владелец перестал существовать: инстанс стратегии
   * остановлен, конфигурация удалена, сборщик выключен. ПОЧЕМУ это
   * произошло, контроллер не знает и не выясняет — никакой оценки policy
   * здесь нет.
   *
   * @example
   * ```typescript
   * const released = await controller.releaseOwner('strategy:btc-5m');
   * logger.info('strategy stopped', { releasedClaims: released });
   * ```
   */
  public async releaseOwner(ownerKey: SubscriptionOwnerKey): Promise<number> {
    assertOwnerKey(ownerKey);
    let released = 0;
    for (const state of [...this._markets.values()]) {
      if (!state.owners.has(ownerKey)) {
        continue;
      }
      const result = await this.release(ownerKey, state.marketId);
      if (result !== 'not-held') {
        released += 1;
      }
    }
    if (released > 0) {
      this._logger.info('All claims of owner released', { ownerKey, releasedClaims: released });
    }
    return released;
  }

  /**
   * Приводит состояние контроллера в соответствие с ТЕРМИНАЛЬНЫМ отказом источника.
   *
   * @returns `true`, если источник в терминальном отказе (состояние снято);
   *   `false` — источник жив, вызов ничего не делает
   *
   * @remarks
   * `PolymarketSource.hasFailed` необратим: источник уже закрыл СВОИ
   * handles. Продолжать считать наши подписки физически живыми после этого
   * нельзя — они не живы, и claim-ы больше ничем не обеспечены. Поэтому
   * контроллер дожидается идущих транзакций, снимает состояния рынков и
   * сбрасывает учёт RTDS-фидов; закрытие handles — идемпотентная
   * подстраховка, а не необходимость.
   *
   * Замена источника здесь НЕ выполняется: пересобрать пару
   * «источник + контроллер» и заново материализовать claim-ы по живым
   * владельцам — работа composition root, у которого эти владельцы есть.
   */
  public async reconcileSourceFailure(): Promise<boolean> {
    if (!this._source.hasFailed) {
      return false;
    }
    if (this._markets.size === 0 && this._rtdsFeeds.size === 0) {
      return true;
    }

    this._logger.error('Source entered terminal failure, dropping all market subscriptions', {
      markets: this._markets.size,
      rtdsFeeds: this._rtdsFeeds.size,
    });

    // Идущие транзакции докатываются сами (их подписки на отказавшем
    // источнике упадут либо не пройдут re-check) — дожидаемся исхода.
    await Promise.allSettled([...this._markets.values()].map((state) => state.opening));

    for (const state of [...this._markets.values()]) {
      this._discard(state);
      await this._closePhysicalResources(state);
    }
    await this._forceCloseRemainingFeeds('source failure');
    return true;
  }

  /**
   * Останавливает контроллер: teardown всех подписок и claim-ов.
   *
   * @returns Promise завершения остановки
   *
   * @remarks
   * Идемпотентен: повторные вызовы ждут первый. Порядок — запрет новых
   * приобретений → ожидание идущих транзакций (они видят флаг закрытия на
   * своих re-check и откатываются сами) → закрытие оставшихся ACTIVE →
   * освобождение RTDS-ссылок.
   *
   * `source.close()` НЕ вызывается: источник принадлежит composition root
   * и разделён с другими потребителями — закрыть его отсюда означало бы
   * оборвать чужие подписки. По той же причине не закрываются ни шина, ни
   * discovery.
   *
   * @example
   * ```typescript
   * await controller.close();
   * await source.close(); // порядок shutdown — дело composition root
   * ```
   */
  public async close(): Promise<void> {
    if (this._closePromise !== null) {
      return this._closePromise;
    }
    this._closed = true; // новые приобретения запрещены с этого тика
    this._closePromise = (async () => {
      await Promise.allSettled([...this._markets.values()].map((state) => state.opening));

      for (const state of [...this._markets.values()]) {
        this._discard(state);
        await this._closePhysicalResources(state);
      }
      await this._forceCloseRemainingFeeds('controller shutdown');

      this._logger.info('PolymarketSubscriptionController closed');
    })();
    return this._closePromise;
  }

  /**
   * Возвращает снимок состояния контроллера.
   *
   * @returns Замороженная статистика (см. {@link PolymarketSubscriptionControllerStats})
   *
   * @example
   * ```typescript
   * const { activeMarkets, claims, rtdsFeeds } = controller.getStats();
   * ```
   */
  public getStats(): PolymarketSubscriptionControllerStats {
    let opening = 0;
    let active = 0;
    let claims = 0;
    for (const state of this._markets.values()) {
      if (state.state === 'ACTIVE') {
        active += 1;
      } else {
        opening += 1;
      }
      claims += state.owners.size;
    }

    const rtdsFeeds: PolymarketSharedRtdsFeedStat[] = [...this._rtdsFeeds.values()].map((shared) =>
      Object.freeze({
        topic: shared.feed.topic,
        symbol: shared.feed.symbol,
        ...(isTwapRtdsFeed(shared.feed) ? { windowSeconds: shared.feed.windowSeconds } : {}),
        refCount: shared.refs.size,
      }),
    );

    return Object.freeze({
      openingMarkets: opening,
      activeMarkets: active,
      claims,
      rtdsFeeds: Object.freeze(rtdsFeeds),
      sourceFailed: this._source.hasFailed,
      closed: this._closed,
    });
  }

  /**
   * Возвращает снимки всех подписок.
   *
   * @returns Снимки, отсортированные по id рынка; владельцы внутри —
   *   лексикографически
   *
   * @remarks
   * Порядок детерминирован намеренно: множества владельцев и карты рынков
   * хранят порядок вставки, и диагностика, зависящая от того, кто
   * подписался первым, расходилась бы между одинаковыми прогонами.
   * Runtime-identity от порядка не зависит вовсе.
   *
   * Vendor-моделей в снимке нет: наружу выходит только canonical.
   *
   * @example
   * ```typescript
   * for (const item of controller.listSubscriptions()) {
   *   logger.info('subscription', { marketId: String(item.marketId), owners: item.ownerKeys });
   * }
   * ```
   */
  public listSubscriptions(): PolymarketSubscriptionSnapshot[] {
    return [...this._markets.values()]
      .map((state) =>
        Object.freeze({
          marketId: state.marketId,
          state: state.state,
          ownerKeys: Object.freeze([...state.owners].sort()),
          startsAt: state.entry.market.startsAt,
          rtdsFeedCount: state.rtdsFeedKeys.length,
        }),
      )
      .sort((a, b) => {
        const left = String(a.marketId);
        const right = String(b.marketId);
        if (left < right) return -1;
        return left > right ? 1 : 0;
      });
  }

  /**
   * Обрабатывает `acquire` для рынка, который уже приобретён или открывается.
   *
   * @param ownerKey - Ключ владельца
   * @param entry - Canonical запись вызывающего
   * @param existing - Существующее состояние рынка
   * @returns Исход приобретения
   *
   * @remarks
   * Порядок здесь — сам инвариант: сперва «этот владелец уже держит claim?»
   * (тогда удержание идемпотентно и расписание не проверяется), и только
   * потом строгий pre-open гейт для НОВОГО владельца.
   *
   * Гейт нового владельца считается по ОБЕИМ записям — своей и той, по
   * которой рынок реально приобретён. Расхождение записи вызывающего с
   * удерживаемой не должно открывать обход правила «до старта»: рынок один,
   * и его расписание — свойство рынка, а не аргумента вызова.
   */
  private async _joinExisting(
    ownerKey: SubscriptionOwnerKey,
    entry: MarketDiscoveryEntry,
    existing: MarketSubscriptionState,
  ): Promise<PolymarketAcquireResult> {
    const marketId = existing.marketId;

    // Доступность проверяется ДО ветки удержания: на остановленном
    // контроллере и на отказавшем источнике ответ «claim при вас» был бы
    // ложью — ресурс за этим claim-ом уже разбирается либо мёртв.
    if (this._closed) {
      return { status: 'rejected', marketId, reason: 'controller-closed' };
    }
    if (this._source.isClosed) {
      return { status: 'rejected', marketId, reason: 'source-unavailable' };
    }
    if (this._source.hasFailed) {
      await this.reconcileSourceFailure();
      return { status: 'rejected', marketId, reason: 'source-unavailable' };
    }

    if (existing.owners.has(ownerKey)) {
      if (existing.state === 'ACTIVE') {
        return { status: 'already-held', marketId };
      }
      // Тот же владелец во время OPENING: второй физический ресурс не
      // открывается, ответ даётся только после исхода транзакции.
      const outcome = await existing.opening;
      return outcome.status === 'opened'
        ? { status: 'already-held', marketId }
        : this._toAcquireResult(outcome, marketId);
    }

    const ineligible =
      this._checkEligibility(entry) ??
      (this._isStarted(existing.entry) ? ('already-started' as const) : undefined);
    if (ineligible !== undefined) {
      this._logger.debug('Join rejected: new owner cannot acquire this market', {
        marketId: String(marketId),
        ownerKey,
        reason: ineligible,
      });
      return { status: 'rejected', marketId, reason: ineligible };
    }

    existing.owners.add(ownerKey); // claim добавляется синхронно
    if (existing.state === 'ACTIVE') {
      this._logger.info('Owner joined existing market subscription', {
        marketId: String(marketId),
        ownerKey,
        owners: existing.owners.size,
      });
      return { status: 'joined', marketId };
    }

    const outcome = await existing.opening;
    if (outcome.status === 'opened') {
      this._logger.info('Owner joined market subscription opened concurrently', {
        marketId: String(marketId),
        ownerKey,
      });
      return { status: 'joined', marketId };
    }
    // Транзакция откатилась: состояния нет, provisional claim исчез вместе с ним
    return this._toAcquireResult(outcome, marketId);
  }

  /**
   * Транзакция открытия физического ресурса рынка.
   *
   * @param state - Зарезервированное состояние `OPENING`
   * @returns Исход транзакции
   *
   * @remarks
   * Порядок шагов:
   *
   * ```text
   * 1. vendor-подготовка prepareMarket()      (сеть не трогается)
   * 2. сверка подготовки с canonical entry
   * 3. hard pre-open re-check ДО ресурсов
   * 4. source.subscribeMarket(instrumentIds)
   * 5. hard pre-open re-check ПОСЛЕ await
   * 6. shared RTDS-фиды
   * 7. hard pre-open re-check ПОСЛЕ всех RTDS await
   * 8. commit ACTIVE
   * ```
   *
   * Любой отказ после открытия ресурса откатывает ВСЁ открытое и удаляет
   * состояние вместе с provisional claim-ами: контроллер не хранит claim на
   * несуществующий физический ресурс, и рынок можно ретраить.
   */
  private async _runOpenTransaction(
    state: MarketSubscriptionState,
  ): Promise<OpenTransactionOutcome> {
    const key = String(state.marketId);

    // ── 1. Vendor-подготовка ───────────────────────────────────────────────
    const selected = this._discovery.prepareMarket(state.marketId);
    if (selected === undefined) {
      await this._rollback(state);
      this._logger.warn('Vendor preparation unavailable, acquisition rejected', { marketId: key });
      return { status: 'rejected', reason: 'not-prepared' };
    }

    // ── 2. Подготовка описывает ТУ ЖЕ версию записи ────────────────────────
    if (!isPreparationConsistent(selected, state.entry)) {
      await this._rollback(state);
      this._logger.warn('Vendor preparation does not match canonical entry, acquisition rejected', {
        marketId: key,
        entryStartsAt: state.entry.market.startsAt.toISO(),
        preparedStartsAt: selected.eventStartsAt.toISO(),
      });
      return { status: 'rejected', reason: 'stale-preparation' };
    }
    state.selected = selected;

    // ── 3. Последний гейт до открытия ресурсов ─────────────────────────────
    const beforeOpen = this._blockingCondition(state.entry);
    if (beforeOpen !== undefined) {
      await this._rollback(state);
      return { status: 'rejected', reason: beforeOpen };
    }

    // Инструменты рынка — единственный source of truth: outcomes[]
    const instrumentIds = selected.outcomes.map((outcome) => outcome.instrumentId);

    // ── 4. Физическая подписка рынка ───────────────────────────────────────
    try {
      state.marketSubscription = await this._source.subscribeMarket(instrumentIds);
    } catch (error) {
      await this._rollback(state);
      this._logger.error('Market subscription failed, acquisition rolled back', {
        marketId: key,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'failed', stage: 'market-subscription' };
    }

    // ── 5. Re-check ПОСЛЕ await подписки ───────────────────────────────────
    const afterMarket = this._blockingCondition(state.entry);
    if (afterMarket !== undefined) {
      await this._rollback(state);
      this._logger.warn('Market started while its subscription was opening, rolled back', {
        marketId: key,
        reason: afterMarket,
      });
      return { status: 'rejected', reason: afterMarket };
    }

    // ── 6. Shared RTDS-фиды рынка ──────────────────────────────────────────
    try {
      state.rtdsFeedKeys = await this._acquireRtdsFeeds(key, selected.rtdsFeeds);
    } catch (error) {
      await this._rollback(state);
      this._logger.error('RTDS subscription failed, acquisition rolled back', {
        marketId: key,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'failed', stage: 'rtds-subscription' };
    }

    // ── 7. Re-check ПОСЛЕ всех RTDS await ──────────────────────────────────
    const afterRtds = this._blockingCondition(state.entry);
    if (afterRtds !== undefined) {
      await this._rollback(state);
      this._logger.warn('Market started while its RTDS feeds were opening, rolled back', {
        marketId: key,
        reason: afterRtds,
      });
      return { status: 'rejected', reason: afterRtds };
    }

    // ── 8. Commit ACTIVE ───────────────────────────────────────────────────
    state.state = 'ACTIVE';
    this._logger.info('Market subscription active', {
      marketId: key,
      owners: state.owners.size,
      instruments: instrumentIds.length,
      rtdsFeeds: selected.rtdsFeeds.map(rtdsFeedLabel),
      startsAt: state.entry.market.startsAt.toISO(),
    });
    return { status: 'opened' };
  }

  /**
   * Проверяет пригодность рынка для НОВОГО владельца.
   *
   * @param entry - Canonical запись рынка
   * @returns Причина отказа либо `undefined`
   *
   * @remarks
   * Ровно три проверки — площадка, подтверждённое состояние и строгое «торги
   * ещё не начались». Ни активов, ни номиналов серий, ни ликвидности, ни
   * ключевых слов, ни окна policy, ни минимального запаса времени: всё это
   * — правила ПЛАНИРОВАНИЯ, они уже применены выше по контуру, и повторять
   * их здесь значило бы завести вторую систему отбора.
   *
   * Строгая граница `now < startsAt` проверяется по инжектированным часам,
   * а не по возрасту плана: план мог быть построен минуты назад.
   */
  private _checkEligibility(entry: MarketDiscoveryEntry): PolymarketAcquireRejection | undefined {
    if (entry.market.venueId !== KnownVenues.POLYMARKET) {
      return 'wrong-venue';
    }
    if (!entry.market.isActive()) {
      return 'inactive';
    }
    if (this._isStarted(entry)) {
      return 'already-started';
    }
    return undefined;
  }

  /**
   * Условие, запрещающее продолжать транзакцию открытия.
   *
   * @param entry - Canonical запись рынка
   * @returns Причина остановки либо `undefined`
   *
   * @remarks
   * Вызывается ПОСЛЕ каждой асинхронной границы: за время ожидания
   * транспорта контроллер могли закрыть, источник — отказать, а рынок —
   * стартовать (см. TSDoc класса).
   */
  private _blockingCondition(
    entry: MarketDiscoveryEntry,
  ): PolymarketAcquireRejection | undefined {
    if (this._closed) {
      return 'controller-closed';
    }
    if (this._source.isClosed || this._source.hasFailed) {
      return 'source-unavailable';
    }
    if (this._isStarted(entry)) {
      return 'already-started';
    }
    return undefined;
  }

  /**
   * Начались ли торги по рынку к текущему моменту часов.
   *
   * @param entry - Canonical запись рынка
   * @returns `true`, если `now >= startsAt`
   *
   * @remarks
   * Момент берётся из инжектированных часов и сравнивается доменной
   * операцией `Market.isStartedAt` — той же самой, которой пользуется
   * планировщик. Второй арифметики над миллисекундами в контуре нет.
   */
  private _isStarted(entry: MarketDiscoveryEntry): boolean {
    return entry.market.isStartedAt(Timestamp.now(this._clock));
  }

  /**
   * Переводит НЕуспешный исход транзакции в исход приобретения.
   *
   * @param outcome - Исход транзакции, кроме `opened`
   * @param marketId - Id рынка
   * @returns Отказ либо сбой с тем же основанием
   *
   * @remarks
   * Успешный исход сюда не приходит по типу: `opened` означает РАЗНОЕ для
   * первого владельца (`opened`), присоединившегося (`joined`) и уже
   * державшего claim (`already-held`), и решать это обязан вызывающий, а не
   * общий переводчик.
   */
  private _toAcquireResult(
    outcome: Exclude<OpenTransactionOutcome, { status: 'opened' }>,
    marketId: MarketId,
  ): PolymarketAcquireResult {
    return outcome.status === 'rejected'
      ? { status: 'rejected', marketId, reason: outcome.reason }
      : { status: 'failed', marketId, stage: outcome.stage };
  }

  /**
   * Откат неудачной транзакции: снять состояние и закрыть всё открытое.
   *
   * @param state - Состояние рынка
   *
   * @remarks
   * Состояние удаляется ПЕРВЫМ и синхронно: пока оно в карте, новый
   * `acquire` присоединялся бы к ресурсу, который уже разбирается.
   */
  private async _rollback(state: MarketSubscriptionState): Promise<void> {
    this._discard(state);
    await this._closePhysicalResources(state);
  }

  /**
   * Удаляет состояние из карты с identity-guard.
   *
   * @param state - Состояние рынка
   *
   * @remarks
   * Сравнивается ОБЪЕКТ, а не ключ: после любого await под тем же
   * `marketId` могло появиться НОВОЕ состояние (успешный retry), и удалять
   * его чужой отложенной уборкой нельзя.
   */
  private _discard(state: MarketSubscriptionState): void {
    const key = String(state.marketId);
    if (this._markets.get(key) === state) {
      this._markets.delete(key);
    }
  }

  /**
   * Закрывает физические ресурсы рынка: подписку и его RTDS-ссылки.
   *
   * @param state - Состояние рынка
   *
   * @remarks
   * Идемпотентно по построению: закрытая подписка закрывается повторно
   * молча, а отпущенные ссылки на фиды второй раз не находятся. Ошибки
   * teardown не пробрасываются — на этом пути их некому обработать, а
   * оборвать разбор состояния они не должны.
   */
  private async _closePhysicalResources(state: MarketSubscriptionState): Promise<void> {
    const key = String(state.marketId);
    if (state.marketSubscription !== undefined) {
      const subscription = state.marketSubscription;
      state.marketSubscription = undefined;
      try {
        await subscription.close();
      } catch (error) {
        this._logger.warn('Failed to close market subscription', {
          marketId: key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const feedKeys = state.rtdsFeedKeys;
    state.rtdsFeedKeys = [];
    await this._releaseRtdsFeeds(key, feedKeys);
  }

  /**
   * Приобретает RTDS-фиды рынка: новый — одна подписка на всех, существующий — +ref.
   *
   * @param marketKey - Ключ РЫНКА, держащего ссылки
   * @param feeds - Фиды подготовленного рынка
   * @returns Ключи приобретённых фидов
   * @throws Ошибка подписки источника — приобретённые ссылки уже освобождены
   *
   * @remarks
   * Запись фида с общим `pending` регистрируется СИНХРОННО, до первого
   * await, поэтому конкурентное приобретение одного фида двумя рынками не
   * создаёт вторую подписку: оба ждут один promise. Отказ открытия
   * освобождает ссылки ожидающих; последняя удаляет запись, и retry создаст
   * новую.
   */
  private async _acquireRtdsFeeds(
    marketKey: string,
    feeds: readonly PolymarketRtdsFeed[],
  ): Promise<readonly string[]> {
    const acquired: string[] = [];
    for (const feed of feeds) {
      const key = rtdsFeedKey(feed);
      let shared = this._rtdsFeeds.get(key);
      if (shared === undefined) {
        shared = {
          feed,
          refs: new Set<string>(),
          // Vendor boundary: у settlement-потока СВОЙ spec подписки
          // (обязательное окно усреднения), поэтому и метод источника отдельный
          pending: isTwapRtdsFeed(feed)
            ? this._source.subscribeChainlinkTwap(feed.windowSeconds, [feed.symbol])
            : this._source.subscribeCryptoPrices(feed.topic, [feed.symbol]),
        };
        this._rtdsFeeds.set(key, shared);
        this._logger.info('RTDS feed subscription opening', { feed: rtdsFeedLabel(feed) });
      }
      shared.refs.add(marketKey);
      acquired.push(key);
      try {
        await shared.pending;
      } catch (error) {
        await this._releaseRtdsFeeds(marketKey, acquired);
        throw error;
      }
    }
    return acquired;
  }

  /**
   * Освобождает ссылки рынка на фиды; последняя ссылка закрывает подписку.
   *
   * @param marketKey - Ключ рынка-владельца ссылок
   * @param feedKeys - Ключи фидов
   */
  private async _releaseRtdsFeeds(
    marketKey: string,
    feedKeys: readonly string[],
  ): Promise<void> {
    for (const key of feedKeys) {
      const shared = this._rtdsFeeds.get(key);
      if (shared === undefined || !shared.refs.has(marketKey)) {
        continue; // фид уже освобождён либо заменён новой подпиской
      }
      shared.refs.delete(marketKey);
      if (shared.refs.size > 0) {
        continue; // фид нужен другим РЫНКАМ — подписка живёт
      }
      this._rtdsFeeds.delete(key);
      await this._closeFeedSubscription(shared);
      this._logger.info('RTDS feed subscription closed (no more refs)', {
        feed: rtdsFeedLabel(shared.feed),
      });
    }
  }

  /**
   * Закрывает подписку фида.
   *
   * @param shared - Запись фида
   *
   * @remarks
   * Отказ открытия — уже обработанный путь acquire: закрывать нечего,
   * ошибка гасится здесь и не всплывает в teardown.
   */
  private async _closeFeedSubscription(shared: SharedRtdsFeed): Promise<void> {
    try {
      const subscription = await shared.pending;
      await subscription.close();
    } catch {
      // Подписка так и не открылась либо транспорт уже мёртв — закрывать нечего.
    }
  }

  /**
   * Досрочно закрывает фиды, оставшиеся без рынков-держателей.
   *
   * @param reason - Причина для лога
   *
   * @remarks
   * Инвариант контура: после teardown всех рынков shared-фидов не остаётся.
   * Остаток — признак дефекта учёта, и он должен быть виден в логах, а не
   * утекать открытым сокетом.
   */
  private async _forceCloseRemainingFeeds(reason: string): Promise<void> {
    if (this._rtdsFeeds.size === 0) {
      return;
    }
    this._logger.warn('RTDS feeds outlived their markets, force-closing', {
      reason,
      feeds: [...this._rtdsFeeds.keys()],
    });
    for (const [key, shared] of [...this._rtdsFeeds]) {
      this._rtdsFeeds.delete(key);
      await this._closeFeedSubscription(shared);
    }
  }
}
