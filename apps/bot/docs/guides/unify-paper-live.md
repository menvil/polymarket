# План: Объединение логики paper и live режимов

## Проблема

Paper и live режимы имеют дублированный код для ротации рынков, подписки на токены,
settlement и discovery. Каждый баг фиксится дважды, расхождения создают новые баги.
main.ts — 5000+ строк, 80% логики идентичны между режимами.

## Цель

Один код для paper и live. Разница только в injected dependencies.

## Что объединять

### 1. MarketSlot — один тип

```typescript
interface MarketSlot {
  readonly instrumentId: InstrumentId;
  readonly marketId: MarketId;
  readonly asset: AssetId;
  readonly tokenIdStr: string;
  readonly expiresAtMs: number;
  readonly tickSize?: Price;           // live only, optional
  readonly minOrderSize?: Quantity;    // live only, optional
  readonly candidate: DiscoveredMarket | null;
  readonly strategy: IStrategy;
  readonly cryptoMeta: CryptoMarketMeta | undefined;
  readonly complementaryInstrumentId?: InstrumentId;
  readonly complementaryAsset?: AssetId;
  readonly outcomeIndex: 0 | 1;
  fillHistory: FillRecord[];
  partialAccum: Map<string, PartialAccum>;
  openedAt: number;
}
```

### 2. Mode-specific dependencies (DI)

```typescript
interface MarketRotationDeps {
  // Shared
  readonly logger: ILogger;
  readonly clock: IClock;
  readonly eventBus: IEventBus;
  readonly portfolioStore: IPortfolioStore;
  readonly accountId: AccountId;
  readonly wsAdapter: IPolymarketWsEmitter;      // один для обоих
  readonly cryptoPriceStore: CryptoPriceStore;
  readonly cryptoSubs: CryptoSubscriptionManager;
  readonly pendingChainlinkStrike: Map<string, number>;
  readonly engine: StrategyEngine;
  readonly marketCatalog: MarketCatalog;
  readonly recording?: RecordingInfra;
  readonly discoveryAdapter?: PolymarketMarketDiscoveryAdapter;
  readonly config: BotConfig;
  
  // Mode-specific (optional)
  readonly exchangeClient?: IExchangeClient;      // paper: registerMarket
  readonly orderReconciler?: OrderReconciler;      // live: reconcile after open
  readonly redeemer?: PolymarketRedeemer;          // live: auto-redeem
  readonly mode: 'paper' | 'live';
}
```

### 3. Unified functions

#### openMarket(candidate, deps) → boolean
- Comp token calculation (identical)
- Capital check (identical)
- EventStart check: 30s for both
- Create MarketSlot (one type)
- WS subscribe primary + comp (identical)
- Register in catalog + scheduler (identical)
- RTDS subscribe (identical)
- Recording open (identical)
- Paper-only: exchangeClient.registerMarket
- Live-only: orderReconciler.reconcile

#### closeMarket(tokenId, reason, deps) → void
- Unregister strategy (identical)
- WS unsubscribe (identical)
- Catalog remove (identical)
- Pending strike cleanup (identical)
- Settlement (identical logic, different price store → injected)
- Live-only: auto-redeem (fire-and-forget)
- Recording close (identical)
- OrderToSlot cleanup (identical)
- Comp token cleanup (identical)
- closedMarkets.add (identical)
- MARKET_CLOSED event (identical)

#### fillMarketSlots(deps) → void
- Get candidates from discovery (identical)
- Filter closed/active/tooSoon (identical)
- Diagnostic logging (add to both)
- Call openMarket (identical)
- Deferred RTDS cleanup (identical)

#### checkExpiredMarkets(deps) → void
- Reentrancy guard (identical)
- Find expired markets (identical)
- Close expired (identical)
- Fill slots (identical)
- Arb pairs: keep as optional extension in paper (if needed)

#### initialSetup(candidate, deps) → void
- Just call openMarket() instead of inline code
- Strike price resolution (identical, different store → injected)

### 4. DNS — already unified
Один блок в начале main.ts, до разветвления.

### 5. WS Adapter
Paper и live используют одинаковый `PolymarketWsAdapter`. Разница — URL и credentials.
В DI передаётся один `wsAdapter` объект.

## Текущие расхождения (баги от дублирования)

1. **Duration filter**: добавлен в live, забыт в paper, потом наоборот
2. **eventStart check**: 30s в одном, 10min в другом, 2min в третьем
3. **Duration check в openMarket**: блокировал все рынки, фиксился только в live
4. **Comp token при startup**: забыт в обоих, фиксился отдельно
5. **Diagnostic logging**: добавлен в live, отсутствует в paper
6. **Ghost ticks filter**: добавлен в WsAdapter (shared), но эффект разный

## Порядок реализации

### Phase 1: Extract shared functions — DONE
1. ✅ Создать `apps/bot/src/bot/MarketRotation.ts`
2. ✅ Определить `MarketSlot` и `MarketRotationDeps`
3. ✅ Перенести `openMarket`, `closeMarket`, `fillMarketSlots`, `checkExpiredMarkets`
4. ✅ Обе mode вызывают shared functions с разными deps

### Phase 2: Unify initial setup — PARTIAL
1. Initial setup: слоты создаются в `initialSlots` Map, затем копируются в `rotation.activeMarkets`
2. Начальный inline discovery код оставлен (создаёт первый слот до engine) — future: refactor в `rotation.openMarket()`

### Phase 3: Cleanup — DONE
1. ✅ Убраны дублированные типы (PaperMarketSlot, ActiveMarketSlot, PaperFillRecord, PaperPartialAccum)
2. ✅ Убраны дублированные helpers (registerMarketAndStrategy, printMarketSummary)
3. ✅ Удалён мёртвый код (~1550 строк)

### Phase 4: Test — TODO
1. Paper: запуск, ротация 3+ рынков, BUY/settlement
2. Live: запуск, ротация 3+ рынков, BUY/fill/settlement
3. compare-paper-live: 100% decision match
4. Backtest: результаты совпадают с pre-refactor

## Результат

- 1287 строк нового кода (MarketRotation.ts)
- ~1550 строк удалённого дублированного кода
- main.ts: 5475 → 3899 строк (-1576)
- TypeScript компилируется без новых ошибок
- Арб-режим (paper only): кастомный expiry check сохранён inline
- Единый eventStart порог: 30 сек для paper и live (было: paper 10 мин, live 30 сек)
