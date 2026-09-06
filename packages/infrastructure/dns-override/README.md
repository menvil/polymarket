# @polymarket/dns-override

Обход заблокированного или подменённого DNS провайдера: резолвит нужные
хосты через DoH и ставит monkey-patch на `node:dns`.

## Зачем отдельный пакет

Подмена DNS — забота **процесса**, а не биржевого адаптера. Патч ставится на
`node:dns.lookup` и потому действует на весь процесс целиком: и на `undici`
(fetch официального SDK), и на `new WebSocket()`, и на любой другой сетевой
клиент.

Раньше эти классы жили внутри `@polymarket/exchange` — legacy V1-адаптера
площадки. Из-за этого сборщик, которому нужен ТОЛЬКО обход DNS, тянул за
собой весь legacy-стек и переставал собираться вместе с ним. Пакет вынесен,
чтобы эта связь исчезла; `@polymarket/exchange/dns` остался тонким
реэкспортом для существующих импортов.

Зависимости: только `@polymarket/logger` и node-builtins.

## Как работает

```text
1. DoH-запрос напрямую по IP к 1.1.1.1 / 1.0.0.1
   (провайдерский DNS в цепочке не участвует)
2. Полученные IP складываются в IpStore с round-robin ротацией
3. dns.lookup подменяется: хост из списка → IP из store,
   любой другой хост → оригинальный lookup
```

Запрос к DoH идёт **по IP**, а не по имени, поэтому сам резолвер не требует
работающего DNS. Последней ступенью стоит системный `dns.resolve4` — она
спасает, если DoH недоступен, но в сценарии «провайдер отравил DNS» вернёт
ровно тот ответ, от которого мы уходим.

Подмена не требует отключения проверки TLS: DoH отдаёт **настоящий** IP,
SNI берётся из hostname, сертификат валидируется штатно.

## Использование

```typescript
import { DnsOverride } from '@polymarket/dns-override';

const dnsOverride = new DnsOverride(logger);
await dnsOverride.install([
  'gamma-api.polymarket.com',
  'clob.polymarket.com',
  'ws-subscriptions-clob.polymarket.com',
  'ws-live-data.polymarket.com',
]);
// ... работа ...
dnsOverride.uninstall();
```

Отказ `install()` не обязан ронять процесс: вызывающий вправе продолжить с
системным DNS (так и делает `applyProcessBootstrap` коллектора).
