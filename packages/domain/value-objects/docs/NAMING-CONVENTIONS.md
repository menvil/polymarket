# Naming Conventions в Error Handling

## Почему `serviceName`, а не `className`?

### 1. Семантическая точность

**`serviceName`** - более точное название, потому что:

```typescript
// Это НЕ просто класс - это SERVICE (Facade layer)
class QuoteService {
  private static readonly SERVICE_NAME = 'QuoteService';
  //                      ^^^^^^^^^^^^
  // Подчеркивает роль: это сервис, а не просто класс
}
```

### 2. Архитектурная ясность

В нашей архитектуре есть разные типы классов:

```text
├── Core (Domain Model)
│   ├── Quote (Value Object)          ← Это класс
│   ├── Price (Value Object)          ← Это класс
│   └── Balance (Entity)              ← Это класс
│
├── Facade (Service Layer)
│   ├── QuoteService                  ← Это СЕРВИС
│   ├── PriceService                  ← Это СЕРВИС
│   └── BalanceService                ← Это СЕРВИС
│
├── Adapters
│   ├── QuoteSerializer               ← Это СЕРВИС (тоже имеет SERVICE_NAME)
│   └── PriceFormatter                ← Это СЕРВИС
│
└── Rules
    └── ValidateMinSize               ← Это ФУНКЦИЯ (не сервис!)
```

**`serviceName`** четко указывает: это имя **сервиса**, а не произвольного класса.

### 3. Контекст использования

Поле `service` в error context показывает, **какой сервис** обрабатывал операцию:

```typescript
{
  "service": "QuoteService",    // ← Сервис-источник ошибки
  "op": "create",               // ← Операция сервиса
  "opChain": [
    "PriceService.create",      // ← Сервис + операция
    "QuoteService.create"       // ← Сервис + операция
  ]
}
```

Если бы мы использовали `className`, это было бы менее понятно:

- Какой класс? Core? Facade? Adapter?
- Это имя сущности или имя обработчика?

### 4. Альтернативные варианты (рассмотрены и отклонены)

#### ❌ `className`

```typescript
const className = 'QuoteService';  // ← Слишком общее
```

**Проблема**: "Class" может быть что угодно (Core, Facade, Adapter, Error class)

#### ❌ `entityName`

```typescript
const entityName = 'QuoteService';  // ← Неточное
```

**Проблема**: QuoteService - это НЕ entity (entity это Balance, User, Order)

#### ❌ `handlerName`

```typescript
const handlerName = 'QuoteService';  // ← Слишком техническое
```

**Проблема**: "Handler" - низкоуровневый термин, непонятно что именно

#### ❌ `componentName`

```typescript
const componentName = 'QuoteService';  // ← Конфликт с полем component
```

**Проблема**: У нас уже есть поле `component` для bid/ask/bidSize/askSize

#### ✅ `serviceName`

```typescript
const serviceName = 'QuoteService';  // ← Точное и ясное!
```

**Почему лучше**:

- Соответствует архитектурному слою (Service/Facade layer)
- Ясно указывает на роль класса
- Не конфликтует с другими полями
- Семантически правильно для error tracking

### 5. Консистентность с индустрией

В микросервисной архитектуре и distributed systems:

```typescript
// Стандартные поля для трассировки:
{
  "service": "payment-service",      // ← Имя СЕРВИСА
  "trace_id": "abc123",
  "span_id": "def456"
}

// Наша архитектура - аналогично:
{
  "service": "QuoteService",         // ← Имя СЕРВИСА (Facade)
  "op": "create",
  "opChain": [...]
}
```

### 6. Примеры из кода

#### errorUtils.ts

```typescript
export function rewrap<TError extends DomainError>(
  serviceName: string,  // ← Используем serviceName
  op: string,
  ctx: Record<string, unknown>,
  err: TError,
  ErrorConstructor: ErrorConstructor<TError>
): TError {
  // ...
  merged.service = serviceName;  // → Записываем в поле service
}
```

#### QuoteService.ts

```typescript
class QuoteService {
  private static readonly SERVICE_NAME = 'QuoteService';

  public static create(...): Result<Quote, InvalidQuoteError> {
    return wrapOp(
      QuoteService.SERVICE_NAME,  // ← Передаем serviceName
      'create',
      // ...
    );
  }
}
```

## Итоговое обоснование

**`serviceName`** выбран, потому что:

1. ✅ Семантически точное - это имя **сервиса** (Facade layer)
2. ✅ Архитектурно ясное - соответствует слою приложения
3. ✅ Консистентное - аналогично distributed tracing
4. ✅ Не конфликтует с другими полями
5. ✅ Легко понятно при чтении логов

Альтернативы (`className`, `entityName`, `handlerName`, `componentName`) либо слишком общие, либо неточные, либо конфликтуют с существующими полями.
