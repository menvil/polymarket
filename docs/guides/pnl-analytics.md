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

| Источник                            | Использование                                      |
|-------------------------------------|----------------------------------------------------|
| CLOB API `/data/trades`             | История сделок пользователя (L2 auth)             |
| CLOB API `/markets/{conditionId}`   | Метаданные рынков: resolved-статус, winners (public) |

> **Важно:** Gamma API не поддерживает lookup по `conditionId` — игнорирует параметр.
> CLOB API `/markets/{conditionId}` — единственный надёжный способ получить
> `tokens[].winner` для определения resolved-статуса.

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

Реальный вывод за 2026-04-08. Рынок `Bitcoin Up or Down - April 8, 10:55AM-11:00AM ET`:
3 fill'а покупки Down-токена через cross-outcome matching (мы — суб-мейкеры), рынок
resolved UP → позиция проиграла 100%.

```
━━━━━━━━━━━━━━━━━━━━━━  2026-04-08  ━━━━━━━━━━━━━━━━━━━━━━

  [LOSS]  Bitcoin Up or Down - April 8, 10:55AM-11:00AM ET
         Token: Down  →  Resolved: Down ✗  (lost $0.00)
  ┌────────────────────────────────────────────────────────────────────┐
  │  #   TIME      OUTCOME  SIDE   SIZE    PRICE   NOTIONAL  FEE       │
  ├────────────────────────────────────────────────────────────────────┤
  │  1   14:58:13  Down     BUY    1.3     0.630   $0.83     $0.08     │
  │  2   14:58:13  Down     BUY    2.6     0.630   $1.62     $0.16     │
  │  3   14:58:13  Down     BUY    1.1     0.630   $0.71     $0.07     │
  └────────────────────────────────────────────────────────────────────┘
  Entry:   5.0 shares × avg 0.630  =  -$3.15
  Redeem:  5.0 shares × $0.00      =  +$0.00  (loser)
  Fees:                                         -$0.32
  ──────────────────────────────────────────────────────────────────────
  Net PnL:  -$3.46   ROI: -110.0%

  [WIN]   Bitcoin Up or Down - April 8, 10:20AM-10:25AM ET
         Token: Up  →  Resolved: Up ✓  (won $1.00)
  ┌────────────────────────────────────────────────────────────────────┐
  │  #   TIME      OUTCOME  SIDE   SIZE    PRICE   NOTIONAL  FEE       │
  ├────────────────────────────────────────────────────────────────────┤
  │  1   14:21:51  Up       BUY    5.0     0.620   $3.10     $0.31     │
  └────────────────────────────────────────────────────────────────────┘
  Entry:   5.0 shares × avg 0.620  =  -$3.10
  Redeem:  5.0 shares × $1.00      =  +$5.00  (winner)
  Fees:                                         -$0.31
  ──────────────────────────────────────────────────────────────────────
  Net PnL:  +$1.59   ROI: +51.3%

  ────────────────────────────────────────────────────────────
  Day: 17 markets │ 9W / 8L (53%) │ Entry: $52.09 │ PnL: -$12.31 (-23.6%)
```

> **Примечание по ROI:** значения вида `-110%` означают что убыток превысил вложенный
> капитал из-за комиссий (lost $3.15 + fees $0.32 = $3.46 при входе $3.15).
> Это математически корректно при высоких fee_rate_bps.

## Нормализация fills

Polymarket CLOB API возвращает трейды с точки зрения тейкера. В prediction markets
возможен **cross-outcome matching**: покупка Down-токена может совпасть с покупкой
Up-токена контрагента. В этом случае:

- Верхний уровень трейда: данные тейкера (BUY Up @ 0.63)
- `maker_orders[i]`: наши данные (BUY Down @ 0.37), где `maker_orders[i].maker_address == ourAddress`

`TradesFetcher` автоматически нормализует каждый трейд:

1. Если `trader_side === 'TAKER'` → берём верхний уровень
2. Иначе → ищем наш адрес в `maker_orders[i].maker_address`, берём `asset_id`, `side`, `matched_amount`, `price` оттуда

Результат: `NormalizedFill[]` — массив наших реальных fills.

## Архитектура

```
apps/pnl/src/
├── main.ts                  ← CLI: аргументы, оркестрация
├── PnlConfig.ts             ← парсинг ENV + CLI-аргументов
├── types.ts                 ← все интерфейсы (RawTrade, NormalizedFill, MarketMeta, ...)
├── core/
│   ├── TradesFetcher.ts     ← пагинация /data/trades + нормализация fills (CLOB API, L2 auth)
│   ├── MarketEnricher.ts    ← метаданные рынков (CLOB API /markets/{id}, public)
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
