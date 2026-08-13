# Защита SELL-ордеров от рассинхрона балансов

## Проблема

В live-торговле наблюдался отказ CLOB при SELL:

```
HTTP 400: "not enough balance / allowance: the balance is not enough
          -> balance: 9557200, order amount: 9560000"
```

То есть ордер хотел продать 9.56 токенов, а on-chain было только 9.5572 — дефицит **0.029%** (≈ 2800 микроединиц).

### Почему это происходит

Стратегия (`CexLeadLagStrategy._checkExitSignalFirst`) при выходе считает размер:

```typescript
const size = Decimal.min(targetExitQty, data.availableTokenQty)
  .toDecimalPlaces(2, Decimal.ROUND_DOWN);
```

`data.availableTokenQty` приходит из `portfolio.availableTokenQuantity(instrumentId)` — это **event-sourced** проекция Portfolio, собранная из Fill-событий. Она корректна относительно нашего учёта, но:

1. Polymarket при MINT/MERGE outcome-токенов может округлить on-chain баланс вниз
2. Частичный fill мог прийти чуть меньше заявленного size
3. Между WS fill event и on-chain settlement бывает микрозазор

В итоге Portfolio показывает 9.56, а on-chain — 9.5572.

### Почему существующая защита не срабатывала

В инфраструктуре есть `PolymarketBalancePolicy.checkSellBalance` (`PolymarketBalancePolicy.ts:262`) с готовой логикой: при дефиците < 1% он возвращает `ok:true` + `suggestedSize` = фактический остаток, округлённый вниз до 2 знаков. Но он вызывается только через `PolymarketPortfolioAdapter.canPlaceOrder` → `PolymarketRestAdapter.placeOrder`.

Боевой путь для стратегий: `PlaceOrderUseCase → PolymarketExchangeClientAdapter.submitOrder → PolymarketExecutionAdapter.postOrder` — **минует** canPlaceOrder.

## Решение: два независимых слоя

### L1 — Pre-flight check в адаптере (основной)

**Файл:** `packages/infrastructure/polymarket/adapters/PolymarketExchangeClientAdapter.ts`

В конструкторе `PolymarketExchangeClientAdapter` добавлен опциональный `balancePolicy`. Перед каждым SELL:

```typescript
const check = await this._balancePolicy.checkBalance({
  tokenId,
  side: 'sell',
  price: params.price.value().toNumber(),
  size: params.size.value().toNumber(),
});

if (!check.ok) return Err(ExchangeError);
if (check.suggestedSize < originalSize) {
  // Используем on-chain balance округлённый до 2 dp
  effectiveSize = Quantity.of(new Decimal(check.suggestedSize));
}
```

**Критическая деталь:** `balancePolicy` передаётся **БЕЗ `portfolioProjector`**, чтобы `checkSellBalance` ушёл в `balanceProvider.getOutcomeBalance()` (on-chain через Balance API), а не в event-sourced проектор (те же данные, что у стратегии).

Wire-up в `apps/bot/src/bot/buildLiveInfra.ts`:

```typescript
const onChainBalancePolicy = new PolymarketBalancePolicy(balanceProvider, logger);
// portfolioProjector НЕ передаём — нужен именно on-chain источник

const exchangeClient = new PolymarketExchangeClientAdapter(
  executionAdapter,
  logger,
  userTradesClient,
  onChainBalancePolicy,
);
```

**Стоимость:** +1 HTTP GET (Balance API) на каждый SELL. Приемлемо, так как SELL-ордера редкие (не spam-paтая MM-стратегия).

### L2 — Retry-on-rejection в ExecutionEngine (safety net)

**Файл:** `packages/application/strategy/src/ExecutionEngine.ts`

При SELL rejection парсим текст ошибки:

```typescript
const match = message.match(/balance:\s*(\d+),\s*order amount:\s*(\d+)/i);
```

Если дефицит < 1% и размер retry-size > 0 — **одна** повторная попытка с новым `orderId` и размером `floor(onChainBalance / 1e6 * 100) / 100`.

Retry не рекурсивен — inline в `_executePlace`. Это гарантирует максимум одну дополнительную попытку на rejection.

## Покрытие сценариев

| Сценарий | Ловит L1 | Ловит L2 |
|----------|----------|----------|
| Штатный full-exit после BUY fill, dust 0.01-0.1% | Да | Да (fallback если L1 не сконфигурирован) |
| Race: balance упал между L1 check и postOrder | Нет | Да |
| Реальная нехватка токенов (>1% deficit) | Нет (reject) | Нет (cooldown, без retry) |
| BUY order (нехватка USDC) | Нет (L1 только для SELL) | Нет (L2 только для SELL) |

## Диагностика

### Логи L1

При adjustment:
```
WARN  SELL size adjusted to on-chain balance (tiny deficit)
  tokenId, originalSize, adjustedSize, deltaTokens, deficitPercent
```

При failure:
```
WARN  SELL pre-flight balance check failed
  tokenId, reason, required, available
```

Счётчик: `exchangeClient.stats.sellDustAdjustCount`.

### Логи L2

При retry:
```
WARN  ExecutionEngine: SELL retry with on-chain adjusted size
  originalSize, adjustedSize, deficitPct, previousError
```

При успехе после retry:
```
INFO  ExecutionEngine: order placed
  retriedAfterDust: true, originalSize, size (=adjusted)
```

Счётчик: `executionEngine.stats.sellDustRetryCount`.

## Метрики для мониторинга

- `sellDustAdjustCount` / `sellDustRetryCount` растущий → расхождение event-sourced vs on-chain стало системным, требует анализа корневой причины
- Если L1 счётчик > 0 и L2 счётчик = 0 — нормальная ситуация (L1 ловит всё)
- Если L2 счётчик > 0 — срабатывает race condition, но ордера успешно ретраются

## Почему именно 1%

Порог `_SELL_DUST_RETRY_MAX_DEFICIT = 0.01` — эвристика:

- **Dust от settlement** обычно 0.01-0.1% — легко вписывается
- **Настоящая нехватка позиции** (например, забыли про residual от прошлого ордера) — обычно > 10%, retry только замаскировал бы багу
- Тот же порог в `PolymarketBalancePolicy.checkSellBalance` — для согласованности поведения L1 и L2

## Связанные файлы

- `packages/infrastructure/polymarket/adapters/PolymarketExchangeClientAdapter.ts` — L1
- `packages/infrastructure/polymarket/rest/policies/PolymarketBalancePolicy.ts` — общая логика проверки
- `packages/application/strategy/src/ExecutionEngine.ts` — L2
- `apps/bot/src/bot/buildLiveInfra.ts` — wire-up