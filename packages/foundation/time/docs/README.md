# Документация @polymarket/time

Модуль для работы с временем через паттерн Dependency Injection в Polymarket trading system.

## Оглавление

- [Обзор](#обзор)
- [Архитектура](./clock-architecture.md)
- [Примеры использования](./usage-examples.md)
- [API Reference](#api-reference)

## Обзор

Модуль `@polymarket/time` предоставляет абстракции для работы с временем, обеспечивающие детерминизм, тестируемость и возможность воспроизведения событий.

### Проблема

В трейдинговых системах прямое использование `new Date()` создает проблемы:

- **Недетерминированность**: каждый вызов возвращает новое время
- **Невозможность тестирования**: нельзя контролировать время в тестах
- **Невозможность воспроизведения**: replay событий дает разные timestamps
- **Race conditions**: время постоянно меняется

### Решение

Модуль предоставляет паттерн Dependency Injection для работы с временем:

- **IClock интерфейс** - единый контракт для всех источников времени
- **LiveClock** - реализация для production (реальное время)
- **PaperClock** - реализация для testing (управляемое время)
- **ReplayClock** - реализация для replay (время из событий)

### Преимущества

- ✅ **Детерминизм** - одинаковые события → одинаковые timestamps
- ✅ **Тестируемость** - полный контроль над временем в тестах
- ✅ **Воспроизводимость** - bit-for-bit идентичное replay
- ✅ **Гибкость** - легкое переключение между режимами

## Быстрый старт

### Установка

```bash
npm install @polymarket/time
```

### Production (LiveClock)

```typescript
import { LiveClock } from '@polymarket/time';

const clock = new LiveClock();
console.log(clock.now()); // Текущее системное время
```

### Testing (PaperClock)

```typescript
import { PaperClock } from '@polymarket/time';

const clock = new PaperClock(new Date('2024-01-01'));
console.log(clock.now()); // 2024-01-01T00:00:00.000Z

clock.tick(5000); // Продвинуть на 5 секунд
console.log(clock.now()); // 2024-01-01T00:00:05.000Z
```

### Replay (ReplayClock)

```typescript
import { ReplayClock } from '@polymarket/time';

const clock = new ReplayClock(new Date(0));

events.forEach((event) => {
  clock.update(event.timestamp); // Обновить время из события
  processEvent(event); // Обработать с детерминированным временем
});
```

## Архитектура

```text
@polymarket/time
├── src/
│   ├── IClock.ts          # Интерфейс источника времени
│   ├── LiveClock.ts       # Реализация для production
│   ├── PaperClock.ts      # Реализация для testing
│   ├── ReplayClock.ts     # Реализация для replay
│   └── index.ts           # Экспорты
├── __tests__/
│   ├── unit/              # Юнит-тесты
│   │   ├── LiveClock.test.ts
│   │   ├── PaperClock.test.ts
│   │   └── ReplayClock.test.ts
│   └── integration/       # Интеграционные тесты
│       └── ClockIntegration.test.ts
└── docs/
    ├── README.md              # Этот файл
    ├── clock-architecture.md  # Подробная архитектура
    └── usage-examples.md      # Примеры использования
```

## API Reference

### IClock

Интерфейс источника времени.

```typescript
interface IClock {
  now(): Date;
}
```

#### `now(): Date`

Возвращает текущее время в соответствии с типом реализации.

### LiveClock

Реализация на основе системного времени для production.

```typescript
class LiveClock implements IClock {
  now(): Date;
}
```

**Применение:**

- Production окружение
- LIVE режим торговли
- Реальное время

**Пример:**

```typescript
const clock = new LiveClock();
const currentTime = clock.now(); // Реальное системное время
```

### PaperClock

Реализация с управляемым временем для тестирования.

```typescript
class PaperClock implements IClock {
  constructor(initialTimestamp: Date);
  now(): Date;
  setTime(timestamp: Date): void;
  tick(ms: number): void;
}
```

**Применение:**

- Unit-тесты
- Integration-тесты
- PAPER режим симуляции

**Методы:**

- `setTime(timestamp)` - установить абсолютное время
- `tick(ms)` - продвинуть время на N миллисекунд

**Пример:**

```typescript
const clock = new PaperClock(new Date('2024-01-01'));

clock.tick(1000); // +1 секунда
console.log(clock.now()); // 2024-01-01T00:00:01.000Z

clock.setTime(new Date('2024-02-01'));
console.log(clock.now()); // 2024-02-01T00:00:00.000Z
```

### ReplayClock

Реализация с фиксированным временем для воспроизведения событий.

```typescript
class ReplayClock implements IClock {
  constructor(initialTimestamp: Date);
  now(): Date;
  update(timestamp: Date): void;
}
```

**Применение:**

- REPLAY режим анализа
- Воспроизведение исторических данных
- Отладка и поиск проблем

**Методы:**

- `update(timestamp)` - обновить время из события

**Пример:**

```typescript
const clock = new ReplayClock(new Date(0));

events.forEach((event) => {
  clock.update(event.timestamp); // Обновить ПЕРЕД обработкой
  processEvent(event);
});
```

**Критическое правило:**

Всегда вызывайте `update()` ПЕРЕД обработкой события.

## Паттерны использования

### Dependency Injection

```typescript
class TradingStrategy {
  constructor(private readonly clock: IClock) {}

  placeOrder(): Order {
    return {
      id: generateId(),
      placedAt: this.clock.now(), // ✅ Время через DI
    };
  }
}

// LIVE режим
const liveStrategy = new TradingStrategy(new LiveClock());

// PAPER режим
const paperStrategy = new TradingStrategy(new PaperClock(new Date()));

// REPLAY режим
const replayStrategy = new TradingStrategy(new ReplayClock(new Date(0)));
```

## Дополнительные материалы

- [Подробная архитектура](./clock-architecture.md) - детальное описание архитектуры и паттернов
- [Примеры использования](./usage-examples.md) - практические примеры для разных сценариев

## Best Practices

### ✅ Правильно

```typescript
// 1. Всегда используйте IClock через DI
class Service {
  constructor(private readonly clock: IClock) {}
}

// 2. Обновляйте ReplayClock ПЕРЕД обработкой
clock.update(event.timestamp);
processEvent(event);

// 3. Используйте PaperClock в тестах
const clock = new PaperClock(new Date('2024-01-01'));
```

### ❌ Неправильно

```typescript
// 1. НЕ создавайте Date напрямую
const timestamp = new Date(); // ❌

// 2. НЕ обновляйте ReplayClock после обработки
processEvent(event);
clock.update(event.timestamp); // ❌ Поздно!

// 3. НЕ используйте LiveClock в тестах
const clock = new LiveClock(); // ❌ Недетерминировано
```
