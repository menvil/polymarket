# Руководство по миграции на Percentage Value Object

> Переход с примитивных типов на type-safe Percentage

## Обзор

Это руководство поможет мигрировать с:

- `number` процентов → `Percentage`
- `Decimal` процентов → `Percentage`
- Прямых вычислений → `PercentageService`
- Manual validation → `Rules`

**Преимущества миграции:**

- ✅ Type safety — невозможно перепутать процент с другим числом
- ✅ Явная обработка ошибок — через `Result<T, E>`
- ✅ Валидация — автоматические инварианты + Rules
- ✅ Консистентность — единообразное представление
- ✅ Читаемость — явная семантика (toDecimal, toBasisPoints)

---

## Миграция со старого API

### Было: number процент

```typescript
// ❌ Старый код
let fee: number = 2.5;  // Непонятно: 2.5% или 0.025?
let spread: number = 0.5;

// Проблемы:
// - Нет валидации
// - Может быть NaN, Infinity
// - Может быть отрицательным (если не нужно)
// - Непонятная шкала (0-100 или 0-1?)
```

**Стало: Percentage**

```typescript
// ✅ Новый код
import { Percentage, PercentageService } from '@polymarket/value-objects/percentage';

const feeResult = PercentageService.create(2.5);
if (!feeResult.ok) {
  console.error('Invalid fee:', feeResult.error.message);
  return;
}
const fee = feeResult.value;  // Percentage (2.5%)

const spreadResult = PercentageService.create(0.5);
if (!spreadResult.ok) {
  console.error('Invalid spread:', spreadResult.error.message);
  return;
}
const spread = spreadResult.value;  // Percentage (0.5%)

// Преимущества:
// ✅ Валидация автоматическая
// ✅ Ясная шкала (0-100)
// ✅ Type safety
// ✅ Явная обработка ошибок
```

---

### Было: Decimal процент

```typescript
// ❌ Старый код
import Decimal from 'decimal.js';

let feeDecimal: Decimal = new Decimal(2.5);
let spreadDecimal: Decimal = new Decimal(0.5);

// Проблемы:
// - Нет валидации диапазона
// - Может быть любое значение
// - Нет семантики (это процент или что-то другое?)
```

**Стало: Percentage**

```typescript
// ✅ Новый код
import { Percentage, PercentageService } from '@polymarket/value-objects/percentage';

const feeResult = PercentageService.create(new Decimal(2.5));
if (feeResult.ok) {
  const fee = feeResult.value;  // Percentage
}

const spreadResult = PercentageService.create(new Decimal(0.5));
if (spreadResult.ok) {
  const spread = spreadResult.value;  // Percentage
}

// Преимущества:
// ✅ Валидация диапазона [-1e6, 1e6]
// ✅ Явная семантика (это процент)
// ✅ Type safety
```

---

### Было: Прямые вычисления

```typescript
// ❌ Старый код
const fee1 = 2.5;
const fee2 = 3.0;
const totalFee = fee1 + fee2;  // 5.5

// Проблемы:
// - Нет проверки результата
// - Может выйти за допустимый диапазон
// - Потеря точности (для Decimal)
```

**Стало: PercentageService**

```typescript
// ✅ Новый код
const fee1 = Percentage.of(2.5);
const fee2 = Percentage.of(3.0);

const totalFeeResult = PercentageService.add(fee1, fee2);
if (totalFeeResult.ok) {
  const totalFee = totalFeeResult.value;  // Percentage(5.5)
  console.log(totalFee.toNumber());  // 5.5
} else {
  console.error('Failed to calculate total fee:', totalFeeResult.error.message);
}

// Преимущества:
// ✅ Валидация результата
// ✅ Явная обработка ошибок
// ✅ Точность через Decimal
```

---

### Было: Manual validation

```typescript
// ❌ Старый код
function validateFee(fee: number): boolean {
  if (fee < 0) {
    console.error('Fee cannot be negative');
    return false;
  }
  if (fee > 5) {
    console.error('Fee exceeds maximum 5%');
    return false;
  }
  return true;
}

const fee = 2.5;
if (!validateFee(fee)) {
  return;
}

// Проблемы:
// - Дублирование логики
// - Нет type safety
// - Плохая обработка ошибок (boolean)
```

**Стало: Rules**

```typescript
// ✅ Новый код
import { Percentage } from '@polymarket/value-objects/percentage';
import { ValidateFeeForTrading } from '@polymarket/value-objects/percentage/rules';

const fee = Percentage.of(2.5);
const validation = ValidateFeeForTrading.check(fee);

if (!validation.ok) {
  console.error('Invalid fee:', validation.error.message);
  console.error('Reason:', validation.error.context?.reason);
  return;
}

// Преимущества:
// ✅ Централизованная логика
// ✅ Type safety
// ✅ Явные ошибки через Result
// ✅ Структурированный контекст
```

---

## Пошаговая миграция

### Шаг 1: Обновление типов

**Было:**

```typescript
interface FeeConfig {
  makerFee: number;
  takerFee: number;
}

function calculateTotalFee(config: FeeConfig): number {
  return config.makerFee + config.takerFee;
}
```

**Стало:**

```typescript
import { Percentage } from '@polymarket/value-objects/percentage';

interface FeeConfig {
  makerFee: Percentage;
  takerFee: Percentage;
}

function calculateTotalFee(config: FeeConfig): Result<Percentage, InvalidPercentageError> {
  return PercentageService.add(config.makerFee, config.takerFee);
}
```

---

### Шаг 2: Обновление создания

**Было:**

```typescript
const fee = 2.5;  // Откуда взялось? Валидно ли?
```

**Стало:**

```typescript
const feeResult = PercentageService.create(2.5);
if (!feeResult.ok) {
  // Обработка ошибки
  return;
}
const fee = feeResult.value;
```

**Или для константных значений:**

```typescript
// Если значение известно и валидно
const fee = Percentage.of(2.5);  // Только для internal использования!
```

---

### Шаг 3: Обновление операций

**Было:**

```typescript
const fee1 = 2.5;
const fee2 = 3.0;
const total = fee1 + fee2;
const doubled = fee1 * 2;
const half = fee1 / 2;
```

**Стало:**

```typescript
const fee1 = Percentage.of(2.5);
const fee2 = Percentage.of(3.0);

// Сложение
const totalResult = PercentageService.add(fee1, fee2);
if (totalResult.ok) {
  const total = totalResult.value;
}

// Умножение
const doubledResult = PercentageService.multiply(fee1, 2);
if (doubledResult.ok) {
  const doubled = doubledResult.value;
}

// Деление
const halfResult = PercentageService.divide(fee1, 2);
if (halfResult.ok) {
  const half = halfResult.value;
}
```

---

### Шаг 4: Обновление валидации

**Было:**

```typescript
function validateFee(fee: number): boolean {
  return fee >= 0 && fee <= 5;
}

const fee = 2.5;
if (!validateFee(fee)) {
  throw new Error('Invalid fee');
}
```

**Стало:**

```typescript
import { ValidateFeeForTrading } from '@polymarket/value-objects/percentage/rules';

const fee = Percentage.of(2.5);
const validation = ValidateFeeForTrading.check(fee);

if (!validation.ok) {
  console.error('Invalid fee:', validation.error.message);
  return;
}
```

---

### Шаг 5: Обновление форматирования

**Было:**

```typescript
const fee = 2.5;
const display = `${fee}%`;  // "2.5%"
const decimal = fee / 100;  // 0.025
```

**Стало:**

```typescript
import { PercentageFormatter } from '@polymarket/value-objects/percentage';

const fee = Percentage.of(2.5);
const display = PercentageFormatter.toPercent(fee);  // "2.50%"
const decimal = fee.toDecimal();  // Decimal(0.025)
const bp = PercentageFormatter.toBasisPoints(fee);  // "250 bp"
```

---

### Шаг 6: Обновление API интеграции

**Было:**

```typescript
// Отправка
await fetch('/api/config', {
  method: 'POST',
  body: JSON.stringify({ fee: 2.5 })
});

// Получение
const response = await fetch('/api/config');
const data = await response.json();
const fee: number = data.fee;  // Нет валидации!
```

**Стало:**

```typescript
import { PercentageSerializer } from '@polymarket/value-objects/percentage';

// Отправка
const fee = Percentage.of(2.5);
const payload = { fee: PercentageSerializer.toJSON(fee) };
await fetch('/api/config', {
  method: 'POST',
  body: JSON.stringify(payload)
});

// Получение
const response = await fetch('/api/config');
const data = await response.json();
const feeResult = PercentageSerializer.fromJSON(data.fee);

if (!feeResult.ok) {
  console.error('Invalid fee from API:', feeResult.error.message);
  return;
}

const fee = feeResult.value;
```

---

## Общие паттерны миграции

### Паттерн 1: Создание из user input

**Было:**

```typescript
function handleFeeInput(input: string): void {
  const fee = parseFloat(input);
  if (isNaN(fee) || fee < 0 || fee > 5) {
    showError('Invalid fee');
    return;
  }
  // Используем fee
}
```

**Стало:**

```typescript
import { PercentageService } from '@polymarket/value-objects/percentage';
import { ValidateFeeForTrading } from '@polymarket/value-objects/percentage/rules';

function handleFeeInput(input: string): void {
  const feeResult = PercentageService.create(input);
  if (!feeResult.ok) {
    showError(`Invalid fee: ${feeResult.error.message}`);
    return;
  }

  const fee = feeResult.value;

  const validation = ValidateFeeForTrading.check(fee);
  if (!validation.ok) {
    showError(`Fee validation failed: ${validation.error.message}`);
    return;
  }

  // Используем fee
}
```

---

### Паттерн 2: Расчёт комиссии от суммы

**Было:**

```typescript
const fee = 2.5;  // 2.5%
const amount = 1000;
const feeAmount = (amount * fee) / 100;  // 25
```

**Стало:**

```typescript
import { Percentage, PercentageService } from '@polymarket/value-objects/percentage';

const fee = Percentage.of(2.5);
const amount = new Decimal(1000);

const feeAmountResult = PercentageService.applyTo(fee, amount);
if (feeAmountResult.ok) {
  const feeAmount = feeAmountResult.value;  // Decimal(25)
}
```

---

### Паттерн 3: Сравнение процентов

**Было:**

```typescript
const fee1 = 2.5;
const fee2 = 3.0;

if (fee1 < fee2) {
  console.log('Fee1 is lower');
}

if (fee1 === fee2) {
  console.log('Same fee');
}
```

**Стало:**

```typescript
const fee1 = Percentage.of(2.5);
const fee2 = Percentage.of(3.0);

if (fee1.isLessThan(fee2)) {
  console.log('Fee1 is lower');
}

if (fee1.equals(fee2)) {
  console.log('Same fee');
}
```

---

### Паттерн 4: Конвертация между представлениями

**Было:**

```typescript
// Процент → дробь
const percent = 50;
const fraction = percent / 100;  // 0.5

// Процент → bp
const bp = percent * 100;  // 5000

// Дробь → процент
const fractionValue = 0.5;
const percentValue = fractionValue * 100;  // 50
```

**Стало:**

```typescript
// Процент → дробь
const pct = Percentage.of(50);
const fraction = pct.toDecimal();  // Decimal(0.5)

// Процент → bp
const bp = pct.toBasisPoints();  // Decimal(5000)

// Дробь → процент
const fractionValue = 0.5;
const pctResult = PercentageService.fromDecimalFraction(fractionValue);
if (pctResult.ok) {
  const percent = pctResult.value;  // Percentage(50)
}

// bp → процент
const bpValue = 5000;
const bpResult = PercentageService.fromBasisPoints(bpValue);
if (bpResult.ok) {
  const percent = bpResult.value;  // Percentage(50)
}
```

---

## Checklist миграции

### Перед миграцией

- [ ] Определить все места использования процентов (number/Decimal)
- [ ] Определить все операции с процентами (сложение, умножение, etc.)
- [ ] Определить все валидации процентов
- [ ] Определить все API endpoints с процентами
- [ ] Подготовить тесты для регрессии

---

### Во время миграции

- [ ] Обновить типы (`number` → `Percentage`)
- [ ] Обновить создание (`create`, `fromDecimalFraction`, `fromBasisPoints`)
- [ ] Обновить операции (`add`, `subtract`, `multiply`, `divide`, `applyTo`)
- [ ] Обновить валидацию (Rules)
- [ ] Обновить форматирование (PercentageFormatter)
- [ ] Обновить сериализацию (PercentageSerializer)
- [ ] Обновить тесты
- [ ] Обновить документацию

---

### После миграции

- [ ] Запустить все тесты
- [ ] Проверить type coverage
- [ ] Проверить обработку ошибок
- [ ] Code review
- [ ] Deploy в staging
- [ ] Мониторинг ошибок
- [ ] Deploy в production

---

## Советы по миграции

### 1. Постепенная миграция

Не нужно мигрировать всё сразу. Начните с одного модуля:

```typescript
// Граница между старым и новым кодом
function legacyCalculateFee(amount: number, feePercent: number): number {
  return (amount * feePercent) / 100;
}

function newCalculateFee(amount: Decimal, fee: Percentage): Result<Decimal, InvalidPercentageError> {
  return PercentageService.applyTo(fee, amount);
}

// Адаптер для совместимости
function calculateFee(amount: number, feePercent: number): number {
  const feeResult = PercentageService.create(feePercent);
  if (!feeResult.ok) {
    throw new Error('Invalid fee');
  }

  const amountDecimal = new Decimal(amount);
  const result = PercentageService.applyTo(feeResult.value, amountDecimal);

  if (!result.ok) {
    throw new Error('Failed to calculate fee');
  }

  return result.value.toNumber();
}
```

---

### 2. Используйте type aliases для плавной миграции

```typescript
// Phase 1: Подготовка
type FeePercent = number;  // Будет заменено на Percentage

interface FeeConfig {
  makerFee: FeePercent;
  takerFee: FeePercent;
}

// Phase 2: Миграция
type FeePercent = Percentage;

// Теперь весь код автоматически использует Percentage
```

---

### 3. Добавьте runtime проверки в переходный период

```typescript
function ensurePercentage(value: number | Percentage): Percentage {
  if (value instanceof Percentage) {
    return value;
  }

  // Старый API - конвертируем
  const result = PercentageService.create(value);
  if (!result.ok) {
    throw new Error(`Invalid percentage: ${value}`);
  }

  return result.value;
}
```

---

### 4. Обновите тесты параллельно

```typescript
// Старый тест
describe('calculateFee', () => {
  it('should calculate fee correctly', () => {
    const fee = 2.5;
    const amount = 1000;
    const result = calculateFee(amount, fee);
    expect(result).toBe(25);
  });
});

// Новый тест
describe('calculateFee', () => {
  it('should calculate fee correctly', () => {
    const fee = Percentage.of(2.5);
    const amount = new Decimal(1000);
    const result = PercentageService.applyTo(fee, amount);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.toNumber()).toBe(25);
    }
  });
});
```

---

## Troubleshooting

### Проблема: "Property 'ok' does not exist on type 'Percentage'"

**Причина:** Пытаетесь использовать Percentage как Result.

**Решение:**

```typescript
// ❌ Неправильно
const fee = Percentage.of(2.5);
if (fee.ok) { ... }

// ✅ Правильно
const feeResult = PercentageService.create(2.5);
if (feeResult.ok) {
  const fee = feeResult.value;
}
```

---

### Проблема: "Cannot assign number to Percentage"

**Причина:** Пытаетесь присвоить number переменной типа Percentage.

**Решение:**

```typescript
// ❌ Неправильно
let fee: Percentage = 2.5;

// ✅ Правильно
const feeResult = PercentageService.create(2.5);
if (feeResult.ok) {
  const fee: Percentage = feeResult.value;
}
```

---

### Проблема: "InvalidPercentageError: OUT_OF_RANGE_HIGH"

**Причина:** Значение превышает MAX_PERCENTAGE (1e6).

**Решение:**

```typescript
// ❌ Неправильно
const huge = PercentageService.create(2000000);  // > 1e6

// ✅ Правильно
const valid = PercentageService.create(1000);  // <= 1e6
```

---

### Проблема: Потеря точности при миграции

**Причина:** Использование toNumber() вместо value().

**Решение:**

```typescript
// ❌ Неправильно (lossy)
const fee = Percentage.of(2.5);
const num = fee.toNumber();  // Может потерять точность

// ✅ Правильно (lossless)
const fee = Percentage.of(2.5);
const decimal = fee.value();  // Decimal (точность сохранена)
```

---

## Заключение

Миграция на Percentage Value Object даёт:

- ✅ **Type safety** — невозможно перепутать процент с числом
- ✅ **Валидацию** — автоматическую и через Rules
- ✅ **Явные ошибки** — через Result<T, E>
- ✅ **Консистентность** — единообразное представление
- ✅ **Читаемость** — явная семантика операций

Следуйте этому руководству для плавной миграции с минимальным риском!
