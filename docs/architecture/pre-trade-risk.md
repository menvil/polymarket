# Пре-трейд риск-контроль (`@polymarket/risk`)

## Проблема

Пре-трейд риск-чекер должен _консервативно_ оценивать риск размещаемого ордера
**до** отправки на биржу. Наивная реализация проверяла лимиты только по
**исполненной** части портфеля (`Portfolio.getPosition`, cost basis позиций) и
не учитывала капитал, уже замороженный под ещё не исполненные ордера. Это
открывало два класса ошибок:

1. **Position limit bypass.** Позиция появляется в `Portfolio` только после
   fill. Поток одновременных BUY-ордеров по одному инструменту проходил проверку
   `maxPositionSize` каждый по отдельности (каждый видел `filled = 0`), а
   суммарно пробивал лимит.
2. **Total exposure bypass.** Экспозиция считалась только по cost basis
   исполненных позиций — зарезервированный под pending BUY-ордера USDC
   (`Portfolio.balance.reserved()`) игнорировался.

Плюс — `minTimeToExpiryMs` при недоступных метаданных инструмента вёл себя
fail-**open** (пропускал BUY), а runtime-`updateParams()` позволял незаметно
подменить политику.

## Решение

### 1. Проекция позиции с учётом pending BUY (`maxPositionSize`)

```
projectedPosition =
  filledQuantity                       // Portfolio.getPosition(instrument).quantity
  + pendingBuyQuantityForInstrument    // held BUY-резервации (submission journal)
  + newBuyQuantity                     // размер нового ордера
```

`pendingBuyQuantityForInstrument` — authoritative-агрегат из submission journal
(`IOrderSubmissionRepository.getPendingBuyQuantityForInstrument`):

- суммирует `reservation.remaining (USDC) / orderPrice` → количество токенов;
- фильтрует по `accountId` + `instrumentId`, `side === 'BUY'`;
- включает резервации в статусах `HELD` / `PARTIALLY_SETTLED` /
  `RECONCILIATION_REQUIRED` с `remaining > 0` (капитал заморожен независимо от
  submission-статуса, поэтому `UNKNOWN` / `VENUE_ACCEPTED` / `COMMITTED` тоже
  учитываются);
- НЕ учитывает текущую submission до создания резервации (`status === 'NONE'`,
  `remaining === 0`);
- **fail-closed**: повреждённые `orderPrice` / `remaining` → `Err`, и
  `PlaceOrderUseCase` блокирует BUY (нельзя проверить лимит).

`PlaceOrderUseCase` собирает pending **под keyed mutex** `[account, instrument]`
(authoritative-проверка), поэтому два конкурентных BUY сериализуются, и второй
видит held-резервацию первого. Precheck вне lock передаёт `0` (fail-fast; не
приводит к ложному reject).

### 2. Total exposure с учётом reserved (`maxTotalExposure`)

```
projectedTotalExposure =
  filledPositionCostBasis            // sum(quantity × averageEntryPrice)
  + portfolio.balance.reserved()     // остаток USDC под pending BUY-ордерами
  + newBuyNotional                   // price × size нового ордера
```

`reserved()` — authoritative-сумма замороженного под BUY капитала (OPEN, partial
fills, UNKNOWN, terminal settlement pending). Cost basis и reserved **не
пересекаются**: исполненные позиции уже списали свою резервацию (`consumed`).

### 3. SELL для long-only Polymarket

SELL — ликвидация, не увеличивает позиционный/экспозиционный риск. Поэтому для
SELL пропускаются: `minTimeToExpiryMs`, `minAvailableBalance`, `maxPositionSize`,
`maxTotalExposure`. Продолжают применяться `maxOpenOrders` (антиспам) и
`maxOrderNotional` (fat-finger). Безусловного раннего `Ok()` для SELL нет — иначе
отключились бы эти два guard'а.

### 4. Expiry gate (`minTimeToExpiryMs`)

`PlaceOrderUseCase` внедряет `IMarketCatalog` и вычисляет:

```
timeToExpiryMs = instrument.expiresAt.toNumber() - clock.now().getTime();
```

Пересчитывается отдельно для precheck (вне lock) и authoritative-проверки (под
lock — время ожидания lock/network прошло). Правила:

| Условие | Результат |
|---|---|
| `minTimeToExpiryMs === undefined` | проверка отключена |
| BUY + лимит включён + expiry недоступно | `RISK_INPUT_INCOMPLETE` (fail-closed) |
| BUY + `timeToExpiryMs < minTimeToExpiryMs` (в т.ч. отрицательное = истёк) | `TOO_CLOSE_TO_EXPIRY` |
| SELL | не блокируется даже при недоступном expiry |

Каталог опционален в `PlaceOrderDeps`; если не передан ИЛИ инструмент неизвестен
— `timeToExpiryMs === undefined` (та же fail-closed логика). В production каталог
передаётся из композиции (`buildOrderUseCases`).

### 5. Иммутабельная `RiskPolicy`

`RiskParams` — «сырой» вход. `RiskPolicy.create(params): Result<RiskPolicy,
RiskConfigError>` валидирует:

- `maxOpenOrders`, `minTimeToExpiryMs` — целые числа `>= 0`;
- `maxPositionSize` — `Quantity` (количество токенов);
- `maxTotalExposure`, `maxOrderNotional`, `minAvailableBalance` — `Money` (USDC).

`RiskPolicy.create` — **полноценный runtime-валидатор границы** (принимает
`unknown`, никогда не бросает — всегда `Result`):

- вход обязан быть **plain object** (prototype === `Object.prototype` или `null`):
  `Date`, экземпляр класса, массив, примитив → `Err('<root>')`;
- учитываются только **own**-свойства (`hasOwnProperty`) — унаследованные и
  prototype-pollution поля игнорируются, а не подставляются;
- каждое поле читается один раз (устойчиво к getter'ам с side-effects);
- неизвестный own-ключ → `Err` независимо от значения (включая `undefined`);
  защита от опечаток и удалённых лимитов вроде `maxDrawdown`;
- `maxPositionSize` — `instanceof Quantity` (сам тип уже enforces `>= 0` на
  конструкторе — отдельная проверка неотрицательности не нужна);
- `maxTotalExposure`/`maxOrderNotional`/`minAvailableBalance` — `instanceof Money`
  И `>= 0` явной проверкой (`Money` core сознательно допускает отрицательные суммы
  — неотрицательность здесь бизнес-правило риск-политики, не инвариант типа);
- если runtime-introspection (`Object.keys`/`getPrototypeOf`/getter/Proxy-trap)
  бросает — `Err('<root>')`, а не исключение;
- собирается замороженный объект только из whitelisted validated own-полей;
- сообщения об ошибках не включают полное raw-значение конфига (только тип/поле).

`instanceof`-проверка на `unknown` никогда не бросает — то же свойство «никогда не
throw» у `RiskPolicy.create()`, что и раньше при ручной `Decimal.isDecimal()`-проверке,
сохраняется без изменений после перехода полей на VO. Это общий паттерн для будущих
`create()`-фабрик, валидирующих `unknown` с VO-полями — см.
`docs/architecture/boundary-contract.md`, Решение 9.

`RiskPolicy` — **номинальный тип** (private brand-поле): структурно совместимый
plain object нельзя присвоить `RiskPolicy` на уровне TypeScript-компилятора. Это
compile-time гарантия, НЕ защита против произвольного JS в runtime.

`OrderRiskChecker` принимает валидную `RiskPolicy` и **иммутабелен**
(`updateParams()` удалён): политика фиксируется на всё время жизни. Смена
политики = новый checker. Композиция вызывает `RiskPolicy.create` и fail-fast на
старте при невалидной конфигурации.

### 6. Fail-closed валидация входов checker'а

Checker не доверяет входам слепо (сторонний VO/repository adapter мог бы вернуть
`Decimal(NaN)` → `after.gt(limit)` вернул бы `false` и открыл обход). Порядок:

1. **side** — первым, даже при пустой политике: не `'BUY'|'SELL'` (в т.ч.
   `'UNKNOWN'`) → `RISK_INPUT_INCOMPLETE`; неизвестный side НЕ трактуется как SELL.
2. **примитивные входы**: `openOrdersCount` (целое `>= 0`), `timeToExpiryMs`
   (finite, если задано), `pendingBuyQuantityForInstrument` (для BUY — `Decimal`,
   finite, `>= 0`).
3. **price/size/notional**: `.value()` извлекается в try/catch (бросок →
   `RISK_INPUT_INCOMPLETE`); `price`/`size` — `Decimal`, finite, `> 0`;
   `orderNotional = price × size` — finite, `> 0`. Не полагается на поведение
   Decimal-сравнений с NaN (сначала `isFinite`, потом сравнение).
4. **portfolio-derived — только в активных BUY-gate'ах** (нет безусловной
   рекурсивной валидации всего Portfolio):
   - `minAvailableBalance`: `available` — finite `>= 0` (отрицательный
     `afterReserve` — это обычный `INSUFFICIENT_AVAILABLE_BALANCE`, не corruption);
   - `maxPositionSize`: `current` quantity — finite `>= 0`; projected — finite `>= 0`;
   - `maxTotalExposure`: `quantity`/`reserved` — finite `>= 0`; `averageEntryPrice`
     — finite `> 0`; накопленная и projected exposure — finite `>= 0`.

   Нарушение → `RISK_INPUT_INCOMPLETE`. Для SELL эти gate'ы (и связанные pending/
   portfolio значения) не вычисляются — мусорное значение SELL не блокирует.

Отдельно `PlaceOrderUseCase` при сбое **получения** pending-экспозиции из
submission journal возвращает `RISK_STATE_UNAVAILABLE` (типизированный
`RiskViolationError`, не общий `TradingError`) — метрики отличают недоступность
authoritative-состояния от нарушения лимита.

> `maxDrawdown` удалён из `RiskParams` — runtime drawdown monitor в этом слое не
> реализуется (нужен отдельный stateful guard).

## Коды нарушений (`RiskViolationCode`)

`TOO_CLOSE_TO_EXPIRY`, `RISK_INPUT_INCOMPLETE`, `RISK_STATE_UNAVAILABLE`,
`MAX_OPEN_ORDERS_EXCEEDED`, `ORDER_NOTIONAL_EXCEEDED`,
`INSUFFICIENT_AVAILABLE_BALANCE`, `POSITION_LIMIT_EXCEEDED`,
`TOTAL_EXPOSURE_EXCEEDED`.

## Порядок проверок (fail-fast, от дешёвых к дорогим)

0. side + input/price/size/notional fail-closed валидация (BUY и SELL)
1. expiry — только BUY
2. `maxOpenOrders` — BUY и SELL
3. `maxOrderNotional` — BUY и SELL
4. `minAvailableBalance` — только BUY
5. `maxPositionSize` — только BUY (filled + pending + new)
6. `maxTotalExposure` — только BUY (cost basis + reserved + new notional)

## `maxOpenOrders` / `openOrdersCount` — текущая семантика

Счётчик `openOrdersCount` — **per-strategy, НЕ account-wide**:

- при наличии `strategyId` `PlaceOrderUseCase` передаёт
  `await orderRepo.countByStrategyId(strategyId)`;
- `UNKNOWN`/`VENUE_ACCEPTED` submissions **без локального Order** в счётчик НЕ
  входят (Order ещё не сохранён);
- ордера других стратегий того же аккаунта не учитываются.

Account-wide active-commitment политика (дедупликация OrderRepository +
submission journal) — **отдельная будущая задача**, здесь намеренно не вводится
(требует единого источника active commitments без двойного учёта).

## Связанные документы

- [Reservation journal safety](./reservation-journal-safety.md)
- [Ordered event outbox](./ordered-event-outbox.md)
- [@polymarket/risk — API-референс](../../packages/application/risk/docs/risk.md)
