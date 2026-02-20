# BalanceService API

Публичный API для работы с Balance. Все методы возвращают `Result<Balance, InvalidBalanceError>`.

## Методы

### `create(available, reserved, accountId, venueId)`

Создаёт новый Balance из available и reserved Money, accountId и venueId.

```typescript
import type { AccountId, VenueId, WalletAddress } from '@polymarket/ids';

const accountId: AccountId = {
  kind: 'WALLET',
  address: '0x1234567890123456789012345678901234567890' as WalletAddress
};
const venueId: VenueId = 'POLYMARKET' as VenueId;

const result = BalanceService.create(
  Money.of(new Decimal(10000)), // 10000 units available
  Money.of(new Decimal(2000)),  // 2000 units reserved
  accountId,       // ID аккаунта владельца
  venueId          // ID площадки (venue)
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
const result = BalanceService.reserve(balance, Money.of(new Decimal(3000)));

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

### `unfreezeReserved(balance, amount)`

Освобождает (размораживает) зарезервированные средства обратно в available.

**Использование:** Отмена резервирования, возврат средств в доступные.

```typescript
const result = BalanceService.unfreezeReserved(balance, Money.of(new Decimal(2000)));

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
3. available + amount (средства возвращаются в available)
4. reserved - amount (уменьшаем reserved)
5. Создание нового Balance

**Возможные ошибки:**

- `CURRENCY_MISMATCH` — валюта amount не совпадает с балансом
- `INSUFFICIENT_RESERVED` — amount > reserved
- `INVALID_FORMAT` — amount <= 0 или не finite

**Примеры использования:**

- Отмена ордера — средства возвращаются в available
- Закрытие позиции без исполнения — возврат залога

---

### `consumeReserved(balance, amount)`

Списывает (тратит) зарезервированные средства без возврата в available.

**Использование:** Исполнение сделки, расход зарезервированных средств.

```typescript
const result = BalanceService.consumeReserved(balance, Money.of(new Decimal(3000)));

if (isErr(result)) {
  if (result.error.context?.reason === BalanceErrorReason.INSUFFICIENT_RESERVED) {
    console.log('Недостаточно зарезервированных средств');
  }
  return;
}

const newBalance = result.value;
// available: не изменился
// reserved: уменьшился на amount
// total: уменьшился на amount (средства потрачены)
```

**Алгоритм:**

1. Проверка валюты (ValidateCurrencyMatch)
2. Проверка суммы (ValidateReleaseAmount)
3. available остаётся без изменений
4. reserved - amount (уменьшаем reserved)
5. Создание нового Balance

**Возможные ошибки:**

- `CURRENCY_MISMATCH` — валюта amount не совпадает с балансом
- `INSUFFICIENT_RESERVED` — amount > reserved
- `INVALID_FORMAT` — amount <= 0 или не finite

**Примеры использования:**

- Исполнение ордера — средства потрачены на покупку
- Списание комиссии из зарезервированных средств
- Расход залога при исполнении обязательств

**Отличие от unfreezeReserved():**

| Метод | available | reserved | total | Сценарий |
| ------- | ----------- | ---------- | ------- | ---------- |
| `unfreezeReserved()` | +amount | -amount | без изменений | Отмена, возврат средств |
| `consumeReserved()` | без изменений | -amount | -amount | Исполнение, трата средств |

---

### `updateAvailable(balance, newAvailable)`

Обновляет доступные средства, сохраняя reserved без изменений.

```typescript
const result = BalanceService.updateAvailable(
  balance,
  Money.of(new Decimal(15000)) // новый available
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
import type { AccountId, VenueId, WalletAddress } from '@polymarket/ids';

const accountId: AccountId = {
  kind: 'WALLET',
  address: '0x1234567890123456789012345678901234567890' as WalletAddress
};
const venueId: VenueId = 'POLYMARKET' as VenueId;

const balance1 = expectOk(BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), accountId, venueId));
const balance2 = expectOk(BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), accountId, venueId));
const balance3 = expectOk(BalanceService.create(Money.of(new Decimal(10001)), Money.of(new Decimal(2000)), accountId, venueId));

const equals1Result = BalanceService.equals(balance1, balance2);
console.log(equals1Result.ok && equals1Result.value); // true

const equals2Result = BalanceService.equals(balance1, balance3);
console.log(equals2Result.ok && equals2Result.value); // false
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
import type { AccountId, VenueId, WalletAddress } from '@polymarket/ids';

const accountId: AccountId = {
  kind: 'WALLET',
  address: '0x1234567890123456789012345678901234567890' as WalletAddress
};
const venueId: VenueId = 'POLYMARKET' as VenueId;

const balance = expectOk(BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), accountId, venueId));

// Проверка доступности
const canAfford1 = BalanceService.canAfford(balance, Money.of(new Decimal(5000)));
console.log(canAfford1.ok && canAfford1.value); // true

const canAfford2 = BalanceService.canAfford(balance, Money.of(new Decimal(15000)));
console.log(canAfford2.ok && canAfford2.value); // false

// Граничный случай (available === amount)
const canAfford3 = BalanceService.canAfford(balance, Money.of(new Decimal(10000)));
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
import type { AccountId, VenueId, WalletAddress } from '@polymarket/ids';

const accountId: AccountId = {
  kind: 'WALLET',
  address: '0x1234567890123456789012345678901234567890' as WalletAddress
};
const venueId: VenueId = 'POLYMARKET' as VenueId;

const balance1 = expectOk(BalanceService.create(Money.of(new Decimal(10000)), Money.of(new Decimal(2000)), accountId, venueId));
const balance2 = expectOk(BalanceService.reserve(balance1, Money.of(new Decimal(3000))));

// balance1 не изменился!
console.log(balance1.available().value()); // 10000
console.log(balance2.available().value()); // 7000
```

## Обработка ошибок

### Exhaustive checking через switch

```typescript
const result = BalanceService.reserve(balance, amount);

if (isErr(result)) {
  const reason = result.error.context?.reason;

  switch (reason) {
    case BalanceErrorReason.INSUFFICIENT_FUNDS:
      // Обработка недостаточных средств
      break;
    case BalanceErrorReason.CURRENCY_MISMATCH:
      // Обработка несовпадения валют
      break;
    case BalanceErrorReason.INVALID_FORMAT:
      // Обработка невалидного формата
      break;
    default:
      // Обработка других ошибок
      console.error(`Unexpected error: ${result.error.message}`);
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
const newAvailableResult = MoneyService.subtract(balance.available(), amount);
if (isErr(newAvailableResult)) {
  return rewrap(newAvailableResult, 'reserve', InvalidBalanceError);
}
const newAvailable = newAvailableResult.value;

const newReservedResult = MoneyService.add(balance.reserved(), amount);
if (isErr(newReservedResult)) {
  return rewrap(newReservedResult, 'reserve', InvalidBalanceError);
}
const newReserved = newReservedResult.value;
```
