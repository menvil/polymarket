# @polymarket/pnl

## Обзор

Read-only CLI-аналитика реализованного PnL пользователя на Polymarket: тянет сделки из
CLOB API `/data/trades`, обогащает resolved-статусом рынков через CLOB API `/markets/
{conditionId}`, считает PnL по формуле "выручка от досрочного выхода + redemption от
resolution − стоимость входа", выводит краткую (по дням) или подробную (по рынкам и fills)
таблицу.

| Файл | Назначение |
|---|---|
| `main.ts` | Точка входа: оркестрирует fetch → enrich → calculate → render |
| `PnlConfig.ts` | `parseConfig()` — CLI-аргументы + ENV (`--from`/`--to`/`--mode`/`--json`) |
| `core/TradesFetcher.ts` | Пагинированная загрузка + нормализация сделок (taker/sub-maker) из CLOB API |
| `core/MarketEnricher.ts` | Дотягивает resolved-статус/winner-outcome по `conditionId` |
| `core/PnlCalculator.ts` | `MarketPnl[]`/`DailyPnl[]`/`PnlReport` — формула PnL |
| `renderers/DailyRenderer.ts` | Краткая таблица: одна строка на торговый день |
| `renderers/DetailedRenderer.ts` | Подробный отчёт: блок на день → таблица fills на рынок |
| `types.ts` | Сырые API-DTO (`RawTrade` и т.п.) + доменные типы отчёта |

```bash
# Краткая сводка за март
npx tsx --env-file=.env src/main.ts --from 2026-03-01 --to 2026-03-31

# Детальный отчёт за сегодня
npx tsx --env-file=.env src/main.ts --from 2026-04-08 --mode detailed

# JSON для дальнейшей обработки
npx tsx --env-file=.env src/main.ts --from 2026-03-01 --json
```

## Формула PnL на рынок

```
entry_cost     = Σ (BUY.size × BUY.price)
sell_proceeds  = Σ (SELL.notional − SELL.fee)     // досрочный выход, taker fee остаётся в USDC
redeem_value   = net_shares × resolvedPrice        // 0.0 или 1.0 при разрешении рынка
fee_usdc_eq    = Σ round5(size × feeRate × price × (1 − price))
buy_fee_shares = fee_usdc_eq / price                // BUY: комиссия конвертируется в токены
net_shares     = Σ BUY.effectiveSize − Σ SELL.size
net_pnl        = sell_proceeds + redeem_value − entry_cost
```

`MarketEnricher` — единственный надёжный способ определить resolved-статус конкретного
рынка по `conditionId` (Gamma API не поддерживает такой lookup) — без него `redeem_value`
не может быть вычислен для рынков, ещё не показавших `winner` в ответе CLOB API.

## Почему весь пакет — на сырых `number`/`string`, не VO

`types.ts`'s собственный докблок формулирует это прямо: "намеренно используем сырые числа
вместо domain Value Objects — это read-only аналитический скрипт, а не торговый движок".
Пакет не пишет ордера, не резервирует баланс, не участвует в risk-гейтах — единственный
потребитель домен-значимых величин (`price`/`size`/`fee_rate_bps`) — арифметика формулы
PnL внутри `PnlCalculator`, результат которой тут же превращается в текстовую/JSON-таблицу.
Это тот же класс решения, что применялся к другим read-only/reporting-путям на протяжении
всей миграции (например, `apps/bot/src/bot/MarketRotation.ts`'s диагностический
`_printMarketSummary()`) — VO здесь добавили бы церемонию без выгоды, поскольку нет ни
одного инварианта, который стоило бы защищать, кроме как в момент самого вычисления.

## Почему сделки нормализуются через `trader_side`/`maker_orders`

CLOB API `/data/trades` возвращает сделки с точки зрения тейкера. Если наш адрес выступил
суб-мейкером (найден в `maker_orders[i].maker_address`, а не на верхнем уровне ответа), то
настоящие параметры НАШЕЙ сделки (`asset_id`/`side`/`matched_amount`/`price`/`fee_rate_bps`/
`outcome`) берутся из соответствующего элемента `maker_orders[]`, а не с верхнего уровня —
иначе PnL считался бы по чужой (тейкерской) стороне сделки.

## Ссылки

- Источник сделок: Polymarket CLOB API `/data/trades` (L2-аутентификация, HMAC)
- Источник метаданных: CLOB API `/markets/{conditionId}` (публичный)
- ADR: `docs/architecture/boundary-contract.md`
- План миграции, Этап 11: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
