# @polymarket/account-state

Приватное состояние торгового аккаунта, построенное **только** из canonical
`TRADING_ACCOUNT_*` событий.

Это второй фундаментальный слой состояния нового торгового рантайма. Первый —
[`@polymarket/trading-state`](../trading-state/README.md) — отвечает на вопрос
«что происходит на рынке». Этот отвечает на вопрос «что происходит с НАМИ».

```text
PUBLIC / MARKET STATE          PRIVATE / ACCOUNT STATE
TradingHotState                AccountHotState
  market metadata                portfolio
  books                          our orders
  public trades                  our fills
  CEX                            positions через Portfolio
  reference prices
  market lifecycle
```

Два read-model **не объединяются** в одно гигантское состояние: стакан и лента
— публичные наблюдения, доступные любому участнику рынка, а баланс, заявки и
исполнения — приватные факты одного аккаунта. Пакеты друг от друга не зависят
и обрабатывают разные типы событий. Согласованный снимок из обоих позже
соберёт `TradingContextBuilder` как read-only потребитель.

## Как состояние наполняется

```text
приватное наблюдение / команда
    ↓
domain/execution processing         ← здесь считается ВСЯ экономика
    ↓
post-commit Order / Portfolio / Fill
    ↓
TRADING_ACCOUNT_*                   ← здесь уже только итог
    ↓
IEventBus → AccountStateProjector → AccountHotState
```

`AccountStateProjector` — **единственный** писатель. Публичных мутирующих
методов у состояния нет, третьей шины нет, и никакой Execution/Reconciler
никогда не будет мутировать `AccountHotState` напрямую.

Проектор **не** считает резервации, комиссии, FIFO-лоты и допустимость
переходов заявки: всё это посчитано producer'ом до публикации. Он проверяет
согласованность и материализует готовые immutable snapshot'ы.

## Три сущности и их роли

```text
Portfolio          ЕДИНСТВЕННЫЙ источник истины: деньги + позиции + резервации
Order              текущее состояние НАШЕЙ заявки
Fill               неизменяемый факт исполнения
AccountFillRecord  runtime-жизненный цикл вокруг этого факта
```

Параллельных `balance` / `availableBalance` / `reservedBalance` / `positions` /
`tokenBalances` в состоянии **нет**: второй источник истины по деньгам
неизбежно разошёлся бы с первым, и вопрос «сколько у нас свободных средств»
получил бы два разных ответа.

```typescript
account.portfolio.balance;            // деньги: available + reserved
account.portfolio.positions;          // позиции по инструментам
account.portfolio.tokenBalances;      // токены: доступные + зарезервированные
account.getPosition(instrumentId);    // удобный доступ — читает из portfolio
```

## Идентичность аккаунта — пара «площадка + аккаунт»

```typescript
view.getAccount(venueId, accountId);
view.accountIdentities(); // [{ venueId, accountId }, …]
```

Один и тот же строковый идентификатор аккаунта в пространствах имён двух
площадок — два **разных** торговых аккаунта с разными деньгами.

Ключ второго уровня — canonical строка `accountIdToString`, а не сам объект:
два эквивалентных `AccountId`, собранных в разных местах, обязаны находить
ОДИН аккаунт. `Map<AccountId, …>` ключуется по ссылке и такой гарантии не
даёт.

## Три исхода события, а не два

```text
новый факт / законное обновление   применить, version += 1
точный дубликат доставки           no-op, версии не меняются
та же идентичность, другой факт     Err, состояние не меняется
```

Дубликат — нормальная доставка, а не ошибка. Но применить его нельзя: он несёт
**устаревший** портфель, и слепое применение вернуло бы в `available` деньги,
уже зарезервированные под живую заявку.

Единственное исключение — `TRADING_ACCOUNT_INITIALIZED`: это ownership-событие,
и его повтор является нарушением lifecycle, а не повторным наблюдением.

## Две оси у исполнения

```text
status       APPLIED → CONFIRMED | REVERTED   что сделали МЫ с деньгами
venueStatus  MATCHED → MINED → CONFIRMED      что говорит ПЛОЩАДКА
                    ↘ RETRYING ↘ FAILED       canonical TradeStatus
```

Схлопнуть их в одну **нельзя**. `MATCHED` означает, что исполнение сматчил
матчер Polymarket (off-chain); `MINED` — что расчётная транзакция попала в блок
Polygon. Это утверждения о разных системах, и разница между ними — реальная
разница в риске отката.

С другой стороны, `REVERTED` — наше действие, и венного двойника у него может
не быть вовсе: сверка откатит исполнение, которого на площадке не оказалось, и
никакого `FAILED` за таким откатом не стоит.

`venueStatus` типизирован существующим `TradeStatus` из `@polymarket/fill` —
своего набора тех же пяти строк не заводится. Поле опционально: площадка без
on-chain расчётов такого статуса не сообщает вовсе.

### Переходы

```text
APPLIED → CONFIRMED      площадка подтвердила финальность
APPLIED → REVERTED       upstream пересчитал откат
CONFIRMED → REVERTED     запрещено
```

`CONFIRMED → REVERTED` запрещён: финальность на то и финальность. Это
подтверждено контрактом площадки — `TradeStatus.CONFIRMED` документирован как
«finality достигнута, транзакция успешна», то есть обратно она не ходит.
Коррекция после финальности, если понадобится, будет отдельным явным
recovery-контрактом.

По venue-оси порядок доставки и порядок на площадке — разные вещи:

```text
current == incoming              повтор                       no-op
терминальный → нетерминальный    запоздавшее старое сообщение no-op
CONFIRMED ↔ FAILED               два исхода одной сделки      Err
нетерминальный → любой           принять
```

Правило живёт в `@polymarket/fill` (`classifyTradeStatusObservation`): оно
выводится из контракта `TradeStatus` и одинаково для любого наблюдателя. Здесь
остаётся только то, чего домен знать не может, — чем обернуть каждый исход.

Политика переходов по НАШЕЙ оси (`classifyFillTransition`) устроена так же, но
осталась в этом пакете: `AccountFillStatus` придуман здесь. `STALE` у неё нет —
переход инициируем мы, а не сеть, и «запоздавшего» перехода не существует.

`MINED` после `CONFIRMED` означает не «сделка перестала быть подтверждённой», а
наблюдение, сделанное раньше и доехавшее позже. Отвергать его нельзя: подписки
проектора `critical`, и одно запоздавшее сообщение роняло бы весь `publish()`.

Задержкой не объясняются только два **разных терминальных** исхода у одной
сделки — там мы действительно ничего не понимаем и останавливаемся.

## Authoritative-коррекция: `TRADING_ACCOUNT_RECONCILED`

Кроме живого контура состояние принимает **коррекцию** от сверки аккаунта
([`@polymarket/account-reconciliation`](../account-reconciliation/README.md)) —
через ту же шину и тот же проектор:

```text
authoritative source → AccountReconciler → TRADING_ACCOUNT_RECONCILED
                                                   ↓
                                  IEventBus → AccountStateProjector → AccountHotState
```

Два правила, которых нет у живых событий:

```text
CAS        account.version === expectedAccountVersion, иначе
           AccountReconciliationVersionConflictError и НОЛЬ мутаций
batch      весь снимок валидируется целиком → ОДИН commit → version += 1
```

Семантика — upsert, а не замена истории:

| сущность | локально нет | то же состояние | изменилось | конфликт |
| --- | --- | --- | --- | --- |
| `Portfolio` | — | не меняется | заменяется целиком | чужой владелец/площадка → `Err` |
| `Order` | вставить | no-op | заменить authoritative-заявкой | другая неизменяемая идентичность → `Err` |
| `Fill` | вставить `CONFIRMED` | `CONFIRMED` → no-op | `APPLIED` → `CONFIRMED` | `REVERTED` или другой факт → `Err` |

Коррекция, ничего не изменившая, — не мутация: версии и `lastMutationAt` не
трогаются. Venue-ось исполнения (`venueStatus`, `venueStatusAt`) коррекция не
стирает и не придумывает. Подробности —
[`docs/account-state.md`](./docs/account-state.md#authoritative-коррекция).

## Market-centric read model

Задача — имея `Market` и `AccountRuntimeStateView`, **одним вызовом**
получить всё приватное состояние аккаунта по этому рынку:

```typescript
const view = buildMarketAccountView(account, market); // Result<MarketAccountView, AccountIdentityMismatchError>
```

```text
NORMALIZED STORAGE

AccountRuntimeState
├── Portfolio
├── Orders
└── Fills

          +
        Market
          ↓

DERIVED VIEW

MarketAccountView
├── account-wide Balance
├── account-wide live orders
├── outcome[0]
│   ├── Position
│   ├── available/reserved tokens
│   ├── orders/openOrders
│   └── fills
└── outcome[1]
    ├── Position
    ├── available/reserved tokens
    ├── orders/openOrders
    └── fills
```

```text
MarketAccountView is NOT stored state.
```

Нормализованное хранение остаётся **единственным** источником истины. Второго
хранения по `MarketId`, индексов `ordersByMarket`/`fillsByMarket`/
`positionsByMarket` и переноса заявок/исполнений внутрь `Market` нет. Связь
задаёт сам `Market`: каждый его исход несёт canonical `instrumentId`, а
приватное состояние уже адресуется тем же инструментом.

| часть исхода | откуда |
| --- | --- |
| `position` | `account.getPosition(instrumentId)` |
| `availableTokens` / `reservedTokens` | `account.portfolio.availableTokens/reservedTokens(instrumentId)` — ноль, если токенного баланса нет |
| `orders` | `account.ordersForInstrument(instrumentId)` — вся история, включая терминальные |
| `openOrders` | `orders`, отфильтрованные по canonical `OPEN_ORDER_STATUSES` (`PENDING`, `OPEN`, `PARTIALLY_FILLED`) |
| `fills` | `account.fillsForInstrument(instrumentId)` — `AccountFillRecord` с обеими осями статуса, ничего не отфильтровано |

**Деньги — общие на аккаунт.** `view.balance` — это
`account.portfolio.balance`, а не баланс рынка: его `available` уже учитывает
резервации под живые BUY на **всех** рынках. Распределять collateral по рынкам
представление не пытается — `marketAvailableCash`/`marketReservedCash` нет.
Поэтому рядом лежит `accountOpenOrders` — все живые заявки аккаунта:

```text
collateral 1000; Market A BUY reserved 100; Market X manual BUY reserved 500
→ view(A).balance.available уже учитывает обе резервации
→ view(A).accountOpenOrders показывает, что кроме A есть и другие обязательства
```

**Исходы — в canonical порядке `Market.outcomes`.** Никаких `YES`/`NO`/`UP`/
`DOWN` в этом пакете: исход сам несёт `index`, `label` и `instrumentId`, и
представление не зависит ни от площадки, ни от семейства рынка.

**Площадка обязана совпасть.** `market.venueId !== account.venueId` →
`Err(AccountIdentityMismatchError)` с `subject = 'MARKET_VENUE'`
(`expected` — площадка аккаунта, `actual` — площадка рынка), без частичного
результата.

**Синхронный снимок.** Функция чистая: без `async`, часов, событий и
мутаций. JavaScript не может вклинить мутацию посреди синхронного построения,
поэтому всё представление описывает одну версию аккаунта — она записана в
`accountVersion` вместе с `lastMutationAt`.

**Не путать с `AuthoritativeAccountState`.** Тот (из
`@polymarket/account-reconciliation`) — факты площадки для сверки; этот — срез
НАШЕГО состояния для будущих `TradingContext`/`Strategy`/`Risk`. Пакеты не
связаны, и сверку этот пакет не импортирует.

Следующий слой — `TradingContext` — соберёт:

```text
MarketAccountView
+
TradingHotState market data
+
CEX/reference data
```

`TradingContext` здесь **не** реализован. Подробности —
[`docs/account-state.md`](./docs/account-state.md#market-centric-read-model).

## Хранение

Пока — **на время жизни рантайма**: заявок и исполнений на порядки меньше, чем
публичных обновлений стакана, поэтому окон, `maxAge`, `maxCount` и компакции
здесь нет. Долговременная история и компакция появятся вместе с
персистентностью исполнения и аккаунта.

## Что дальше

Ни живого процессора, ни адаптера сверки в этом пакете **нет** — здесь
зафиксировано только направление.

**Fast path** (приватный WebSocket):

```text
private WS
    ↓
приватное наблюдение
    ↓
будущий account/domain processor
    ↓
TRADING_ACCOUNT_* post-commit event
    ↓
IEventBus → AccountStateProjector
```

**Reconciliation path** (authoritative REST) — контракт и ядро уже есть
(`TRADING_ACCOUNT_RECONCILED`, `@polymarket/account-reconciliation`); впереди
production-адаптер источника и runtime wiring:

```text
authoritative REST
    ↓
Polymarket source adapter         ← следующий этап
    ↓
AccountReconciler
    ↓
TRADING_ACCOUNT_RECONCILED
    ↓
ТА ЖЕ IEventBus → ТОТ ЖЕ AccountStateProjector
```

Reconciler **никогда** не мутирует `AccountHotState` напрямую: у состояния
один писатель, и добавление второго вернуло бы ровно ту гонку, ради
устранения которой проектор и заведён.

Подробности — в [`docs/account-state.md`](./docs/account-state.md).
