# Market Entity

## Обзор

Market — неизменяемая доменная сущность, представляющая бинарный рынок предсказаний в системе Polymarket.

## Структура пакета

```
packages/domain/entities/market/
└── src/
    ├── Market.ts                    # Entity (FSM + lifecycle)
    ├── MarketNotifications.ts       # Notification events (не event sourcing)
    ├── MarketTradingPolicy.ts       # TradingState + бизнес-правила операций
    ├── value-objects/
    │   ├── MarketSlug.ts            # URL-safe branded type (a-z0-9-)
    │   ├── MarketStatus.ts          # 'ACTIVE' | 'CLOSED' | 'RESOLVED'
    │   ├── MarketState.ts           # Discriminated union + FSM-переходы + type guards
    │   └── index.ts
    ├── view/
    │   ├── MarketSnapshot.ts        # Plain-object тип для сериализации
    │   ├── MarketParser.ts          # Реконструкция Market из raw данных
    │   └── MarketViewModel.ts       # Presentation: URL, toSnapshot
    └── index.ts
```

> **Branded types из других пакетов:**
> - `MarketId` — из `@polymarket/ids`
> - `OutcomeToken` — из `@polymarket/value-objects/outcome-token`
> - Ошибки — из `@polymarket/errors/market` (re-exported)

---

## Почему так сделано?

### 1. Immutability через `expirationMs: number`

**Проблема**: `expirationDate: Date` — мутабельный объект. Внешний код мог изменить дату через ссылку.

**Решение**: хранить `_expirationMs: number`, getter `expirationDate` возвращает `new Date(...)` — копию каждый раз.

### 2. `MarketState` discriminated union

**Проблема**: `status: string` + `resolvedOutcomeIndex: number | null` допускали невозможные состояния.

**Решение**: Discriminated union — `resolvedOutcomeIndex` существует ТОЛЬКО в `RESOLVED`:

```typescript
type MarketState =
  | { status: 'ACTIVE' }
  | { status: 'CLOSED' }
  | { status: 'RESOLVED'; resolvedOutcomeIndex: 0 | 1 }; // только здесь!
```

### 3. FSM в `MarketState` namespace, не в Entity

**Проблема**: Entity знала правила FSM-переходов — нарушение SRP.

**Решение**: `MarketState.close(state)` и `MarketState.resolve(state, index)` содержат всю логику переходов. Entity делегирует:

```typescript
// В Market.close():
const nextState = MarketState.close(this.state, { marketId: this.id });
// ↑ MarketState знает что можно, что нельзя — Market не знает
```

### 4. Expiration — ответственность `MarketTradingPolicy`

**Проблема**: Архитектурная неопределённость — где проверяется истечение срока? В entity или снаружи?

**Решение**: `Market` — только FSM. Бизнес-правила (когда именно допустим переход по времени) — в `MarketTradingPolicy`:

| Вопрос | Ответственный |
|--------|--------------|
| `ACTIVE → CLOSED` допустим? (FSM) | `MarketState.close()` |
| Рынок уже истёк? (query) | `market.isExpiredAt(nowMs)` |
| В каком торговом состоянии рынок? (policy) | `MarketTradingPolicy.getTradingState(market, nowMs)` |
| Можно ли досрочно закрыть? (policy) | `MarketTradingPolicy.evaluateForceClose(market)` |

### 5. Lifecycle методы бросают, не возвращают Result

`close()` и `resolve()` бросают конкретные подклассы `MarketLifecycleError`. Это сигнализирует: "ты вызвал метод в неверном состоянии — это баг в коде".

```
MarketLifecycleError
├── MarketAlreadyClosedError     (close() на CLOSED/RESOLVED)
├── MarketAlreadyResolvedError   (resolve() на RESOLVED, close() на RESOLVED)
└── MarketInvalidTransitionError (resolve() на ACTIVE — нужно сначала close())
```

### 6. Notification Events (Outbox pattern)

`close(nowMs)` и `resolve(index, nowMs)` эмитируют уведомления в буфер. Application-слой вызывает `pullNotifications()` и публикует в event bus.

```typescript
const closed = market.close(Date.now());
const notifications = closed.pullNotifications(); // [MarketClosedNotification]
await eventBus.publish(notifications);
```

Типы именуются с суффиксом `Notification` — явное разграничение с event-sourcing events.
Общий тип: `MarketNotification` (discriminated union).

### 7. TradingState — решения вместо boolean-проверок

`MarketTradingPolicy.getTradingState(market, nowMs)` возвращает одно из четырёх состояний вместо 3–4 отдельных boolean-вызовов:

```typescript
type TradingState = 'TRADING' | 'EXPIRED' | 'CLOSED' | 'RESOLVED'
```

Exhaustive switch гарантирует покрытие всех состояний на уровне компилятора.

### 8. Parser → Snapshot → Aggregate pipeline

**Проблема**: Если `MarketParser.from(raw)` сразу возвращает `Market`, он знает доменные инварианты (distinct tokens и т.д.) — нарушение SRP. Parser должен только валидировать форму данных.

**Решение**: `MarketSnapshot` — доменно-типизированный data carrier (`MarketId`, `OutcomeToken`, `MarketState`, `expirationMs: number`). Parser делает всю конвертацию, `fromSnapshot()` = `Market.create(snapshot)`.

| Шаг | Метод | Ответственность |
|-----|-------|-----------------|
| 1 | `MarketParser.from(raw)` | `unknown → Result<MarketSnapshot>` — валидация + конвертация в доменные типы |
| 2 | `Market.fromSnapshot(snapshot)` | `MarketSnapshot → Result<Market>` — доменные инварианты через create() |
| — | `MarketViewModel.toSnapshot(market)` | `Market → MarketSnapshot` — тривиальное копирование полей |

```
raw JSON
  ↓ MarketParser.from()          ← валидация структуры + конвертация в доменные типы
MarketSnapshot (доменные типы)
  ↓ Market.fromSnapshot()        ← применение доменных инвариантов (= create())
Market

// Round-trip (in-memory, без MarketParser):
Market
  ↓ MarketViewModel.toSnapshot() ← тривиальное копирование полей
MarketSnapshot (доменные типы)
  ↓ Market.fromSnapshot()        ← применение доменных инвариантов (= create())
Market
```

---

## Жизненный цикл

```
ACTIVE → CLOSED → RESOLVED
```

| Переход | Entity метод | Что бросает |
|---------|-------------|------------|
| ACTIVE → CLOSED | `market.close(nowMs)` | `MarketAlreadyClosedError`, `MarketAlreadyResolvedError` |
| CLOSED → RESOLVED | `market.resolve(index, nowMs)` | `MarketAlreadyResolvedError`, `MarketInvalidTransitionError` |

---

## Примеры использования

### Создание рынка

```typescript
import { Market, MarketState, unsafeMarketId, parseMarketSlug } from '@polymarket/market';
import { OutcomeToken, BinaryOutcome } from '@polymarket/value-objects/outcome-token';

const conditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF',
  chainId: 137,
  conditionId: '0xabc...',
};

const result = Market.create({
  id: unsafeMarketId('market-abc'),
  slug: parseMarketSlug('will-trump-win-2024')!,
  question: 'Will Trump win the 2024 election?',
  outcomes: [
    { token: OutcomeToken.of(conditionRef, BinaryOutcome.UP), index: 0, name: 'Yes' },
    { token: OutcomeToken.of(conditionRef, BinaryOutcome.DOWN), index: 1, name: 'No' },
  ],
  expirationMs: Date.parse('2024-11-05T00:00:00Z'),
  state: MarketState.active(),
});

if (result.ok) {
  const market = result.value;
  console.log(market.id, market.state.status); // 'market-abc', 'ACTIVE'
}
```

### Policy: торговые решения через TradingState

```typescript
import { MarketTradingPolicy } from '@polymarket/market';

const now = Date.now();

// Единственная точка входа для торговых решений:
switch (MarketTradingPolicy.getTradingState(market, now)) {
  case 'TRADING':
    await orderService.accept(order);
    break;
  case 'EXPIRED':
    // рынок активен, но истёк — пора закрывать
    const closed = market.close(now);
    await eventBus.publish(closed.pullNotifications());
    break;
  case 'CLOSED':
    // ждём результата от оракула
    break;
  case 'RESOLVED':
    await settlement.process(market);
    break;
}

// Досрочное закрытие (admin/dispute — без проверки expiration)
const decision = MarketTradingPolicy.evaluateForceClose(market);
if (decision.allowed) {
  const closed = market.close(now);
  await eventBus.publish(closed.pullNotifications());
} else {
  logger.warn('Force-close rejected', { reason: decision.reason });
}
```

### Lifecycle переходы

```typescript
import {
  MarketAlreadyClosedError,
  MarketInvalidTransitionError,
} from '@polymarket/errors/market';

const now = Date.now();
const closed = market.close(now);     // ACTIVE → CLOSED
const resolved = closed.resolve(0, now); // CLOSED → RESOLVED

// FSM guard:
try {
  market.resolve(0, now); // throws: нельзя resolve из ACTIVE
} catch (e) {
  if (e instanceof MarketInvalidTransitionError) {
    console.log(e.message); // 'Cannot resolve an active market. Call close() first.'
    console.log(e.context?.currentStatus); // 'ACTIVE'
  }
}
```

### Notifications (Outbox pattern)

```typescript
const now = Date.now();

// close() эмитирует MarketClosedNotification
const closed = market.close(now);
const closeNotifications = closed.pullNotifications();
// [{ type: 'MARKET_CLOSED', marketId, slug, occurredAt: now }]

// resolve() эмитирует MarketResolvedNotification
const resolved = closed.resolve(0, now);
const resolveNotifications = resolved.pullNotifications();
// [{ type: 'MARKET_RESOLVED', marketId, slug, resolvedOutcomeIndex: 0, occurredAt: now }]

// pullNotifications() очищает буфер
resolved.pullNotifications(); // []

// create() и Market.fromSnapshot() НЕ эмитируют уведомлений (восстановление ≠ бизнес-событие)
```

### Сериализация и реконструкция

```typescript
import { Market, MarketViewModel, MarketParser } from '@polymarket/market';

// Market → snapshot (для БД / API / Redis)
const snapshot = MarketViewModel.toSnapshot(market);
await db.save(snapshot);

// snapshot → Market (двухэтапный pipeline)
const raw = await db.load(id);

// Шаг 1: валидация структуры
const snapshotResult = MarketParser.from(raw);
if (!snapshotResult.ok) {
  logger.error('Corrupt market data', { error: snapshotResult.error.message });
  return;
}

// Шаг 2: реконструкция domain entity
const marketResult = Market.fromSnapshot(snapshotResult.value);
if (marketResult.ok) {
  console.log(marketResult.value.state.status); // 'ACTIVE'
}

// URL
const url = MarketViewModel.getMarketUrl(market);
// → 'https://polymarket.com/event/will-trump-win-2024'
```

### Тестируемость без `Date.now()`

```typescript
// Всё детерминировано — nowMs всегда явный параметр
const EXPIRY = 1_000_000;
const market = Market.create({ ..., expirationMs: EXPIRY }).value!;

// Queries:
expect(market.isExpiredAt(500_000)).toBe(false);
expect(market.isExpiredAt(1_000_000)).toBe(true);
expect(market.timeToExpiryAt(800_000)).toBe(200_000);

// Policy (nowMs явно):
expect(MarketTradingPolicy.getTradingState(market, 500_000)).toBe('TRADING');
expect(MarketTradingPolicy.getTradingState(market, 1_000_000)).toBe('EXPIRED');

// Notifications (nowMs явно):
const closed = market.close(1_000_000);
expect(closed.pullNotifications()[0].occurredAt).toBe(1_000_000);
```

---

## MarketState — FSM namespace

```typescript
import { MarketState, isActive, isClosed, isResolved } from '@polymarket/market';

// Конструкторы
const active   = MarketState.active();
const closed   = MarketState.closed();
const resolved = MarketState.resolved(0); // 0 = YES, 1 = NO

// FSM-переходы (бросают при нарушении)
const next  = MarketState.close(active, { marketId: 'market-abc' });
const final = MarketState.resolve(next, 0, { marketId: 'market-abc' });

// Type guards с сужением типов
if (isResolved(market.state)) {
  // TypeScript знает: market.state.resolvedOutcomeIndex: 0 | 1
  console.log(market.state.resolvedOutcomeIndex);
}
```

---

## Тестовое покрытие

| Файл | Statements | Branches | Functions | Lines |
|------|-----------|----------|-----------|-------|
| Market.ts | 100% | 100% | 100% | 100% |
| MarketTradingPolicy.ts | 100% | 100% | 100% | 100% |
| MarketNotifications.ts | — (types only) | — | — | — |
| MarketState.ts | 100% | 100% | 100% | 100% |
| MarketParser.ts | 100% | 100% | 100% | 100% |
| MarketViewModel.ts | 100% | 100% | 100% | 100% |

7 тестовых наборов, 137 тестов.
