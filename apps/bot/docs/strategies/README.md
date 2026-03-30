# Стратегии бота Polymarket

## Обзор

Бот торгует на бинарных крипто-рынках Polymarket (Bitcoin Up/Down) с таймфреймами 5 и 15 минут. Рынки создаются по Chainlink oracle: в начале фиксируется strike price (priceToBeat), в конце — settlement по текущей цене.

---

## Сводная таблица результатов (15-мин, 4 дня, ~338 рынков)

| Стратегия | PnL (total) | WR | Fills | OOS прибыльный? | Статус |
|-----------|-------------|-----|-------|-----------------|--------|
| **AdaptiveEntry** (auto UP/DOWN) | **+18.73** | 79.8% | 114 | 3/4 дня | **Лучшая** |
| **SelectiveEntry** (UP only) | **+13.75** | 69.1% | 81 | 4/4 дня | Стабильная |
| Avellaneda-Stoikov MM | -174 | ~45% | ~2000 | Нет | Не работает |
| CryptoProbStrategy | -90 (OOS) | ~55% | ~500 | Нет | Overfit |

---

## Работающие стратегии

### 1. AdaptiveEntryStrategy (рекомендуется)

**Файл**: `src/strategies/AdaptiveEntryStrategy.ts`
**Документация**: [adaptive-entry.md](adaptive-entry.md)

Momentum-based стратегия. На отметке 50% времени рынка принимает одноразовое решение: купить UP или DOWN (auto-selection) или пропустить. Выбирает токен с большим EWMA rise. Hold до settlement.

**Ключевые результаты (15-мин)**:
- +18.73 USDC на 252 рынках, 79.8% WR
- 3/4 дней прибыльные (btc1: -5.45, btc2: +13.71, btc4: +1.87, btc5: +8.60)
- Auto-selection: один конфиг на рынок, стратегия сама выбирает UP или DOWN

**На 5-мин**: не работает стабильно (+2.72 total, 1/4 дней прибыльный).

### 2. SelectiveEntryStrategy

**Файл**: `src/strategies/SelectiveEntryStrategy.ts`
**Документация**: [selective-entry.md](selective-entry.md)

Buy-and-hold на основе zone filter (55-68¢) и delta% (0.03-0.12%). Проверяет на каждом тике, входит при прохождении всех фильтров. Hold до settlement.

**Ключевые результаты (15-мин)**:
- +13.75 USDC на 252 рынках, 69.1% WR
- 4/4 дней прибыльные — самая стабильная
- Зависит от Chainlink delta% (требует crypto price данные)

---

## Не работающие стратегии (reference)

### Avellaneda-Stoikov MM
**Файл**: `src/strategies/AvellanedaStoikovStrategy.ts`

Market making с динамическими спредами. Сильная adverse selection на 5-мин рынках уничтожает PnL. Множество параметров (~40+), все overfit. Ablation study показал: zone filter 55-73¢ делает breakeven, но не больше.

### CryptoProbStrategy
**Файл**: `src/strategies/CryptoProbStrategy.ts`

Directional торговля на основе P(UP) из empirical probability table. Overfit на train (btc1: +10 USDC), OOS catastrophic (-90 USDC). 150 ячеек prob table = слишком много степеней свободы.

### ProbTableStrategy
**Файл**: `src/strategies/ProbTableStrategy.ts`

Ранняя версия CryptoProbStrategy с other entry/exit logic. Те же проблемы с overfit.

---

## Ключевые выводы из исследования

1. **Hold до settlement > активная торговля** — exit logic, trail stops, market making на коротких рынках ухудшают результаты
2. **Zone filter 55-73¢** — единственный устойчивый фильтр, делает любую стратегию breakeven+
3. **15-мин рынки >> 5-мин** — больше momentum persistence, лучше signal-to-noise
4. **Минимум параметров** — 6 параметров (AdaptiveEntry) лучше 40+ (AS MM)
5. **Auto-selection** — один конфиг на рынок лучше двух отдельных запусков UP/DOWN
6. **EWMA trade tape > order book mid** — спреды в book часто 1¢/99¢, mid = 50¢ всегда

---

## Запуск бэктеста

```bash
cd apps/bot

# AdaptiveEntry (рекомендуется)
MODE=backtest CONFIG=configs/ae-auto-btc2-backtest.json npx tsx src/main.ts

# SelectiveEntry
MODE=backtest CONFIG=configs/sel-baseline-btc2-backtest.json npx tsx src/main.ts
```
