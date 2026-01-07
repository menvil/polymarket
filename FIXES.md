# Исправления UI и Market Discovery

## Проблема 1: UI панели показываются и сразу пропадают

### Причина
После инициализации blessed UI, использовались `console.log()` вызовы, которые перекрывали blessed screen.

### Решение
Заменил все `console.log()` после инициализации UI на `ui.log()`:

```typescript
// ❌ БЫЛО (неправильно):
await ui.initialize();
console.log('✅ UI ready\n');  // <-- перекрывает blessed screen
console.log('🔍 Initializing Market Discovery...');

// ✅ СТАЛО (правильно):
await ui.initialize();
ui.log('UI initialized', 'system', 'INFO');  // <-- использует blessed
ui.log('Initializing Market Discovery...', 'system', 'INFO');
```

**Все сообщения после `ui.initialize()` теперь идут через `ui.log()`**, что правильно отображается в blessed панелях.

## Проблема 2: getActiveMarkets() не возвращает рынки

### Причина
Метод не был полностью реализован - не было pagination и правильных query параметров для Gamma API.

### Решение
Реализовал полный fetch с pagination:

```typescript
async getActiveMarkets(): Promise<GammaMarketData[]> {
  const allMarkets: GammaMarketData[] = [];
  let offset = 0;
  const limit = 500;
  const maxPages = 10; // Max 5000 markets

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${this.config.baseUrl}/markets`);
    url.searchParams.set('closed', 'false');
    url.searchParams.set('limit', limit.toString());
    url.searchParams.set('offset', offset.toString());
    url.searchParams.set('order', 'volume');
    url.searchParams.set('ascending', 'false');

    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Polymarket-MM-Bot/3.0.0',
      },
    });

    const data = await response.json();

    if (data.length === 0) break;

    allMarkets.push(...data);
    offset += limit;

    if (data.length < limit) break;
  }

  return allMarkets;
}
```

**Особенности:**
- ✅ Pagination до 10 страниц (5000 рынков)
- ✅ Фильтр `closed=false` (только активные)
- ✅ Сортировка по volume (descending)
- ✅ Подробное логирование каждой страницы
- ✅ Обработка ошибок и timeout

## Как тестировать

### 1. Проверить UI

```bash
# Собрать
npm run build

# Запустить с Terminal UI
npm run dev

# Должны увидеть:
# - Blessed UI с 4 панелями
# - Логи в правой панели (ACTIVITY)
# - Сообщения о сканировании рынков
# - Выбор лучшего рынка
```

**Ожидаемый вывод в ACTIVITY панели:**
```
[12:34:56.123] [SYS] UI initialized
[12:34:56.456] [SYS] Initializing Market Discovery...
[12:34:56.789] [SYS] Market Discovery ready
[12:34:57.012] [SYS] Scanning markets from Gamma API...
[12:34:59.345] [SYS] Selected market: Bitcoin up or down? (score: 8.50)
[12:34:59.678] [SYS] Score: 8.50, Time: 2.5h, Vol: $5000.00
[12:34:59.901] [SYS] Initializing trading orchestrator...
[12:35:00.234] [SYS] Trading bot running! Mode: SIMULATION
```

### 2. Проверить Market Discovery

```bash
# Запустить и следить за логами
npm run dev

# В логах должно быть:
# - "Fetching active markets from Gamma API..."
# - "Fetching page 1" (с URL и параметрами)
# - "Page 1 fetched" (количество рынков)
# - "Fetched markets from Gamma API" (total count)
# - "Filtered markets" (сколько прошло фильтры)
# - "Best market selected" (детали победителя)
```

### 3. Проверить Headless режим

```bash
# Запустить без blessed UI
HEADLESS=1 npm run dev

# Должны увидеть console.log вывод:
# [2024-12-27T12:34:56.789Z] [INFO] [system] UI initialized
# [2024-12-27T12:34:57.012Z] [INFO] [system] Scanning markets...
# ...
```

## Что изменилось в файлах

### 1. `src/bootstrap/main.ts`
- ✅ Убраны `console.log()` после `ui.initialize()`
- ✅ Все сообщения идут через `ui.log()`
- ✅ Headless mode проверка перед console.log

### 2. `src/infrastructure/exchange/clients/GammaApiClient.ts`
- ✅ Реализован полный fetch с pagination
- ✅ Добавлены query параметры (`closed`, `limit`, `offset`, `order`)
- ✅ Логирование каждой страницы
- ✅ Обработка пустых результатов
- ✅ Исправлены ошибки в catch блоке

## Проверка работоспособности

### Минимальный тест

Создайте файл `test-integration.ts`:

```typescript
import { GammaApiClient, MarketDiscoveryService } from './dist/domain/services/market-discovery/index.js';

const logger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug: () => {},
};

const client = new GammaApiClient(
  { baseUrl: 'https://gamma-api.polymarket.com', timeout: 10000 },
  logger
);

const discovery = new MarketDiscoveryService(
  client,
  {
    filter: {
      minTimeToExpiryHours: 0,
      minSpread: 0.02,
      minDailyVolume: 100,
      maxMarketsToTrack: 5,
      requiredKeywords: ['up', 'down'],
      anyOfKeywords: ['bitcoin', 'ethereum', 'solana', 'xrp'],
    },
  },
  logger
);

const result = await discovery.findBestMarket();

if (result.market) {
  console.log('✅ Market Discovery работает!');
  console.log(`   Market: ${result.market.question}`);
  console.log(`   Score: ${result.market.score.toFixed(2)}`);
  console.log(`   Total fetched: ${result.totalFetched}`);
  console.log(`   Passed filters: ${result.totalFiltered}`);
} else {
  console.log('❌ No markets found');
}
```

Запустите:
```bash
npm run build
node test-integration.ts
```

## Troubleshooting

### UI все еще пропадает

**Проблема:** Blessed screen мигает и пропадает

**Решение:**
1. Убедитесь, что используете `npm run dev` (не node напрямую)
2. Проверьте, что нет `console.log` после `ui.initialize()`
3. Попробуйте headless режим: `HEADLESS=1 npm run dev`

### API не возвращает рынки

**Проблема:** `totalFetched: 0`

**Решение:**
1. Проверьте сеть: `curl https://gamma-api.polymarket.com/markets?limit=10`
2. Проверьте логи - должно быть "Fetching page 1"
3. Увеличьте timeout: `GAMMA_API_URL=https://gamma-api.polymarket.com`

### Фильтры слишком строгие

**Проблема:** `totalFiltered: 0` (ничего не прошло фильтры)

**Решение:** Ослабьте фильтры в `main.ts`:
```typescript
{
  minTimeToExpiryHours: 0,    // ✅ 0 = any market
  minSpread: 0.01,            // ✅ Уменьшите с 0.02 до 0.01
  minDailyVolume: 50,         // ✅ Уменьшите с 100 до 50
  maxMarketsToTrack: 5,
  requiredKeywords: [],       // ✅ Уберите для теста
  anyOfKeywords: ['bitcoin'], // ✅ Оставьте только один
}
```

## Готово!

Теперь:
- ✅ UI работает корректно (логи в правой панели)
- ✅ Market Discovery получает реальные рынки из Gamma API
- ✅ Нет виртуальных/фейковых рынков
- ✅ Все сообщения идут через UI

**Запустите:** `npm run dev` 🚀
