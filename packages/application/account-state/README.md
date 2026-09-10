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
`tokenReservations` в состоянии **нет**: второй источник истины по деньгам
неизбежно разошёлся бы с первым, и вопрос «сколько у нас свободных средств»
получил бы два разных ответа.

```typescript
account.portfolio.balance;            // деньги: available + reserved
account.portfolio.positions;          // позиции по инструментам
account.portfolio.tokenReservations;  // зарезервированные токены
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

## Жизненный цикл исполнения

```text
APPLIED → CONFIRMED     площадка подтвердила финальность
APPLIED → REVERTED      upstream пересчитал откат
```

`CONFIRMED → REVERTED` запрещён: финальность на то и финальность. Коррекция
после финальности, если понадобится, будет отдельным явным recovery-контрактом
с собственным событием — а не тихим переходом, способным откатить деньги,
которые считались окончательными.

## Хранение

Пока — **на время жизни рантайма**: заявок и исполнений на порядки меньше, чем
публичных обновлений стакана, поэтому окон, `maxAge`, `maxCount` и компакции
здесь нет. Долговременная история и компакция появятся вместе с
персистентностью исполнения и аккаунта.

## Что дальше

Ни того, ни другого в этом пакете **нет** — здесь зафиксировано только
направление.

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

**Reconciliation path** (authoritative REST):

```text
authoritative REST
    ↓
будущий AccountReconciler
    ↓
обнаружение пропущенных/разошедшихся фактов
    ↓
canonical account-события
    ↓
ТА ЖЕ IEventBus → ТОТ ЖЕ AccountStateProjector
```

Reconciler **никогда** не будет мутировать `AccountHotState` напрямую: у
состояния один писатель, и добавление второго вернуло бы ровно ту гонку, ради
устранения которой проектор и заведён.

Подробности — в [`docs/account-state.md`](./docs/account-state.md).
