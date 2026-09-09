# PnL-аналитика (`apps/pnl`)

Read-only CLI: сколько мы заработали или потеряли на Polymarket за период.

```bash
# Краткая сводка по дням
npx tsx apps/pnl/src/main.ts --from 2026-08-01 --to 2026-08-31

# Подробный отчёт: блок на день → сделки по каждому рынку
npx tsx apps/pnl/src/main.ts --from 2026-09-08 --mode detailed

# JSON для дальнейшей обработки
npx tsx apps/pnl/src/main.ts --from 2026-08-01 --json

# Включить ещё не закрытые позиции
npx tsx apps/pnl/src/main.ts --from 2026-08-01 --include-open
```

Нужен один параметр окружения — `WALLET_ADDRESS` (или `FUNDER_ADDRESS`).

## Почему больше нет ни приватного ключа, ни API-ключей

Прежняя версия ходила в CLOB `/data/trades` с L2-подписью: держала
`PRIVATE_KEY` и тройку `POLYMARKET_API_*`, поднимала signer, считала HMAC.
Для инструмента, который только читает и печатает таблицу, это лишние
полномочия: ключ, способный подписывать ордера, лежал в окружении ради
отчёта.

Позиции и активность на Polymarket **публичны**. `createPublicClient()`
из официального SDK читает их по адресу кошелька без единого секрета:

```typescript
const client = createPublicClient();       // никаких креденшелов
await client.listActivity({ user, start, end, type: [ActivityType.TRADE] });
await client.listClosedPositions({ user });
```

Проверено: `createSecureClient` требует **настоящий** signer даже когда
готовые `credentials` переданы — он всё равно зовёт `getAddress` +
`signTypedData` и идёт в `/auth/api-key`. Поэтому «читать без ключей»
возможно только на публичном пути, и мы на нём.

## Откуда берётся число

```text
netPnl  = realizedPnl позиции          ← считает площадка
entryCost    = avgPrice × totalBought  ← из позиции
sellProceeds = Σ SELL.amount           ← из ленты сделок
netShares    = Σ BUY.shares − Σ SELL.shares
redeemValue  = netShares × curPrice    ← 0.0 или 1.0 после резолюции
roi          = netPnl / entryCost
```

`netPnl` **не пересчитывается**. Прежняя версия воспроизводила формулу
«выручка от выхода + redemption − стоимость входа» вместе с моделью
комиссий:

```text
fee_usdc_eq    = Σ round5(size × feeRate × price × (1 − price))
buy_fee_shares = fee_usdc_eq / price     // BUY: комиссия удерживается в токенах
```

Публичный контур ставку `feeRateBps` не отдаёт. Подставить
предполагаемую — значит разойтись с реальностью незаметно для читателя
отчёта, поэтому берём число площадки: это ровно то, что показывает сайт,
и оно уже включает комиссии.

Следствие: колонка **FEES печатает `—`, а не `$0.00`**. Ноль читался бы
как «комиссий не было», а правда — «величина не отделена от PnL».

## Что потерялось при переходе и как вернуть

| было на аутентифицированном пути | сейчас |
| --- | --- |
| `feeRateBps` и пофилловая комиссия | `—` (внутри `realizedPnl`) |
| роль MAKER/TAKER по каждому fill | всегда `TAKER` |
| разбор sub-maker сделок | не нужен: лента отдаёт события от лица кошелька |

Вернуть можно, добавив `createSecureClient` + `listAccountTrades` — но это
снова потребует signer (ethers или viem) и API-креденшелов. Делать это
стоит только если понадобится именно комиссионная детализация.

## Устройство

| файл | назначение |
| --- | --- |
| `main.ts` | оркестрация: activity → positions → calculate → render |
| `PnlConfig.ts` | CLI-аргументы и `WALLET_ADDRESS` |
| `core/ActivityFetcher.ts` | сделки из `listActivity()`, фильтр `type` на сервере |
| `core/PositionsFetcher.ts` | позиции с `realizedPnl` из `listClosedPositions()` |
| `core/PnlCalculator.ts` | агрегация по рынкам и дням |
| `renderers/` | краткая и подробная таблицы, `fmtOptional` для `—` |
| `types.ts` | типы отчёта; wire-формат держит SDK |

Две особенности API, на которые опирается код:

- **Combo-сделки отбрасываются.** `listActivity` отдаёт и их (`isCombo: true`),
  но они торгуют позицию протокола v2, а не outcome-токен рынка.
- **Период фильтруется у нас.** Ни `listClosedPositions`, ни `listPositions`
  не принимают границы времени — отбор по `timestamp` идёт после загрузки.

## Почему сырые `number`, а не Value Objects

Это read-only аналитика, а не торговый движок: она не пишет ордера, не
резервирует баланс, не участвует в risk-гейтах. Единственный потребитель
величин — арифметика агрегации, результат которой тут же превращается в
таблицу. Защищать здесь нечего, а VO добавили бы церемонию без выгоды.
