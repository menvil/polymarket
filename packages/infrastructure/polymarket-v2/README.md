# @polymarket/polymarket-v2

Polymarket V2 ingress boundary: наблюдения официального SDK
`@polymarket/client` → canonical `ExternalMessage` → общий `ExternalMessageBus`.

## 1. Назначение

`PolymarketSource` превращает public-наблюдения официального SDK в canonical
ExternalMessages и публикует их в общий bus внешнего контура:

```text
@polymarket/client (официальный SDK: Gamma / CLOB WS / RTDS)
        ↓
PolymarketSource            ← этот пакет
        ↓
ExternalMessage             ← canonical {type, payload, metadata}
        ↓
ExternalMessageBus          ← общий bus контура (инъецируется)
```

Транспортное поведение (WebSocket, reconnect, backoff, heartbeat, decode)
целиком принадлежит официальному SDK — пакет НЕ строит второй framework
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

## 3. Без семантики

Здесь НЕТ конверсии в `OrderBook`/`Trade`/VO/ApplicationEvent — это работа
`PolymarketSemanticAdapter`, который появится ПОСЛЕ Recorder checkpoint и
будет подписчиком того же bus. Пакет не зависит от Domain/Application
(закреплено тестом `__tests__/contour-boundary.test.ts`).

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

Будущий Recorder персистит `message.payload` (source-native SDK event),
а НЕ canonical envelope/`MessageMetadata`. Сериализуемость payload
(JSON.stringify без потерь, с сохранением discriminators) закреплена
тестами и live smoke.

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

## Характеризация SDK

Полные parity-таблицы (старый wire/RTDS/Gamma против SDK 0.6.0), решение
«SDK event = V2 source-native payload» и результаты live smoke —
в `docs/sdk-parity.md`. Development-only smoke: `scripts/smoke.ts`
(`npx tsx packages/infrastructure/polymarket-v2/scripts/smoke.ts`).

## Тесты

```bash
npm test          # typecheck тестов + jest (22 теста)
npm run build     # tsc -b (с project references)
npm run lint      # eslint src
```
