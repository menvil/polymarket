# Архитектура Clock

## Обзор

Модуль `@polymarket/time` предоставляет абстракцию для работы с временем через паттерн Dependency Injection. Это обеспечивает детерминизм, тестируемость и возможность воспроизведения событий.

## Проблема

В трейдинговых системах критически важна точная и предсказуемая работа с временем:

### Недостатки прямого использования `new Date()`

```typescript
class StrategyContext {
  now(): Date {
    return new Date(); // ❌ Проблемы
  }
}
```

**Проблемы:**

1. **Недетерминированность**: каждый вызов возвращает новое время
2. **Невозможность тестирования**: нельзя контролировать время в тестах
3. **Невозможность воспроизведения**: replay событий дает разные timestamps
4. **Race conditions**: время постоянно меняется

### Пример проблемы

```typescript
// Воспроизведение событий дважды дает разные результаты
const telemetry1 = replayEvents(events); // timestamps = [T1, T2, T3]
const telemetry2 = replayEvents(events); // timestamps = [T4, T5, T6] ❌

// T1 ≠ T4, потому что new Date() возвращает текущее время
```

## Решение: IClock Interface

### Архитектурный принцип

**Компоненты системы не создают время, они получают его через dependency injection.**

```typescript
interface IClock {
  now(): Date;
}

class StrategyContext {
  constructor(private readonly clock: IClock) {} // ✅ DI

  now(): Date {
    return this.clock.now(); // ✅ Детерминированное время
  }
}
```

### Преимущества

1. **Детерминизм**: одинаковые события → одинаковые timestamps
2. **Тестируемость**: полный контроль над временем в тестах
3. **Воспроизводимость**: bit-for-bit идентичное replay
4. **Гибкость**: легко переключаться между режимами

## Реализации

### LiveClock - Production

Используется в боевом окружении для работы с реальным временем.

```typescript
const clock = new LiveClock();
const ctx = new StrategyContext(clock);

console.log(ctx.now()); // Текущее системное время
```

**Характеристики:**

- Возвращает `new Date()` при каждом вызове
- Время постоянно движется вперед
- Недетерминировано (разные вызовы = разные значения)

**Применение:**

- LIVE режим торговли
- Production окружение
- Реальные рыночные данные

### PaperClock - Testing

Используется для тестирования с полным контролем над временем.

```typescript
const clock = new PaperClock(new Date('2024-01-01'));

console.log(clock.now()); // 2024-01-01T00:00:00.000Z

clock.tick(5000); // Продвинуть на 5 секунд
console.log(clock.now()); // 2024-01-01T00:00:05.000Z

clock.setTime(new Date('2024-02-01')); // Установить точное время
console.log(clock.now()); // 2024-02-01T00:00:00.000Z
```

**Характеристики:**

- Время не движется само по себе
- Полный контроль через `setTime()` и `tick()`
- Детерминировано (одинаковые операции = одинаковый результат)

**Применение:**

- Unit-тесты
- Integration-тесты
- PAPER режим симуляции

**Методы управления:**

- `setTime(timestamp)`: установить абсолютное время
- `tick(ms)`: продвинуть время на N миллисекунд

### ReplayClock - Replay

Используется для детерминированного воспроизведения исторических событий.

```typescript
const clock = new ReplayClock(new Date(0));

// Система воспроизведения обновляет clock из событий
events.forEach((event) => {
  clock.update(event.timestamp); // Обновить время
  processEvent(event); // Обработать событие
});
```

**Характеристики:**

- Хранит зафиксированное время из последнего события
- Обновляется только через `update()`
- Гарантирует идентичные timestamps при повторном воспроизведении

**Применение:**

- REPLAY режим анализа
- Воспроизведение исторических данных
- Отладка и поиск проблем

**Критическое правило:**

Система воспроизведения ДОЛЖНА обновлять clock ПЕРЕД обработкой события:

```typescript
for (const event of events) {
  clock.update(event.timestamp); // 1. Обновить время
  strategy.onEvent(event, ctx); // 2. Обработать событие
}
```

## Гарантии детерминизма

### Проблема недетерминизма

```typescript
// ❌ БЕЗ ReplayClock
events.forEach((event) => {
  const timestamp = new Date(); // Всегда новое время!
  telemetry.push({ event, timestamp });
});

// Replay дважды → разные timestamps
```

### Решение с ReplayClock

```typescript
// ✅ С ReplayClock
const clock = new ReplayClock(new Date(0));

events.forEach((event) => {
  clock.update(event.timestamp); // Фиксируем время из события
  telemetry.push({ event, timestamp: clock.now() });
});

// Replay дважды → ИДЕНТИЧНЫЕ timestamps (bit-for-bit)
```

## Паттерны использования

### Pattern 1: Dependency Injection

```typescript
class TradingStrategy {
  constructor(private readonly clock: IClock) {}

  placeOrder(): Order {
    return {
      id: generateId(),
      placedAt: this.clock.now(), // ✅ DI time
      // ...
    };
  }
}

// LIVE режим
const liveStrategy = new TradingStrategy(new LiveClock());

// PAPER режим (тестирование)
const paperStrategy = new TradingStrategy(new PaperClock(new Date()));

// REPLAY режим
const replayStrategy = new TradingStrategy(new ReplayClock(new Date(0)));
```

### Pattern 2: Тестирование с контролируемым временем

```typescript
describe('TradingStrategy', () => {
  it('должен размещать ордера с правильными timestamps', () => {
    const clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));
    const strategy = new TradingStrategy(clock);

    const order1 = strategy.placeOrder();
    expect(order1.placedAt).toEqual(new Date('2024-01-01T00:00:00Z'));

    clock.tick(5000); // +5 секунд

    const order2 = strategy.placeOrder();
    expect(order2.placedAt).toEqual(new Date('2024-01-01T00:00:05Z'));
  });
});
```

### Pattern 3: Воспроизведение событий

```typescript
class ReplaySystem {
  constructor(
    private readonly clock: ReplayClock,
    private readonly strategy: TradingStrategy
  ) {}

  replay(events: Event[]): Telemetry[] {
    const telemetry: Telemetry[] = [];

    events.forEach((event) => {
      // 1. Обновить clock из события
      this.clock.update(event.timestamp);

      // 2. Обработать событие с зафиксированным временем
      const result = this.strategy.onEvent(event);

      // 3. Записать telemetry (timestamp будет из события)
      telemetry.push({
        event: event.type,
        timestamp: this.clock.now(), // === event.timestamp
        result,
      });
    });

    return telemetry;
  }
}

// Использование
const clock = new ReplayClock(new Date(0));
const strategy = new TradingStrategy(clock);
const replaySystem = new ReplaySystem(clock, strategy);

const telemetry1 = replaySystem.replay(events);
const telemetry2 = replaySystem.replay(events);

// telemetry1 === telemetry2 (bit-for-bit)
```

## Сравнение реализаций

| Характеристика     | LiveClock          | PaperClock         | ReplayClock          |
| ------------------ | ------------------ | ------------------ | -------------------- |
| Источник времени   | `Date.now()`       | Управляемый        | События              |
| Детерминизм        | ❌ Нет             | ✅ Да              | ✅ Да                |
| Время движется     | ✅ Автоматически   | ❌ Вручную         | ❌ Через `update()`  |
| Применение         | Production         | Testing            | Replay               |
| Режим              | LIVE               | PAPER              | REPLAY               |
| Управление         | -                  | `setTime()`, `tick()` | `update()`           |
| Воспроизводимость  | ❌ Невозможна      | ✅ Возможна        | ✅ Гарантирована     |

## Best Practices

### ✅ Правильно

```typescript
// 1. Всегда используйте IClock через DI
class Service {
  constructor(private readonly clock: IClock) {}
}

// 2. Никогда не создавайте Date напрямую в бизнес-логике
const timestamp = this.clock.now(); // ✅

// 3. Обновляйте ReplayClock ПЕРЕД обработкой события
clock.update(event.timestamp);
processEvent(event);

// 4. Используйте PaperClock в тестах
const clock = new PaperClock(new Date('2024-01-01'));
```

### ❌ Неправильно

```typescript
// 1. НЕ создавайте Date напрямую
const timestamp = new Date(); // ❌

// 2. НЕ обновляйте ReplayClock ПОСЛЕ обработки
processEvent(event);
clock.update(event.timestamp); // ❌ Поздно!

// 3. НЕ используйте LiveClock в тестах
const clock = new LiveClock(); // ❌ Недетерминировано

// 4. НЕ полагайтесь на системное время в воспроизведении
const replayTime = new Date(); // ❌ Каждый replay разный
```

## Диаграмма архитектуры

```
┌─────────────────────────────────────────────────────────────┐
│                          IClock                             │
│                     (интерфейс)                             │
│                      now(): Date                            │
└──────────────┬──────────────┬──────────────┬────────────────┘
               │              │              │
       ┌───────▼──────┐ ┌─────▼──────┐ ┌────▼──────────┐
       │  LiveClock   │ │ PaperClock │ │ ReplayClock   │
       ├──────────────┤ ├────────────┤ ├───────────────┤
       │ Date.now()   │ │ Управляемо │ │ Из событий    │
       │ Production   │ │ Testing    │ │ Replay        │
       └──────────────┘ └────────────┘ └───────────────┘
               │              │              │
               └──────────────┼──────────────┘
                              │
                    ┌─────────▼──────────┐
                    │  StrategyContext   │
                    │                    │
                    │ now() {            │
                    │   clock.now()      │
                    │ }                  │
                    └────────────────────┘
```

## Заключение

Использование `IClock` через dependency injection обеспечивает:

1. **Детерминизм**: предсказуемое поведение во всех режимах
2. **Тестируемость**: полный контроль над временем в тестах
3. **Воспроизводимость**: идентичное replay исторических событий
4. **Гибкость**: легкое переключение между режимами работы

Это фундаментальный паттерн для построения надежных трейдинговых систем.
