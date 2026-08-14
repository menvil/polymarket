> **Статус: устарел, все 10 findings закрыты.**
> Перенесено из корня репозитория в `docs/reviews/` в рамках Этапа 0.5 плана миграции
> (`/Users/menvil/.claude/plans/synthetic-swimming-heron.md`). Исходно план называл живыми
> только 2 косметических пункта (typo в `Portfolio.ts`, пример в `portfolio-entity.md`) —
> при повторной проверке 2026-08-04 выяснилось, что фактически закрыты все 10, в основном
> более ранними коммитами "hardening" на этой же ветке (`git log`: `f5f16bff`, `02febf83`,
> `e765f302` и др.), не требуют доп. действий:
>
> 1. `Portfolio.ts` — typo "positon"→"position": исправлено (docstring `reserveTokensForOrder`
>    уже содержит "position").
> 2. `Portfolio.ts` `releaseTokenReservation` — валидация `qty > 0`: добавлена (guard в начале метода).
> 3. `Portfolio.ts` `reserveTokensForOrder` — валидация `qty > 0`: добавлена (guard в начале метода).
> 4. `OrderBook.ts` `applyFullState` — поведение при отсутствующем `timestamp`: задокументировано
>    в `@remarks` как намеренное (сохранение `_lastUpdatedAt` при backtest-воспроизведении).
> 5. `OrderUpdateHandler.ts` — риск потери событий между `pullEvents`/`save`/`publishAll`:
>    файл полностью переписан в тонкий адаптер (WS → `EventBus`), доменная логика с
>    `pullEvents`/`save` перенесена в `UpdateOrderStatusUseCase`/`OrderUpdateOrchestrator` —
>    класс с исходной проблемой больше не существует.
> 6. `TradeTape.test.ts` — тест "readonly массив" без проверки иммутабельности: переименован
>    в "возвращает массив (readonly — compile-time гарантия TypeScript)", ложная claim снята.
> 7. `OrderBookHistory.test.ts` — не хватало assert на `h.size()` в boundary-тесте `maxAgeMs`:
>    добавлено `expect(h.size()).toBe(2)` с комментарием про строгое неравенство на границе.
> 8. `EventBus.ts` — несогласованность `publish`/`publishAll` на границе `_maxQueueSize`:
>    оба метода теперь используют единую семантику "итоговый размер > maxQueueSize".
> 9. `portfolio-entity.md:253` — пример проверял `tokenReservations.size` вместо конкретной
>    записи: исправлено на `tokenReservations.has(instrumentId)`.
> 10. `BalanceAllocator.ts` — отсутствие проверки существования allocation перед мутацией
>     баланса: пакет `packages/application/balance-allocator` удалён из репозитория целиком,
>     класс нигде не встречается — проблема снята вместе с кодом.
>
> Ниже — исходный вывод CodeRabbit без изменений (для истории).

Starting CodeRabbit review in plain text mode...

Connecting to review service
Setting up
Analyzing
Reviewing

============================================================================
File: packages/domain/entities/portfolio/src/Portfolio.ts
Line: 549 to 553
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/domain/entities/portfolio/src/Portfolio.ts around lines 549 - 553, Fix the typo in the documentation example in Portfolio's comment: change "positon" to "position" in the code example that references reserveTokensForOrder and availableTokenQuantity to ensure the docstring for Portfolio.reserveTokensForOrder is correct and readable.

============================================================================
File: packages/domain/entities/portfolio/src/Portfolio.ts
Line: 602 to 630
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/domain/entities/portfolio/src/Portfolio.ts around lines 602 - 630, The releaseTokenReservation method lacks validation that qty is positive; add a guard at the start of releaseTokenReservation (mirroring reserveTokensForOrder) to return an Err InvalidBalanceError when qty.lte(0) (or qty.isNegative/qty.isZero) with a clear message and context (instrumentId, requested qty), preventing negative qty from incorrectly increasing reservations; keep existing logic for checking current.lt(qty) and use withTokenReservations and tokenReservations as before.

============================================================================
File: packages/domain/entities/portfolio/src/Portfolio.ts
Line: 556 to 580
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/domain/entities/portfolio/src/Portfolio.ts around lines 556 - 580, In reserveTokensForOrder, add validation to ensure the qty argument is strictly positive (qty.gt(0)); if qty is zero or negative, return an Err (e.g., new InvalidBalanceError) with a clear message and context (include instrumentId and the invalid qty) instead of proceeding to update tokenReservations; keep the existing flow for the positive-qty case and reuse the same Result/InvalidBalanceError pattern used later in the method.

============================================================================
File: packages/domain/market-data/order-book/src/OrderBook.ts
Line: 189 to 192
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/domain/market-data/order-book/src/OrderBook.ts around lines 189 - 192, The applyFullState method currently preserves the previous _lastUpdatedAt when the timestamp argument is omitted; change the logic in applyFullState so that if timestamp is provided it sets this._lastUpdatedAt = timestamp, otherwise it explicitly clears it (this._lastUpdatedAt = undefined) to avoid misleading stale timestamps; if preserving the old timestamp was intentional, instead add a clear JSDoc remark on applyFullState explaining that omission preserves the prior_lastUpdatedAt.

============================================================================
File: packages/application/handlers/src/OrderUpdateHandler.ts
Line: 104 to 127
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/application/handlers/src/OrderUpdateHandler.ts around lines 104 - 127, The code currently calls updatedOrder.pullEvents() after await this._orders.save(updatedOrder), risking lost events if publishAll fails; change to pull events into a local const before saving (const events = updatedOrder.pullEvents()), then save the order, then attempt this._eventBus.publishAll(events); on publish failure re-attach or persist the events for retry (e.g., push them back onto updatedOrder or write to an outbox and call this._orders.save/persist) so events are not lost; reference methods: pullEvents,_orders.save, _eventBus.publishAll, and the updatedOrder instance.

============================================================================
File: `packages/domain/market-data/trade-tape/__tests__/unit/TradeTape.test.ts`
Line: 148 to 153
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In `@packages/domain/market-data/trade-tape/__tests__/unit/TradeTape.test.ts` around lines 148 - 153, The test "возвращает readonly массив" currently only asserts Array.isArray(all) but doesn't verify immutability; update the test for TradeTape.create(...) and its getAll() to either (A) assert runtime immutability by checking Object.isFrozen(all) or attempting a mutation (e.g., push/splice/assign) and expecting it to throw or not change the original, or (B) if immutability is only a TS compile-time guarantee, rename the spec to "возвращает массив" to remove the readonly claim; locate and change the test that uses TradeTape.create and tape.getAll() to implement one of these two fixes.

============================================================================
File: `packages/domain/market-data/order-book/__tests__/unit/OrderBookHistory.test.ts`
Line: 286 to 296
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In `@packages/domain/market-data/order-book/__tests__/unit/OrderBookHistory.test.ts` around lines 286 - 296, Add an assertion that verifies the number of remaining snapshots so the age-boundary behavior is explicit: after creating the history via OrderBookHistory.create(...) and recording snapshots with h.record(...) at T0, T0+10_000 and T0+40_000, assert h.size() equals 2 to confirm that the snapshot 'b' (age exactly maxAgeMs) is retained under the current strict-inequality semantics while 'a' is evicted; place this check alongside the existing expect(h.getLatest()?.tokenId).

============================================================================
File: packages/application/event-bus/src/EventBus.ts
Line: 191 to 196
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/application/event-bus/src/EventBus.ts around lines 191 - 196, The boundary check for queue overflow is inconsistent between publish and publishAll: publish uses ">= this._maxQueueSize" while publishAll uses "> this._maxQueueSize", causing different behavior at the exact limit. Pick one semantic (recommend using ">=" to reject when the resulting queue would be at or exceed the limit) and make the other match: update publishAll's condition to use ">= this._maxQueueSize" (or change publish to ">" if you intend to allow filling to exactly_maxQueueSize), ensuring both methods reference the same _queue and_maxQueueSize semantics.

============================================================================
File: packages/domain/entities/portfolio/docs/portfolio-entity.md
Line: 253
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/domain/entities/portfolio/docs/portfolio-entity.md at line 253, The example's comment incorrectly asserts the entire tokenReservations map is empty by checking released.value.tokenReservations.size; change the example to check the specific instrument entry removal instead: use released.value.tokenReservations.has(instrumentId) to assert false or released.value.tokenReservations.get(instrumentId) to assert undefined, referencing the released.value.tokenReservations map and the instrumentId used earlier in the example.

============================================================================
File: packages/application/balance-allocator/src/BalanceAllocator.ts
Line: 176 to 192
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/application/balance-allocator/src/BalanceAllocator.ts around lines 176 - 192, In releaseWithPnL, validate that the market allocation exists before mutating _totalBalance: check this._allocations.has(marketId) at the start of the method and if it does not exist throw a TradingError (or return an error) that includes marketId and a clear message; only if the allocation exists proceed to compute addResult via MoneyService.add, update this._totalBalance and then delete the allocation; update any related tests to cover the non-existent-market case.

Review completed: 10 findings ✔
