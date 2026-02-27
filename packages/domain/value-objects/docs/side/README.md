# Side Value Object

**Side** — направление торговой операции: `'BUY'` или `'SELL'`.

## Обзор

Side — это string literal type alias (`'BUY' | 'SELL'`), не class. Такой выбор обоснован тем, что Side представляет примитивное значение без внутреннего состояния, требующего защиты через private constructor.

**Ключевые характеристики:**

- Только два валидных значения: `'BUY'` и `'SELL'`
- Единственный источник правды — `ALL_SIDES` (замороженный массив)
- Case-sensitive: `'buy'` — невалидное значение, только `'BUY'`
- Контракт "Never Throw": методы парсинга возвращают `Result`, утилиты — значения напрямую

## Инварианты

1. **Два значения**: только `'BUY'` или `'SELL'` — никаких других строк
2. **Case-sensitive**: строго uppercase, `'buy'` и `'Sell'` невалидны
3. **Иммутабельный набор**: `ALL_SIDES` заморожен через `Object.freeze`, runtime-мутация невозможна
4. **Единый источник правды**: `isValidSide()`, `SIDE_SET` и `getAllValues()` производны от `ALL_SIDES`

## Быстрый старт

```typescript
import { SideService, SideSerializer, SideFormatter } from '@polymarket/value-objects';

// Создание из строки
const result = SideService.fromString('BUY');
if (result.ok) {
  const side = result.value; // 'BUY'
}

// Парсинг из unknown (API, DB, пользовательский ввод)
const parsed = SideService.fromUnknown(rawInput);
if (!parsed.ok) {
  // parsed.error.context.reason — INVALID_TYPE или INVALID_VALUE
  console.error(parsed.error.message);
}

// Утилиты — возвращают значения напрямую, не бросают
const opposite = SideService.opposite('BUY');        // 'SELL'
const canMatch  = SideService.canMatch('BUY', 'SELL'); // true

// Форматирование для UI
SideFormatter.toDisplay('BUY');  // 'Buy'
SideFormatter.toColor('SELL');   // 'red'
```

## Связанные разделы

- [architecture.md](./architecture.md) — почему type alias, ALL_SIDES как источник правды, контракт ошибок
- [facade.md](./facade.md) — полный справочник API: SideService, SideSerializer, SideFormatter, SideErrorReason
- [examples.md](./examples.md) — практические сценарии: order matching, парсинг из API, обработка ошибок, UI dropdown
