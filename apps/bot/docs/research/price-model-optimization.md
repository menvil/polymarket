# Оптимизация модели ценообразования

## Текущее состояние

SelectiveEntry использует эвристические фильтры (zone, delta%, tau, spread, deltaAccel) калиброванные на ~200 рынках. Зона 55-68¢ — грубое приближение. Стратегия не имеет формальной модели вероятности.

## Цель

Построить модель `P(BTC > strike | current_price, tau, sigma)` которая точнее оценивает вероятность чем средний участник Polymarket orderbook. Разница между нашей оценкой и рыночной ценой = edge.

---

## 1. Собственный Price Oracle

### Зачем
Chainlink агрегирует цены через цепочку: **Биржа → Data Aggregator (Kaiko/CryptoCompare) → Chainlink node → медиана → блокчейн**. Задержка 1-3с. Мы можем срезать до одного шага: **Биржа → наш агрегатор**.

### Источники Chainlink
Ноды Chainlink (Chainlayer, LinkPool, Fiews, Everstake, T-Systems и др.) тянут данные через:
- CoinGecko, CryptoCompare, Amberdata, Kaiko, BraveNewCoin — data aggregators
- Те в свою очередь тянут с Binance, Coinbase, Kraken и др.

### Наши прямые источники (WebSocket feeds)

**Tier 1 — обязательные:**
- **Binance** (`wss://stream.binance.com`) — самый большой объём BTC/USDT
- **Coinbase** (`wss://ws-feed.exchange.coinbase.com`) — основной источник Chainlink для BTC/USD
- **Kraken** (`wss://ws.kraken.com`) — в Chainlink node network

**Tier 2 — дополнительные:**
- **OKX**, **Bybit** — большой азиатский объём, могут лидировать по движениям
- **CME futures** (через feed provider) — институционалы двигают цену тут первыми

3-4 биржи достаточно. Больше — diminishing returns.

### Что собирать
- **Trade tape** (каждая сделка: price, size, timestamp) — для VWAP и vol estimation
- **Top-of-book** (best bid/ask) — для mid и spread
- НЕ full orderbook — слишком много данных, малый edge

### Агрегация
- Volume-weighted mid: `Σ(mid_i × volume_i) / Σ(volume_i)`
- Или median — устойчив к outliers (одна биржа отстала)

---

## 2. Модель вероятности (Binary Option Pricing)

### Формула
```
P(UP) = Φ((ln(S/K) + (r - σ²/2)τ) / (σ√τ))
```
Где:
- `S` — текущая цена BTC (наш агрегатор)
- `K` — strike price
- `σ` — realized volatility (ключевой input)
- `τ` — время до expiry (секунды)
- `r` ≈ 0 (drift на 5 минутах пренебрежимо мал)
- `Φ` — CDF нормального распределения

### Ключевой input: волатильность (σ)
Кто точнее оценивает σ, тот точнее знает fair price.

Источники σ:
- **Realized vol** из последних 5-30 минут Binance tick data
- **Order flow imbalance** — больше покупок → momentum → корректировка drift
- **Cross-exchange signals** — цена на Bybit двинулась раньше Binance

### Почему рынок может быть неправ
- Участники не считают vol в реальном времени
- Книга тонкая — один крупный ордер двигает mid
- Market makers ставят с запасом (широкий спред)
- Mid между bid/ask не обязательно fair price

### Пример edge
Strike = $66800, tau = 120s, BTC = $66830 (delta +$30), σ ≈ $15/мин:
- BTC должен упасть на $30 чтобы пересечь strike = ~2σ за 2 минуты
- Наша модель: P(UP) ≈ 85-90%
- Рынок показывает mid = 72¢
- Edge = 13-18¢

---

## 3. Валидация модели (Backtesting Framework)

### Данные для сбора (на каждый рынок, каждую секунду)
1. **Наша агрегированная цена** (Binance + Coinbase + Kraken)
2. **Chainlink цена** (каждый RTDS update)
3. **Polymarket orderbook** (top-of-book каждые 1-5с)
4. **Polymarket trade tape** (каждая сделка)
5. **Resolution outcome** (UP/DOWN)

### Метрика: Brier Score
```
Brier = Σ(forecast_i - outcome_i)² / N
```
- `forecast_i` — наша P(UP) в момент i
- `outcome_i` — 1 если UP, 0 если DOWN
- Ниже = лучше

### Процесс валидации
Имея непрерывные данные за неделю, для каждой секунды каждого рынка:

1. **Snapshot на время T**: цена BTC, vol за N минут, Polymarket orderbook
2. **Наша модельная P(UP)** через формулу с realized vol
3. **Рыночная P(UP)**: Polymarket mid в тот момент
4. **Outcome**: что реально произошло

Тысячи точек данных. Brier score покажет кто точнее — наша модель или рынок.

### Итерация
- Менять окно vol (5 мин vs 10 мин vs 15 мин)
- Добавлять drift estimation
- Добавлять order flow signals
- Каждый раз проверять: улучшился ли Brier score?

Полностью data-driven, без подгонки на одном дне.

---

## 4. Эмпирические зоны входа

С большим объёмом данных (1000+ рынков) можно перейти от фиксированных порогов к data-driven зонам:

### Heatmap: (mid, tau) → WR%
Вместо прямоугольника 55-68¢ — кривая оптимального входа:
- mid=62 при tau=180s → WR=82%
- mid=62 при tau=120s → WR=71%
- mid=55 при tau=240s → WR=68%

### Feature engineering для модели

**Базовые features:**
- Длительность рынка (5min vs 15min)
- Underlier (BTC vs ETH vs SOL) — разная волатильность
- Время суток (US session vs Asia) — разная ликвидность
- Delta при входе, vol regime

**Microstructure features (биржи — Binance/Coinbase/Kraken):**
- **Book depth** — суммарный размер bid/ask на N уровнях. Тонкая книга = легко двинуть цену
- **Book imbalance** — `(bid_volume - ask_volume) / (bid_volume + ask_volume)`. Сильный bid imbalance → давление вверх
- **Trade flow imbalance** — % buy vs sell trades за последние N секунд (aggressive buying/selling)
- **Trade velocity** — количество сделок в секунду. Ускорение = начало движения
- **VWAP deviation** — текущая цена vs VWAP за окно. Отклонение = momentum или reversion
- **Spread dynamics** — как менялся spread за последние 30-60с. Расширение = неопределённость

**Microstructure features (Polymarket):**
- **Polymarket book depth** — сколько стоит на bid/ask ближайших уровнях
- **Polymarket book imbalance** — давление покупателей vs продавцов UP/DOWN токенов
- **Polymarket trade flow** — кто агрессор (buyer vs seller), размеры сделок
- **Polymarket spread dynamics** — расширение спреда = маркетмейкеры уходят (неуверенность)
- **UP/DOWN корреляция** — как двигаются оба токена. Расхождение = арбитражный сигнал
- **Large order detection** — крупные ордера в книге (informed trader?)

**Динамические features (временные окна):**
- Все метрики считать за несколько окон: 10с, 30с, 60с, 120с
- Изменение метрики (delta imbalance за 30с) важнее чем абсолютное значение
- Momentum features: accelerating imbalance = сильный сигнал

**Контекст конфигурации рынка:**
- Каждая статистическая точка привязана к полной конфигурации: цена, vol, book state, flow state
- Это позволяет кластеризовать рынки по "режимам" (trending, mean-reverting, volatile, quiet)
- Модель учится: в каком режиме какие фильтры работают

Условная вероятность: `P(WIN | mid, tau, delta, vol, timeOfDay, bookImbalance, tradeFlow, ...)` вместо фиксированных порогов.

Нужно 2000-5000 рынков чтобы не переобучиться. С microstructure features — ближе к 5000 (больше dimensions).

---

## 5. Другие assets (ETH, SOL, XRP)

### Потенциальные плюсы
- Шире спреды → можно входить дешевле → больше маржа на win
- Менее эффективный рынок → больше edge для модели

### Потенциальные минусы
- Fill rate ниже (меньше ликвидности)
- WR может быть ниже (менее предсказуемый рынок)
- Chainlink обновляется реже
- EWMA менее стабильная (меньше трейдов в tape)

### EV баланс
```
EV = WR × avgWin - (1-WR) × avgLoss
```
Если WR падает с 80% до 60%, а avgWin растёт с 35¢ до 48¢ — EV может быть хуже. Нужно проверять на данных.

---

## 6. Архитектура системы

```
Binance WS ─────┐
Coinbase WS ─────┼→ PriceAggregator → собственный "oracle" price
Kraken WS  ──────┘         │
                            ├→ BinaryOptionPricer → P(UP), P(DOWN)
Chainlink RTDS ─────────────┤
                            ├→ DataRecorder (всё пишем для backtesting)
Polymarket WS ──────────────┘
                            ├→ BrierScoreTracker → online validation
                            └→ Strategy → place/cancel orders
```

---

## 7. План реализации

### Phase 1: Сбор данных (1-2 недели)
- [ ] Подключить Binance WS (`btcusdt@trade`, `btcusdt@bookTicker`) в data collector
- [ ] Подключить Coinbase WS (matches + ticker)
- [ ] Записывать параллельно с Chainlink и Polymarket
- [ ] Набрать 1000+ рынков

### Phase 2: Offline валидация
- [ ] Реализовать BinaryOptionPricer (формула + realized vol)
- [ ] Скрипт: для каждого рынка посчитать модельную P(UP) vs рыночную
- [ ] Brier score: наша модель vs Polymarket mid
- [ ] Определить оптимальное окно vol (5/10/15 мин)

### Phase 3: Online интеграция
- [ ] PriceAggregator в бот (замена/дополнение Chainlink)
- [ ] Стратегия использует модельную P(UP) вместо эвристических фильтров
- [ ] A/B: старая стратегия vs модельная (paper параллельно)

### Phase 4: Оптимизация
- [ ] Эмпирические зоны из heatmap
- [ ] Cross-exchange signals
- [ ] Тестирование на ETH/SOL markets
