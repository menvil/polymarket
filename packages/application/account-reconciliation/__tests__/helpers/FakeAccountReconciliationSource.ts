/**
 * Детерминированный authoritative-источник для тестов сверки.
 *
 * @remarks
 * Test-only: production HTTP здесь нет и не будет. Позволяет задать:
 *
 * ```text
 * данные      Portfolio, openOrders, fills, ответ getOrder по каждой заявке
 * отказы      Err или исключение на любом методе
 * блокировка  следующий вызов метода ждёт release() — для гонок и single-flight
 * счётчики    сколько раз вызван каждый метод и пик одновременных вызовов
 * ```
 *
 * Пик считается ПО МЕТОДУ: один проход читает портфель, заявки и исполнения
 * параллельно, поэтому три одновременных вызова разных методов — норма. А вот
 * два одновременных `getPortfolio` по одному аккаунту означают два прохода
 * сразу — ровно то, что запрещает single-flight.
 *
 * Данные отдаются на момент ОТВЕТА, а не вызова: заблокированный вызов после
 * `release()` увидит то, что тест успел поменять, — так же, как настоящий
 * источник отвечает состоянием на момент обработки запроса.
 */
import { accountKey } from '@polymarket/account-state';
import type { Fill } from '@polymarket/fill';
import type { AccountId, OrderId, VenueId } from '@polymarket/ids';
import type { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';
import { Err, Ok, type Result } from '@polymarket/result';
import {
  AccountReconciliationSourceError,
  type AccountReconciliationSourceOperation,
  type IAccountReconciliationSource,
} from '../../src/index.js';

/** Что источник знает об одном аккаунте. */
interface AccountData {
  portfolio: Portfolio | undefined;
  openOrders: readonly Order[];
  fills: readonly Fill[];
  /** Ответ `getOrder`; отсутствие ключа — «источник заявку не знает» */
  readonly orders: Map<OrderId, Order>;
}

/** Как метод должен отказать. */
type FailureMode = 'ERR' | 'THROW';

/**
 * Удержание следующего вызова метода.
 *
 * @remarks
 * `entered` разрешается, когда вызов дошёл до источника, — тест узнаёт, что
 * проход действительно начался, не угадывая число микротасок.
 */
export interface SourceHold {
  /** Вызов дошёл до источника и ждёт */
  readonly entered: Promise<void>;
  /** Отпустить вызов */
  release(): void;
}

interface PendingHold {
  readonly method: AccountReconciliationSourceOperation;
  /** Ключ аккаунта; `undefined` — любой аккаунт */
  readonly account: string | undefined;
  readonly markEntered: () => void;
  readonly gate: Promise<void>;
}

/** Удобный доступ к данным одного аккаунта. */
export interface FakeAccountHandle {
  setPortfolio(portfolio: Portfolio): FakeAccountHandle;
  setOpenOrders(orders: readonly Order[]): FakeAccountHandle;
  setFills(fills: readonly Fill[]): FakeAccountHandle;
  /** Настоящее состояние заявки для `getOrder` */
  setOrder(order: Order): FakeAccountHandle;
  /** Ответ `getOrder` для этой заявки — «не знаю» (`undefined`) */
  forgetOrder(orderId: OrderId): FakeAccountHandle;
  /**
   * Произвольный ответ `getOrder(orderId)` — в том числе ЧУЖАЯ заявка.
   *
   * @remarks
   * Нужен, чтобы проверить, что сверка не доверяет ответу, противоречащему
   * вопросу.
   */
  answerGetOrder(orderId: OrderId, answer: Order): FakeAccountHandle;
}

/**
 * Fake-реализация {@link IAccountReconciliationSource}.
 *
 * @example
 * ```typescript
 * const source = new FakeAccountReconciliationSource();
 * source.account(accountId).setPortfolio(portfolio()).setOpenOrders([order]);
 * const hold = source.holdNext('getPortfolio');
 * // … запустить проход …
 * await hold.entered;
 * hold.release();
 * ```
 */
export class FakeAccountReconciliationSource implements IAccountReconciliationSource {
  /** Сколько раз вызван каждый метод */
  public readonly calls: Record<AccountReconciliationSourceOperation, number> = {
    getPortfolio: 0,
    getOpenOrders: 0,
    getFills: 0,
    getOrder: 0,
  };
  /** Аргумент `orderId` каждого вызова `getOrder`, по порядку */
  public readonly getOrderCalls: OrderId[] = [];

  private readonly _accounts = new Map<string, AccountData>();
  private readonly _failures = new Map<AccountReconciliationSourceOperation, FailureMode>();
  private readonly _holds: PendingHold[] = [];
  /** Текущие и пиковые одновременные вызовы: `метод|аккаунт` и `метод|*` */
  private readonly _inFlight = new Map<string, number>();
  private readonly _peak = new Map<string, number>();

  /**
   * Пик одновременных вызовов метода.
   *
   * @param method - Метод источника
   * @param accountId - По одному аккаунту; по умолчанию — по всем
   * @returns Максимум вызовов, выполнявшихся одновременно
   */
  public peakConcurrency(method: AccountReconciliationSourceOperation, accountId?: AccountId): number {
    return this._peak.get(concurrencyKey(method, accountId === undefined ? '*' : accountKey(accountId))) ?? 0;
  }

  /**
   * Данные аккаунта — создаются пустыми при первом обращении.
   *
   * @param accountId - Аккаунт
   * @returns Handle для настройки данных
   */
  public account(accountId: AccountId): FakeAccountHandle {
    const data = this._data(accountId);
    const handle: FakeAccountHandle = {
      setPortfolio: (portfolio) => {
        data.portfolio = portfolio;
        return handle;
      },
      setOpenOrders: (orders) => {
        data.openOrders = orders;
        return handle;
      },
      setFills: (fills) => {
        data.fills = fills;
        return handle;
      },
      setOrder: (order) => {
        data.orders.set(order.id, order);
        return handle;
      },
      forgetOrder: (orderId) => {
        data.orders.delete(orderId);
        return handle;
      },
      answerGetOrder: (orderId, answer) => {
        data.orders.set(orderId, answer);
        return handle;
      },
    };
    return handle;
  }

  /**
   * Заставляет метод отказывать, пока не вызван {@link recover}.
   *
   * @param method - Метод источника
   * @param mode - `ERR` — вернуть `Err`, `THROW` — нарушить контракт порта исключением
   */
  public fail(method: AccountReconciliationSourceOperation, mode: FailureMode = 'ERR'): void {
    this._failures.set(method, mode);
  }

  /**
   * Снимает отказ метода.
   *
   * @param method - Метод источника
   */
  public recover(method: AccountReconciliationSourceOperation): void {
    this._failures.delete(method);
  }

  /**
   * Удерживает СЛЕДУЮЩИЙ вызов метода до `release()`.
   *
   * @param method - Метод источника
   * @param accountId - Только для этого аккаунта; по умолчанию — для любого
   * @returns Удержание
   */
  public holdNext(method: AccountReconciliationSourceOperation, accountId?: AccountId): SourceHold {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this._holds.push({
      method,
      account: accountId === undefined ? undefined : accountKey(accountId),
      markEntered,
      gate,
    });
    return { entered, release };
  }

  /** {@inheritDoc IAccountReconciliationSource.getPortfolio} */
  public getPortfolio(
    venueId: VenueId,
    accountId: AccountId,
  ): Promise<Result<Portfolio, AccountReconciliationSourceError>> {
    return this._serve('getPortfolio', venueId, accountId, undefined, (data) =>
      data.portfolio === undefined
        ? Err(
            new AccountReconciliationSourceError(
              'getPortfolio',
              venueId,
              accountId,
              'fake source: portfolio is not configured',
            ),
          )
        : Ok(data.portfolio),
    );
  }

  /** {@inheritDoc IAccountReconciliationSource.getOpenOrders} */
  public getOpenOrders(
    venueId: VenueId,
    accountId: AccountId,
  ): Promise<Result<readonly Order[], AccountReconciliationSourceError>> {
    return this._serve('getOpenOrders', venueId, accountId, undefined, (data) => Ok(data.openOrders));
  }

  /** {@inheritDoc IAccountReconciliationSource.getFills} */
  public getFills(
    venueId: VenueId,
    accountId: AccountId,
  ): Promise<Result<readonly Fill[], AccountReconciliationSourceError>> {
    return this._serve('getFills', venueId, accountId, undefined, (data) => Ok(data.fills));
  }

  /** {@inheritDoc IAccountReconciliationSource.getOrder} */
  public getOrder(
    venueId: VenueId,
    accountId: AccountId,
    orderId: OrderId,
  ): Promise<Result<Order | undefined, AccountReconciliationSourceError>> {
    this.getOrderCalls.push(orderId);
    return this._serve('getOrder', venueId, accountId, orderId, (data) => Ok(data.orders.get(orderId)));
  }

  /**
   * Общий путь вызова: счётчики, удержание, отказ, ответ.
   *
   * @param method - Метод
   * @param venueId - Площадка
   * @param accountId - Аккаунт
   * @param orderId - Заявка для `getOrder`
   * @param respond - Ответ по текущим данным аккаунта
   * @returns Ответ источника
   * @throws {Error} Если метод настроен на `THROW`
   */
  private async _serve<T>(
    method: AccountReconciliationSourceOperation,
    venueId: VenueId,
    accountId: AccountId,
    orderId: OrderId | undefined,
    respond: (data: AccountData) => Result<T, AccountReconciliationSourceError>,
  ): Promise<Result<T, AccountReconciliationSourceError>> {
    const key = accountKey(accountId);
    this.calls[method] += 1;
    const tracked = [concurrencyKey(method, key), concurrencyKey(method, '*')];
    for (const slot of tracked) this._enter(slot);
    try {
      const holdIndex = this._holds.findIndex(
        (hold) => hold.method === method && (hold.account === undefined || hold.account === key),
      );
      if (holdIndex >= 0) {
        const [hold] = this._holds.splice(holdIndex, 1);
        hold.markEntered();
        await hold.gate;
      } else {
        // Настоящий источник всегда асинхронен: ответ не приходит в том же тике.
        await Promise.resolve();
      }

      const failure = this._failures.get(method);
      if (failure === 'THROW') throw new Error(`fake source: ${method} exploded`);
      if (failure === 'ERR') {
        return Err(
          new AccountReconciliationSourceError(method, venueId, accountId, 'fake source: HTTP 503', {
            ...(orderId === undefined ? {} : { orderId }),
          }),
        );
      }
      return respond(this._data(accountId));
    } finally {
      for (const slot of tracked) this._leave(slot);
    }
  }

  private _data(accountId: AccountId): AccountData {
    const key = accountKey(accountId);
    let data = this._accounts.get(key);
    if (data === undefined) {
      data = { portfolio: undefined, openOrders: [], fills: [], orders: new Map() };
      this._accounts.set(key, data);
    }
    return data;
  }

  private _enter(slot: string): void {
    const current = (this._inFlight.get(slot) ?? 0) + 1;
    this._inFlight.set(slot, current);
    this._peak.set(slot, Math.max(this._peak.get(slot) ?? 0, current));
  }

  private _leave(slot: string): void {
    this._inFlight.set(slot, (this._inFlight.get(slot) ?? 1) - 1);
  }
}

/** Ключ счётчика одновременных вызовов. */
function concurrencyKey(method: AccountReconciliationSourceOperation, account: string): string {
  return `${method}|${account}`;
}
