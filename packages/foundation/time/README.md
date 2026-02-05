# @polymarket/time

Утилиты для работы с временем и временными метками в Polymarket trading system.

## ✨ Ключевые особенности

- ✅ **Type-safe работа с временем** - строгая типизация для временных меток
- ✅ **Высокоточные операции** - работа с миллисекундами и наносекундами
- ✅ **Immutable** - все операции возвращают новые значения
- ✅ **Zero dependencies** - никаких внешних зависимостей в production
- ✅ **Высокое покрытие тестами** - >90% покрытие

## 📦 Установка

```bash
npm install @polymarket/time
```

## 🚀 Быстрый старт

```typescript
import { now, fromMillis, toMillis } from '@polymarket/time';

// Получение текущего времени
const currentTime = now();

// Создание временной метки из миллисекунд
const timestamp = fromMillis(1609459200000);

// Конвертация в миллисекунды
const millis = toMillis(timestamp);
```

## 📖 API

(API будет дополнен по мере разработки модуля)

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
