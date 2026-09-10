/**
 * Read-only проекции приватного состояния для потребителей.
 *
 * @remarks
 * Единственный писатель — `AccountStateProjector`. Поэтому наружу из пакета
 * выходят только эти интерфейсы, а конкретные mutable-классы не
 * экспортируются вовсе: иначе правило «один писатель» осталось бы
 * комментарием, который ничто не проверяет, и любой потребитель мог бы
 * вызвать `applyFill()` без единого приведения типов.
 *
 * Глубоких копий при чтении НЕ делается: это горячий путь. Возвращаемые
 * массивы объявлены `readonly`, а `Order`, `Fill` и `Portfolio` immutable по
 * построению.
 */
import type { AccountId, FillId, InstrumentId, OrderId, VenueId } from '@polymarket/ids';
import type { IPosition, Portfolio } from '@polymarket/portfolio';
import type { Timestamp } from '@polymarket/timestamp';
import type { AccountFillRecord, AccountOrderRecord } from './records.js';

/**
 * Идентичность торгового аккаунта — ПАРА, а не один идентификатор.
 *
 * @remarks
 * Один и тот же строковый идентификатор аккаунта в пространствах имён двух
 * площадок — два РАЗНЫХ торговых аккаунта с разными деньгами. То же правило,
 * что у рынка в `@polymarket/trading-state`.
 *
 * Тип нужен перечислению: `getAccount()` принимает пару аргументов, а плоский
 * список аккаунтов не позволил бы построить обратный вызов.
 */
export interface TradingAccountIdentity {
  /** Площадка аккаунта */
  readonly venueId: VenueId;
  /** Идентификатор аккаунта внутри пространства имён площадки */
  readonly accountId: AccountId;
}

/**
 * Состояние одного торгового аккаунта — только чтение.
 *
 * @remarks
 * Отдельных `balance`, `availableBalance`, `reservedBalance`, `positions` и
 * `tokenReservations` здесь НЕТ и быть не должно: всё это уже живёт в
 * `portfolio` и связано его инвариантами. Второй набор полей неизбежно
 * разошёлся бы с первым, и вопрос «сколько у нас свободных денег» получил бы
 * два разных ответа.
 *
 * ```text
 * state.portfolio.balance             деньги: available + reserved
 * state.portfolio.positions           позиции по инструментам
 * state.portfolio.tokenReservations   зарезервированные токены
 * ```
 *
 * @example
 * ```typescript
 * const account = view.getAccount(venueId, accountId);
 * account?.portfolio.balance.available();
 * account?.openOrders().length;
 * account?.getPosition(instrumentId)?.quantity.value();
 * ```
 */
export interface AccountRuntimeStateView {
  /** Площадка аккаунта */
  readonly venueId: VenueId;
  /** Аккаунт в том виде, в каком он был принят при инициализации */
  readonly accountId: AccountId;
  /**
   * Единственный источник истины по деньгам, позициям и резервациям.
   *
   * @remarks
   * `Portfolio` immutable, поэтому отдаётся ссылкой без копирования. Каждая
   * принятая мутация заменяет его целиком на post-commit снимок из события.
   */
  readonly portfolio: Portfolio;
  /**
   * Сколько принятых мутаций изменило ЭТОТ аккаунт.
   *
   * @remarks
   * Инициализация — первая мутация, поэтому у только что созданного аккаунта
   * версия равна 1, а не 0. Отвергнутое событие и дубликат версию не меняют.
   */
  readonly version: number;
  /**
   * `metadata.createdAt` последней принятой мутации аккаунта.
   *
   * @remarks
   * Это время СОБЫТИЯ, а не показания часов и не `order.timestamp` /
   * `fill.timestamp`. Повтор той же ленты событий даёт то же значение —
   * иначе replay перестал бы совпадать с торговлей.
   */
  readonly lastMutationAt: Timestamp;

  /** Заявка по идентификатору либо `undefined` */
  getOrder(orderId: OrderId): AccountOrderRecord | undefined;
  /** Все известные заявки аккаунта */
  orders(): readonly AccountOrderRecord[];
  /**
   * Заявки в живых статусах.
   *
   * @remarks
   * Живыми считаются `PENDING`, `OPEN` и `PARTIALLY_FILLED`. `PENDING`
   * входит СОЗНАТЕЛЬНО: для нашего рантайма это уже незавершённая экспозиция
   * — деньги или токены под неё зарезервированы, — даже если площадка ещё не
   * подтвердила приём.
   *
   * Терминальные (`FILLED`, `CANCELED`, `REJECTED`, `EXPIRED`) исключены.
   */
  openOrders(): readonly AccountOrderRecord[];
  /**
   * Заявки по инструменту.
   *
   * @param instrumentId - Инструмент, полученный из `order.asset`
   *
   * @remarks
   * Инструмент вычисляется из `assetIdToInstrumentId(order.asset)` при
   * commit'е — второго поля `instrumentId` внутри записи нет.
   */
  ordersForInstrument(instrumentId: InstrumentId): readonly AccountOrderRecord[];

  /** Исполнение по идентификатору либо `undefined` */
  getFill(fillId: FillId): AccountFillRecord | undefined;
  /** Все известные исполнения аккаунта */
  fills(): readonly AccountFillRecord[];
  /** Исполнения одной заявки */
  fillsForOrder(orderId: OrderId): readonly AccountFillRecord[];
  /** Исполнения по инструменту */
  fillsForInstrument(instrumentId: InstrumentId): readonly AccountFillRecord[];

  /**
   * Позиция по инструменту.
   *
   * @param instrumentId - Инструмент позиции
   * @returns Позиция из `portfolio.positions` либо `undefined`
   *
   * @remarks
   * Это ЧТЕНИЕ ИЗ ПОРТФЕЛЯ, а не отдельная коллекция: параллельной
   * `positions: Map` в состоянии аккаунта нет. Удобный доступ — да, второй
   * источник истины — нет.
   */
  getPosition(instrumentId: InstrumentId): IPosition | undefined;
}

/**
 * Приватное состояние — только чтение.
 *
 * @remarks
 * Единственный тип состояния, доступный за пределами пакета.
 *
 * @example
 * ```typescript
 * const view: AccountHotStateView = projector.state();
 * const account = view.getAccount(venueId, accountId);
 * account?.portfolio.balance.available().value();
 * ```
 */
export interface AccountHotStateView {
  /**
   * Сколько принятых приватных мутаций произошло по ВСЕМ аккаунтам.
   *
   * @remarks
   * Глобальный счётчик, а не сумма чего-либо: одно принятое событие
   * увеличивает и его, и версию затронутого аккаунта — ровно на единицу
   * каждую, даже если атомарно изменились исполнение, заявка, портфель и три
   * индекса.
   */
  getVersion(): number;
  /**
   * Состояние аккаунта либо `undefined`, если он не инициализирован.
   *
   * @param venueId - Площадка аккаунта — обязательная часть идентичности
   * @param accountId - Аккаунт внутри пространства имён площадки
   *
   * @remarks
   * Поиск идёт по canonical-строке `AccountId`, а не по ссылке на объект:
   * два эквивалентных `AccountId`, собранных в разных местах, находят ОДИН и
   * тот же аккаунт.
   */
  getAccount(venueId: VenueId, accountId: AccountId): AccountRuntimeStateView | undefined;
  /**
   * Идентичности всех инициализированных аккаунтов — парами.
   *
   * @remarks
   * Возвращает пары, а не список `AccountId`: из плоского списка нельзя
   * вызвать {@link getAccount}, а два аккаунта разных площадок с одинаковым
   * идентификатором в нём стали бы неотличимы.
   */
  accountIdentities(): readonly TradingAccountIdentity[];
}
