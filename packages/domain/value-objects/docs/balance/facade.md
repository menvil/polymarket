# BalanceService API

Публичный API для работы с Balance. Все методы возвращают `Result<Balance, InvalidBalanceError>`.

## Методы

### `create(available, reserved)`

Создаёт новый Balance из available и reserved Money.

```typescript
const result = BalanceService.create(
  Money.of(10000), // $100.00 available
  Money.of(2000)   // $20.00 reserved
);

if (isErr(result)) {
  console.error(result.error.context?.reason);
  return;
}

const balance = result.value;
```

**Возможные ошибки:**

- `NEGATIVE_AVAILABLE` — available < 0
- `NEGATIVE_RESERVED` — reserved < 0
- `CURRENCY_MISMATCH` — разные валюты (только если Money будет поддерживать несколько валют)

---

### `reserve(balance, amount)`

Резервирует средства из available в reserved.

```typescript
const result = BalanceService.reserve(balance, Money.of(3000));

if (isErr(result)) {
  if (result.error.context?.reason === BalanceErrorReason.INSUFFICIENT_FUNDS) {
    console.log('Недостаточно средств для резервирования');
  }
  return;
}

const newBalance = result.value;
// available: 7000, reserved: 5000
```

**Алгоритм:**

1. Проверка валюты (ValidateCurrencyMatch)
2. Проверка суммы (ValidateReserveAmount)
3. available - amount
4. reserved + amount
5. Создание нового Balance

**Возможные ошибки:**

- `CURRENCY_MISMATCH` — валюта amount не совпадает с балансом
- `INSUFFICIENT_FUNDS` — amount > available
- `INVALID_FORMAT` — amount <= 0 или не finite

---

### `release(balance, amount)`

Освобождает зарезервированные средства обратно в available.

```typescript
const result = BalanceService.release(balance, Money.of(2000));

if (isErr(result)) {
  if (result.error.context?.reason === BalanceErrorReason.INSUFFICIENT_RESERVED) {
    console.log('Недостаточно зарезервированных средств');
  }
  return;
}

const newBalance = result.value;
// available: 12000, reserved: 0
```

**Алгоритм:**

1. Проверка валюты (ValidateCurrencyMatch)
2. Проверка суммы (ValidateReleaseAmount)
3. available + amount
4. reserved - amount
5. Создание нового Balance

**Возможные ошибки:**

- `CURRENCY_MISMATCH` — валюта amount не совпадает с балансом
- `INSUFFICIENT_RESERVED` — amount > reserved
- `INVALID_FORMAT` — amount <= 0 или не finite

---

### `updateAvailable(balance, newAvailable)`

Обновляет доступные средства, сохраняя reserved без изменений.

```typescript
const result = BalanceService.updateAvailable(
  balance,
  Money.of(15000) // новый available
);

if (result.ok) {
  const newBalance = result.value;
  // available: 15000, reserved: 2000 (без изменений)
}
```

**Алгоритм:**

1. Проверка валюты (ValidateCurrencyMatch)
2. Создание нового Balance(newAvailable, old reserved)

**Возможные ошибки:**

- `CURRENCY_MISMATCH` — валюта newAvailable не совпадает с балансом
- `NEGATIVE_AVAILABLE` — newAvailable < 0

---

### `equals(balance1, balance2)`

Сравнивает два баланса на точное равенство (strict equality, без epsilon).

```typescript
const balance1 = expectOk(BalanceService.create(Money.of(10000), Money.of(2000)));
const balance2 = expectOk(BalanceService.create(Money.of(10000), Money.of(2000)));
const balance3 = expectOk(BalanceService.create(Money.of(10001), Money.of(2000)));

const equals1 = BalanceService.equals(balance1, balance2);
console.log(equals1.ok && equals1.value); // true

const equals2 = BalanceService.equals(balance1, balance3);
console.log(equals2.ok && equals2.value); // false
```

**Алгоритм:**

1. Проверка совпадения валют (balance1.currency === balance2.currency)
2. Сравнение available через MoneyService.equals()
3. Сравнение reserved через MoneyService.equals()
4. Возвращает true только если оба поля равны (strict equality)

**Возможные ошибки:**

- `CURRENCY_MISMATCH` — валюты балансов не совпадают

**Особенности:**

- ✅ Strict equality — точное совпадение без epsilon
- ✅ Проверяет available И reserved
- ✅ Использует MoneyService.equals() внутри

---

### `canAfford(balance, amount)`

Проверяет, достаточно ли доступных средств для указанной суммы.

```typescript
const balance = expectOk(BalanceService.create(Money.of(10000), Money.of(2000)));

// Проверка доступности
const canAfford1 = BalanceService.canAfford(balance, Money.of(5000));
console.log(canAfford1.ok && canAfford1.value); // true

const canAfford2 = BalanceService.canAfford(balance, Money.of(15000));
console.log(canAfford2.ok && canAfford2.value); // false

// Граничный случай (available === amount)
const canAfford3 = BalanceService.canAfford(balance, Money.of(10000));
console.log(canAfford3.ok && canAfford3.value); // true
```

**Алгоритм:**

1. Проверка совпадения валют (balance.currency === amount.currency)
2. Сравнение available >= amount через MoneyService.isGreaterThanOrEqual()
3. Возвращает true если available >= amount

**Возможные ошибки:**

- `CURRENCY_MISMATCH` — валюта amount не совпадает с балансом

**Особенности:**

- ✅ Проверяет только available (reserved не учитывается)
- ✅ Граничный случай: available === amount → true
- ✅ Используется перед reserve() для проверки возможности операции

---

## Контракт Never Throw

**Гарантии:**

- ✅ Методы **никогда** не бросают исключения
- ✅ Все ошибки возвращаются через `Result`
- ✅ Типизированные ошибки через `BalanceErrorReason`

## Иммутабельность

**Все операции возвращают новый Balance:**

```typescript
const balance1 = expectOk(BalanceService.create(Money.of(10000), Money.of(2000)));
const balance2 = expectOk(BalanceService.reserve(balance1, Money.of(3000)));

// balance1 не изменился!
console.log(balance1.available().value()); // 10000
console.log(balance2.available().value()); // 7000
```

## Обработка ошибок

### Exhaustive checking через switch

```typescript
const result = BalanceService.reserve(balance, amount);

if (isErr(result)) {
  switch (result.error.context?.reason) {
    case BalanceErrorReason.INSUFFICIENT_FUNDS:
      // Обработка недостаточных средств
      break;
    case BalanceErrorReason.CURRENCY_MISMATCH:
      // Обработка несовпадения валют
      break;
    case BalanceErrorReason.INVALID_FORMAT:
      // Обработка невалидного формата
      break;
    // TypeScript проверит, что все cases покрыты
  }
}
```

### Проверка конкретной ошибки

```typescript
if (!result.ok && result.error.context?.reason === BalanceErrorReason.INSUFFICIENT_FUNDS) {
  const ctx = result.error.context;
  console.log(`Недостаточно средств: запрошено ${ctx.requested}, доступно ${ctx.available}`);
}
```

### Использование context

Каждая ошибка содержит контекст с полезной информацией:

```typescript
if (isErr(result)) {
  const ctx = result.error.context;
  console.log('Operation:', ctx.op);              // "reserve"
  console.log('Reason:', ctx.reason);             // "INSUFFICIENT_FUNDS"
  console.log('Requested:', ctx.requested);       // "5000"
  console.log('Available:', ctx.available);       // "3000"
  console.log('Currency:', ctx.currency);         // "USDC"
}
```

## Интеграция с MoneyService

BalanceService использует MoneyService для арифметических операций:

```typescript
// Внутри BalanceService.reserve()
const newAvailableResult = this.subtractMoney(balance.available(), amount);
const newReservedResult = this.addMoney(balance.reserved(), amount);

// subtractMoney делегирует MoneyService
private static subtractMoney(a: Money, b: Money): Result<Money, InvalidBalanceError> {
  const result = MoneyService.subtract(a, b);
  if (isErr(result)) {
    return Err(new InvalidBalanceError(result.error.message, {
      context: { reason: BalanceErrorReason.INVALID_FORMAT, ... }
    }));
  }
  return Ok(result.value);
}
```
