# Integration Guide: UI + Market Discovery

## Что изменилось

### 1. UI Module (Infrastructure Layer)

✅ **Создан модуль** `src/infrastructure/ui/`:
- `ITradingUI` - интерфейс для всех UI реализаций
- `BlessedTradingUI` - полноценный terminal UI (blessed)
- `HeadlessUI` - минималистичный console.log режим
- Компоненты: `StatusPanel`, `LogPanel`, `OrderPanel`, `PositionPanel`

### 2. Market Discovery Service (Domain Layer)

✅ **Создан модуль** `src/domain/services/market-discovery/`:
- `MarketDiscoveryService` - главный сервис
- `GammaApiClient` - клиент для Gamma API
- `MarketFilter` - фильтрация рынков по критериям
- `MarketScorer` - ранжирование рынков по score

### 3. Integration в main.ts

✅ **Интегрировано** в `src/bootstrap/main.ts`:
- UI инициализируется перед всем остальным
- Market Discovery сканирует реальные рынки из Gamma API
- Выбирается лучший рынок (highest score)
- Trading запускается на реальном рынке

## Запуск

### Development режим (с Terminal UI)

```bash
npm run dev
```

**Что происходит:**
1. Инициализируется BlessedTradingUI (4-panel layout)
2. Market Discovery сканирует Gamma API
3. Фильтрует по критериям (crypto + up/down)
4. Ранжирует по score (time > liquidity > volume)
5. Выбирает лучший рынок
6. Запускает trading на выбранном рынке

### Headless режим (console.log only)

```bash
HEADLESS=1 npm run dev
```

**Для чего:**
- Серверы без terminal UI
- CI/CD pipelines
- Логирование в файл с редиректом (`> bot.log`)

## Конфигурация

### Environment Variables

Добавлена переменная:

```bash
# Gamma API URL (optional, defaults to official API)
GAMMA_API_URL=https://gamma-api.polymarket.com

# Headless mode (optional, defaults to false)
HEADLESS=1
```

### Market Filters

Фильтры настраиваются в `src/bootstrap/main.ts`:

```typescript
const marketDiscovery = new MarketDiscoveryService(
  gammaApiClient,
  {
    filter: {
      minTimeToExpiryHours: 0, // 0 = any market
      minSpread: 0.02,          // 2% minimum
      minDailyVolume: 100,      // $100 minimum
      maxMarketsToTrack: 5,
      requiredKeywords: ['up', 'down'],
      anyOfKeywords: ['bitcoin', 'ethereum', 'solana', 'xrp'],
    },
  },
  logger
);
```

**Эквивалент из v3.js:**
```javascript
return m.active && !m.closed && m.enableOrderBook &&
    (question.includes('bitcoin') || question.includes('ethereum') ||
     question.includes('solana') || question.includes('xrp')) &&
    question.includes('up') &&
    question.includes('down');
```

## UI Layout (BlessedTradingUI)

```
┌─ STATUS ────────────────────┐┌─ ACTIVITY ──────────────────┐
│ Market: BTC up/down?        ││ [12:34:56] [SYS] Bot started│
│ End: 2025-12-28 18:00:00    ││ [12:34:57] [OMS] Order...   │
│ Time: 2h 15m                ││ [12:34:58] [TRD] Fill...    │
│                             ││                             │
│ Mode: QUOTE                 ││                             │
│ Edge: [OK] ALIVE            ││                             │
│                             ││                             │
│ Positions:                  ││                             │
│   YES: 10.5                 ││                             │
│   NO:  5.2                  ││                             │
│   Net: +5.3                 ││                             │
│                             ││                             │
│ PnL:                        ││                             │
│   Unrealized: +12.50        ││                             │
│   Realized: -3.25           ││                             │
│   Total: +9.25              ││                             │
│                             ││                             │
│ Cash:                       ││                             │
│   Available: $9850.00       ││                             │
│   Reserved: $150.00         ││                             │
│                             ││                             │
│ Orderbook:                  ││                             │
│   YES: 0.6500 (sp: 0.0250)  ││                             │
│     Bid: 0.6375 | Ask: 0.6625││                           │
│   NO:  0.3600 (sp: 0.0200)  ││                             │
│     Bid: 0.3500 | Ask: 0.3700││                           │
└─────────────────────────────┘└─────────────────────────────┘
┌─ ORDERS & FILLS ────────────┐┌─ MAIN LOOP ─────────────────┐
│ Token Side  Price    Size...││ [12:34:56] Tick...          │
│ YES   BUY   0.6500   10.0...││ [12:34:57] Quoting...       │
│ ...                         ││ ...                         │
└─────────────────────────────┘└─────────────────────────────┘
```

## Архитектура Market Discovery

```
MarketDiscoveryService.findBestMarket()
├─> GammaApiClient.getActiveMarkets()
│   └─> GET https://gamma-api.polymarket.com/markets
│       └─> Returns: [ { condition_id, question, end_date, ... }, ... ]
│
├─> MarketFilter.filterMarkets()
│   ├─> Basic: active && !closed && enableOrderBook
│   ├─> Time: minTimeToExpiryHours
│   ├─> Spread: minSpread
│   ├─> Volume: minDailyVolume
│   └─> Keywords: requiredKeywords + anyOfKeywords
│       └─> Returns: [ { conditionId, question, ... }, ... ]
│
├─> MarketScorer.scoreMarkets()
│   ├─> Normalize: timeToExpiry, liquidity, volume → [0, 1]
│   ├─> Apply weights: 3.0x time + 2.0x liq + 1.0x vol
│   └─> Sort by score descending
│       └─> Returns: [ highest_score, ..., lowest_score ]
│
└─> Select best: candidates[0]
```

## Как использовать UI в коде

### Log messages

```typescript
ui.log('Order placed', 'oms', 'INFO');
ui.log('Low liquidity detected', 'risk', 'WARN');
ui.log('Failed to place order', 'error', 'ERROR');
```

### Update status

```typescript
ui.updateStatus({
  marketQuestion: market.question,
  marketEndDate: market.endDate.toISOString(),
  timeToExpiry: formatTimeToExpiry(market.endDate),
  mode: 'QUOTE',
  edgeAlive: true,
  edgeStage: 'ALIVE',
  yesPosition: 10.5,
  noPosition: 5.2,
  netPosition: 5.3,
  unrealizedPnL: 12.50,
  realizedPnL: -3.25,
  totalPnL: 9.25,
  cash: 9850,
  reservedCash: 150,
  yesMid: 0.65,
  noMid: 0.36,
  yesSpread: 0.025,
  noSpread: 0.020,
  yesBestBid: 0.6375,
  yesBestAsk: 0.6625,
  noBestBid: 0.35,
  noNoBestAsk: 0.37,
});
```

### Update orders

```typescript
ui.updateOrders([
  {
    id: 'order123',
    tokenId: 'YES',
    side: 'BUY',
    price: 0.65,
    size: 10,
    filledSize: 0,
    status: 'LIVE',
    createdAt: '12:34:56',
  },
]);
```

### Update fills

```typescript
ui.updateFills([
  {
    id: 'fill123',
    orderId: 'order123',
    tokenId: 'YES',
    side: 'BUY',
    price: 0.65,
    size: 10,
    timestamp: '12:34:56',
  },
]);
```

### Force render

```typescript
ui.render(); // Usually called automatically
```

## Тестирование

### Проверить Market Discovery

```bash
# Temporary test script
node << 'EOF'
import { GammaApiClient, MarketDiscoveryService } from './dist/domain/services/market-discovery/index.js';

const logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };
const client = new GammaApiClient({ baseUrl: 'https://gamma-api.polymarket.com' }, logger);
const discovery = new MarketDiscoveryService(client, {
  filter: {
    minTimeToExpiryHours: 0,
    minSpread: 0.02,
    minDailyVolume: 100,
    maxMarketsToTrack: 5,
    requiredKeywords: ['up', 'down'],
    anyOfKeywords: ['bitcoin', 'ethereum'],
  }
}, logger);

const result = await discovery.findBestMarket();
console.log('Best market:', result.market?.question);
console.log('Score:', result.market?.score);
EOF
```

### Проверить UI

```bash
# Run in dev mode and verify UI appears
npm run dev

# Should show blessed terminal UI with 4 panels
# Press Ctrl+C to exit
```

## Миграция из v3.js

Если нужно вернуться к v3.js (старый файл):

```bash
# Backup current main.ts
cp src/bootstrap/main.ts src/bootstrap/main.ts.backup

# Use old JS file
node polymarket-mm-bot-v3.js
```

**Но рекомендуется использовать новый TypeScript код!**

## Troubleshooting

### UI не появляется

**Проблема:** Terminal UI не отображается

**Решение:**
1. Проверьте, что не запущен headless режим: `unset HEADLESS`
2. Проверьте terminal: `echo $TERM` (должен быть xterm-256color)
3. Попробуйте: `HEADLESS=1 npm run dev` (console logs)

### Market Discovery не находит рынки

**Проблема:** `No suitable markets found`

**Решение:**
1. Проверьте фильтры - может быть слишком строгие
2. Уменьшите `minDailyVolume` или `minSpread`
3. Уберите `requiredKeywords` для тестирования
4. Проверьте доступность Gamma API: `curl https://gamma-api.polymarket.com/markets`

### Build ошибки

**Проблема:** TypeScript compile errors

**Решение:**
```bash
npm run clean
npm install
npm run build
```

## Документация

- UI: `docs/architecture/ui-refactoring.md`
- Market Discovery: `docs/services/market-discovery.md`
- API Reference: `docs/api/` (generated by TypeDoc)

## Next Steps

После интеграции можно добавить:
1. Периодическое пересканирование рынков (каждые 5 минут)
2. Автоматическое переключение на новый рынок при экспирации
3. Web UI (WebSocket + React)
4. Metrics export (Prometheus)
5. Replay mode для тестирования стратегий

---

**Готово!** Теперь бот использует:
- ✅ Blessed Terminal UI
- ✅ Реальные рынки из Gamma API
- ✅ Умную фильтрацию и ранжирование
- ✅ Нет фейковых/виртуальных рынков
