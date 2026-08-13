# Alpha Ideas Backlog — BTC 5-min Up/Down

Список потенциальных источников альфы для бинарных опционов BTC на 5-мин окне (Polymarket). Отсортирован по ожидаемой ценности и стоимости внедрения. Текущий baseline: `CexLeadLagStrategy` (CEX-consensus residual vs Chainlink).

## Приоритет 1 — внедрить в первую очередь

### 1.1. Perp Order Flow Imbalance (OFI)

- **Источник**: Binance / Bybit / OKX BTCUSDT-PERP, L1/L2 book deltas, 1-секундные bucket'ы.
- **Гипотеза**: дельта объёмов bid/ask опережает спот на секунды — лучший микроструктурный предиктор на горизонте 5–60 сек.
- **Как применить**: второй сигнал в `SignalEvaluator`, weighted vote с CEX-consensus residual. Требовать согласия двух источников для входа.
- **Стоимость**: средняя — нужно подписаться на full book stream, считать OFI инкрементально.
- **Ожидаемый эффект**: +20–40% к Sharpe микроструктурных стратегий по литературе.

### 1.2. Realized Volatility gate

- **Источник**: BTC mid 1-сек тики за последние 30–60 сек.
- **Гипотеза**: при низкой RV сигнал 0.5 bps — шум; при высокой — значим.
- **Как применить**: блокировать вход при `RV(30s) < p20` исторического распределения. Или: использовать как множитель к `signalThresholdBps` / sizing.
- **Стоимость**: низкая (uses already-collected tape).

### 1.3. Polymarket order-flow sanity check

- **Источник**: собственный orderbook + tape.
- **Гипотеза**: если рынок уже >5¢ улетел в сторону нашего сигнала за 2 сек — alpha уже в цене, EV отрицательный.
- **Как применить**: блокировать вход при `priceChange(2s) > 5c` в направлении сигнала.
- **Стоимость**: низкая, инфраструктура уже есть.

## Приоритет 2 — режимные фильтры / sizing modulators

### 2.1. Perp funding + basis как regime-switch

- **Источник**: Binance/Bybit/OKX funding rate (8h), perp-spot basis.
- **Гипотеза**: extreme funding → mean-reversion риск, уменьшаем size.
- **Как применить**: множитель к `orderSize` (например, при `|funding| > p90` → size × 0.5).
- **Стоимость**: низкая, обновляется раз в 8 часов.

### 2.2. Auto-correlation regime

- **Источник**: 5–10 сек BTC returns rolling AR(1).
- **Гипотеза**: AR(1) > 0 → trending режим, сигнал работает; < 0 → mean-reverting, выключаем.
- **Как применить**: ON/OFF переключатель или вес сигнала.
- **Стоимость**: низкая.

### 2.3. Time-to-expiry gamma effect

- **Текущее состояние**: уже частично реализовано через `tauTighteningStartSec` / `tauTighteningMinMultiplier`.
- **Идея расширения**: dynamic размер позиции в последние 60 сек — урезать до 0 при `t < 30s` если в позиции, не открываться при `t < 90s`.

## Приоритет 3 — лидирующие/опережающие инструменты

### 3.1. Perp-spot premium (mark-index spread)

- **Гипотеза**: микро-расхождение perp vs spot опережает спот на 100–500 мс.
- **Аналог CEX-consensus**, но с лидирующим инструментом.

### 3.2. CME BTC futures basis

- **Окно**: только в рабочие часы CME.
- **Особенность**: институциональный поток, медленнее, направленный.

### 3.3. Cross-venue lead-lag

- **Гипотеза**: на разных биржах latency разная; одни биржи стабильно опережают.
- **Как применить**: измерять lead-lag pairwise, использовать «лидера» как первичный сигнал.

## Приоритет 4 — опционы (Deribit)

### 4.1. DVOL / IV term-structure

- **Гипотеза**: резкий рост 1d IV без движения спота → ожидание импульса.
- **Применение**: слабо предиктивен по знаку, годится для **sizing**, не для direction.

### 4.2. 0DTE/1DTE skew + gamma profile

- **Гипотеза**: pinning к крупным страйкам в последние минуты к экспирации.
- **Проверить**: корреляция между близостью к крупному OI-страйку и скоростью движения по `t→T`.

### 4.3. Dealer GEX (gamma exposure)

- **Гипотеза**: положительный GEX → mean-reversion режим; отрицательный → trending.
- **Применение**: regime filter макроуровня, не микро.

## Приоритет 5 — стейблы (хвостовые события)

### 5.1. USDT/USD off-peg

- **Источник**: Curve 3pool, Coinbase USDT/USD.
- **Гипотеза**: дисконт USDT → leverage stress → давление вниз на BTC.
- **Применение**: emergency-shutdown switch, очень редкое событие.

### 5.2. USDC/USDT cross на Binance + funding

- **Применение**: индикатор capital flight, regime filter.

### 5.3. Stablecoin supply delta (Tether/Circle mint/burn)

- **Вердикт**: слишком медленно для 5-мин, не использовать.

## Микроструктура Polymarket

### 6.1. UP/DOWN imbalance в моменте сигнала

- **Гипотеза**: согласие CEX-сигнала и Polymarket-flow → подтверждение; расхождение → возможный fade.
- **Применение**: ortho-фильтр поверх CEX-сигнала.

### 6.2. Last-trade aggressor side (1–2 сек)

- **Применение**: подтверждение направления.

### 6.3. Cancel-replace rate

- **Применение**: proxy на «информационный» поток vs мусорные ордера.

## Что НЕ делать

- Stablecoin supply delta — слишком медленно.
- DVOL/GEX как micro-сигнал — не масштабируется на 5-мин окно (только режимный фильтр).
- On-chain метрики (whale tx, exchange inflow) — слишком медленно для 5-мин.
- Sentiment / Twitter / news API — шум, latency 10+ сек.
