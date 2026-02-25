# Market Entity

## Обзор

Market — неизменяемая доменная сущность, представляющая бинарный рынок предсказаний в системе Polymarket.

## Почему так сделано?

### 1. Immutability через `expirationMs: number`

**Проблема**: `expirationDate: Date` — мутабельный объект. Внешний код мог бы получить ссылку и изменить дату:

```typescript
// Опасно в старой версии:
const d = market.expirationDate;
d.setFullYear(2099); // изменяет состояние market!
```

**Решение**: хранить `_expirationMs: number`, а getter `expirationDate` возвращает `new Date(this._expirationMs)` — копию. Два вызова возвращают разные объекты с одинаковым временем.

### 2. `MarketState` discriminated union

**Проблема**: Старые поля `status: string` + `resolvedOutcomeIndex: number | null` допускали невозможные состояния:

```typescript
// Компилятор пропускал это без ошибок:
{ status: 'ACTIVE', resolvedOutcomeIndex: 0 } // ← невозможное состояние!
```

**Решение**: Discriminated union — `resolvedOutcomeIndex` существует ТОЛЬКО в состоянии RESOLVED:

```typescript
type MarketState =
  | { status: 'ACTIVE' }
  | { status: 'CLOSED' }
  | { status: 'RESOLVED'; resolvedOutcomeIndex: 0 | 1 }; // только здесь!
```

### 3. Lifecycle guards без Result

**Проблема**: `close()` возвращал `Result<Market>`, хотя вызов `close()` на закрытом рынке — это ошибка программиста, не пользователя.

**Решение**: `close()` и `resolve()` бросают `MarketLifecycleError` (не возвращают Result). Это сигнализирует: "ты вызвал метод неправильно, это баг в коде".

### 4. Branded types для IDs

**Проблема**: `id: string` позволял передать любую строку. Ошибки на уровне типов невозможны:

```typescript
const orderId = 'order-123';
doSomethingWithMarket(orderId); // TypeScript не поймает!
```

**Решение**: `MarketId`, `MarketSlug`, `OutcomeTokenId` — branded types, которые TypeScript различает на уровне типизации.

### 5. `isExpiredAt(nowMs)` для тестируемости

**Проблема**: `isExpired()` использовал `Date.now()` — нетестируемо.

**Решение**: Основной метод `isExpiredAt(nowMs)` принимает время как параметр. `isExpired()` — convenience wrapper для продакшн-кода.

### 6. Вынос URL/JSON в `MarketViewModel`

**Проблема**: `marketUrl`, `toJSON`, `fromJSON` в доменной сущности нарушают принцип DDD — домен не должен знать о presentation-деталях.

**Решение**: `MarketViewModel` — статический класс для всей presentation/serialization логики.

---

## Структура

```
packages/domain/entities/market/
└── src/
    ├── Market.ts                    # Entity
    ├── value-objects/
    │   ├── MarketId.ts              # Branded type
    │   ├── MarketSlug.ts            # URL-safe branded type
    │   ├── OutcomeTokenId.ts        # Branded type
    │   ├── MarketStatus.ts          # Строковые литералы
    │   ├── MarketState.ts           # Discriminated union + type guards
    │   └── index.ts
    ├── errors/
    │   └── MarketErrors.ts          # MarketValidationError, MarketLifecycleError
    ├── view/
    │   └── MarketViewModel.ts       # URL, toJSON, fromJSON
    └── index.ts
```

---

## Жизненный цикл

```
ACTIVE → CLOSED → RESOLVED
```

| Переход | Метод | Guard |
|---------|-------|-------|
| ACTIVE → CLOSED | `market.close()` | Бросает `MarketLifecycleError` если не ACTIVE |
| CLOSED → RESOLVED | `market.resolve(0\|1)` | Бросает `MarketLifecycleError` если не CLOSED |

---

## Примеры использования

### Создание рынка

```typescript
import { Market, MarketState, asMarketId, parseMarketSlug, parseOutcomeTokenId } from '@polymarket/market';

const result = Market.create({
  id: asMarketId('market-abc'),
  slug: parseMarketSlug('will-trump-win-2024')!,
  question: 'Will Trump win the 2024 election?',
  outcomeNames: ['Yes', 'No'],
  outcomeTokenIds: [
    parseOutcomeTokenId('token-yes-123')!,
    parseOutcomeTokenId('token-no-456')!,
  ],
  expirationMs: Date.parse('2024-11-05T00:00:00Z'),
  state: MarketState.active(),
});

if (result.ok) {
  const market = result.value;
  console.log(market.canTrade()); // true (если не истёк)
}
```

### Lifecycle переходы

```typescript
const closed = market.close();       // ACTIVE → CLOSED
const resolved = closed.resolve(0);  // CLOSED → RESOLVED (YES победил)

// Lifecycle guard:
try {
  market.resolve(0); // throws MarketLifecycleError: "Call close() first"
} catch (e) {
  if (MarketLifecycleError.is(e)) {
    console.log(e.context?.currentStatus); // 'ACTIVE'
  }
}
```

### Serialization (через MarketViewModel)

```typescript
import { MarketViewModel } from '@polymarket/market';

const url = MarketViewModel.getMarketUrl(market);
// → 'https://polymarket.com/event/will-trump-win-2024'

const json = MarketViewModel.toJSON(market);
const restored = MarketViewModel.fromJSON(json);
```

### Тестируемость без Date.now()

```typescript
const fixedTime = 1_000_000;
const market = Market.create({ ..., expirationMs: fixedTime }).value!;

// Детерминированные тесты:
expect(market.isExpiredAt(500_000)).toBe(false);
expect(market.isExpiredAt(1_000_000)).toBe(true);
expect(market.timeToExpiryAt(800_000)).toBe(200_000);
```

---

## MarketState — discriminated union

```typescript
// Конструкторы
const active   = MarketState.active();
const closed   = MarketState.closed();
const resolved = MarketState.resolved(0); // YES | resolved(1) // NO

// Type guards с сужением типов
if (isResolved(market.state)) {
  // TypeScript знает: market.state.resolvedOutcomeIndex: 0 | 1
  console.log(market.state.resolvedOutcomeIndex);
}

// Проверка допустимых переходов
canTransition(MarketState.active(), 'CLOSED');   // → true
canTransition(MarketState.active(), 'RESOLVED'); // → false
```
