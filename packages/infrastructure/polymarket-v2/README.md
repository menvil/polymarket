# @polymarket/polymarket-v2

Polymarket V2 boundary: наблюдения Polymarket V2 client/bindings
`@polymarket/client` → canonical `ExternalMessage` → общий `ExternalMessageBus`,
canonical discovery рынков и authenticated account-state observation для
сверки аккаунта.

## 1. Назначение

`PolymarketSource` превращает public-наблюдения Polymarket V2 client/bindings в canonical
ExternalMessages и публикует их в общий bus внешнего контура:

```text
@polymarket/client (Polymarket V2 client: Gamma / CLOB WS / RTDS)
        ↓
PolymarketSource            ← этот пакет
        ↓
ExternalMessage             ← canonical {type, payload, metadata}
        ↓
ExternalMessageBus          ← общий bus контура (инъецируется)
```

Транспортное поведение (WebSocket, reconnect, backoff, heartbeat, decode)
целиком принадлежит Polymarket V2 client — пакет НЕ строит второй framework
поверх него.

## 2. Boundary: SDK event = source-native payload

Payload каждого сообщения — БУКВАЛЬНО объект, который вернул SDK
(`StandardMarketEvent`, `CryptoPricesBinanceEvent`,
`CryptoPricesChainlinkEvent`), тот же reference, без remapping и без
выбрасывания полей. Vendor discriminators (`topic`, `type`) сохраняются
внутри payload — они нужны будущим Recorder/Reader/SemanticAdapter.

`ExternalMessage.type` — НАШ routing discriminator контура
(`POLYMARKET_MARKET`, `POLYMARKET_CRYPTO_BINANCE`,
`POLYMARKET_CRYPTO_CHAINLINK`); он дополняет vendor-поля, а не заменяет их.

## 3. Без семантики в data plane

Здесь НЕТ конверсии в `OrderBook`/`Trade`/VO/ApplicationEvent — это работа
`PolymarketSemanticAdapter`, который является подписчиком того же bus.

Границы зависимостей у трёх плоскостей пакета РАЗНЫЕ, и все закреплены
тестом `__tests__/contour-boundary.test.ts`:

**Data plane** (`PolymarketSource`, `PolymarketExternalMessage`) — ровно
восемь разрешённых импортов, ни Domain, ни Application среди них нет:

```text
@polymarket/bindings/subscriptions   @polymarket/message-bus
@polymarket/client                   @polymarket/messages
@polymarket/external-message-bus     @polymarket/logger
@polymarket/external-messages        @polymarket/result
```

**Control plane** (`PolymarketMarketDiscovery`,
`PolymarketCryptoUpDownClassifier`, `PolymarketRtdsFeeds`,
`PolymarketFinalization`) — те же восемь ПЛЮС ровно восемь своих:

```text
@polymarket/bindings/gamma     typed vendor-модели каталога
@polymarket/market             canonical Domain Market — результат работы
@polymarket/ports              контракт снимка (MarketDiscoverySnapshot)
@polymarket/value-objects      Money/Ratio наблюдений
@polymarket/ids                MarketId/InstrumentId/VenueId/CryptoAssetId
@polymarket/time               IClock (детерминизм обхода в тестах)
@polymarket/timestamp          Timestamp расписания
decimal.js                     Decimal-арифметика внутри границы VO
```

**Account plane** (`PolymarketAccountVenueStateSource`,
`PolymarketClobRefreshedBalanceReader`, `PolymarketTakerFeeRateResolver`,
`polymarketAccountMapping` и точка входа `account`) — свой закрытый список
из десяти импортов, без шин и без discovery:

```text
@polymarket/account-reconciliation   порт IAccountVenueStateSource и его DTO
@polymarket/fill                     FillMapper — общее с приватным WS правило FillId
@polymarket/ids                      AccountId/OrderId/MarketId/AssetId
@polymarket/value-objects            Money/Quantity/OutcomePrice
@polymarket/timestamp                время исполнения
@polymarket/result                   Result
@polymarket/client                   типы secure-клиента (BaseSecureClient)
@polymarket/client/actions           типы запросов CLOB-actions
@polymarket/bindings                 типы enum TradeStatus и брендов SDK
@polymarket/bindings/clob            типы OpenOrder/ClobTrade/BalanceAllowanceResponse
```

От SDK account plane берёт только ТИПЫ: runtime-код SDK (ESM-only) в пакете
не загружается — так же, как в двух других плоскостях. Действие
`updateBalanceAllowance` и enum `AssetType` передаёт composition root.
`@polymarket/fill` разрешён ТОЛЬКО этой плоскости.

Списки ПОЛНЫЕ и защищены от расхождения тестом
`README перечисляет ВСЕ границы полностью`: он читает этот файл и требует,
чтобы каждый разрешённый специфаер здесь присутствовал. Неполный список
здесь был бы хуже отсутствующего — читатель полагался бы на него как на
границу.

Исключение для control plane — не послабление, а его прямая работа: задача
Discovery в том и состоит, чтобы превратить vendor-запись в canonical
`Market` ДО границы Application, и делать это, не зная доменного типа,
невозможно. Обеим плоскостям по-прежнему запрещены trading/semantic/
exchange-пакеты, а `@polymarket/market-discovery` (Filter/Scorer) запрещён
control plane отдельным правилом: owner selection живёт НАД портом.

## 4. Один bus

Source публикует в инъецированный общий `ExternalMessageBus` — собственного
Polymarket-bus НЕ существует. Целевая схема контура:

```text
PolymarketSource ──┐
                   │
CexSource ─────────┼──→ ONE ExternalMessageBus
                   │
OtherSource ───────┘
```

## 5. Будущие consumers

```text
ExternalMessageBus
 ├── Recorder (N-002)
 ├── PolymarketSemanticAdapter (N-00x)
 └── Market/Header consumers
```

## 6. Recorder rule

Recorder персистит `message.payload` (source-native SDK event) НЕИЗМЕНЁННЫМ,
внутри archive envelope `{type, ingress, payload}` (Replayable Raw Format
V2). Canonical live-конверт и `MessageMetadata` на диск не идут: из metadata
в архив попадает только исторический `ingress` (`runId`/`sequence` + момент
наблюдения), а `messageId`/`correlationId`/`causationId`/`createdAt` —
нет. Сериализуемость payload (JSON.stringify без потерь, с сохранением
discriminators) закреплена тестами и live smoke.

## 7. Replay invariant

Будущий Reader реконструирует `ExternalMessage` из записанного payload
(свежая metadata своего runtime) и кормит ТОТ ЖЕ SemanticAdapter, что и
live-режим. Именно поэтому payload обязан оставаться самодостаточным:
содержать vendor discriminators и не требовать нашей metadata для
понимания данных.

## Использование

```typescript
import { createPublicClient } from '@polymarket/client';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { LiveHighResolutionClock, MessageMetadataGenerator } from '@polymarket/messages';
import { PolymarketSource } from '@polymarket/polymarket-v2';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';

// Composition root: ОДИН client, ОДИН bus, ОДИН generator на процесс
const client = createPublicClient();
const bus = new ExternalMessageBus<PolymarketExternalMessage>();
const metadataGenerator = new MessageMetadataGenerator({
  clock: new LiveClock(),
  highResolutionClock: new LiveHighResolutionClock(),
});
const logger = new ConsoleLogger(new LiveClock(), LogLevel.INFO);
const source = new PolymarketSource({ client, bus, metadataGenerator, logger });

// Подписки (каналы, реально используемые системой)
await source.subscribeMarket([yesTokenId, noTokenId]);
await source.subscribeCryptoPrices('prices.crypto.binance', ['btcusdt']);
await source.subscribeCryptoPrices('prices.crypto.chainlink', ['btc/usd']);

// Consumers подписываются на typed union
bus.subscribe('POLYMARKET_MARKET', (message) => {
  // message.payload: StandardMarketEvent (narrowing компилятором)
});

// Graceful shutdown: source закрывает СВОИ подписки; bus закрывает владелец
await source.close();
await bus.close();
```

## Policy отказов

- `Err` от `bus.publish` → source логирует ошибку, переходит в терминальное
  состояние `failed` и закрывает все свои подписки (никаких скрытых retry:
  отклонение canonical bus — отказ контура доставки, а не транзиентный сбой).
- Падение SDK-итератора → та же терминальная ветка; unhandled rejections
  исключены (pump полностью изолирован).
- Ошибки `subscribe*` (SDK `SubscribeError`) пробрасываются вызывающему
  как есть — SDK-ошибки и есть Infrastructure-ошибки, второй набор
  идентичных обёрток не заводится.
- SDK-handle, разрешившийся после `close()`/отказа (медленный `subscribe`),
  немедленно закрывается и не регистрируется; вызов отклоняется той же
  ошибкой состояния.
- `close()` (и `close()` отдельной подписки) безопасно await-ить из
  обработчика этого же bus: pump выходит из ожидания `publish` по сигналу
  закрытия, цикл handler → close → pump → publish → handler не образуется;
  прерванное сообщение уже в очереди движка и доставляется текущим drain-ом.

## Характеризация SDK

Полные parity-таблицы (старый wire/RTDS/Gamma против SDK 0.6.0), решение
«SDK event = V2 source-native payload» и результаты live smoke —
в `docs/sdk-parity.md`. Development-only smoke: `scripts/smoke.ts`
(`npx tsx packages/infrastructure/polymarket-v2/scripts/smoke.ts`).

## Market Discovery (control plane)

Помимо data-plane `PolymarketSource`, пакет содержит control-plane
`PolymarketMarketDiscovery`: обнаружение технически поддержанного universe
через `listMarkets`/`fetchEvent` и выдачу его наружу как **canonical
`MarketDiscoverySnapshot`** с доменными `Market` внутри.

```typescript
const refreshed = await discovery.refresh();   // true → снимок актуален
universe.replace(discovery.getSnapshot());     // Application: только Market
```

Что он делает и чего НЕ делает:

- ✅ окно ближайших рынков, технический gate торгуемости, классификация
  семейства `CRYPTO_UP_DOWN`, ТОЧНОЕ `startsAt` из события, canonical
  mapping, детерминированный порядок и дедупликация;
- ❌ owner selection: ключевые слова, минимальная ликвидность/спред,
  предпочтения по активу и длительности, top-N. Это Policy НАД портом.

Vendor-объекты границу порта не пересекают. RTDS-фиды, settlement-правило и
typed Gamma-модели остаются доступны Infrastructure через
`prepareMarket(marketId)` — без сети, из данных обхода.

Discovery ничего НЕ публикует в `ExternalMessageBus` — Gamma остаётся query
path. Подробности (пагинация, классификатор, кэш событий, стоимость окна,
маппинг полей) — в `docs/market-discovery-v2.md`; live-проверка —
`scripts/discovery-smoke.ts`.

## Account-state observation (account plane)

`PolymarketAccountVenueStateSource` — production-адаптер порта
`IAccountVenueStateSource` из `@polymarket/account-reconciliation` на
официальном secure-клиенте SDK. Это request/response-порт для сверки:

```text
AccountVenueStateScope
        ↓
PolymarketAccountVenueStateSource
        ├── refreshed collateral                (весь аккаунт)
        ├── scoped token balances               (каждый актив scope, ноль явно)
        ├── account-wide open orders            (все страницы SDK)
        └── complete trades of scoped markets   (каждый рынок scope, все страницы)
        ↓
AuthoritativeAccountState
```

```text
PolymarketAccountVenueStateSource
  НЕ публикует ExternalMessage
  НЕ публикует ApplicationEvent
```

Обе шины остаются неизменными: адаптер вызывается сверкой, а не подписан
на bus. Создание `createSecureClient()`, ключи и `process.env` — забота
composition root; адаптер принимает готовые зависимости:

Точка входа — отдельная, `@polymarket/polymarket-v2/account`: корень пакета
account plane НЕ re-экспортирует, чтобы потребители data/control-плоскостей
не загружали стек приватного состояния аккаунта.

```typescript
import { AssetType } from '@polymarket/client';
import { updateBalanceAllowance } from '@polymarket/client/actions';
import {
  PolymarketAccountVenueStateSource,
  PolymarketClobRefreshedBalanceReader,
  PolymarketStaticTakerFeeRateResolver,
} from '@polymarket/polymarket-v2/account';

// ставки taker-комиссии рынков scope (crypto up/down — 0.07)
const takerFeeRates = PolymarketStaticTakerFeeRateResolver.create([[conditionId, 0.07]]);
if (!takerFeeRates.ok) throw takerFeeRates.error;

const source = PolymarketAccountVenueStateSource.create(
  { venueId: KnownVenues.POLYMARKET, accountId, makerAddress: funderAddress },
  {
    client: secureClient,
    balanceReader: PolymarketClobRefreshedBalanceReader.fromSdk(secureClient, {
      updateBalanceAllowance,
      assetTypes: AssetType,
    }),
    takerFeeRates: takerFeeRates.value,
  },
);
```

Главное:

- ❌ `listPositions`, сканирование всей истории сделок, предположения о
  стратегии, сборка `Portfolio`, сверка и мутации;
- ✅ балансы — `updateBalanceAllowance` (обновить CLOB-взгляд и прочитать), а
  не голый `fetchBalanceAllowance`; отказ — `Err`, никогда не ноль.
  `PolymarketClobRefreshedBalanceReader` — refreshed CLOB balance reader:
  it MUST NOT be treated as independently verified on-chain truth.
  Authoritative-гарантию даёт внедрённый reader: композиция, которой нужна
  физическая истина инвентаря, может заменить или обернуть его on-chain
  верификатором без изменений `PolymarketAccountVenueStateSource`;
- ✅ сделки рынков scope разбираются ТЕМ ЖЕ `FillMapper`, что и приватный WS:
  **REST и приватный WS дают одну canonical-идентичность `Fill`**;
- ✅ комиссия TAKER-исполнения — по ставке `PolymarketTakerFeeRateResolver`
  рынка сделки: REST `feeRateBps` приходит `"0"` и на `Fill.fee` не влияет;
  отказ резолвера — `Err` прохода;
- ⚠️ collateral отдаётся в canonical `USDC`, хотя collateral Polymarket
  CLOB V2 — pUSD: решение о canonical-представлении открыто и обязано быть
  принято до того, как matcher начнёт менять `Portfolio`;
- ✅ fail closed: непереводимый статус, противоречивая заявка, неопознанное
  владение maker-заявкой, оборванная пагинация — `Err` всего прохода.

Подробности и NEXT / BLOCKERS (время исполнения REST ↔ WS, pUSD/USDC,
ставка комиссии в приватном WS, on-chain проверка балансов) —
`docs/account-venue-state-source.md`.

## Тесты

```bash
npm test          # typecheck тестов + jest
npm run build     # tsc -b (с project references)
npm run lint      # eslint src
```
