# UI Refactoring: Blessed Terminal Interface

## Проблема

Оригинальный код `polymarket-mm-bot-v3.js` содержал UI логику вперемешку с бизнес-логикой:
- Прямые вызовы `blessed` API из основного кода
- Дублирование логов между экраном и файлами
- Отсутствие абстракции для других типов UI (headless, web)
- Сложная поддержка и тестирование

## Решение

Выделена UI логика в отдельный модуль `infrastructure/ui/` с чистой архитектурой:

### Архитектура

```
infrastructure/ui/
├── types.ts                    # Интерфейсы и типы
├── BlessedTradingUI.ts         # Blessed реализация
├── HeadlessUI.ts               # Headless реализация
├── components/
│   ├── StatusPanel.ts          # Статус панель
│   ├── LogPanel.ts             # Логи
│   ├── OrderPanel.ts           # Ордера и филлы
│   └── PositionPanel.ts        # Позиции и PnL
└── index.ts                    # Экспорты
```

### Интерфейс ITradingUI

Все UI реализации соответствуют единому интерфейсу:

```typescript
interface ITradingUI {
  initialize(): Promise<void>;
  log(message: string, category: LogCategory, level: LogLevel): void;
  updateStatus(data: StatusDisplayData): void;
  updateOrders(orders: OrderDisplayData[]): void;
  updateFills(fills: FillDisplayData[]): void;
  render(): void;
  destroy(): Promise<void>;
}
```

### Реализации

#### 1. BlessedTradingUI

**Использование:**
```typescript
import { BlessedTradingUI } from './infrastructure/ui';

const ui = new BlessedTradingUI({
  asciiOnly: true,
  maxLogEntries: 200
});

await ui.initialize();
ui.log('Bot started', 'system', 'INFO');
ui.updateStatus({ ... });
ui.render();
```

**Особенности:**
- Two-column layout (статус слева, логи справа)
- 4 панели: Status, Activity, Orders & Fills, Main Loop
- Авто-скроллинг логов
- Цветовое кодирование по категориям/уровням
- Поддержка ASCII/emoji режимов
- Подавление ошибок `xterm-256color` warnings

**Layout:**
```
┌─ STATUS ────────────┐┌─ ACTIVITY ──────────┐
│ Market: BTC 100k?   ││ [12:34:56] [OMS] ... │
│ Mode: QUOTE         ││ [12:34:57] [TRD] ... │
│ Edge: ✅ ALIVE      ││ ...                  │
│                     ││                      │
│ Positions:          ││                      │
│   YES: 10.5         ││                      │
│   NO:  5.2          ││                      │
│   Net: +5.3         ││                      │
│                     ││                      │
│ PnL:                ││                      │
│   Unrealized: +12.50││                      │
│   Realized: -3.25   ││                      │
│   Total: +9.25      ││                      │
└─────────────────────┘└─────────────────────┘
┌─ ORDERS & FILLS ────┐┌─ MAIN LOOP ─────────┐
│ Token Side Price ... ││ [12:34:56] Tick ... │
│ YES   BUY  0.6500 ...││ [12:34:57] Quote ...│
│ ...                 ││ ...                  │
└─────────────────────┘└─────────────────────┘
```

#### 2. HeadlessUI

**Использование:**
```typescript
import { HeadlessUI } from './infrastructure/ui';

const ui = new HeadlessUI({
  asciiOnly: true,
  updateInterval: 5000 // Логировать статус каждые 5 сек
});

await ui.initialize();
ui.log('Bot started', 'system', 'INFO');
ui.updateStatus({ ... });
```

**Особенности:**
- Только console.log вывод
- Нет blessed зависимости
- Подходит для серверов, CI/CD, логирования в файлы
- Throttling для статус обновлений

**Формат вывода:**
```
[2024-12-27T12:34:56.789Z] [INFO] [system] Bot started
[2024-12-27T12:34:57.000Z] [INFO] [system] Mode: QUOTE | Net: +5.2 | PnL: +$12.50 | Edge: ALIVE
[2024-12-27T12:34:58.123Z] [INFO] [oms] Open orders: 2
[2024-12-27T12:34:59.456Z] [INFO] [trade] FILL: BUY YES @ 0.6500 x 10.0
```

### Компоненты

#### StatusPanel

Форматирует данные статуса для отображения:
- Информация о рынке
- Режим работы и edge status
- Позиции (YES, NO, net)
- PnL breakdown
- Баланс кэша
- Состояние orderbook

#### LogPanel

Форматирует логи:
- Timestamp + категория + сообщение
- Цветовое кодирование по уровню (ERROR, WARN, INFO, DEBUG)
- Дедупликация последовательных одинаковых сообщений
- Конвертация emoji → ASCII при необходимости

#### OrderPanel

Форматирует ордера и филлы:
- Таблица открытых ордеров (токен, сторона, цена, размер, статус)
- Таблица недавних филлов (время, токен, сторона, цена, размер)
- Цветовое кодирование (BUY = зеленый, SELL = красный)

#### PositionPanel

Форматирует позиции и PnL:
- Текущие позиции (YES, NO, net)
- PnL breakdown (unrealized, realized, total)
- Баланс кэша (available, reserved)
- Компактный summary для статус баров

## Критические моменты из оригинала

### 1. Подавление Blessed Warnings

**Проблема:** xterm-256color warnings засоряют вывод.

**Решение:**
```typescript
private suppressBlessedWarnings(): void {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: any, encoding?: any, callback?: any) => {
    const str = chunk.toString();
    if (
      str.includes('Error on xterm-256color') ||
      str.includes('Setulc') ||
      str.includes('\\u001b[58::')
    ) {
      return true; // Подавляем
    }
    return originalStderrWrite(chunk, encoding, callback);
  };
}
```

### 2. Дедупликация Логов

**Проблема:** Дубликаты логов (особенно от mainloop) засоряют экран.

**Решение:**
```typescript
export function deduplicateLogs(logs: LogEntry[]): LogEntry[] {
  if (logs.length === 0) return [];
  const result: LogEntry[] = [logs[0]];

  for (let i = 1; i < logs.length; i++) {
    const current = logs[i];
    const previous = logs[i - 1];

    // Пропускаем если то же сообщение + та же категория
    if (current.message === previous.message && current.category === previous.category) {
      continue;
    }

    result.push(current);
  }

  return result;
}
```

### 3. Форматирование Чисел

**Оригинал:** Функция `fmt()` для форматирования с знаком.

**Решение:**
```typescript
function fmt(value: number, decimals: number, showSign = false): string {
  const formatted = value.toFixed(decimals);
  if (showSign && value > 0) {
    return `+${formatted}`;
  }
  return formatted;
}
```

### 4. Icon System (ASCII vs Emoji)

**Оригинал:** ICON_MAP с emoji/ascii вариантами.

**Решение:**
```typescript
function getIcon(name: string, asciiOnly: boolean): string {
  const ICON_MAP: Record<string, { emoji: string; ascii: string }> = {
    ok: { emoji: '✅', ascii: '[OK]' },
    warn: { emoji: '⚠️', ascii: '[WARN]' },
    err: { emoji: '❌', ascii: '[ERR]' },
    // ...
  };

  const iconData = ICON_MAP[name];
  if (!iconData) return name;
  return asciiOnly ? iconData.ascii : iconData.emoji;
}
```

### 5. Blessed Tags (Color Coding)

**Формат:** `{color-fg}text{/color-fg}`

**Использование:**
```typescript
const netColor = data.netPosition > 0 ? 'green-fg' : 'red-fg';
return `{${netColor}}Net: ${data.netPosition.toFixed(1)}{/${netColor}}`;
```

**Stripped при выводе:**
```typescript
blessed.stripTags(str); // Убирает теги для расчета длины
```

## Преимущества Рефакторинга

1. **Разделение ответственности**: UI логика изолирована от бизнес-логики
2. **Тестируемость**: Компоненты можно тестировать независимо
3. **Расширяемость**: Легко добавить новые UI реализации (Web, Desktop)
4. **Поддержка**: Изменения в UI не затрагивают основной код
5. **Headless режим**: Можно запускать без terminal UI
6. **Чистый код**: Явные интерфейсы, типизация, документация

## Использование в Main Code

```typescript
import { BlessedTradingUI, HeadlessUI } from './infrastructure/ui';

// Выбор UI реализации
const ui = process.env.HEADLESS === '1'
  ? new HeadlessUI({ asciiOnly: true })
  : new BlessedTradingUI({ asciiOnly: true, maxLogEntries: 200 });

await ui.initialize();

// Использование единого интерфейса
ui.log('Bot started', 'system', 'INFO');

ui.updateStatus({
  marketQuestion: market.question,
  marketEndDate: market.endDate.toISOString(),
  timeToExpiry: formatTimeToExpiry(market.endDate),
  mode: currentMode,
  edgeAlive: edge.alive,
  edgeStage: edge.stage,
  yesPosition: inventory.yesShares,
  noPosition: inventory.noShares,
  netPosition: inventory.netPosition,
  unrealizedPnL: inventory.unrealizedPnL,
  realizedPnL: inventory.realizedPnL,
  totalPnL: inventory.totalPnL,
  cash: inventory.cash,
  reservedCash: inventory.reservedCash,
  yesMid: yesOrderbook.midPrice,
  noMid: noOrderbook.midPrice,
  yesSpread: yesOrderbook.spread,
  noSpread: noOrderbook.spread,
  yesBestBid: yesOrderbook.bestBid,
  yesBestAsk: yesOrderbook.bestAsk,
  noBestBid: noOrderbook.bestBid,
  noNoBestAsk: noOrderbook.bestAsk,
});

ui.updateOrders(openOrders);
ui.updateFills(recentFills);
ui.render();

// Cleanup
await ui.destroy();
```

## Миграция из Оригинального Кода

### До (оригинальный код):
```javascript
log('Order placed', 'oms', 'INFO');
renderScreen();
```

### После (рефакторинг):
```typescript
ui.log('Order placed', 'oms', 'INFO');
// render() вызывается автоматически
```

### До (статус):
```javascript
SCREEN_BUFFERS.status = computeStatus();
renderScreen();
```

### После (рефакторинг):
```typescript
ui.updateStatus(computeStatusDisplayData());
// render() вызывается автоматически
```

## Дальнейшие Улучшения

1. **Web UI**: Добавить WebSocketTradingUI для browser-based dashboard
2. **File UI**: Добавить FileTradingUI для записи в структурированные логи
3. **Metrics**: Интеграция с Prometheus/Grafana
4. **Replay**: UI для replay логов и визуализации
5. **Tests**: Unit тесты для всех компонентов

## Заключение

Рефакторинг UI выделил презентационную логику в отдельный модуль с чистым интерфейсом. Это упрощает поддержку, тестирование и расширение системы новыми типами UI.
