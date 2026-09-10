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
 * массивы объявлены `readonly`; `Fill` и `Portfolio` immutable по построению.
 * Порядок во всех перечисляющих методах — порядок принятия записей
 * состоянием; отдельной сортировки не вводится.
 *
 * ### Оговорка про `Order`
 *
 * `Order` immutable по ТОРГОВОМУ состоянию — все переходы возвращают новый
 * экземпляр, — но несёт внутренний буфер драфтов доменных событий, который
 * `pullEvents()` опустошает МУТАЦИЕЙ. Состояние этот буфер не читает и в
 * сравнение идентичности он не входит, поэтому на семантику проекции он не
 * влияет.
 *
 * Тем не менее вызывать `pullEvents()` на заявке, полученной отсюда, нельзя:
 * это изменит объект, лежащий в состоянии. Драфты обязан слить producer ДО
 * публикации `TRADING_ACCOUNT_ORDER_COMMITTED` — см. контракт события.
 */
import type { AccountId, FillId, InstrumentId, OrderId, VenueId } from '@polymarket/ids';
import type { Portfolio } from '@polymarket/portfolio';
import type { Position } from '@polymarket/position';
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
 * `tokenBalances` здесь НЕТ и быть не должно: всё это уже живёт в
 * `portfolio` и связано его инвариантами. Второй набор полей неизбежно
 * разошёлся бы с первым, и вопрос «сколько у нас свободных денег» получил бы
 * два разных ответа.
 *
 * ```text
 * state.portfolio.balance             деньги: available + reserved
 * state.portfolio.positions           позиции по инструментам
 * state.portfolio.tokenBalances       токены: доступные + зарезервированные
 * ```
 *
 * ### Навигация — производные представления
 *
 * ```text
 * orders / fills                  хранимое состояние
 *      ↓ scan + filter
 * ordersForInstrument / fillsForInstrument / fillsForOrder
 * ```
 *
 * Этот интерфейс описывает РЕЗУЛЬТАТ навигации, а не способ его получить.
 * Сейчас способ — линейный проход по каноническим коллекциям; хранимых
 * индексов нет. Завести внутренний индекс позже можно, не меняя ни одной
 * сигнатуры здесь.
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
   * @param instrumentId - Инструмент исхода
   *
   * @remarks
   * Производное представление: инструмент каждой заявки вычисляется из
   * `assetIdToInstrumentId(order.asset)` НА ЧТЕНИИ. Второго поля внутри записи
   * нет и хранимого индекса тоже — см. {@link AccountRuntimeStateView}.
   */
  ordersForInstrument(instrumentId: InstrumentId): readonly AccountOrderRecord[];

  /** Исполнение по идентификатору либо `undefined` */
  getFill(fillId: FillId): AccountFillRecord | undefined;
  /** Все известные исполнения аккаунта */
  fills(): readonly AccountFillRecord[];
  /**
   * Исполнения одной заявки.
   *
   * @param orderId - Заявка, исполнения которой нужны
   *
   * @remarks
   * Производное представление поверх {@link fills}; порядок — тот же, в
   * котором исполнения были приняты.
   */
  fillsForOrder(orderId: OrderId): readonly AccountFillRecord[];
  /**
   * Исполнения по инструменту.
   *
   * @param instrumentId - Инструмент исхода
   *
   * @remarks
   * Производное представление: инструмент вычисляется из
   * `assetIdToInstrumentId(fill.tokenId)` на чтении.
   */
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
  getPosition(instrumentId: InstrumentId): Position | undefined;
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
   * каждую, сколько бы частей состояния одна canonical-мутация ни затронула.
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
