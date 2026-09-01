# Канонический Market при регистрации стратегии

## Проблема

`StrategyScheduler.register()` принимает каноническую доменную сущность `Market`
(`@polymarket/market`). Ротация рынков и бэктест-раннеры её под рукой не имели и
подсовывали заглушку:

```typescript
// БЫЛО — так делать нельзя
const marketStub = { expiresAt } as Parameters<typeof engine.scheduler.register>[0]['market'];
```

Каст стирает проверку типов, поэтому код компилировался. Но в рантайме у такого
«рынка» нет ни `outcomes`, ни `id`, ни `question`. Стратегия, которая читает
`snapshot.market.outcomes`, получает `undefined` и молча уходит в свою ветку
fallback.

Именно так `BinanceProbMMStrategy` определяла сторону токена: поиск исхода не
находил ничего **никогда**, срабатывал fallback `this._isUpToken = true`, и
DOWN-токен торговался как UP.

## Решение

Один общий конструктор `apps/bot/src/bot/buildCanonicalMarket.ts`, который
собирает настоящий `Market` из данных, уже доступных в точке регистрации:

```typescript
import { buildCanonicalMarket } from './buildCanonicalMarket.js';

const marketResult = buildCanonicalMarket({
  marketId: slot.marketId,
  question: slot.candidate?.question,
  instrumentId: slot.instrumentId,
  complementaryInstrumentId: slot.complementaryInstrumentId,
  outcomeIndex: slot.outcomeIndex,
  expiresAtMs: slot.expiresAtMs,
  eventStartMs: slot.cryptoMeta?.eventStartTimeMs,
  cryptoSymbol: slot.cryptoMeta?.rtdsFilter,
});
if (!marketResult.ok) {
  logger.error('Failed to build canonical market', {
    marketId: String(slot.marketId),
    error: marketResult.error.message,
  });
  return false;
}

await engine.scheduler.register({ /* ... */ market: marketResult.value });
```

### Шаги алгоритма

1. Проверяем комплементарный инструмент — без него двух исходов нет.
2. Нормализуем крипто-символ в `CryptoAssetId`.
3. Считаем расписание: `expiresAt` обязателен, `startsAt` — точное начало события
   либо `expiresAt - FALLBACK_MARKET_DURATION_MS`.
4. Раскладываем исходы: торгуемый инструмент — на позицию `outcomeIndex`,
   комплементарный — на встречную. Метка позиции 0 — `Up`, позиции 1 — `Down`.
5. Отдаём всё в `Market.create()` — доменные инварианты проверяет сущность.

### Точки вызова

| Файл | Источник данных | Поведение при `Err` |
| --- | --- | --- |
| `src/bot/MarketRotation.ts` | `MarketSlot` (discovery-кандидат) | лог + `return false` |
| `src/bot/runMultiMarketBacktest.ts` | `readSnapshotMeta` + Gamma `rawMarket` | лог + `return null` |
| `src/main.ts` (single-market backtest) | `readSnapshotMeta` + Gamma `rawMarket` | `logger.fatal` + `process.exit(1)` |

## Почему это сделано так

### Почему конструктор возвращает `Result`, а не бросает

Регистрация стратегии — не место для исключений: у каждой точки вызова свой
способ отменить открытие рынка (`false` / `null` / `process.exit`). `Result`
позволяет вызывающему обработать отказ его собственной идиомой.

### Почему у каждого fallback именно такое значение

- **`question` → `String(marketId)`.** Вопрос не участвует в торговых решениях,
  но `Market.create()` требует непустую строку. ID рынка — единственная
  подстановка, которая ничего не выдумывает и однозначна в логах.
- **Нет `complementaryInstrumentId` → `Err`.** Второй CTF-токен нельзя вывести из
  одного лишь торгуемого `tokenId`. Придуманный `instrumentId` означал бы
  маршрутизацию ордеров в несуществующий инструмент.
- **Нет `eventStartMs` → `expiresAtMs - FALLBACK_MARKET_DURATION_MS` (1 час).**
  Часовая серия — доминирующее семейство крипто-рынков Polymarket. Значение
  влияет только на `startsAt` и производную `crypto.duration`; торговый контур
  читает `market.expiresAt` и отдельное поле снапшота `eventStartMs`. Fallback
  существует ради строгого инварианта `startsAt < expiresAt`.
- **`eventStartMs >= expiresAtMs` → `Err`.** Это противоречие в данных площадки,
  а не пробел в них; «починка» сдвигом дала бы расписание, которого не существует.
- **Неизвестен крипто-актив → `Err`.** `family: 'CRYPTO_UP_DOWN'` обязывает
  указать актив; «btc по умолчанию» — ложь о том, на чём строится модель цены.
- **`state` → `MarketState.active()`.** Стратегия регистрируется только на рынке,
  который площадка отдаёт как торгуемый; подтверждённого закрытия у нас нет.
- **`slug` не заполняется.** Домену он не нужен, а строить слаг из вопроса значит
  выдумывать идентификатор площадки.

### Почему `cryptoSymbol`, а не готовый `CryptoAssetId`

Планировщик выводит `StrategyEntry.cryptoAsset` из `cryptoSymbol` функцией
`normalizeCryptoAsset()`. Если бы конструктор принимал уже нормализованный актив,
он мог бы разойтись с планировщиком. Поэтому на вход идёт **тот же сырой символ**
(обычно `cryptoMeta.rtdsFilter`), а нормализует его **та же самая функция**:
`normalizeCryptoAsset` экспортирована из `@polymarket/strategy` специально для
этого. Своя копия алгоритма здесь была бы источником молчаливого расхождения —
`market.crypto.asset` и `StrategyEntry.cryptoAsset` указывали бы на разные активы
без единой ошибки компиляции.

## Конвенция меток исходов

`outcomeIndex 0 = Up`, `outcomeIndex 1 = Down` — конвенция уже действовала в
`MarketRotation.openMarket`, `readSnapshotMeta` и `BacktestEngine`. Метки `Up` и
`Down` распознают `isUpLikeOutcome`/`isDownLikeOutcome` в
`src/strategies/BinanceProbMMStrategy.ts`, поэтому строки заданы дословно.
