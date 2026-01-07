### Domain Services

## Обзор

**Domain Services** содержат бизнес-логику, которая не принадлежит конкретной Entity или Value Object. Сервисы являются stateless и работают только с переданными им параметрами.

```
┌─────────────────────────────────────────┐
│        Domain Services                  │
│                                         │
│  ┌──────────┐  ┌──────────┐           │
│  │ Pricing  │  │   Risk   │           │
│  │ Services │  │ Services │           │
│  └──────────┘  └──────────┘           │
│  ┌──────────┐  ┌──────────┐           │
│  │Inventory │  │Execution │           │
│  │ Services │  │ Services │           │
│  └──────────┘  └──────────┘           │
└─────────────────────────────────────────┘
```

### Принципы Domain Services

1. **Stateless** - не хранят состояние между вызовами
2. **Pure functions** - детерминированные, предсказуемые результаты
3. **Domain logic** - содержат чистую бизнес-логику
4. **Reusable** - используются из разных частей системы
5. **Testable** - легко тестируются в изоляции

---

## Pricing Services

### 1. FairValueCalculator

**Назначение**: Расчет справедливой стоимости токена.

**Файл**: `src/domain/services/pricing/FairValueCalculator.ts`

#### Формула

```
fairValue = W_MID * midPrice +
            W_MICRO * microprice +
            W_EMA * ema

где:
- midPrice = (bestBid + bestAsk) / 2
- microprice = (bidPrice * askSize + askPrice * bidSize) / (bidSize + askSize)
- ema = alpha * midPrice + (1 - alpha) * previousEma
```

#### Использование

```typescript
const calculator = new FairValueCalculator();

const config: FairValueConfig = {
  weightMid: 0.4,        // 40% mid-price
  weightMicroprice: 0.4, // 40% microprice
  weightEma: 0.2,        // 20% EMA
  emaAlpha: 0.1,         // EMA smoothing factor
};

const fairValue = calculator.calculate(
  orderbook,
  previousFairValue,
  config
);

console.log(`Fair value: ${fairValue.value}`);

// Проверка YES/NO mismatch
const mismatch = calculator.calculateYesNoMismatch(
  fairYes,
  fairNo
);

if (mismatch.value > 1.0) {
  console.warn('YES + NO не равно 1.0, возможен арбитраж');
}
```

#### Зачем нужен Fair Value?

- ✅ Определение "правильной" цены актива
- ✅ Обнаружение мисприсингов
- ✅ Базис для генерации котировок маркет-мейкера
- ✅ Проверка арбитражного условия YES + NO = 1.0

---

### 2. MicropriceCalculator

**Назначение**: Расчет microprice с учетом объемов.

**Файл**: `src/domain/services/pricing/MicropriceCalculator.ts`

#### Формула

```
microprice = (bidPrice * askSize + askPrice * bidSize) / (bidSize + askSize)
```

#### Интуиция

- Если `askSize >> bidSize` → microprice ближе к bidPrice (давление продавцов)
- Если `bidSize >> askSize` → microprice ближе к askPrice (давление покупателей)
- Если `bidSize = askSize` → microprice = midPrice

#### Использование

```typescript
const calculator = new MicropriceCalculator();

const bids = [
  { price: Price.fromNumber(0.64), quantity: Quantity.fromNumber(100) },
];

const asks = [
  { price: Price.fromNumber(0.66), quantity: Quantity.fromNumber(200) },
];

const microprice = calculator.calculate(bids, asks);
// microprice = (0.64 * 200 + 0.66 * 100) / 300 = 0.6467

console.log(`Microprice: ${microprice.value}`);

// Интерпретация
if (microprice.value < midPrice.value) {
  console.log('Больше давление продавцов');
} else if (microprice.value > midPrice.value) {
  console.log('Больше давление покупателей');
}
```

---

### 3. ArbitrageDetector

**Назначение**: Обнаружение арбитражных возможностей.

**Файл**: `src/domain/services/pricing/ArbitrageDetector.ts`

#### Условия арбитража

```
SELL_BOTH: (yesBid + noBid) > 1.0 + fees
  → Продать оба токена с прибылью

BUY_BOTH: (yesAsk + noAsk) < 1.0 - fees
  → Купить оба токена с прибылью
```

#### Использование

```typescript
const detector = new ArbitrageDetector();
const fees = Percentage.fromNumber(1.0); // 1%

const opportunity = detector.detect(yesOrderbook, noOrderbook, fees);

if (opportunity) {
  console.log(`Arbitrage found! Type: ${opportunity.type}`);
  console.log(`Profit: ${opportunity.profitPercent.toFixed(2)}%`);
  console.log(`Action: ${opportunity.action}`);
  console.log(`Profit per USDC: $${opportunity.profitPerUSDC.amount}`);
}

// Проверка перед размещением котировок
const wouldCreateArbitrage = detector.wouldCreateArbitrage(
  yesBid,
  yesAsk,
  noBid,
  noAsk,
  fees
);

if (wouldCreateArbitrage) {
  console.warn('Quote adjustment needed to avoid arbitrage');
}
```

---

## Risk Services

### 1. RiskAssessmentService

**Назначение**: Комплексная оценка рисков торговой сессии.

**Файл**: `src/domain/services/risk/RiskAssessmentService.ts`

#### Оцениваемые риски

1. **Position Risk** - размер позиции относительно лимитов
2. **P&L Risk** - текущий unrealized P&L
3. **Time Risk** - близость к экспирации рынка
4. **Inventory Risk** - дисбаланс YES/NO позиций

#### Формулы

```
netUtilization = |netPosition| / maxNetPosition
grossUtilization = grossPosition / maxGrossPosition
positionUrgency = max(netUtilization, grossUtilization)

secondsToExpiry = (expiry - now) / 1000
timeUrgency = max(0, 1 - secondsToExpiry / timeUrgencySeconds)

urgency = max(positionUrgency, timeUrgency)
```

#### Статусы и режимы

| Urgency | Status | Mode | Действия |
|---------|--------|------|----------|
| < 50% | NORMAL | QUOTE | Обычные котировки |
| 50-80% | WARNING | INVENTORY | Skew котировок для reduce position |
| > 80% | PANIC | PANIC | Stop quoting, агрессивно reduce |

#### Структура RiskAssessment

```typescript
interface RiskAssessment {
  status: RiskStatus;                    // 'NORMAL' | 'WARNING' | 'PANIC'
  mode: TradingMode;                     // 'QUOTE' | 'INVENTORY' | 'PANIC'
  urgency: Percentage;                   // 0-100%
  netPositionUtilization: Percentage;    // 0-100%
  grossPositionUtilization: Percentage;  // 0-100%
  secondsToExpiry: number;               // Время до экспирации (секунды)
  timeToExpiry: string;                  // Человекочитаемый формат: "1h30m", "5m45s", "30s"
  marketQuestion: string;                // Название текущего маркета
  marketUrl: string;                     // URL маркета на Polymarket
  recommendations: string[];             // Рекомендации
}
```

#### Формат времени

Поле `timeToExpiry` форматируется в человекочитаемый формат:
- `>= 1 часа`: `"1h30m"` (часы и минуты)
- `< 1 часа`: `"5m45s"` (минуты и секунды)
- `< 1 минуты`: `"30s"` (только секунды)

#### Использование

```typescript
const service = new RiskAssessmentService();

const config: RiskConfig = {
  maxNetPosition: 1000,
  maxGrossPosition: 2000,
  panicThreshold: 0.8,
  inventoryThreshold: 0.5,
  timeUrgencySeconds: 86400, // 24 hours
};

const assessment = service.assess(tradingSession, market, config);

console.log(`Status: ${assessment.status}`);
console.log(`Mode: ${assessment.mode}`);
console.log(`Urgency: ${assessment.urgency.value}%`);
console.log(`Net utilization: ${assessment.netPositionUtilization.value}%`);

// Новые поля для мониторинга
console.log(`Market: ${assessment.marketQuestion}`);
console.log(`Time to expiry: ${assessment.timeToExpiry}`);
console.log(`Market URL: ${assessment.marketUrl}`);

if (assessment.status === 'PANIC') {
  console.error('PANIC MODE! Reduce positions immediately!');
  assessment.recommendations.forEach(rec => {
    console.log(`- ${rec}`);
  });
}
```

#### Пример вывода

```json
{
  "status": "NORMAL",
  "mode": "QUOTE",
  "urgency": { "value": 47.14 },
  "netPositionUtilization": { "value": 0 },
  "grossPositionUtilization": { "value": 0 },
  "secondsToExpiry": 1162.915,
  "timeToExpiry": "19m22s",
  "marketQuestion": "Bitcoin Up or Down - December 28, 3:00PM-3:15PM ET",
  "marketUrl": "https://polymarket.com/event/...",
  "recommendations": []
}
```

---

### 2. PayoffCalculator

**Назначение**: Расчет P&L при различных исходах бинарного рынка.

**Файл**: `src/domain/services/risk/PayoffCalculator.ts`

#### Логика выплат

```
Если исход YES:
  payoff = yesQuantity * $1.00 + noQuantity * $0.00 = yesQuantity
  pnl = payoff - (yesCostBasis + noCostBasis)

Если исход NO:
  payoff = yesQuantity * $0.00 + noQuantity * $1.00 = noQuantity
  pnl = payoff - (yesCostBasis + noCostBasis)

worstCasePnl = min(pnlIfYes, pnlIfNo)
isLockedInLoss = (pnlIfYes < 0 && pnlIfNo < 0)
```

#### Использование

```typescript
const calculator = new PayoffCalculator();

const payoff = calculator.calculate(
  yesPosition,  // 100 YES @ $0.65
  noPosition,   // 50 NO @ $0.30
  Price.fromNumber(0.65),
  Price.fromNumber(0.35)
);

console.log(`PnL if YES wins: $${payoff.pnlIfYes.amount}`);
console.log(`PnL if NO wins: $${payoff.pnlIfNo.amount}`);
console.log(`Worst case: $${payoff.worstCasePnl.amount}`);

if (payoff.isLockedInLoss) {
  console.error('⚠️ LOCKED-IN LOSS! Guaranteed loss regardless of outcome!');
}

// Проверка хеджирования
const isHedged = calculator.isHedged(yesPosition, noPosition, 0.9);
if (!isHedged) {
  console.warn('Position is not well-hedged');
}
```

#### Интерпретация результатов

- `isLockedInLoss = true` → Убыток гарантирован
- `pnlIfYes > 0 && pnlIfNo > 0` → Profitable hedge (arbitrage!)
- `pnlIfYes > 0 && pnlIfNo < 0` → Bullish position
- `pnlIfYes < 0 && pnlIfNo > 0` → Bearish position

---

### 3. MarginCalculator

**Назначение**: Расчет требуемой маржи для позиций.

**Файл**: `src/domain/services/risk/MarginCalculator.ts`

#### Формулы маржи

```
BUY order:
  requiredMargin = price * quantity

SELL order:
  requiredMargin = (1.00 - price) * quantity  // max risk
```

#### Использование

```typescript
const calculator = new MarginCalculator();

// Маржа для покупки 100 YES по $0.65
const marginBuy = calculator.calculateOrderMargin(
  'BUY',
  Price.fromNumber(0.65),
  Quantity.fromNumber(100)
);
console.log(`Required margin: $${marginBuy.amount}`); // $65

// Маржа для продажи 100 YES по $0.65
const marginSell = calculator.calculateOrderMargin(
  'SELL',
  Price.fromNumber(0.65),
  Quantity.fromNumber(100)
);
console.log(`Required margin: $${marginSell.amount}`); // $35 (max risk)

// Проверка перед размещением ордера
const requirement = calculator.checkMarginRequirement(order, portfolio);

if (!requirement.isSufficient) {
  console.error(`Insufficient margin!`);
  console.error(`Required: $${requirement.requiredMargin.amount}`);
  console.error(`Available: $${requirement.availableCash.amount}`);
  console.error(`Shortfall: $${requirement.shortfall.amount}`);
  throw new InsufficientFundsError('Not enough margin');
}

// Максимальный размер позиции при заданном cash
const maxSize = calculator.calculateMaxPositionSize(
  'BUY',
  Price.fromNumber(0.65),
  Money.fromUSDC(1000)
);
console.log(`Max size: ${maxSize.value} shares`);
```

---

## Inventory Services

### 1. PositionTracker

**Назначение**: Отслеживание и анализ позиций.

**Файл**: `src/domain/services/inventory/PositionTracker.ts`

#### Формулы

```
netPosition = yesQuantity - noQuantity
grossPosition = |yesQuantity| + |noQuantity|
hedgeRatio = min(yesQty, noQty) / max(yesQty, noQty)
imbalance = netPosition / grossPosition  // -1 to 1
```

#### Использование

```typescript
const tracker = new PositionTracker();

const metrics = tracker.calculateMetrics(portfolio, 'market-123');

console.log(`Net position: ${metrics.netPosition}`);
console.log(`Gross position: ${metrics.grossPosition}`);
console.log(`Hedge ratio: ${metrics.hedgeRatio.toFixed(2)}`);
console.log(`Imbalance: ${metrics.imbalance.toFixed(2)}`);
console.log(`Dominant side: ${metrics.dominantSide}`);

// Расчет skew для котировок
const skew = tracker.calculateSkew(portfolio, 'market-123', 1.0);

if (skew > 0.3) {
  console.log('High YES imbalance, skew quotes to reduce position');
} else if (skew < -0.3) {
  console.log('High NO imbalance, skew quotes to reduce position');
}

// Проверка лимитов
const exceedsLimit = tracker.exceedsLimit(
  portfolio,
  'market-123',
  1000, // net limit
  2000  // gross limit
);

if (exceedsLimit) {
  console.error('Position limit exceeded!');
}
```

---

### 2. LotAccountingService

**Назначение**: Управление лотами позиций по FIFO.

**Файл**: `src/domain/services/inventory/LotAccountingService.ts`

#### FIFO Algorithm

```
При покупке:
  1. Создать новый PositionLot(quantity, entryPrice, timestamp)
  2. Добавить в список lots позиции

При продаже:
  1. Взять lots в порядке создания (oldest first)
  2. Списывать по мере достаточности:
     - Если lot.quantity <= remainingToSell → remove entire lot
     - Если lot.quantity > remainingToSell → remove partial lot
  3. Рассчитать realized P&L: proceeds - costBasis
```

#### Использование

```typescript
const service = new LotAccountingService();

// Добавление лота при покупке
const lot = service.addLot(
  position,
  Quantity.fromNumber(100),
  Price.fromNumber(0.65)
);

// Удаление лотов при продаже (FIFO)
const result = service.removeLotsFIFO(
  position,
  Quantity.fromNumber(50),
  Price.fromNumber(0.70)
);

console.log(`Removed ${result.removedLots.length} lots`);
console.log(`Cost basis: $${result.costBasis.amount}`);
console.log(`Proceeds: $${result.proceeds.amount}`);
console.log(`Realized P&L: $${result.realizedPnl.amount}`);

// Summary всех лотов
const summary = service.getLotsSummary(position);

console.log(`Total quantity: ${summary.totalQuantity.value}`);
console.log(`Average entry: $${summary.avgEntryPrice.value}`);
console.log(`Number of lots: ${summary.lotCount}`);
console.log(`Oldest lot: ${summary.oldestLotAgeDays.toFixed(0)} days`);

// Tax implications (short-term vs long-term)
const taxResult = service.calculateTaxImplications(
  position,
  Quantity.fromNumber(100),
  Price.fromNumber(0.75)
);

console.log(`Short-term gain: $${taxResult.shortTermGain.amount}`);
console.log(`Long-term gain: $${taxResult.longTermGain.amount}`);
```

---

### 3. HedgeRatioCalculator

**Назначение**: Расчет коэффициента хеджирования.

**Файл**: `src/domain/services/inventory/HedgeRatioCalculator.ts`

#### Формула

```
hedgeRatio = min(yesQty, noQty) / max(yesQty, noQty)

Quality:
- ratio >= 0.95 → PERFECT
- ratio >= 0.80 → GOOD
- ratio >= 0.50 → MODERATE
- ratio >= 0.20 → POOR
- ratio < 0.20 → NONE
```

#### Использование

```typescript
const calculator = new HedgeRatioCalculator();

const result = calculator.calculate(
  Quantity.fromNumber(100), // YES
  Quantity.fromNumber(85),  // NO
  0.95 // target ratio
);

console.log(`Hedge ratio: ${result.ratio.toFixed(2)}`);
console.log(`Quality: ${result.quality}`);

if (result.quality !== 'PERFECT' && result.quality !== 'GOOD') {
  console.warn(`Hedge quality is ${result.quality}`);
  console.log(`Recommendation: Buy ${result.recommendedHedgeSize.toFixed(0)} ${result.hedgeSide}`);
}

// Для рынка в портфеле
const hedgeResult = calculator.calculateForMarket(
  portfolio,
  'market-123',
  0.95
);

// Hedge effectiveness
const effectiveness = calculator.calculateEffectiveness(yesQty, noQty);
console.log(`Hedge effectiveness: ${effectiveness.value}%`);

// Проверка необходимости ребалансировки
const needsRebalancing = calculator.needsRebalancing(
  yesQty,
  noQty,
  0.8 // min acceptable ratio
);

if (needsRebalancing) {
  console.log('Position needs rebalancing');
}
```

---

## Execution Services

### 1. SlippageCalculator

**Назначение**: Расчет ожидаемого slippage.

**Файл**: `src/domain/services/execution/SlippageCalculator.ts`

#### Формула

```
slippage = (executionPrice - expectedPrice) / expectedPrice

Симуляция исполнения:
1. BUY order: заполняем через ask уровни (ascending)
2. SELL order: заполняем через bid уровни (descending)
3. avgFillPrice = sum(fill.price * fill.qty) / totalFilledQty
```

#### Использование

```typescript
const calculator = new SlippageCalculator();

// Расчет expected slippage
const slippage = calculator.calculateExpectedSlippage(
  orderbook,
  'BUY',
  Quantity.fromNumber(100)
);

console.log(`Expected slippage: ${slippage.slippagePercent.value.toFixed(2)}%`);
console.log(`Average fill price: $${slippage.avgFillPrice.value}`);
console.log(`Best price: $${slippage.bestPrice.value}`);
console.log(`Filled quantity: ${slippage.filledQuantity}`);
console.log(`Levels crossed: ${slippage.levelsCrossed}`);

if (!slippage.isFullyFillable) {
  console.warn(`Order partially fillable! Unfilled: ${slippage.unfilledQuantity}`);
}

// Максимальный размер для заданного slippage
const maxSize = calculator.calculateMaxSizeForSlippage(
  orderbook,
  'BUY',
  1.0 // max 1% slippage
);

console.log(`Max size for 1% slippage: ${maxSize.value} shares`);

// Market impact
const impact = calculator.calculateMarketImpact(
  orderbook,
  'BUY',
  Quantity.fromNumber(500)
);

if (impact.value > 2.0) {
  console.warn('High market impact! Consider splitting order');
}
```

---

### 2. OrderValidator

**Назначение**: Валидация ордеров перед размещением.

**Файл**: `src/domain/services/execution/OrderValidator.ts`

#### Проверки

1. **Price validation**: цена в (0, 1)
2. **Size validation**: размер > 0 и в пределах лимитов
3. **Margin validation**: достаточно средств
4. **Position limit validation**: не превышает лимиты
5. **Marketable check**: не создает self-trade
6. **Arbitrage check**: не создает арбитраж

#### Использование

```typescript
const validator = new OrderValidator();

const config: ValidationConfig = {
  maxOrderSize: 1000,
  minOrderSize: 10,
  maxNetPosition: 5000,
  maxGrossPosition: 10000,
  checkSelfTrade: true,
  checkArbitrage: true,
};

const result = validator.validate(order, tradingSession, config);

if (!result.isValid) {
  console.error('Order validation failed:');
  result.errors.forEach(error => {
    console.error(`❌ ${error}`);
  });
  throw new Error('Invalid order');
}

if (result.warnings.length > 0) {
  console.warn('Warnings:');
  result.warnings.forEach(warning => {
    console.warn(`⚠️  ${warning}`);
  });
}

// Проверка marketable order
const isMarketable = validator.checkMarketable(order, orderbook);

if (isMarketable) {
  console.warn('Order is marketable (crosses spread), may self-trade');
}

// Быстрая проверка risk limits
const passesRiskCheck = validator.validateRiskLimits(
  order,
  session,
  5000, // max net
  10000 // max gross
);
```

---

## Best Practices

### 1. Использование сервисов

```typescript
// ✅ GOOD: Передаем все зависимости явно
const fairValue = fairValueCalculator.calculate(
  orderbook,
  previousFairValue,
  config
);

// ❌ BAD: Сервис хранит состояние
class FairValueCalculator {
  private previousValue: Price; // ❌ stateful!

  calculate(orderbook: Orderbook): Price {
    // используем this.previousValue
  }
}
```

### 2. Композиция сервисов

```typescript
// Сервисы можно комбинировать
class QuoteGenerator {
  constructor(
    private fairValueCalc: FairValueCalculator,
    private positionTracker: PositionTracker,
    private arbitrageDetector: ArbitrageDetector
  ) {}

  generate(session: TradingSession): {bid: Price, ask: Price} {
    // 1. Calculate fair value
    const fairValue = this.fairValueCalc.calculate(...);

    // 2. Calculate skew based on inventory
    const skew = this.positionTracker.calculateSkew(...);

    // 3. Adjust quotes with skew
    const bid = Price.fromNumber(fairValue.value - spread/2 - skewAdj);
    const ask = Price.fromNumber(fairValue.value + spread/2 + skewAdj);

    // 4. Validate no arbitrage
    const wouldCreateArb = this.arbitrageDetector.wouldCreateArbitrage(...);
    if (wouldCreateArb) {
      // adjust quotes
    }

    return {bid, ask};
  }
}
```

### 3. Тестирование

```typescript
describe('FairValueCalculator', () => {
  it('should calculate fair value', () => {
    const calculator = new FairValueCalculator();

    const orderbook = createMockOrderbook({
      bids: [{price: 0.64, quantity: 100}],
      asks: [{price: 0.66, quantity: 100}],
    });

    const fairValue = calculator.calculate(
      orderbook,
      Price.fromNumber(0.65),
      {
        weightMid: 0.5,
        weightMicroprice: 0.3,
        weightEma: 0.2,
        emaAlpha: 0.1,
      }
    );

    expect(fairValue.value).toBeCloseTo(0.65, 2);
  });
});
```

---

## Диаграмма взаимодействий

```
┌──────────────────────────────────────────────────────────┐
│                     Application Layer                     │
│                                                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │           PlaceOrderCommand Handler                │  │
│  │                                                    │  │
│  │  1. Validate order       → OrderValidator         │  │
│  │  2. Check margin         → MarginCalculator       │  │
│  │  3. Check position limit → PositionTracker        │  │
│  │  4. Calculate slippage   → SlippageCalculator     │  │
│  │  5. Place order          → IExchangeAdapter       │  │
│  └────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │          UpdateQuoteCommand Handler                │  │
│  │                                                    │  │
│  │  1. Get orderbook        → IMarketDataFeed        │  │
│  │  2. Calculate fair value → FairValueCalculator    │  │
│  │  3. Calculate skew       → PositionTracker        │  │
│  │  4. Check arbitrage      → ArbitrageDetector      │  │
│  │  5. Place bid/ask        → IExchangeAdapter       │  │
│  └────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │        GetRiskMetricsQuery Handler                 │  │
│  │                                                    │  │
│  │  1. Get positions        → Portfolio              │  │
│  │  2. Calculate payoff     → PayoffCalculator       │  │
│  │  3. Assess risk          → RiskAssessmentService  │  │
│  │  4. Calculate hedge      → HedgeRatioCalculator   │  │
│  │  5. Return metrics       → RiskMetricsDTO         │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────┐
│                      Domain Services                       │
│                                                            │
│  Pricing    Risk    Inventory    Execution                │
│     ↓         ↓          ↓            ↓                   │
│  FairVal  Assess  PositionTr   Slippage                  │
│  Micro    Payoff  LotAcct      Validator                  │
│  Arbitr   Margin  HedgeRat                                │
└──────────────────────────────────────────────────────────┘
```

---

## Заключение

Domain Services инкапсулируют бизнес-логику, которая:
- Не принадлежит конкретной Entity
- Требует данные из нескольких Entities
- Является stateless и reusable

Используйте сервисы активно для:
- ✅ Расчетов (fair value, P&L, slippage)
- ✅ Валидации (orders, risk limits)
- ✅ Анализа (positions, hedge ratio)
- ✅ Обнаружения паттернов (arbitrage)

Все сервисы хорошо тестируются и легко композируются друг с другом.
