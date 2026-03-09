# TokenBalanceService API

Публичный API для работы с TokenBalance. Все методы возвращают `Result<TokenBalance, InvalidTokenBalanceError>` или простые типы для проверочных методов.

## Методы

### `create(token, available, reserved, accountId, venueId)`

Создаёт новый TokenBalance из OutcomeToken, available, reserved Quantity, AccountId и VenueId.

```typescript
import { TokenBalanceService } from '@polymarket/value-objects/token-balance';
import { OutcomeToken } from '@polymarket/value-objects/outcome-token';
import { Quantity } from '@polymarket/value-objects/quantity';
import { BinaryOutcome, KnownOnChainProtocols, KnownVenues } from '@polymarket/ids';
import type { OnChainConditionRef, AccountId, VenueId, ChainId, ConditionId } from '@polymarket/ids';
import { parseWalletAddress, accountIdFromWallet } from '@polymarket/ids';
import { isErr } from '@polymarket/result';
import Decimal from 'decimal.js';

const conditionRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
  chainId: 137 as ChainId,
  conditionId: '0x...' as ConditionId
};

const token = OutcomeToken.of(conditionRef, BinaryOutcome.UP);
const parsedAddress = parseWalletAddress('0x1234567890123456789012345678901234567890');
if (!parsedAddress) throw new Error('Invalid wallet address');
const walletAddress = parsedAddress;
const accountId: AccountId = accountIdFromWallet(walletAddress);
const venueId: VenueId = KnownVenues.POLYMARKET;

const result = TokenBalanceService.create(
  token,                          // OutcomeToken
  Quantity.of(new Decimal(100)),  // 100 токенов available
  Quantity.of(new Decimal(20)),   // 20 токенов reserved
  accountId,                      // ID аккаунта владельца
  venueId                         // ID площадки (venue)
);

if (isErr(result)) {
  console.error(result.error.context?.reason);
  return;
}

const balance = result.value;
```

**Возможные ошибки:**

- `INVALID_TOKEN` — token is null or not OutcomeToken instance
- `INVALID_AMOUNT` — available or reserved is null or not Quantity instance
- `INVALID_FORMAT` — accountId or venueId is null
- `NEGATIVE_AVAILABLE` — available < 0
- `NEGATIVE_RESERVED` — reserved < 0
- `NAN` — available или reserved является NaN
- `NON_FINITE` — available или reserved не является finite

---

### `createWithZeroReserved(token, available, accountId, venueId)`

Convenience метод для создания баланса с нулевым reserved.

```typescript
const result = TokenBalanceService.createWithZeroReserved(
  token,
  Quantity.of(new Decimal(100)), // 100 токенов available
  accountId,
  venueId
);

if (result.ok) {
  const balance = result.value;
  console.log(balance.available().value().toNumber()); // 100
  console.log(balance.reserved().value().toNumber());  // 0
}
```

**Возможные ошибки:**

- Те же что и у `create()`, кроме NEGATIVE_RESERVED (reserved всегда 0)

---

### `reserve(balance, qty)`

Резервирует токены из available в reserved.

```typescript
import { TokenBalanceService, TokenBalanceErrorReason } from '@polymarket/value-objects/token-balance';
import { isErr } from '@polymarket/result';

const result = TokenBalanceService.reserve(
  balance,
  Quantity.of(new Decimal(30))
);

if (isErr(result)) {
  if (result.error.context?.reason === TokenBalanceErrorReason.INSUFFICIENT_AVAILABLE) {
    console.log('Недостаточно токенов для резервирования');
  }
  return;
}

const newBalance = result.value;
// available: 70, reserved: 50
```

**Алгоритм:**

1. Проверка суммы (ValidateReserveAmount)
2. available - qty
3. reserved + qty
4. Создание нового TokenBalance

**Возможные ошибки:**

- `INSUFFICIENT_AVAILABLE` — qty > available
- `INVALID_FORMAT` — qty <= 0 или не finite

---

### `unfreezeReserved(balance, qty)`

Освобождает (размораживает) зарезервированные токены обратно в available.

**Использование:** Отмена резервирования, возврат токенов в доступные.

```typescript
import { TokenBalanceService, TokenBalanceErrorReason } from '@polymarket/value-objects/token-balance';
import { isErr } from '@polymarket/result';

const result = TokenBalanceService.unfreezeReserved(
  balance,
  Quantity.of(new Decimal(20))
);

if (isErr(result)) {
  if (result.error.context?.reason === TokenBalanceErrorReason.INSUFFICIENT_RESERVED) {
    console.log('Недостаточно зарезервированных токенов');
  }
  return;
}

const newBalance = result.value;
// available: 120, reserved: 0
```

**Алгоритм:**

1. Проверка суммы (ValidateReleaseAmount)
2. available + qty (токены возвращаются в available)
3. reserved - qty (уменьшаем reserved)
4. Создание нового TokenBalance

**Возможные ошибки:**

- `INSUFFICIENT_RESERVED` — qty > reserved
- `INVALID_FORMAT` — qty <= 0 или не finite

**Примеры использования:**

- Отмена ордера — токены возвращаются в available
- Закрытие позиции без исполнения — возврат токенов

---

### `consumeReserved(balance, qty)`

Списывает (тратит) зарезервированные токены без возврата в available.

**Использование:** Исполнение сделки, расход зарезервированных токенов.

```typescript
import { TokenBalanceService, TokenBalanceErrorReason } from '@polymarket/value-objects/token-balance';
import { isErr } from '@polymarket/result';

const result = TokenBalanceService.consumeReserved(
  balance,
  Quantity.of(new Decimal(30))
);

if (isErr(result)) {
  if (result.error.context?.reason === TokenBalanceErrorReason.INSUFFICIENT_RESERVED) {
    console.log('Недостаточно зарезервированных токенов');
  }
  return;
}

const newBalance = result.value;
// available: не изменился
// reserved: уменьшился на qty
// total: уменьшился на qty (токены потрачены)
```

**Алгоритм:**

1. Проверка суммы (ValidateReleaseAmount)
2. available остаётся без изменений
3. reserved - qty (уменьшаем reserved)
4. Создание нового TokenBalance

**Возможные ошибки:**

- `INSUFFICIENT_RESERVED` — qty > reserved
- `INVALID_FORMAT` — qty <= 0 или не finite

**Примеры использования:**

- Исполнение ордера — токены потрачены на покупку
- Обмен токенов на другой outcome

**Отличие от unfreezeReserved():**

| Метод | available | reserved | total | Сценарий |
| ------- | ----------- | ---------- | ------- | ---------- |
| `unfreezeReserved()` | +qty | -qty | без изменений | Отмена, возврат токенов |
| `consumeReserved()` | без изменений | -qty | -qty | Исполнение, трата токенов |

---

### `updateAvailable(balance, newAvailable)`

Обновляет доступные токены, сохраняя reserved без изменений.

```typescript
const result = TokenBalanceService.updateAvailable(
  balance,
  Quantity.of(new Decimal(150)) // новый available
);

if (result.ok) {
  const newBalance = result.value;
  // available: 150, reserved: 20 (без изменений)
}
```

**Алгоритм:**

1. Создание нового TokenBalance(token, newAvailable, old reserved, accountId, venueId)

**Возможные ошибки:**

- `NEGATIVE_AVAILABLE` — newAvailable < 0
- `INVALID_AMOUNT` — newAvailable is null or not Quantity

---

### `canReserve(balance, qty)`

Проверяет, достаточно ли доступных токенов для резервирования указанного количества.

```typescript
import { expectOk } from '@polymarket/result';

const balance = expectOk(TokenBalanceService.create(
  token,
  Quantity.of(new Decimal(100)),
  Quantity.of(new Decimal(20)),
  accountId,
  venueId
));

// Проверка возможности резервирования
const canReserve1 = TokenBalanceService.canReserve(
  balance,
  Quantity.of(new Decimal(50))
);
console.log(canReserve1); // true

const canReserve2 = TokenBalanceService.canReserve(
  balance,
  Quantity.of(new Decimal(150))
);
console.log(canReserve2); // false

// Граничный случай (available === qty)
const canReserve3 = TokenBalanceService.canReserve(
  balance,
  Quantity.of(new Decimal(100))
);
console.log(canReserve3); // true
```

**Алгоритм:**

1. Сравнение available >= qty
2. Возвращает true если available >= qty

**Возвращает:** `boolean` (не Result!)

**Особенности:**

- ✅ Проверяет только available (reserved не учитывается)
- ✅ Граничный случай: available === qty → true
- ✅ Используется перед reserve() для проверки возможности операции
- ✅ Never throws — всегда возвращает boolean

---

### `equals(balance1, balance2)`

Сравнивает два баланса на точное равенство (strict equality).

```typescript
import { TokenBalanceService } from '@polymarket/value-objects/token-balance';
import { expectOk } from '@polymarket/result';

const balance1 = expectOk(TokenBalanceService.create(
  token,
  Quantity.of(new Decimal(100)),
  Quantity.of(new Decimal(20)),
  accountId,
  venueId
));
const balance2 = expectOk(TokenBalanceService.create(
  token,
  Quantity.of(new Decimal(100)),
  Quantity.of(new Decimal(20)),
  accountId,
  venueId
));
const balance3 = expectOk(TokenBalanceService.create(
  token,
  Quantity.of(new Decimal(101)),
  Quantity.of(new Decimal(20)),
  accountId,
  venueId
));

console.log(TokenBalanceService.equals(balance1, balance2)); // true
console.log(TokenBalanceService.equals(balance1, balance3)); // false
```

**Алгоритм:**

1. Сравнение token через hasSameToken()
2. Сравнение available.equals(other.available)
3. Сравнение reserved.equals(other.reserved)
4. Сравнение accountId === other.accountId
5. Сравнение venueId === other.venueId
6. Возвращает true только если все поля равны (strict equality)

**Возвращает:** `boolean` (не Result!)

**Особенности:**

- ✅ Strict equality — точное совпадение без epsilon
- ✅ Проверяет все поля: token, available, reserved, accountId, venueId
- ✅ Never throws — всегда возвращает boolean

---

### `isZero(balance)`

Проверяет, является ли баланс нулевым (total === 0).

```typescript
import { TokenBalanceService } from '@polymarket/value-objects/token-balance';
import { expectOk } from '@polymarket/result';

const emptyBalance = expectOk(TokenBalanceService.create(
  token,
  Quantity.ZERO,
  Quantity.ZERO,
  accountId,
  venueId
));

console.log(TokenBalanceService.isZero(emptyBalance)); // true

const nonZeroBalance = expectOk(TokenBalanceService.create(
  token,
  Quantity.of(new Decimal(100)),
  Quantity.ZERO,
  accountId,
  venueId
));

console.log(TokenBalanceService.isZero(nonZeroBalance)); // false
```

**Алгоритм:**

1. Проверка balance.isZero()
2. Возвращает true если total === 0

**Возвращает:** `boolean` (не Result!)

**Особенности:**

- ✅ Проверяет total (available + reserved)
- ✅ Never throws — возвращает false для null/undefined
- ✅ Безопасная проверка без исключений

---

### `isPositive(balance)`

Проверяет, является ли баланс положительным (total > 0).

```typescript
import { TokenBalanceService } from '@polymarket/value-objects/token-balance';
import { expectOk } from '@polymarket/result';

const balance = expectOk(TokenBalanceService.create(
  token,
  Quantity.of(new Decimal(100)),
  Quantity.ZERO,
  accountId,
  venueId
));

console.log(TokenBalanceService.isPositive(balance)); // true

const emptyBalance = expectOk(TokenBalanceService.create(
  token,
  Quantity.ZERO,
  Quantity.ZERO,
  accountId,
  venueId
));

console.log(TokenBalanceService.isPositive(emptyBalance)); // false
```

**Алгоритм:**

1. Проверка balance.isPositive()
2. Возвращает true если total > 0

**Возвращает:** `boolean` (не Result!)

**Особенности:**

- ✅ Проверяет total (available + reserved)
- ✅ Never throws — возвращает false для null/undefined
- ✅ Безопасная проверка без исключений

---

## Контракт Never Throw

**Гарантии:**

- ✅ Методы **никогда** не бросают исключения (кроме простых проверочных методов, которые защищены)
- ✅ Все ошибки возвращаются через `Result` (для методов возвращающих Result)
- ✅ Типизированные ошибки через `TokenBalanceErrorReason`
- ✅ Проверочные методы (canReserve, equals, isZero, isPositive) возвращают boolean и никогда не бросают

## Иммутабельность

**Все операции возвращают новый TokenBalance:**

```typescript
import { TokenBalanceService } from '@polymarket/value-objects/token-balance';
import { expectOk } from '@polymarket/result';

const balance1 = expectOk(TokenBalanceService.create(
  token,
  Quantity.of(new Decimal(100)),
  Quantity.of(new Decimal(20)),
  accountId,
  venueId
));
const balance2 = expectOk(TokenBalanceService.reserve(
  balance1,
  Quantity.of(new Decimal(30))
));

// balance1 не изменился!
console.log(balance1.available().value().toNumber()); // 100
console.log(balance2.available().value().toNumber()); // 70
```

## Обработка ошибок

### Exhaustive checking через switch

```typescript
import { TokenBalanceErrorReason } from '@polymarket/value-objects/token-balance';
import { isErr } from '@polymarket/result';

const result = TokenBalanceService.reserve(balance, qty);

if (isErr(result)) {
  switch (result.error.context?.reason) {
    case TokenBalanceErrorReason.INSUFFICIENT_AVAILABLE:
      // Обработка недостаточных токенов
      break;
    case TokenBalanceErrorReason.INVALID_FORMAT:
      // Обработка невалидного формата (qty <= 0 или не finite)
      break;
    // TypeScript проверит, что все cases покрыты
  }
}
```

### Проверка конкретной ошибки

```typescript
if (!result.ok && result.error.context?.reason === TokenBalanceErrorReason.INSUFFICIENT_AVAILABLE) {
  const ctx = result.error.context;
  console.log(`Недостаточно токенов: запрошено ${ctx.requested}, доступно ${ctx.available}`);
}
```

### Использование context

Каждая ошибка содержит контекст с полезной информацией:

```typescript
if (isErr(result)) {
  const ctx = result.error.context;
  console.log('Operation:', ctx.op);              // "reserve"
  console.log('Reason:', ctx.reason);             // "INSUFFICIENT_AVAILABLE"
  console.log('Requested:', ctx.requested);       // "50"
  console.log('Available:', ctx.available);       // "30"
}
```

## Интеграция с QuantityService

TokenBalanceService использует QuantityService для арифметических операций:

```typescript
// Внутри TokenBalanceService.reserve()
const newAvailableResult = this.subtractQuantity(balance.available(), qty);
const newReservedResult = this.addQuantity(balance.reserved(), qty);

// subtractQuantity делегирует QuantityService
// Вызывается внутри wrapOp, поэтому просто передаёт ошибку
private static subtractQuantity(a: Quantity, b: Quantity): Result<Quantity, InvalidTokenBalanceError> {
  const result = QuantityService.subtract(a, b);
  if (isErr(result)) {
    // wrapOp уже добавит context
    return Err(new InvalidTokenBalanceError(result.error.message));
  }
  return result;
}
```
