/**
 * Market-centric read model приватного состояния аккаунта.
 *
 * @remarks
 * Отвечает на вопрос «что у аккаунта на ЭТОМ рынке» одним вызовом — не
 * заводя второго хранения. Нормализованное состояние остаётся единственным
 * источником истины:
 *
 * ```text
 * NORMALIZED STORAGE                       DERIVED VIEW
 *
 * AccountRuntimeState                      MarketAccountView
 * ├── Portfolio                            ├── balance            весь аккаунт
 * │   ├── Balance                          ├── accountOpenOrders  весь аккаунт
 * │   ├── Position[instrumentId]     +     ├── outcomes[0]
 * │   └── TokenBalance[instrumentId] Market│   position, tokens, orders, fills
 * ├── Orders[orderId]                      └── outcomes[1]
 * └── Fills[fillId]                            position, tokens, orders, fills
 * ```
 *
 * Связь рынка с приватным состоянием задаёт сам `Market`: каждый его исход
 * несёт canonical `InstrumentId`, а позиции, токены, заявки и исполнения
 * аккаунта уже адресуются тем же инструментом. Поэтому представление —
 * чистая выборка по `outcome.instrumentId`, без индексов по `MarketId`, без
 * копий состояния и без переноса заявок/исполнений внутрь `Market`.
 *
 * ### Снимок
 *
 * ```text
 * AccountRuntimeStateView + immutable Market → синхронный производный снимок
 * ```
 *
 * Построение синхронно: JavaScript не может вклинить мутацию состояния
 * посреди него, поэтому все части представления описывают ОДНУ версию
 * аккаунта — она и записана в `accountVersion` вместе с `lastMutationAt`.
 * Представление нигде не хранится, часов не читает, событий не публикует и
 * ничего не мутирует.
 *
 * ### Чем это НЕ является
 *
 * Это не `AuthoritativeAccountState` из `@polymarket/account-reconciliation`:
 * тот описывает факты площадки для сверки, а это — удобный срез НАШЕГО
 * состояния для будущих `TradingContext`/`Strategy`/`Risk`. Пакеты не
 * связаны, и импортировать сверку сюда нельзя.
 */
import type { AccountId, VenueId } from '@polymarket/ids';
import type { Market, MarketOutcome } from '@polymarket/market';
import { OPEN_ORDER_STATUSES } from '@polymarket/order';
import type { Position } from '@polymarket/position';
import { Err, Ok, type Result } from '@polymarket/result';
import type { Timestamp } from '@polymarket/timestamp';
import type { Balance, Quantity } from '@polymarket/value-objects';
import { AccountIdentityMismatchError } from './errors.js';
import type { AccountFillRecord, AccountOrderRecord } from './records.js';
import type { AccountRuntimeStateView } from './views.js';

/**
 * Приватное состояние аккаунта по ОДНОМУ исходу рынка.
 *
 * @remarks
 * Всё здесь выбрано по `outcome.instrumentId` из того же
 * `AccountRuntimeStateView`; своих данных у представления нет.
 *
 * - `availableTokens`/`reservedTokens` — из публичного API `Portfolio`,
 *   который сам приводит отсутствие `TokenBalance` к нулю. Инвариант
 *   `Position.quantity == availableTokens + reservedTokens` обеспечивает
 *   `Portfolio`; здесь он не перепроверяется и не «чинится».
 * - `orders` — вся известная рантайму история заявок инструмента, включая
 *   терминальные; `openOrders` — её живая часть по canonical
 *   `OPEN_ORDER_STATUSES` (`PENDING`, `OPEN`, `PARTIALLY_FILLED`).
 * - `fills` — записи `AccountFillRecord`, а не голые `Fill`: в записи живут
 *   обе оси (`AccountFillStatus` рантайма и `venueStatus` площадки). Ничего
 *   не отфильтровано — ни `REVERTED`, ни `FAILED`, ни старое: это срез
 *   текущего состояния рантайма, а не свежий хвост площадки.
 *
 * @example
 * ```typescript
 * const [first] = view.outcomes;
 * first.outcome.label;                  // 'Up'
 * first.availableTokens.value();        // свободные токены исхода
 * first.openOrders.length;              // живые заявки исхода
 * ```
 */
export interface MarketAccountOutcomeView {
  /** Исход рынка как есть — с `index`, `label` и `instrumentId` */
  readonly outcome: MarketOutcome;
  /** Позиция по инструменту исхода либо `undefined` */
  readonly position: Position | undefined;
  /** Свободные токены исхода; ноль, если токенного баланса нет */
  readonly availableTokens: Quantity;
  /** Зарезервированные под SELL токены исхода; ноль, если баланса нет */
  readonly reservedTokens: Quantity;
  /** Все известные заявки по инструменту исхода, включая терминальные */
  readonly orders: readonly AccountOrderRecord[];
  /** Живые заявки исхода: `PENDING`, `OPEN`, `PARTIALLY_FILLED` */
  readonly openOrders: readonly AccountOrderRecord[];
  /** Все известные исполнения по инструменту исхода — с обеими осями статуса */
  readonly fills: readonly AccountFillRecord[];
}

/**
 * Всё приватное состояние аккаунта, относящееся к одному рынку.
 *
 * @remarks
 * ### Деньги — общие на аккаунт
 *
 * `balance` — это `account.portfolio.balance`: account-wide collateral, а НЕ
 * баланс рынка. Его `available` уже учитывает резервации под живые BUY на ВСЕХ
 * рынках. Распределять общий collateral по рынкам представление не пытается:
 * `marketAvailableCash`/`marketReservedCash` нет и не будет как источника
 * истины. Если стратегии понадобится аналитическая атрибуция денежных
 * резервов по рынку, это будет отдельный производный расчёт.
 *
 * ### Живые заявки — тоже общие
 *
 * `accountOpenOrders` — все живые заявки аккаунта на всех рынках, включая
 * заявки этого рынка. Они нужны, потому что заявки вне рынка занимают тот же
 * collateral:
 *
 * ```text
 * collateral 1000; Market A BUY reserved 100; Market X manual BUY reserved 500
 * → view(A).balance.available уже учитывает обе резервации
 * → view(A).accountOpenOrders показывает, что кроме A есть и другие обязательства
 * ```
 *
 * ### Токены — по исходам
 *
 * `outcomes` — ровно два исхода в canonical порядке `Market.outcomes`. Никаких
 * `YES`/`NO`/`UP`/`DOWN`: исход сам несёт `index`, `label` и `instrumentId`,
 * поэтому представление не зависит ни от площадки, ни от семейства рынка.
 *
 * ### Версия
 *
 * `accountVersion` и `lastMutationAt` — те же, что у аккаунта в момент
 * построения: будущий `TradingContext` сохранит по ним provenance и проверит
 * согласованность версий.
 *
 * @example
 * ```typescript
 * const view = buildMarketAccountView(account, market);
 * if (view.ok) {
 *   view.value.balance.available();             // общий collateral аккаунта
 *   view.value.outcomes[0].position?.quantity;  // позиция по первому исходу
 *   view.value.accountOpenOrders.length;        // живые заявки на всех рынках
 * }
 * ```
 */
export interface MarketAccountView {
  /** Рынок, для которого построено представление, — тот же экземпляр */
  readonly market: Market;
  /** Площадка аккаунта (совпадает с `market.venueId`) */
  readonly venueId: VenueId;
  /** Аккаунт */
  readonly accountId: AccountId;
  /** Версия аккаунта в момент построения */
  readonly accountVersion: number;
  /** `metadata.createdAt` последней принятой мутации аккаунта */
  readonly lastMutationAt: Timestamp;
  /**
   * Общий account-wide collateral `Balance`.
   *
   * @remarks
   * Это НЕ баланс конкретного рынка: `available` уже учитывает резервации под
   * живые заявки на всех рынках.
   */
  readonly balance: Balance;
  /**
   * Все живые заявки аккаунта на всех рынках.
   *
   * @remarks
   * Нужны потому, что заявки вне текущего рынка тоже могут занимать общий
   * collateral.
   */
  readonly accountOpenOrders: readonly AccountOrderRecord[];
  /** Ровно два исхода `Market`, в canonical порядке `Market.outcomes` */
  readonly outcomes: readonly [MarketAccountOutcomeView, MarketAccountOutcomeView];
}

/**
 * Строит market-centric представление приватного состояния аккаунта.
 *
 * Алгоритм:
 * 1. Проверить, что рынок и аккаунт с одной площадки; иначе — `Err` без
 *    частичного результата.
 * 2. Для каждого из двух исходов `market.outcomes` выбрать по
 *    `outcome.instrumentId`: позицию, свободные/зарезервированные токены,
 *    заявки (и их живую часть) и исполнения.
 * 3. Добавить account-wide `balance` и живые заявки всего аккаунта, версию и
 *    время последней мутации.
 *
 * @param account - Read-only состояние одного аккаунта
 * @param market - Рынок, для которого нужен срез
 * @returns Представление либо `Err(AccountIdentityMismatchError)` с
 *   `subject = 'MARKET_VENUE'`, если `market.venueId !== account.venueId`
 *   (`expected` — площадка аккаунта, `actual` — площадка рынка)
 * @throws Ничего не бросает: расхождение площадок — `Err`
 *
 * @remarks
 * Чистая синхронная функция: без `async`, без часов, без событий, без
 * мутаций. Вызывает только читающие методы `AccountRuntimeStateView` и
 * `Portfolio`; всё, что они возвращают, отдаётся как есть, без копирования.
 *
 * Выборка — линейный проход по заявкам и исполнениям аккаунта (как и вся
 * навигация пакета): хранимых индексов по рынку нет. Если профилирование
 * когда-нибудь покажет узкое место, индекс можно завести внутри состояния,
 * не меняя этой сигнатуры.
 *
 * @example
 * ```typescript
 * const account = projector.state().getAccount(venueId, accountId);
 * if (account !== undefined) {
 *   const view = buildMarketAccountView(account, market);
 *   if (!view.ok) return view; // рынок другой площадки
 *   const [first, second] = view.value.outcomes;
 *   first.openOrders;  // живые заявки по первому исходу
 *   second.fills;      // исполнения по второму исходу, с обеими осями статуса
 * }
 * ```
 */
export function buildMarketAccountView(
  account: AccountRuntimeStateView,
  market: Market,
): Result<MarketAccountView, AccountIdentityMismatchError> {
  if (market.venueId !== account.venueId) {
    return Err(
      new AccountIdentityMismatchError(
        'MARKET_VENUE',
        account.venueId,
        account.accountId,
        account.venueId,
        market.venueId,
      ),
    );
  }

  const [first, second] = market.outcomes;
  return Ok({
    market,
    venueId: account.venueId,
    accountId: account.accountId,
    accountVersion: account.version,
    lastMutationAt: account.lastMutationAt,
    balance: account.portfolio.balance,
    accountOpenOrders: account.openOrders(),
    outcomes: [outcomeView(account, first), outcomeView(account, second)],
  });
}

/**
 * Срез состояния аккаунта по одному исходу.
 *
 * @param account - Read-only состояние аккаунта
 * @param outcome - Исход рынка; связь задаёт его `instrumentId`
 * @returns Представление исхода
 */
function outcomeView(account: AccountRuntimeStateView, outcome: MarketOutcome): MarketAccountOutcomeView {
  const { instrumentId } = outcome;
  const orders = account.ordersForInstrument(instrumentId);
  return {
    outcome,
    position: account.getPosition(instrumentId),
    availableTokens: account.portfolio.availableTokens(instrumentId),
    reservedTokens: account.portfolio.reservedTokens(instrumentId),
    orders,
    openOrders: orders.filter((record) => OPEN_ORDER_STATUSES.has(record.order.status)),
    fills: account.fillsForInstrument(instrumentId),
  };
}
