# @polymarket/risk

## Обзор

Pre-trade риск-контроль: синхронная проверка ордера ДО отправки на биржу.

| Компонент | Роль |
|---|---|
| `RiskParams` | «Сырые» лимиты (опциональные поля, `Money`/`Quantity`-типизированные) |
| `RiskPolicy` | Валидированная иммутабельная политика (`create()` → `Result`) |
| `OrderRiskChecker` | Иммутабельный чекер (`checkBeforeOrder()`), реализует `IOrderRiskChecker` |
| `PreOrderCheckInput` | Входные данные проверки (portfolio, side, price, size, ...) |
| `RiskViolationError` / `RiskViolationCode` | Типизированная ошибка нарушения лимита |
| `RiskConfigError` | Ошибка невалидной конфигурации (`RiskPolicy.create()`) |

```typescript
import { OrderRiskChecker, RiskPolicy } from '@polymarket/risk';
import { Money, Quantity } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

const policy = RiskPolicy.create({
  maxOpenOrders: 10,
  maxOrderNotional: Money.of(new Decimal(5000), 'USDC'),
  maxPositionSize: Quantity.of(new Decimal(1000)),
});
if (!policy.ok) throw policy.error;
const checker = new OrderRiskChecker(policy.value, logger);

const result = checker.checkBeforeOrder(input);
if (!result.ok) {
  logger.warn('Risk check failed', { code: result.error.riskCode });
}
```

## `RiskPolicy.create()` — валидация через `instanceof`, не через проверку Decimal-диапазона

`RiskParams` — «сырой» вход (`unknown` до валидации, может прийти из конфига/env).
До Этапа 7 плана миграции четыре лимитных поля (`maxPositionSize`, `maxTotalExposure`,
`maxOrderNotional`, `minAvailableBalance`) были `Decimal`, и валидация проверяла
`Decimal.isDecimal(value)` → `isNaN()`/`isFinite()` → `isNegative()` вручную.

После конверсии на VO (`Quantity`/`Money`) валидация **упрощается**, а не усложняется:

- **`maxPositionSize` (`Quantity`)** — проверка сводится к `value instanceof Quantity`.
  `Quantity` core enforces `>= 0` и finite на собственном конструкторе — невалидный
  экземпляр `Quantity` физически не может существовать в runtime, поэтому отдельная
  проверка диапазона не нужна.
- **`maxTotalExposure`/`maxOrderNotional`/`minAvailableBalance` (`Money`)** — проверка:
  `value instanceof Money` **и** `!value.isNegative()`. `Money` core **сознательно**
  допускает отрицательные суммы (это не invariant — см. `Money`'s докблок,
  "Неотрицательность — бизнес-логика"), поэтому неотрицательность лимита остаётся
  отдельной явной проверкой в `RiskPolicy`, а не делегируется типу.

`instanceof` на `unknown` никогда не бросает — свойство `RiskPolicy.create()` "никогда
не throw, все ошибки через `Result`" сохраняется без изменений. Раньше `RiskPolicy.create({
maxTotalExposure: 100 })` (голое число вместо `Decimal`) отклонялось как "не Decimal";
теперь то же значение (и голый `Decimal`, ранее легитимный вход) отклоняется как "не
Money" — сообщение об ошибке точнее отражает актуальный контракт поля.

Это общий паттерн, применимый к любой будущей `create()`-фабрике, валидирующей `unknown`
с VO-полями: если VO enforces инвариант на конструкторе — `instanceof` уже достаточен;
если VO сознательно НЕ enforces инвариант (как `Money`'s неотрицательность) — этот
инвариант остаётся отдельной явной проверкой на стороне вызывающего кода.

## Почему внутренняя арифметика `OrderRiskChecker` остаётся на `Decimal`, а не VO-методах

Черновой план миграции предполагал перевод внутренних вычислений `OrderRiskChecker`
(`orderNotional = price × size`, projected position/exposure) на "VO-методы". При
реализации (Этап 7) это решение пересмотрено:

- `Money`/`Quantity` core **не содержат математических методов** — это осознанная
  архитектура (см. `Money`'s докблок: "НЕ содержит математических методов"). Арифметика
  живёт только в facade-слое (`MoneyService`/`QuantityService`), у которого **0 внешних
  вызовов** по всему репозиторию — паттерн без единого реального потребителя.
- После конверсии `RiskParams`/`PreOrderCheckInput` (Этап 7) публичная граница
  `OrderRiskChecker` (конструктор через `RiskPolicy` + `checkBeforeOrder(input:
  PreOrderCheckInput)`) уже полностью VO-типизирована. Это ровно то условие, при
  котором ADR (`docs/architecture/boundary-contract.md`, Решение про арифметику) уже
  дважды в этой миграции (`TradeFlowCalculator` — Этап 2, `FeeCalculator`/cross-market —
  Этап 4) признавал внутреннюю `Decimal`-арифметику после распаковки VO НЕ долгом:
  правило про арифметику применяется к тому, что пересекает публичную границу, а не к
  внутренней реализации.
- `OrderRiskChecker`'s внутренняя арифметика — часть сложной fail-closed defensive-
  валидации (`_isFiniteNonNegativeDecimal`/`_isFinitePositiveDecimal`, `try/catch`
  вокруг каждого `.value()`, ручные NaN/Infinity/negative проверки на каждом шаге). Это
  осознанная защита pre-trade risk-гейта от повреждённых VO-getter'ов и посторонних
  portfolio-derived значений — не косметика, которую можно переписать без риска.

Итог: `this._params.X` (после конверсии — `Money`/`Quantity`) читается через `.value()`
в 4 методах (`_checkOrderNotional`, `_checkAvailableBalance`, `_checkPositionSize`,
`_checkTotalExposure`), но дальнейшая арифметика и вся defensive-валидация — без
изменений.

## `PortfolioService`'s reserve/release-методы — симметричный паттерн (Этап 7)

Хотя это не часть `@polymarket/risk`, стоит знать при чтении `OrderRiskChecker`'s
вызывающего кода: `PortfolioService.reserveForOrder`/`releaseReservation`
(`@polymarket/use-cases`) теперь принимают `Money` напрямую (раньше — `Decimal`,
оборачивался в `Money.of(...)` на первой строке тела метода — классический "примитив на
публичной границе, VO-обёртка немедленно внутри"). Аналогично
`reserveTokensForOrder`/`releaseTokenReservation` принимают `Quantity`
(`Portfolio`-entity, Этап 3, не тронута — `.value()` распаковывается на границе
`PortfolioService`, не глубже).

## Ссылки

- ADR: `docs/architecture/boundary-contract.md`
- План миграции, Этап 7: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
- `@polymarket/use-cases` — `PlaceOrderUseCase` (единственный реальный вызывающий
  `checkBeforeOrder()` в проде), `PortfolioService` (reserve/release-методы)
