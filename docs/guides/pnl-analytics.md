# PnL Analytics (`apps/pnl`)

Standalone-скрипт для анализа реализованного PnL по **resolved** рынкам Polymarket.

## Как запускать

```bash
cd apps/pnl

# Краткая сводка по дням за март
npx tsx --env-file=.env src/main.ts --from 2026-03-01 --to 2026-03-31

# Детальный отчёт за сегодня
npx tsx --env-file=.env src/main.ts --from 2026-04-08 --mode detailed

# JSON для дальнейшей обработки
npx tsx --env-file=.env src/main.ts --from 2026-03-01 --json
```

> `.env` — тот же файл что у бота (`apps/bot/.env`). Можно использовать symlink или передать путь явно через `--env-file`.

## Аргументы CLI

| Аргумент       | Обязательный | Описание                                    | Пример           |
|----------------|:------------:|---------------------------------------------|------------------|
| `--from`       | ✅            | Начало периода (UTC)                        | `2026-03-01`     |
| `--to`         | ❌            | Конец периода (UTC, по умолчанию сегодня)   | `2026-03-31`     |
| `--mode`       | ❌            | `daily` (по умолчанию) или `detailed`       | `--mode detailed`|
| `--json`       | ❌            | Вывод JSON вместо форматированного текста   | `--json`         |

## ENV-переменные

| Переменная                  | Обязательная | Описание                               |
|-----------------------------|:------------:|----------------------------------------|
| `PRIVATE_KEY`               | ✅            | Приватный ключ кошелька (0x...)        |
| `POLYMARKET_API_KEY`        | ✅            | Polymarket L2 API key                  |
| `POLYMARKET_API_SECRET`     | ✅            | Polymarket L2 API secret               |
| `POLYMARKET_API_PASSPHRASE` | ✅            | Polymarket L2 API passphrase           |
| `FUNDER_ADDRESS`            | ❌            | Адрес фандера (для POLY_PROXY кошельков)|

## Источники данных

| Источник                            | Использование                          |
|-------------------------------------|----------------------------------------|
| CLOB API `/data/trades`             | История сделок пользователя (L2 auth) |
| Gamma API `/markets?conditionId=..` | Метаданные рынков (public)            |

## Почему только resolved рынки?

Для prediction markets PnL можно посчитать только после settlement:

- **Открытый рынок** → цена токена ещё может измениться, PnL нереализованный
- **Closed рынок** → Polymarket выставил `closed=true`, `outcomePrices=["1","0"]` или `["0","1"]`
- Наш токен получает `resolvedPrice = 1.0` (победа) или `0.0` (поражение)

## Формула PnL

```
entry_cost    = Σ (BUY.size × BUY.price)
sell_proceeds = Σ (SELL.size × SELL.price)    # досрочный выход до резолюции
net_shares    = Σ BUY.size − Σ SELL.size      # акции ушедшие в settlement
redeem_value  = net_shares × resolvedPrice    # 0.0 или 1.0
fees          = Σ (notional × fee_rate_bps / 10_000)

net_pnl       = sell_proceeds + redeem_value − entry_cost − fees
roi           = net_pnl / entry_cost × 100%
```

## Пример вывода `--mode daily`

```
=== PnL Report: 2026-03-01 — 2026-03-31  [resolved markets only] ===

  DATE         MKTS   W    L   ENTRY COST    REDEEM     FEES    NET PNL    ROI
  ────────────────────────────────────────────────────────────────────────────
  2026-03-01     4    3    1     $142.50    $161.00   -$0.43   +$18.07  +12.7%
  2026-03-02     6    4    2     $198.20    $220.10   -$0.59   +$21.31  +10.7%
  ...
  ────────────────────────────────────────────────────────────────────────────
  TOTAL         87   67   20   $2,841.30  $3,046.20   -$8.52  +$196.38   +6.9%

  Win rate:   77.0%  (67/87)
  Avg PnL:    +$2.26 per market
  Best day:   2026-03-07  +$34.90  (5W/0L)
  Worst day:  2026-03-10  -$47.67  (1W/2L)
  Total fees: $8.52
```

## Пример вывода `--mode detailed`

```
━━━━━━━━━━━━━━━━━━━━━━  2026-03-01  ━━━━━━━━━━━━━━━━━━━━━━

[WIN]  Bitcoin Up or Down — Mar 1, 1:05–1:10 PM ET
       Token: UP  →  Resolved: UP ✓  (won $1.00)
  ┌──────────────────────────────────────────────────────────────┐
  │  #  TIME      SIDE   SIZE    PRICE   NOTIONAL   FEE          │
  │  1  13:04:22  BUY   100.0   0.620    $62.00   $0.02         │
  │  2  13:04:45  BUY    50.0   0.640    $32.00   $0.01         │
  └──────────────────────────────────────────────────────────────┘
  Entry:   150.0 shares × avg 0.627  =  -$94.00
  Redeem:  150.0 shares × $1.00      =  +$150.00  (winner)
  Fees:                                  -$0.03
  ────────────────────────────────────────────────────────────────
  Net PnL:  +$55.97   ROI: +59.5%

[LOSS]  Bitcoin Up or Down — Mar 1, 1:15–1:20 PM ET
        Token: DOWN  →  Resolved: DOWN ✗  (lost $0.00)
  ┌──────────────────────────────────────────────────────────────┐
  │  #  TIME      SIDE   SIZE    PRICE   NOTIONAL   FEE          │
  │  1  13:14:10  BUY    80.0   0.590    $47.20   $0.01         │
  │  2  13:14:55  SELL   20.0   0.560   +$11.20   $0.00   [!]   │
  └──────────────────────────────────────────────────────────────┘
  Entry:   80.0 shares × avg 0.590   =  -$47.20
  Sold:    20.0 shares × avg 0.560   =  +$11.20  (early exit)
  Redeem:  60.0 shares × $0.00       =   $0.00   (loser)
  Fees:                                  -$0.01
  ────────────────────────────────────────────────────────────────
  Net PnL:  -$36.01   ROI: -76.3%

  ────────────────────────────────────────────────────────────────
  Day: 4 markets │ 3W / 1L (75%) │ Entry: $142.50 │ PnL: +$18.07 (+12.7%)
```

## Архитектура

```
apps/pnl/src/
├── main.ts                  ← CLI: аргументы, оркестрация
├── PnlConfig.ts             ← парсинг ENV + CLI-аргументов
├── types.ts                 ← все интерфейсы (RawTrade, MarketMeta, MarketPnl, ...)
├── core/
│   ├── TradesFetcher.ts     ← пагинация /data/trades (CLOB API, L2 auth)
│   ├── MarketEnricher.ts    ← метаданные рынков (Gamma API, public)
│   └── PnlCalculator.ts     ← расчёт PnL, группировка по дням
└── renderers/
    ├── format.ts            ← вспомогательные функции форматирования
    ├── DailyRenderer.ts     ← краткая таблица по дням
    └── DetailedRenderer.ts  ← подробный блочный вывод по рынкам
```

## Добавление новых фильтров

В будущем можно добавить в CLI:

- `--market 0xabc...` — фильтр по конкретному рынку
- `--asset-id 123...` — фильтр по токену
- `--csv output.csv` — экспорт в CSV
- `--min-pnl 10` — показывать только рынки с PnL > $10
