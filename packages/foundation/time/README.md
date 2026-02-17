# @polymarket/time

Утилиты для работы с временем и временными метками в Polymarket trading system.

## ✨ Ключевые особенности

- ✅ **Type-safe работа с временем** - строгая типизация через IClock интерфейс
- ✅ **Миллисекундная точность** - работа с Date (JavaScript millisecond precision)
- ✅ **Dependency Injection** - подмена источника времени для тестирования
- ✅ **Minimal dependencies** - только @polymarket/result для type-safe error handling
- ✅ **Детерминизм** - воспроизводимое поведение в тестах и replay режиме

## 📦 Установка

```bash
npm install @polymarket/time
```

## 🚀 Быстрый старт

```typescript
import { LiveClock, PaperClock, type IClock } from '@polymarket/time';

// Production: используй системное время
const liveClock: IClock = new LiveClock();
const currentTime = liveClock.now(); // Date

// Testing: используй контролируемое время
const paperClock = new PaperClock(new Date('2024-01-01'));
paperClock.tick(1000); // +1 секунда
const testTime = paperClock.now(); // Date('2024-01-01T00:00:01Z')
```

## 📖 API

### IClock

Интерфейс источника времени для Dependency Injection:

```typescript
interface IClock {
  now(): Date;  // Получить текущее время
}
```

### LiveClock

Production реализация, использует системное время:

```typescript
const clock = new LiveClock();
clock.now(); // new Date()
```

### PaperClock

Testing реализация, контролируемое время:

```typescript
const clock = new PaperClock(new Date('2024-01-01'));
clock.tick(1000);  // +1 секунда
clock.setTime(new Date('2024-01-02'));  // установить абсолютное время
```

### ReplayClock

Replay реализация, воспроизведение событий:

```typescript
const clock = new ReplayClock(new Date(0));
clock.update(event.timestamp);  // установить время из события
```

## 🧪 Тестирование

```bash
npm test
```

## 🏗️ Архитектура

```text
@polymarket/time                       # Layer 0 (Foundation)
    ↓ используется в
@polymarket/value-objects              # Layer 1 (Domain Primitives)
@polymarket/entities                   # Layer 2 (Domain Core)
    ↓ используются в
Application Layer                      # Layer 3
```

## 📄 License

MIT

## 🤝 Связанные пакеты

- `@polymarket/math` - Математические утилиты для trading системы
- `@polymarket/result` - Type-safe обработка ошибок
- `@polymarket/errors` - Типы ошибок для trading системы
