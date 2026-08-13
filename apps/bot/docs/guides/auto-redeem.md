# Авто-клейм (Auto-Redeem) settled позиций

## Проблема

После settlement крипто-рынка (BTC Up/Down) winning-токены нужно конвертировать в USDC.e ("claim" / "redeem"). Токены хранятся на **proxy-кошельке** (`0x326A...`), а не на EOA — прямой вызов CTF не работает.

## Решение

Gasless авто-клейм через **Builder Relayer** — не требует MATIC для газа.

### Архитектура

```
┌─────────────┐     L2 auth      ┌────────────┐
│ AutoRedeemer │ ───────────────► │  CLOB API  │ ← GET /data/trades
│  (фоновый)  │                  │            │ ← GET /markets/{id}
│             │                  └────────────┘
│             │  Builder auth     ┌──────────────────┐
│             │ ────────────────► │ Builder Relayer   │ ← POST /submit
│             │                  │ relayer-v2.pm.com │
│             │                  └────────┬─────────┘
│             │                           │ gasless
│             │                           ▼
│             │                  ┌──────────────────┐
│             │                  │ CTF Contract      │
│             │                  │ redeemPositions() │
│             │                  └──────────────────┘
└─────────────┘
```

### Два набора API keys

| Тип | Назначение | Env vars |
|-----|-----------|----------|
| **CLOB API keys** | Запрос trades, ордера | `POLYMARKET_API_KEY`, `_SECRET`, `_PASSPHRASE` |
| **Builder API keys** | Gasless redeem через Relayer | `BUILDER_API_KEY`, `_SECRET`, `_PASSPHRASE` |

### Компоненты

1. **`AutoRedeemer`** (`src/bot/AutoRedeemer.ts`) — фоновый сервис
   - Проверяет settled рынки каждые 5 минут
   - Автоматически редимит все найденные settled позиции
   - Кэширует уже обработанные conditionIds

2. **`PolymarketRedeemer`** (`src/bot/PolymarketRedeemer.ts`) — инлайн redeem
   - Вызывается сразу при settlement рынка (fire-and-forget)
   - Для немедленного клейма в момент settlement

## Настройка

### 1. Создание Builder API keys

```bash
cd apps/bot
npx tsx scripts/create-builder-keys.ts
```

Скрипт выведет 3 значения. Добавьте их в `.env`:

```env
BUILDER_API_KEY=019d495d-...
BUILDER_API_SECRET=16xFjuX...
BUILDER_API_PASSPHRASE=75a73a...
```

### 2. Запуск

Auto-redeemer запускается автоматически в `live` режиме бота:

```bash
MODE=live CONFIG=configs/sel-paper-5min.json npx tsx src/main.ts
```

В логах:

```
[INFO] Auto-redeemer initialized (gasless via Builder Relayer)
[INFO] Background auto-redeemer started (checks every 5 min)
```

### 3. Ручной тест

```bash
# Одноразовая проверка всех settled рынков
npx tsx scripts/test-auto-redeem.ts

# Тест redeem конкретного рынка
npx tsx scripts/test-redeem.ts <conditionId>
```

## Как работает AutoRedeemer (каждые 5 минут)

1. `GET /data/trades` (L2 auth) → все trades пользователя → уникальные conditionIds
2. Для каждого conditionId: `GET /markets/{id}` → проверяем `closed === true`
3. Если settled и не в кэше:
   - Кодируем calldata: `CTF.redeemPositions(USDC.e, 0x00, conditionId, [1,2])`
   - Отправляем через Builder Relayer (`PROXY` mode)
   - Ждём `STATE_MINED`
   - Добавляем в кэш `_redeemedConditions`

## Контракты (Polygon Mainnet)

| Контракт | Адрес |
|----------|-------|
| CTF (Conditional Tokens) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| USDC.e (Bridged USDC) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |

## Почему gasless, а не прямой вызов CTF?

Токены на Polymarket хранятся на **proxy-кошельке** (`0x326A...`), а не на EOA (`0x68C3...`). Прямой вызов `CTF.redeemPositions` от EOA не найдёт токенов. Builder Relayer выполняет транзакцию от имени proxy, оплачивая газ.

## Файлы

| Файл | Назначение |
|------|-----------|
| `src/bot/AutoRedeemer.ts` | Фоновый сервис (periodic check + redeem) |
| `src/bot/PolymarketRedeemer.ts` | Инлайн redeem при settlement |
| `scripts/create-builder-keys.ts` | Создание Builder API keys |
| `scripts/test-redeem.ts` | Тест redeem одного рынка |
| `scripts/test-auto-redeem.ts` | Тест одного цикла авто-клейма |

## Ограничения

- BTC Up/Down = стандартный CTF (не NegRisk). Для NegRisk рынков нужен другой контракт
- Если транзакция revert-нётся (нет токенов / уже redeemed) — это нормально, логируется как debug

## Патченные зависимости

`@polymarket/builder-abstract-signer/dist/factory.js` — duck-type detection для ethers v6 совместимости (оригинал проверяет `instanceof ethers.Wallet` для ethers v5).
