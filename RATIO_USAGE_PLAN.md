# План использования Ratio Value Object

## 📋 Оглавление

1. [Архитектура: Ratio vs Spread](#архитектура-ratio-vs-spread)
2. [Use Cases для Ratio](#use-cases-для-ratio)
3. [Use Cases для Spread](#use-cases-для-spread)
4. [Roadmap Implementation](#roadmap-implementation)
5. [Migration Guidelines](#migration-guidelines)

---

## Архитектура: Ratio vs Spread

### Ratio VO - Универсальные проценты/коэффициенты

**Назначение**: Представление любых относительных величин (проценты, доли, коэффициенты)

**Характеристики**:
- ✅ Универсальный: fees, discounts, markups, slippage, любые %
- ✅ Простой: хранит только дробь (fraction), без контекста
- ✅ Helpers для compound operations: `onePlus()`, `oneMinus()`
- ✅ Форматирование: decimal, percent, bps

**НЕ содержит**:
- ❌ Бизнес-логики (валидация границ - в Rules)
- ❌ Арифметики между Ratio (только helpers для compound ops)
- ❌ Domain-specific контекста (цены, спреды)

**Примеры**:
```typescript
// Fee 2%
const fee = RatioService.fromPercent(2);        // 0.02
const afterFee = amount.mul(fee.oneMinus());    // amount * 0.98

// Markup 10%
const markup = RatioService.fromPercent(10);    // 0.10
const withMarkup = price.mul(markup.onePlus()); // price * 1.10

// Slippage 0.25% (25 bps)
const slippage = RatioService.fromBps(25);      // 0.0025
```

---

### Spread VO - Domain-specific спреды

**Назначение**: Bid-ask spread с контекстом prediction markets

**Характеристики**:
- ✅ Domain model: bid/ask цены, не просто числа
- ✅ Инварианты: bid <= ask
- ✅ Операции: widen(), tighten(), shift(), asymmetric adjustments
- ✅ Domain форматирование: "0.48-0.52", "mid: 0.50, width: 0.04"

**Содержит**:
- ✅ Bid и Ask как Price объекты
- ✅ Domain operations: widen/tighten для quoting
- ✅ Calculations: mid(), width(), widthBps()
- ✅ Validation rules: minSpread, maxSpread

**Примеры**:
```typescript
// Создание
const spread = SpreadService.create(bidPrice, askPrice);

// Domain operations
const widened = SpreadService.widen(spread, 10); // widen на 10 bps
const mid = spread.mid();                        // midpoint

// Policies
const isValid = ValidateMinSpread.check(spread, minSpreadBps);
```

---

## Use Cases для Ratio

### 1. **Fees & Commissions**

```typescript
// Trading fee 0.2%
const tradingFee = RatioService.fromPercent(0.2);

// Применение к сумме
const grossAmount = Money.of(1000, 'USDC');
const feeAmount = grossAmount.mul(tradingFee.value);           // 2 USDC
const netAmount = grossAmount.mul(tradingFee.oneMinus());      // 998 USDC
```

**Где использовать**:
- `OrderService.calculateFees()`
- `SettlementService.applyCommission()`
- `BalanceService.deductFee()`

---

### 2. **Discounts & Markups**

```typescript
// Discount 15%
const discount = RatioService.fromPercent(15);

// Применение к цене
const originalPrice = Price.of(new Decimal(0.65));
const discountedPrice = originalPrice.mul(discount.oneMinus()); // price * 0.85
```

**Где использовать**:
- `PricingService.applyDiscount()`
- `PromotionService.calculateMarkdown()`
- `QuoteService.addMarkup()` - добавить markup к quote

---

### 3. **Slippage Tolerance**

```typescript
// Slippage tolerance 0.5% (50 bps)
const maxSlippage = RatioService.fromBps(50);

// Вычисление допустимого диапазона
const targetPrice = Price.of(new Decimal(0.50));
const minAcceptable = targetPrice.mul(maxSlippage.oneMinus()); // 0.4975
const maxAcceptable = targetPrice.mul(maxSlippage.onePlus());  // 0.5025
```

**Где использовать**:
- `OrderValidation.checkSlippage()`
- `ExecutionService.validatePrice()`
- `QuoteService.applySlippageTolerance()`

---

### 4. **Risk Management Ratios**

```typescript
// Max position size = 25% of balance
const maxPositionRatio = RatioService.fromPercent(25);

// Проверка
const balance = Balance.of(Money.of(10000, 'USDC'));
const maxPosition = balance.amount().mul(maxPositionRatio.value); // 2500 USDC
```

**Где использовать**:
- `RiskService.validatePositionSize()`
- `LimitService.checkExposure()`
- `BalanceService.calculateAvailable()`

---

### 5. **Spread Width Percentage** (НЕ сам Spread!)

```typescript
// Spread width как % от mid price
const widthPct = RatioService.fromPercent(8); // 8%

// Использование для создания Spread
const result = SpreadService.fromMidAndWidthPercentage(0.50, widthPct);
// mid = 0.50, width = 0.50 * 0.08 = 0.04
// bid = 0.48, ask = 0.52
```

**Где использовать**:
- `SpreadService.fromMidAndWidthPercentage()` ✅ TODO
- `QuotingPolicy.calculateTargetSpread()`
- `MarketMakingService.adjustSpreadWidth()`

---

### 6. **Probability Adjustments**

```typescript
// Shift probability by 5%
const shift = RatioService.fromPercent(5);

// Применение
const currentProb = Price.of(new Decimal(0.45)); // 45%
const adjusted = currentProb.add(shift.value);    // 0.50 (50%)
```

**Где использовать**:
- `ProbabilityService.adjustConfidence()`
- `CalibrationService.applyBias()`

---

## Use Cases для Spread

### 1. **Quoting Policies**

```typescript
// Расширить spread на 10 bps для низколиквидных рынков
const policy = (spread: Spread) => {
  const bpsToAdd = 10;
  return SpreadService.widen(spread, bpsToAdd);
};
```

**Операции**:
- `SpreadService.widen(spread, bps)` - расширить на N bps
- `SpreadService.tighten(spread, bps)` - сузить на N bps
- `SpreadService.widenBy(spread, ratio)` - расширить на % ✅ TODO

---

### 2. **Risk Policies**

```typescript
// Validation: max spread = 500 bps
const maxSpreadBps = 500;
const isValid = ValidateMaxSpread.check(spread, maxSpreadBps);

// Validation: min spread = 10 bps
const minSpreadBps = 10;
const isValid = ValidateMinSpread.check(spread, minSpreadBps);
```

**Правила**:
- `ValidateMinSpread` - минимальная ширина для ликвидности
- `ValidateMaxSpread` - максимальная ширина для справедливости
- `ValidateSpreadSymmetry` - симметричность относительно mid (если нужно)

---

### 3. **Форматирование**

```typescript
// Display
SpreadFormatter.toString(spread);        // "Spread[bid=0.48, ask=0.52]"
SpreadFormatter.toDisplayString(spread); // "0.48-0.52"
SpreadFormatter.toVerboseString(spread); // "Bid: 0.48, Ask: 0.52, Mid: 0.50, Width: 0.04 (400 bps)"

// Width formatting
spread.widthBps(); // 400 (basis points)
```

---

### 4. **Spread Operations**

```typescript
// Shift (move both bid and ask)
const shifted = SpreadService.shift(spread, new Decimal(0.05));
// bid: 0.48 → 0.53, ask: 0.52 → 0.57

// Asymmetric (move only bid or ask)
const adjusted = SpreadService.adjustBid(spread, new Decimal(0.47));
// bid: 0.48 → 0.47, ask: 0.52 (unchanged)
```

---

## Roadmap Implementation

### Phase 1: Завершение Ratio VO ✅
- [x] Ratio core value object
- [x] RatioService facade
- [x] RatioFormatter (decimal, percent, bps)
- [x] RatioSerializer (JSON)
- [x] Validation rules (GteMinusOne, LteOne)
- [x] Tests и документация
- [x] wrapOp integration

### Phase 2: Spread методы с Ratio (текущая)
- [ ] `SpreadService.fromMidAndWidth()` - создание из mid + абсолютная ширина
- [ ] `SpreadService.fromMidAndWidthPercentage()` - создание из mid + % ширина
- [ ] `SpreadService.widenBy(spread, ratio)` - расширить на % (вместо абсолютных bps)
- [ ] `SpreadService.tightenBy(spread, ratio)` - сузить на %

**Приоритет**: HIGH - требуется для quoting policies

---

### Phase 3: Integration в Services
- [ ] **OrderService**: fees, slippage tolerance
- [ ] **QuoteService**: markup/discount, spread adjustments
- [ ] **RiskService**: position limits, exposure ratios
- [ ] **PricingService**: discounts, dynamic pricing
- [ ] **BalanceService**: reserve ratios, available balance %

**Приоритет**: MEDIUM - постепенная миграция

---

### Phase 4: Policies & Rules
- [ ] **QuotingPolicy**: dynamic spread width based on volatility/liquidity
- [ ] **FeePolicy**: tiered fees based on volume
- [ ] **RiskPolicy**: max position as % of balance
- [ ] **SlippagePolicy**: market-specific tolerance

**Приоритет**: LOW - после core integration

---

## Migration Guidelines

### ❌ НЕ мигрировать на Ratio

**Spread operations остаются в Spread**:
```typescript
// ❌ НЕ делать так:
const widthRatio = RatioService.fromBps(spread.widthBps());
const newSpread = /* что-то с ratio */

// ✅ Используй Spread операции:
const widened = SpreadService.widen(spread, 10);
```

**Почему**: Spread - это domain model с контекстом (bid/ask цены), не просто число

---

### ✅ Когда мигрировать на Ratio

**Любые проценты/коэффициенты БЕЗ domain контекста**:

```typescript
// ❌ БЫЛО: raw numbers
const feePercent = 0.02;  // Что это? 2% или 0.02%?
const amount = grossAmount * (1 - feePercent);

// ✅ СТАЛО: явная семантика
const fee = RatioService.fromPercent(2);
const amount = grossAmount.mul(fee.oneMinus());
```

---

### Checklist для миграции

**Перед миграцией спросите**:

1. ✅ Это универсальный процент/коэффициент? → **Ratio**
2. ✅ Нужна только математика без domain контекста? → **Ratio**
3. ❌ Это bid-ask spread с контекстом? → **Spread остается**
4. ❌ Нужны domain operations (widen/tighten)? → **Spread остается**

---

## Примеры кода

### Пример 1: Fee calculation

```typescript
// OrderService.ts
export class OrderService {
  private readonly tradingFee = RatioService.fromPercent(0.2).value;

  calculateNetAmount(grossAmount: Money): Result<Money, InvalidMoneyError> {
    // amount * (1 - fee)
    return MoneyService.multiply(grossAmount, this.tradingFee.oneMinus());
  }

  calculateFeeAmount(grossAmount: Money): Result<Money, InvalidMoneyError> {
    // amount * fee
    return MoneyService.multiply(grossAmount, this.tradingFee.value);
  }
}
```

---

### Пример 2: Spread creation from mid + width %

```typescript
// SpreadService.ts (TODO - Phase 2)
public static fromMidAndWidthPercentage(
  mid: Decimal | number | string,
  widthPercentage: Decimal | number | string,
  options?: { ensureLteOne?: boolean }
): Result<Spread, InvalidSpreadError> {
  return wrapOp(this.SERVICE_NAME, 'fromMidAndWidthPercentage', {}, () => {
    // 1. Parse mid
    const midDecimal = toDecimal('mid', mid, SpreadErrorReason.INVALID_MID, InvalidSpreadError);
    if (isErr(midDecimal)) return midDecimal;

    // 2. Parse width percentage as Ratio
    const widthRatioResult = RatioService.fromPercent(widthPercentage, options);
    if (isErr(widthRatioResult)) {
      return Err(rewrap(this.SERVICE_NAME, 'fromMidAndWidthPercentage', {},
        widthRatioResult.error, InvalidSpreadError));
    }

    // 3. Calculate width: mid * ratio
    const width = midDecimal.value.mul(widthRatioResult.value.toDecimal());

    // 4. Calculate bid/ask
    const halfWidth = width.div(2);
    const bidDecimal = midDecimal.value.minus(halfWidth);
    const askDecimal = midDecimal.value.plus(halfWidth);

    // 5. Create prices
    const bidResult = PriceService.create(bidDecimal);
    if (isErr(bidResult)) return Err(rewrap(...));

    const askResult = PriceService.create(askDecimal);
    if (isErr(askResult)) return Err(rewrap(...));

    // 6. Create spread
    return this.create(bidResult.value, askResult.value);
  }, InvalidSpreadError);
}
```

---

### Пример 3: Quoting Policy с Ratio

```typescript
// QuotingPolicy.ts
export class VolatilityBasedQuotingPolicy {
  calculateTargetSpread(
    baseSpread: Spread,
    volatility: Decimal
  ): Result<Spread, InvalidSpreadError> {
    // High volatility → widen spread by %
    const volatilityRatio = RatioService.fromDecimal(volatility);
    if (isErr(volatilityRatio)) return Err(...);

    // Widen spread by volatility %
    return SpreadService.widenBy(baseSpread, volatilityRatio.value);
  }
}
```

---

## Ключевые принципы

### 1. **Separation of Concerns**
- **Ratio**: Универсальная математика с процентами
- **Spread**: Domain model для bid-ask spreads

### 2. **Explicit Semantics**
```typescript
// ❌ Неявно
const fee = 0.02;

// ✅ Явно
const fee = RatioService.fromPercent(2);
```

### 3. **Type Safety**
```typescript
// ❌ Легко перепутать
function applyFee(amount: number, fee: number): number

// ✅ Невозможно перепутать
function applyFee(amount: Money, fee: Ratio): Result<Money, Error>
```

### 4. **Testability**
```typescript
// ✅ Легко тестировать с явными типами
const fee = RatioService.fromPercent(2).value;
expect(fee.toDecimal()).toEqual(new Decimal(0.02));
expect(fee.oneMinus()).toEqual(new Decimal(0.98));
```

---

## Следующие шаги

### Immediate (Phase 2)
1. Реализовать `SpreadService.fromMidAndWidthPercentage()` ✅ HIGH PRIORITY
2. Реализовать `SpreadService.fromMidAndWidth()` ✅ HIGH PRIORITY
3. Реализовать `SpreadService.widenBy(spread, ratio)` - расширить на %
4. Реализовать `SpreadService.tightenBy(spread, ratio)` - сузить на %

### Short-term (Phase 3)
5. Добавить Ratio в OrderService для fees
6. Добавить Ratio в QuoteService для markup/discount
7. Добавить Ratio в RiskService для limits

### Long-term (Phase 4)
8. Создать QuotingPolicy с динамическими spread adjustments
9. Создать FeePolicy с tiered fees
10. Создать RiskPolicy с ratio-based limits

---

## Заключение

**Ratio VO готов к использованию!** ✅

**Ключевые takeaways**:
- ✅ Используй **Ratio** для универсальных процентов/коэффициентов
- ✅ Оставь **Spread** для domain-specific bid-ask spreads
- ✅ Явная семантика лучше магических чисел
- ✅ Type safety предотвращает ошибки
- ✅ Начни с Phase 2: Spread методы с Ratio

**Следующий шаг**: Реализовать `fromMidAndWidthPercentage()` и `fromMidAndWidth()` в SpreadService.
