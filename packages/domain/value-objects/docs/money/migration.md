# Миграция на Money Value Object

> Руководство по переходу на новый Money API

## Содержание

1. [Обзор изменений](#обзор-изменений)
2. [Пошаговая миграция](#пошаговая-миграция)
3. [Breaking Changes](#breaking-changes)
4. [Чеклист миграции](#чеклист-миграции)

---

## Обзор изменений

### Что изменилось

**Старый подход:**
- Money бросал исключения
- Отсутствие явной обработки ошибок
- Прямое использование конструктора

**Новый подход:**
- MoneyService возвращает `Result<T, E>`
- Явная обработка всех ошибок через Result
- Единая точка входа (Facade)

---

## Пошаговая миграция

### Шаг 1: Изменить импорты

**Было:**

```typescript
import { Money } from '@polymarket/value-objects';
```

**Стало:**

```typescript
import { Money, MoneyService } from '@polymarket/value-objects/money';
```

---

### Шаг 2: Заменить создание Money

**Было:**

```typescript
// Создание через статические методы (конструктор приватный)
const money = Money.of(100);           // Валюта по умолчанию: 'USDC'
const money2 = Money.of(100, 'MATIC'); // Указать валюту
const money3 = Money.fromDecimal(new Decimal('100.5'));
const money4 = Money.zero();           // Money(0)
```

**Стало:**

```typescript
// Возвращает Result
const result = MoneyService.create(100);
if (!result.ok) {
  // Обработка ошибки
  console.error(result.error.message);
  return;
}
const money = result.value;
```

---

### Шаг 3: Обновить арифметические операции

**Было:**

```typescript
// Нет явной обработки ошибок
const sum = money1.add(money2);  // Может бросить
const diff = money1.subtract(money2);
```

**Стало:**

```typescript
// Через MoneyService с Result
const sumResult = MoneyService.add(money1, money2);
if (!sumResult.ok) {
  // Обработка ошибки (CurrencyMismatch, Overflow)
  console.error(sumResult.error.message);
  return;
}
const sum = sumResult.value;

const diffResult = MoneyService.subtract(money1, money2);
if (!diffResult.ok) {
  console.error(diffResult.error.message);
  return;
}
const diff = diffResult.value;
```

---

### Шаг 4: Обновить обработку ошибок

**Было:**

```typescript
try {
  const money = new Money(userInput);
  processPayment(money);
} catch (error) {
  // Перехват всех исключений
  console.error('Failed to create money');
}
```

**Стало:**

```typescript
const result = MoneyService.create(userInput);
if (!result.ok) {
  // Типизированная обработка ошибок
  const reason = result.error.context?.reason;

  switch (reason) {
    case 'INVALID_FORMAT':
      showError('Please enter a valid number');
      break;
    case 'EXCEEDS_MAX_AMOUNT':
      showError('Amount is too large');
      break;
    default:
      showError('Invalid amount');
  }
  return;
}

const money = result.value;
processPayment(money);
```

---

## Breaking Changes

### 1. Удалены методы арифметики из Money

**Было:**

```typescript
money1.add(money2)
money1.subtract(money2)
money1.multiply(factor)
money1.divide(divisor)
```

**Стало:**

```typescript
MoneyService.add(money1, money2)
MoneyService.subtract(money1, money2)
MoneyService.multiply(money1, factor)
MoneyService.divide(money1, divisor)
```

**Причина:** Арифметика в Facade для консистентного Result API.

---

### 2. MoneyService.create не бросает исключений

**Было:**

```typescript
try {
  const money = new Money(value);
} catch (e) {
  // handle
}
```

**Стало:**

```typescript
const result = MoneyService.create(value);
if (!result.ok) {
  // handle result.error
}
```

**Причина:** Явная обработка ошибок через Result.

---

### 3. Изменён формат ошибок

**Было:**

```typescript
// Generic Error
throw new Error('Invalid money amount');
```

**Стало:**

```typescript
// Типизированные ошибки с контекстом
InvalidMoneyError {
  context: {
    op: 'create',
    value: "abc",
    reason: 'INVALID_FORMAT'
  }
}
```

**Причина:** Больше информации для диагностики и обработки.

---

## Чеклист миграции

### Перед началом

- [ ] Убедитесь что используете TypeScript (для type safety)
- [ ] Обновите зависимости: `@polymarket/value-objects`, `@polymarket/errors`, `@polymarket/result`
- [ ] Прочитайте документацию: [README](./README.md), [Architecture](./architecture.md)

### Код

- [ ] Обновите импорты на `@polymarket/value-objects/money`
- [ ] Замените `new Money()` на `MoneyService.create()`
- [ ] Замените методы арифметики на `MoneyService.*`
- [ ] Добавьте обработку Result для всех операций
- [ ] Обновите error handling на типизированные ошибки

### Тесты

- [ ] Обновите моки для MoneyService
- [ ] Проверьте тесты на арифметические операции
- [ ] Добавьте тесты для error cases
- [ ] Проверьте покрытие тестами (должно остаться >= текущего)

### Запуск

- [ ] Прогоните все тесты: `npm test`
- [ ] Прогоните линтер: `npm run lint`
- [ ] Прогоните typecheck: `npm run typecheck`
- [ ] Протестируйте в dev окружении

---

## Примеры миграции

### До миграции

```typescript
import { Money } from '@polymarket/value-objects';

class PaymentService {
  processPayment(amount: number) {
    try {
      const money = new Money(amount);
      const fee = money.multiply(0.002);  // 0.2% fee
      const total = money.add(fee);

      return { success: true, total };
    } catch (error) {
      return { success: false, error: 'Invalid amount' };
    }
  }
}
```

### После миграции

```typescript
import { Money, MoneyService } from '@polymarket/value-objects/money';
import { InvalidMoneyError } from '@polymarket/errors';

class PaymentService {
  processPayment(amount: number) {
    // Создание Money через Service
    const moneyResult = MoneyService.create(amount);
    if (!moneyResult.ok) {
      return {
        success: false,
        error: this.formatError(moneyResult.error)
      };
    }

    const money = moneyResult.value;

    // Вычисление комиссии
    const feeResult = MoneyService.multiply(money, 0.002);
    if (!feeResult.ok) {
      return {
        success: false,
        error: 'Failed to calculate fee'
      };
    }

    const fee = feeResult.value;

    // Вычисление итога
    const totalResult = MoneyService.add(money, fee);
    if (!totalResult.ok) {
      return {
        success: false,
        error: 'Failed to calculate total'
      };
    }

    return { success: true, total: totalResult.value };
  }

  private formatError(error: InvalidMoneyError): string {
    const reason = error.context?.reason;

    switch (reason) {
      case 'INVALID_FORMAT':
        return 'Please enter a valid number';
      case 'EXCEEDS_MAX_AMOUNT':
        return 'Amount is too large';
      default:
        return 'Invalid amount';
    }
  }
}
```

---

## Заключение

Миграция на новый Money API:
- ✅ Делает код более безопасным (Result<T, E>)
- ✅ Улучшает обработку ошибок (типизированные ошибки)
- ✅ Упрощает тестирование (явные контракты)
- ✅ Совместим с Price и Quantity (единый стиль)

Следуйте чеклисту и примерам для плавной миграции.
