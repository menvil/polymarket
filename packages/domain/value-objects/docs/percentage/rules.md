# Rules Layer — Валидация Percentage

> Контекстные правила для комиссий и спредов

## Обзор

Rules Layer содержит **5 правил валидации** для контекстных проверок Percentage:

1. **ValidateFeeNonNegative** — комиссия >= 0%
2. **ValidateFeeForTrading** — торговая комиссия [0%, 5%]
3. **ValidateTotalFee** — суммарная комиссия <= 10%
4. **ValidateSpreadNonNegative** — спред >= 0%
5. **ValidateSpreadRange** — спред в диапазоне [min, max]

**Ключевые принципы:**

- **Single Responsibility** — одно правило = одна проверка
- **Композируемость** — правила независимы
- **Явная семантика** — имя правила отражает его назначение
- **Result<void, InvalidPercentageError>** — явная обработка ошибок

---

## 1. ValidateFeeNonNegative

Проверяет что комиссия неотрицательная.

### Правило

```
fee >= 0%
```

### API

```typescript
ValidateFeeNonNegative.check(fee: Percentage): Result<void, InvalidPercentageError>
```

### Когда использовать

- Базовая валидация комиссий
- Перед ValidateFeeForTrading
- Когда нужна только проверка знака

### Примеры

```typescript
import { Percentage } from '@polymarket/value-objects/percentage';
import { ValidateFeeNonNegative } from '@polymarket/value-objects/percentage/rules';

// ✅ Успех: положительная комиссия
const fee1 = Percentage.of(2.5);
const result1 = ValidateFeeNonNegative.check(fee1);
console.log(result1.ok);  // true

// ✅ Успех: нулевая комиссия
const fee2 = Percentage.ZERO;
const result2 = ValidateFeeNonNegative.check(fee2);
console.log(result2.ok);  // true

// ❌ Ошибка: отрицательная комиссия
const fee3 = Percentage.of(-0.5);
const result3 = ValidateFeeNonNegative.check(fee3);
if (!result3.ok) {
  console.log(result3.error.message);           // "Fee cannot be negative"
  console.log(result3.error.context?.fee);      // "-0.5"
  console.log(result3.error.context?.reason);   // "NEGATIVE_FEE"
}
```

### Error Context

```typescript
{
  fee: string;     // Значение комиссии
  reason: 'NEGATIVE_FEE'
}
```

---

## 2. ValidateFeeForTrading

Проверяет что торговая комиссия в допустимом диапазоне.

### Правило

```
0% <= fee <= 5%
```

### Константы

```typescript
MAX_TRADING_FEE = 5%
```

### API

```typescript
ValidateFeeForTrading.check(fee: Percentage): Result<void, InvalidPercentageError>
```

### Когда использовать

- Валидация maker/taker fees
- Валидация индивидуальных комиссий (не суммарных)
- Polymarket-специфичные торговые операции

### Примеры

```typescript
import { Percentage } from '@polymarket/value-objects/percentage';
import { ValidateFeeForTrading } from '@polymarket/value-objects/percentage/rules';

// ✅ Успех: валидная торговая комиссия
const validFee = Percentage.of(2.5);
const result1 = ValidateFeeForTrading.check(validFee);
console.log(result1.ok);  // true

// ✅ Успех: нулевая комиссия
const zeroFee = Percentage.ZERO;
const result2 = ValidateFeeForTrading.check(zeroFee);
console.log(result2.ok);  // true

// ✅ Успех: максимальная комиссия
const maxFee = Percentage.of(5);
const result3 = ValidateFeeForTrading.check(maxFee);
console.log(result3.ok);  // true

// ❌ Ошибка: отрицательная комиссия
const negativeFee = Percentage.of(-0.5);
const result4 = ValidateFeeForTrading.check(negativeFee);
if (!result4.ok) {
  console.log(result4.error.message);           // "Trading fee cannot be negative"
  console.log(result4.error.context?.fee);      // "-0.5"
  console.log(result4.error.context?.maxFee);   // "5"
  console.log(result4.error.context?.reason);   // "NEGATIVE_FEE"
}

// ❌ Ошибка: превышает максимум
const tooHighFee = Percentage.of(6);
const result5 = ValidateFeeForTrading.check(tooHighFee);
if (!result5.ok) {
  console.log(result5.error.message);           // "Trading fee 6% exceeds maximum 5%"
  console.log(result5.error.context?.fee);      // "6"
  console.log(result5.error.context?.maxFee);   // "5"
  console.log(result5.error.context?.reason);   // "EXCEEDS_MAX_FEE"
}
```

### Error Context

```typescript
{
  fee: string;           // Значение комиссии
  maxFee: string;        // Максимальная комиссия (5)
  reason: 'NEGATIVE_FEE' | 'EXCEEDS_MAX_FEE'
}
```

---

## 3. ValidateTotalFee

Проверяет что суммарная комиссия не превышает лимит.

### Правило

```
totalFee <= 10%
```

### Константы

```typescript
MAX_TOTAL_FEE = 10%
```

### API

```typescript
ValidateTotalFee.check(totalFee: Percentage): Result<void, InvalidPercentageError>
```

### Когда использовать

- После сложения maker + taker fees
- Валидация комбинированных комиссий
- Проверка общих затрат на торговлю

### Примеры

```typescript
import { Percentage, PercentageService } from '@polymarket/value-objects/percentage';
import { ValidateTotalFee } from '@polymarket/value-objects/percentage/rules';

// ✅ Успех: валидная суммарная комиссия
const validTotalFee = Percentage.of(8);
const result1 = ValidateTotalFee.check(validTotalFee);
console.log(result1.ok);  // true

// ✅ Успех: максимальная суммарная комиссия
const maxTotalFee = Percentage.of(10);
const result2 = ValidateTotalFee.check(maxTotalFee);
console.log(result2.ok);  // true

// ❌ Ошибка: превышает максимум
const tooHighFee = Percentage.of(12);
const result3 = ValidateTotalFee.check(tooHighFee);
if (!result3.ok) {
  console.log(result3.error.message);               // "Total fee 12% exceeds maximum 10%"
  console.log(result3.error.context?.totalFee);     // "12"
  console.log(result3.error.context?.maxTotalFee);  // "10"
  console.log(result3.error.context?.reason);       // "EXCEEDS_MAX_TOTAL_FEE"
}

// ✅ Пример с суммой комиссий
const makerFee = Percentage.of(3);
const takerFee = Percentage.of(4);
const addResult = PercentageService.add(makerFee, takerFee);

if (addResult.ok) {
  const totalFee = addResult.value;
  const validateResult = ValidateTotalFee.check(totalFee);
  console.log(validateResult.ok);  // true (3% + 4% = 7% <= 10%)
}

// ❌ Пример с превышением
const highMakerFee = Percentage.of(6);
const highTakerFee = Percentage.of(5);
const addResult2 = PercentageService.add(highMakerFee, highTakerFee);

if (addResult2.ok) {
  const totalFee = addResult2.value;
  const validateResult = ValidateTotalFee.check(totalFee);
  console.log(validateResult.ok);  // false (6% + 5% = 11% > 10%)

  if (!validateResult.ok) {
    console.log(validateResult.error.context?.reason);  // "EXCEEDS_MAX_TOTAL_FEE"
  }
}
```

### Error Context

```typescript
{
  totalFee: string;       // Значение суммарной комиссии
  maxTotalFee: string;    // Максимальная суммарная комиссия (10)
  reason: 'EXCEEDS_MAX_TOTAL_FEE'
}
```

---

## 4. ValidateSpreadNonNegative

Проверяет что спред неотрицательный.

### Правило

```
spread >= 0%
```

### API

```typescript
ValidateSpreadNonNegative.check(spread: Percentage): Result<void, InvalidPercentageError>
```

### Когда использовать

- Базовая валидация спредов
- Перед ValidateSpreadRange
- Когда нужна только проверка знака

### Примеры

```typescript
import { Percentage } from '@polymarket/value-objects/percentage';
import { ValidateSpreadNonNegative } from '@polymarket/value-objects/percentage/rules';

// ✅ Успех: положительный спред
const spread1 = Percentage.of(0.5);
const result1 = ValidateSpreadNonNegative.check(spread1);
console.log(result1.ok);  // true

// ✅ Успех: нулевой спред
const spread2 = Percentage.ZERO;
const result2 = ValidateSpreadNonNegative.check(spread2);
console.log(result2.ok);  // true

// ❌ Ошибка: отрицательный спред
const spread3 = Percentage.of(-0.1);
const result3 = ValidateSpreadNonNegative.check(spread3);
if (!result3.ok) {
  console.log(result3.error.message);           // "Spread cannot be negative"
  console.log(result3.error.context?.spread);   // "-0.1"
  console.log(result3.error.context?.reason);   // "NEGATIVE_SPREAD"
}
```

### Error Context

```typescript
{
  spread: string;     // Значение спреда
  reason: 'NEGATIVE_SPREAD'
}
```

---

## 5. ValidateSpreadRange

Проверяет что спред в допустимом диапазоне.

### Правило

```
minSpread <= spread <= maxSpread
```

### Константы

```typescript
DEFAULT_MIN_SPREAD = 0%
DEFAULT_MAX_SPREAD = 10%
```

### API

```typescript
ValidateSpreadRange.check(
  spread: Percentage,
  minSpread?: Percentage,  // default: 0%
  maxSpread?: Percentage   // default: 10%
): Result<void, InvalidPercentageError>
```

### Когда использовать

- Валидация спредов с кастомными лимитами
- Проверка диапазона bid-ask spread
- Различные уровни рынка (разные лимиты)

### Примеры

```typescript
import { Percentage } from '@polymarket/value-objects/percentage';
import { ValidateSpreadRange } from '@polymarket/value-objects/percentage/rules';

// ✅ Успех: валидный спред (default limits)
const validSpread = Percentage.of(2);
const result1 = ValidateSpreadRange.check(validSpread);
console.log(result1.ok);  // true (2% in [0%, 10%])

// ✅ Успех: минимальный спред
const minSpread = Percentage.ZERO;
const result2 = ValidateSpreadRange.check(minSpread);
console.log(result2.ok);  // true

// ✅ Успех: максимальный спред
const maxSpread = Percentage.of(10);
const result3 = ValidateSpreadRange.check(maxSpread);
console.log(result3.ok);  // true

// ❌ Ошибка: ниже минимума
const tooLowSpread = Percentage.of(-0.5);
const result4 = ValidateSpreadRange.check(tooLowSpread);
if (!result4.ok) {
  console.log(result4.error.message);             // "Spread -0.5% is below minimum 0%"
  console.log(result4.error.context?.spread);     // "-0.5"
  console.log(result4.error.context?.minSpread);  // "0"
  console.log(result4.error.context?.maxSpread);  // "10"
  console.log(result4.error.context?.reason);     // "BELOW_MIN_SPREAD"
}

// ❌ Ошибка: выше максимума
const tooHighSpread = Percentage.of(15);
const result5 = ValidateSpreadRange.check(tooHighSpread);
if (!result5.ok) {
  console.log(result5.error.message);             // "Spread 15% exceeds maximum 10%"
  console.log(result5.error.context?.spread);     // "15"
  console.log(result5.error.context?.minSpread);  // "0"
  console.log(result5.error.context?.maxSpread);  // "10"
  console.log(result5.error.context?.reason);     // "EXCEEDS_MAX_SPREAD"
}

// ✅ Кастомные лимиты
const customSpread = Percentage.of(3);
const customResult = ValidateSpreadRange.check(
  customSpread,
  Percentage.of(1),   // minSpread: 1%
  Percentage.of(5)    // maxSpread: 5%
);
console.log(customResult.ok);  // true (3% in [1%, 5%])

// ❌ Кастомные лимиты: выше максимума
const customSpread2 = Percentage.of(8);
const customResult2 = ValidateSpreadRange.check(
  customSpread2,
  Percentage.of(1),
  Percentage.of(5)
);
console.log(customResult2.ok);  // false (8% > 5%)
if (!customResult2.ok) {
  console.log(customResult2.error.context?.reason);  // "EXCEEDS_MAX_SPREAD"
}
```

### Error Context

```typescript
{
  spread: string;       // Значение спреда
  minSpread: string;    // Минимальный спред
  maxSpread: string;    // Максимальный спред
  reason: 'BELOW_MIN_SPREAD' | 'EXCEEDS_MAX_SPREAD'
}
```

---

## Композиция правил

### Последовательная валидация

```typescript
function validateTradingFee(fee: Percentage): Result<void, InvalidPercentageError> {
  // 1. Проверка неотрицательности
  const nonNegativeResult = ValidateFeeNonNegative.check(fee);
  if (!nonNegativeResult.ok) {
    return nonNegativeResult;
  }

  // 2. Проверка диапазона
  const rangeResult = ValidateFeeForTrading.check(fee);
  if (!rangeResult.ok) {
    return rangeResult;
  }

  return Ok(undefined);
}
```

**Примечание:** ValidateFeeForTrading уже проверяет неотрицательность, поэтому можно использовать только его.

---

### Валидация комбинированных комиссий

```typescript
function validateFeeStructure(
  makerFee: Percentage,
  takerFee: Percentage
): Result<void, InvalidPercentageError> {
  // 1. Валидация maker fee
  const makerResult = ValidateFeeForTrading.check(makerFee);
  if (!makerResult.ok) {
    return makerResult;
  }

  // 2. Валидация taker fee
  const takerResult = ValidateFeeForTrading.check(takerFee);
  if (!takerResult.ok) {
    return takerResult;
  }

  // 3. Вычисление total fee
  const totalResult = PercentageService.add(makerFee, takerFee);
  if (!totalResult.ok) {
    return totalResult;
  }

  const totalFee = totalResult.value;

  // 4. Валидация total fee
  const totalValidateResult = ValidateTotalFee.check(totalFee);
  if (!totalValidateResult.ok) {
    return totalValidateResult;
  }

  return Ok(undefined);
}
```

---

### Валидация спреда с разными уровнями

```typescript
function validateMarketSpread(
  spread: Percentage,
  marketTier: 'premium' | 'standard' | 'basic'
): Result<void, InvalidPercentageError> {
  // 1. Базовая проверка
  const nonNegativeResult = ValidateSpreadNonNegative.check(spread);
  if (!nonNegativeResult.ok) {
    return nonNegativeResult;
  }

  // 2. Проверка диапазона в зависимости от tier
  switch (marketTier) {
    case 'premium':
      return ValidateSpreadRange.check(
        spread,
        Percentage.of(0.1),  // min 0.1%
        Percentage.of(2)     // max 2%
      );
    case 'standard':
      return ValidateSpreadRange.check(
        spread,
        Percentage.of(0.5),  // min 0.5%
        Percentage.of(5)     // max 5%
      );
    case 'basic':
      return ValidateSpreadRange.check(
        spread,
        Percentage.of(1),    // min 1%
        Percentage.of(10)    // max 10%
      );
  }
}
```

---

## Best Practices

### ✅ DO: Используйте специализированные правила

```typescript
// ✅ Хорошо (явная семантика)
ValidateFeeForTrading.check(fee);
ValidateTotalFee.check(totalFee);
ValidateSpreadRange.check(spread);
```

### ❌ DON'T: Не проверяйте вручную

```typescript
// ❌ Плохо (дублирование логики)
if (fee.isNegative() || fee.isGreaterThan(Percentage.of(5))) {
  return Err(...);
}
```

---

### ✅ DO: Композируйте правила

```typescript
// ✅ Хорошо (композиция)
function validateFees(maker: Percentage, taker: Percentage) {
  const makerCheck = ValidateFeeForTrading.check(maker);
  if (!makerCheck.ok) return makerCheck;

  const takerCheck = ValidateFeeForTrading.check(taker);
  if (!takerCheck.ok) return takerCheck;

  const total = PercentageService.add(maker, taker);
  if (!total.ok) return total;

  return ValidateTotalFee.check(total.value);
}
```

---

### ✅ DO: Используйте кастомные лимиты когда нужно

```typescript
// ✅ Хорошо (гибкость)
ValidateSpreadRange.check(
  spread,
  Percentage.of(customMin),
  Percentage.of(customMax)
);
```

### ❌ DON'T: Не хардкодьте везде

```typescript
// ❌ Плохо (магические числа)
if (spread.isLessThan(Percentage.of(0.5)) || spread.isGreaterThan(Percentage.of(10))) {
  // ...
}
```

---

### ✅ DO: Обрабатывайте специфичные ошибки

```typescript
// ✅ Хорошо
const result = ValidateFeeForTrading.check(fee);
if (!result.ok) {
  switch (result.error.context?.reason) {
    case 'NEGATIVE_FEE':
      return 'Fee cannot be negative';
    case 'EXCEEDS_MAX_FEE':
      return 'Fee too high (max 5%)';
  }
}
```

---

## Заключение

Rules Layer для Percentage обеспечивает:

1. **5 специализированных правил** — для комиссий и спредов
2. **Композируемость** — правила независимы и можно комбинировать
3. **Явную семантику** — имена правил отражают их назначение
4. **Type safety** — Result<void, InvalidPercentageError> для всех проверок
5. **Гибкость** — кастомные лимиты где нужно (ValidateSpreadRange)
6. **Консистентность** — единый формат error context

Используйте Rules для контекстной валидации Percentage в бизнес-логике!
