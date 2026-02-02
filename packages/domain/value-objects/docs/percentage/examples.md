# Практические примеры использования Percentage

> Реальные сценарии работы с процентами на Polymarket

## Содержание

1. [Торговые комиссии](#торговые-комиссии)
2. [Спреды и ликвидность](#спреды-и-ликвидность)
3. [PnL и доходность](#pnl-и-доходность)
4. [Изменение цен](#изменение-цен)
5. [API интеграция](#api-интеграция)
6. [UI форматирование](#ui-форматирование)

---

## Торговые комиссии

### Расчёт maker/taker fees

```typescript
import { Percentage, PercentageService } from '@polymarket/value-objects/percentage';
import { ValidateFeeForTrading, ValidateTotalFee } from '@polymarket/value-objects/percentage/rules';

// Создание комиссий из конфигурации
const makerFeeResult = PercentageService.create(2.0);
const takerFeeResult = PercentageService.create(3.0);

if (!makerFeeResult.ok || !takerFeeResult.ok) {
  throw new Error('Invalid fee configuration');
}

const makerFee = makerFeeResult.value;
const takerFee = takerFeeResult.value;

// Валидация индивидуальных комиссий
const makerValidation = ValidateFeeForTrading.check(makerFee);
const takerValidation = ValidateFeeForTrading.check(takerFee);

if (!makerValidation.ok) {
  console.error('Invalid maker fee:', makerValidation.error.message);
}

if (!takerValidation.ok) {
  console.error('Invalid taker fee:', takerValidation.error.message);
}

// Расчёт суммарной комиссии
const totalFeeResult = PercentageService.add(makerFee, takerFee);

if (totalFeeResult.ok) {
  const totalFee = totalFeeResult.value;

  // Валидация суммарной комиссии
  const totalValidation = ValidateTotalFee.check(totalFee);

  if (totalValidation.ok) {
    console.log(`Maker: ${makerFee.toNumber()}%`);
    console.log(`Taker: ${takerFee.toNumber()}%`);
    console.log(`Total: ${totalFee.toNumber()}%`);
  } else {
    console.error('Total fee exceeds limit:', totalValidation.error.message);
  }
}
```

---

### Применение комиссии к сумме сделки

```typescript
import Decimal from 'decimal.js';
import { Percentage, PercentageService } from '@polymarket/value-objects/percentage';

const takerFee = Percentage.of(3);  // 3%
const tradeAmount = new Decimal(1000);  // $1000 USDC

// Расчёт суммы комиссии
const feeAmountResult = PercentageService.applyTo(takerFee, tradeAmount);

if (feeAmountResult.ok) {
  const feeAmount = feeAmountResult.value;  // Decimal(30)
  const netAmount = tradeAmount.minus(feeAmount);  // Decimal(970)

  console.log(`Trade amount: ${tradeAmount.toString()} USDC`);
  console.log(`Fee (${takerFee.toNumber()}%): ${feeAmount.toString()} USDC`);
  console.log(`Net amount: ${netAmount.toString()} USDC`);
}

// Trade amount: 1000 USDC
// Fee (3%): 30 USDC
// Net amount: 970 USDC
```

---

### Сравнение fee структур

```typescript
import { Percentage } from '@polymarket/value-objects/percentage';

interface FeeStructure {
  maker: Percentage;
  taker: Percentage;
}

const standardFees: FeeStructure = {
  maker: Percentage.of(2),
  taker: Percentage.of(3)
};

const premiumFees: FeeStructure = {
  maker: Percentage.of(1),
  taker: Percentage.of(2)
};

function compareFeeStructures(
  standard: FeeStructure,
  premium: FeeStructure,
  tradeAmount: Decimal
): void {
  console.log('Fee Comparison for $1000 trade:');
  console.log('---');

  // Standard fees
  const standardMakerResult = PercentageService.applyTo(standard.maker, tradeAmount);
  const standardTakerResult = PercentageService.applyTo(standard.taker, tradeAmount);

  if (standardMakerResult.ok && standardTakerResult.ok) {
    console.log(`Standard - Maker: $${standardMakerResult.value.toString()}`);
    console.log(`Standard - Taker: $${standardTakerResult.value.toString()}`);
  }

  // Premium fees
  const premiumMakerResult = PercentageService.applyTo(premium.maker, tradeAmount);
  const premiumTakerResult = PercentageService.applyTo(premium.taker, tradeAmount);

  if (premiumMakerResult.ok && premiumTakerResult.ok) {
    console.log(`Premium - Maker: $${premiumMakerResult.value.toString()}`);
    console.log(`Premium - Taker: $${premiumTakerResult.value.toString()}`);

    // Savings
    const makerSavings = standardMakerResult.value.minus(premiumMakerResult.value);
    const takerSavings = standardTakerResult.value.minus(premiumTakerResult.value);

    console.log(`Savings - Maker: $${makerSavings.toString()}`);
    console.log(`Savings - Taker: $${takerSavings.toString()}`);
  }
}

// Fee Comparison for $1000 trade:
// ---
// Standard - Maker: $20
// Standard - Taker: $30
// Premium - Maker: $10
// Premium - Taker: $20
// Savings - Maker: $10
// Savings - Taker: $10
```

---

## Спреды и ликвидность

### Расчёт bid-ask spread

```typescript
import Decimal from 'decimal.js';
import { PercentageService } from '@polymarket/value-objects/percentage';
import { ValidateSpreadRange } from '@polymarket/value-objects/percentage/rules';

const bidPrice = new Decimal(0.64);
const askPrice = new Decimal(0.66);

// Расчёт абсолютного спреда
const absoluteSpread = askPrice.minus(bidPrice);  // 0.02

// Расчёт относительного спреда (в процентах от mid price)
const midPrice = bidPrice.plus(askPrice).dividedBy(2);  // 0.65
const relativeSpreadDecimal = absoluteSpread.dividedBy(midPrice);  // 0.0307...

// Конвертация в Percentage
const spreadResult = PercentageService.fromDecimalFraction(relativeSpreadDecimal);

if (spreadResult.ok) {
  const spread = spreadResult.value;

  console.log(`Bid: ${bidPrice.toString()}`);
  console.log(`Ask: ${askPrice.toString()}`);
  console.log(`Mid: ${midPrice.toString()}`);
  console.log(`Absolute spread: ${absoluteSpread.toString()}`);
  console.log(`Relative spread: ${spread.toNumber().toFixed(2)}%`);

  // Валидация спреда
  const validation = ValidateSpreadRange.check(spread);
  if (validation.ok) {
    console.log('Spread is within acceptable range');
  } else {
    console.error('Spread is too wide:', validation.error.message);
  }
}

// Bid: 0.64
// Ask: 0.66
// Mid: 0.65
// Absolute spread: 0.02
// Relative spread: 3.08%
// Spread is within acceptable range
```

---

### Анализ ликвидности по спреду

```typescript
import { Percentage } from '@polymarket/value-objects/percentage';

type LiquidityTier = 'excellent' | 'good' | 'fair' | 'poor';

function assessLiquidity(spread: Percentage): LiquidityTier {
  if (spread.isLessThanOrEqual(Percentage.of(1))) {
    return 'excellent';  // <= 1%
  } else if (spread.isLessThanOrEqual(Percentage.of(2))) {
    return 'good';       // <= 2%
  } else if (spread.isLessThanOrEqual(Percentage.of(5))) {
    return 'fair';       // <= 5%
  } else {
    return 'poor';       // > 5%
  }
}

const spread1 = Percentage.of(0.5);
console.log(assessLiquidity(spread1));  // "excellent"

const spread2 = Percentage.of(1.5);
console.log(assessLiquidity(spread2));  // "good"

const spread3 = Percentage.of(3.0);
console.log(assessLiquidity(spread3));  // "fair"

const spread4 = Percentage.of(8.0);
console.log(assessLiquidity(spread4));  // "poor"
```

---

## PnL и доходность

### Расчёт PnL в процентах

```typescript
import Decimal from 'decimal.js';
import { PercentageService } from '@polymarket/value-objects/percentage';

const initialInvestment = new Decimal(1000);
const currentValue = new Decimal(1250);

// Расчёт абсолютного PnL
const absolutePnL = currentValue.minus(initialInvestment);  // 250

// Расчёт PnL в процентах
const pnlDecimal = absolutePnL.dividedBy(initialInvestment);  // 0.25
const pnlResult = PercentageService.fromDecimalFraction(pnlDecimal);

if (pnlResult.ok) {
  const pnl = pnlResult.value;

  console.log(`Initial: $${initialInvestment.toString()}`);
  console.log(`Current: $${currentValue.toString()}`);
  console.log(`Absolute PnL: $${absolutePnL.toString()}`);
  console.log(`PnL: ${pnl.toNumber()}%`);

  if (pnl.isPositive()) {
    console.log('✅ Profit');
  } else if (pnl.isNegative()) {
    console.log('❌ Loss');
  } else {
    console.log('➖ Break even');
  }
}

// Initial: $1000
// Current: $1250
// Absolute PnL: $250
// PnL: 25%
// ✅ Profit
```

---

### Расчёт убытков

```typescript
import Decimal from 'decimal.js';
import { PercentageService } from '@polymarket/value-objects/percentage';

const initialInvestment = new Decimal(1000);
const currentValue = new Decimal(750);

const absoluteLoss = currentValue.minus(initialInvestment);  // -250
const lossDecimal = absoluteLoss.dividedBy(initialInvestment);  // -0.25
const lossResult = PercentageService.fromDecimalFraction(lossDecimal);

if (lossResult.ok) {
  const loss = lossResult.value;

  console.log(`Loss: ${loss.toNumber()}%`);  // -25%
  console.log(`Is negative: ${loss.isNegative()}`);  // true

  // Расчёт необходимого возврата для break-even
  // Если потеряли 25%, нужно вернуть 33.33% от текущей стоимости
  const requiredReturnDecimal = initialInvestment.dividedBy(currentValue).minus(1);
  const requiredReturnResult = PercentageService.fromDecimalFraction(requiredReturnDecimal);

  if (requiredReturnResult.ok) {
    const requiredReturn = requiredReturnResult.value;
    console.log(`Required return to break-even: ${requiredReturn.toNumber().toFixed(2)}%`);
  }
}

// Loss: -25%
// Is negative: true
// Required return to break-even: 33.33%
```

---

### Расчёт годовой доходности (APY)

```typescript
import Decimal from 'decimal.js';
import { PercentageService } from '@polymarket/value-objects/percentage';

const initialInvestment = new Decimal(1000);
const finalValue = new Decimal(1500);
const daysHeld = 365;

// Simple return
const simpleReturnDecimal = finalValue.dividedBy(initialInvestment).minus(1);
const simpleReturnResult = PercentageService.fromDecimalFraction(simpleReturnDecimal);

if (simpleReturnResult.ok) {
  const simpleReturn = simpleReturnResult.value;
  console.log(`Simple return: ${simpleReturn.toNumber()}%`);  // 50%

  // Annualized return (APY)
  const yearsHeld = new Decimal(daysHeld).dividedBy(365);
  const apyDecimal = finalValue.dividedBy(initialInvestment).pow(new Decimal(1).dividedBy(yearsHeld)).minus(1);
  const apyResult = PercentageService.fromDecimalFraction(apyDecimal);

  if (apyResult.ok) {
    const apy = apyResult.value;
    console.log(`APY: ${apy.toNumber().toFixed(2)}%`);  // 50.00% (same for 1 year)
  }
}
```

---

## Изменение цен

### Расчёт процентного изменения цены

```typescript
import Decimal from 'decimal.js';
import { PercentageService } from '@polymarket/value-objects/percentage';

function calculatePriceChange(oldPrice: Decimal, newPrice: Decimal) {
  const changeDecimal = newPrice.minus(oldPrice).dividedBy(oldPrice);
  const changeResult = PercentageService.fromDecimalFraction(changeDecimal);

  if (changeResult.ok) {
    const change = changeResult.value;

    console.log(`Old price: ${oldPrice.toString()}`);
    console.log(`New price: ${newPrice.toString()}`);
    console.log(`Change: ${change.toNumber().toFixed(2)}%`);

    if (change.isPositive()) {
      console.log('📈 Price increased');
    } else if (change.isNegative()) {
      console.log('📉 Price decreased');
    } else {
      console.log('➖ No change');
    }

    return change;
  }
}

// Рост цены
calculatePriceChange(new Decimal(0.5), new Decimal(0.6));
// Old price: 0.5
// New price: 0.6
// Change: 20.00%
// 📈 Price increased

// Падение цены
calculatePriceChange(new Decimal(0.6), new Decimal(0.5));
// Old price: 0.6
// New price: 0.5
// Change: -16.67%
// 📉 Price decreased
```

---

### Мониторинг волатильности

```typescript
import Decimal from 'decimal.js';
import { Percentage, PercentageService } from '@polymarket/value-objects/percentage';

interface PricePoint {
  timestamp: number;
  price: Decimal;
}

function calculateVolatility(prices: PricePoint[]): Percentage | null {
  if (prices.length < 2) return null;

  const returns: Decimal[] = [];

  for (let i = 1; i < prices.length; i++) {
    const returnDecimal = prices[i].price
      .minus(prices[i - 1].price)
      .dividedBy(prices[i - 1].price);
    returns.push(returnDecimal);
  }

  // Расчёт стандартного отклонения
  const mean = returns.reduce((sum, r) => sum.plus(r), new Decimal(0)).dividedBy(returns.length);
  const variance = returns
    .reduce((sum, r) => sum.plus(r.minus(mean).pow(2)), new Decimal(0))
    .dividedBy(returns.length);
  const stdDev = variance.sqrt();

  const volatilityResult = PercentageService.fromDecimalFraction(stdDev);
  return volatilityResult.ok ? volatilityResult.value : null;
}

const prices: PricePoint[] = [
  { timestamp: 1, price: new Decimal(0.50) },
  { timestamp: 2, price: new Decimal(0.52) },
  { timestamp: 3, price: new Decimal(0.48) },
  { timestamp: 4, price: new Decimal(0.51) },
  { timestamp: 5, price: new Decimal(0.49) }
];

const volatility = calculateVolatility(prices);
if (volatility) {
  console.log(`Volatility: ${volatility.toNumber().toFixed(2)}%`);
}
```

---

## API интеграция

### Получение конфигурации комиссий

```typescript
import { PercentageSerializer } from '@polymarket/value-objects/percentage';

interface FeeConfigResponse {
  makerFee: { value: string };
  takerFee: { value: string };
  minimumFee: { value: string };
}

async function loadFeeConfig(): Promise<{
  maker: Percentage;
  taker: Percentage;
  minimum: Percentage;
} | null> {
  const response = await fetch('/api/config/fees');
  const data: FeeConfigResponse = await response.json();

  // Десериализация с валидацией
  const makerResult = PercentageSerializer.fromJSON(data.makerFee);
  const takerResult = PercentageSerializer.fromJSON(data.takerFee);
  const minimumResult = PercentageSerializer.fromJSON(data.minimumFee);

  if (!makerResult.ok) {
    console.error('Invalid maker fee:', makerResult.error.context);
    return null;
  }

  if (!takerResult.ok) {
    console.error('Invalid taker fee:', takerResult.error.context);
    return null;
  }

  if (!minimumResult.ok) {
    console.error('Invalid minimum fee:', minimumResult.error.context);
    return null;
  }

  return {
    maker: makerResult.value,
    taker: takerResult.value,
    minimum: minimumResult.value
  };
}
```

---

### Отправка обновлённых комиссий

```typescript
import { Percentage, PercentageSerializer } from '@polymarket/value-objects/percentage';
import { ValidateFeeForTrading } from '@polymarket/value-objects/percentage/rules';

async function updateFeeConfig(
  makerFee: Percentage,
  takerFee: Percentage
): Promise<boolean> {
  // Валидация перед отправкой
  const makerValidation = ValidateFeeForTrading.check(makerFee);
  if (!makerValidation.ok) {
    console.error('Invalid maker fee:', makerValidation.error.message);
    return false;
  }

  const takerValidation = ValidateFeeForTrading.check(takerFee);
  if (!takerValidation.ok) {
    console.error('Invalid taker fee:', takerValidation.error.message);
    return false;
  }

  // Сериализация
  const payload = {
    makerFee: PercentageSerializer.toJSON(makerFee),
    takerFee: PercentageSerializer.toJSON(takerFee)
  };

  const response = await fetch('/api/config/fees', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  return response.ok;
}
```

---

## UI форматирование

### Отображение комиссий в UI

```typescript
import { Percentage, PercentageFormatter } from '@polymarket/value-objects/percentage';

function renderFeeDisplay(fee: Percentage): JSX.Element {
  return (
    <div className="fee-display">
      <span className="fee-value">
        {PercentageFormatter.toPercent(fee)}
      </span>
      <span className="fee-bp">
        ({PercentageFormatter.toBasisPoints(fee)})
      </span>
    </div>
  );
}

// Renders: "2.50% (250 bp)"
```

---

### Цветное отображение PnL

```typescript
import { Percentage, PercentageFormatter } from '@polymarket/value-objects/percentage';

function renderPnL(pnl: Percentage): JSX.Element {
  const className = pnl.isPositive()
    ? 'pnl-positive'
    : pnl.isNegative()
    ? 'pnl-negative'
    : 'pnl-neutral';

  const icon = pnl.isPositive() ? '↑' : pnl.isNegative() ? '↓' : '→';

  return (
    <div className={className}>
      <span className="pnl-icon">{icon}</span>
      <span className="pnl-value">
        {PercentageFormatter.toPercent(pnl, 2)}
      </span>
    </div>
  );
}

// Positive: "↑ 25.00%" (green)
// Negative: "↓ -15.00%" (red)
// Neutral: "→ 0.00%" (gray)
```

---

### Таблица со спредами

```typescript
import { Percentage, PercentageFormatter } from '@polymarket/value-objects/percentage';

interface MarketRow {
  name: string;
  spread: Percentage;
}

function renderSpreadTable(markets: MarketRow[]): JSX.Element {
  return (
    <table>
      <thead>
        <tr>
          <th>Market</th>
          <th>Spread</th>
          <th>Spread (bp)</th>
        </tr>
      </thead>
      <tbody>
        {markets.map(market => (
          <tr key={market.name}>
            <td>{market.name}</td>
            <td>{PercentageFormatter.toPercent(market.spread, 2)}</td>
            <td>{PercentageFormatter.toBasisPoints(market.spread, 1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const markets: MarketRow[] = [
  { name: 'BTC/USD', spread: Percentage.of(0.5) },
  { name: 'ETH/USD', spread: Percentage.of(0.8) },
  { name: 'SOL/USD', spread: Percentage.of(1.2) }
];

// Renders:
// | Market   | Spread | Spread (bp) |
// |----------|--------|-------------|
// | BTC/USD  | 0.50%  | 50.0 bp     |
// | ETH/USD  | 0.80%  | 80.0 bp     |
// | SOL/USD  | 1.20%  | 120.0 bp    |
```

---

## Заключение

Percentage Value Object предоставляет:

- **Type-safe операции** для всех расчётов с процентами
- **Валидацию** через Rules для бизнес-правил
- **Форматирование** для UI и API
- **Гибкость** для различных use cases (fees, spreads, PnL)

Используйте эти примеры как отправную точку для вашей реализации!
