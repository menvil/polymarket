╔═════════════════════════════════════════════╗
║                                             ║
║           New update available!             ║
║          Run: coderabbit update             ║
║                                             ║
╚═════════════════════════════════════════════╝

Starting CodeRabbit review in plain text mode...

Connecting to review service
Setting up
Analyzing
Reviewing

============================================================================
File: packages/application/handlers/src/BookDepthCollector.ts
Line: 123 to 128
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/application/handlers/src/BookDepthCollector.ts around lines 123 - 128, The async event handler subscribed to BOOK_DEPTH (assigned to _unsubBookDepth) can allow exceptions from _record (and internally OrderBookHistory.create()) to become unhandled; wrap the handler body in a try-catch that logs/handles errors via your _deps.logger or event bus error path and prevents promise rejection, or alternatively validate/create the OrderBookHistory instance in the BookDepthCollector constructor so _record cannot throw RangeError at runtime—update the subscribe callback around the call to this._record(...) to catch and report any thrown errors.



============================================================================
File: packages/application/handlers/src/BookDepthCollector.ts
Line: 26 to 29
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/application/handlers/src/BookDepthCollector.ts around lines 26 - 29, Update the documentation example to match the actual constructor signature of BookDepthCollector by passing a single deps object and a config object: construct it as new BookDepthCollector(deps, config) where deps is a BookDepthCollectorDeps containing eventBus and logger (e.g., { eventBus, logger, ... }) and config is the options object (e.g., { maxCount: 500, maxAgeMs: 300_000 }); locate the example near the top of BookDepthCollector and replace the three-argument form new BookDepthCollector(eventBus, logger, {...}) with the correct two-argument form that references BookDepthCollectorDeps and the config object.



============================================================================
File: packages/application/handlers/src/OrderUpdateHandler.ts
Line: 116 to 132
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/application/handlers/src/OrderUpdateHandler.ts around lines 116 - 132, The success message "Order update applied" is logged regardless of publish outcome and pulled events from updatedOrder.pullEvents() are lost if this._eventBus.publishAll throws; change flow so publishing is attempted first and only log "Order update applied" after publish succeeds (or add a distinct log for partial failure), e.g., call this._eventBus.publishAll(events) inside the try and move the this._logger.info('Order update applied', ...) into the try after publish, log an error+context in the catch (as already done) and consider persisting events (outbox) or re-throwing from the catch to avoid silent loss when publish fails.



============================================================================
File: packages/application/balance-allocator/src/BalanceAllocator.ts
Line: 415 to 419
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/application/balance-allocator/src/BalanceAllocator.ts around lines 415 - 419, The _countAffordableSlots method can divide by zero because it only checks balance positivity; update _countAffordableSlots to also validate slotCost.value() is positive/non-zero before dividing (return 0 when slotCost is zero or non-positive), so perform a defensive check on slotCost.value() (the BigNumber returned by slotCost.value()) and avoid calling div/floor when it's zero or non-positive.



============================================================================
File: packages/application/handlers/__tests__/TradeTapeCollector.test.ts
Line: 306 to 318
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/application/handlers/__tests__/TradeTapeCollector.test.ts around lines 306 - 318, The inline comment in the test "оба ограничения работают одновременно" is incorrect about which trade remains fresh; update the comment around the expect(c.size(TOKEN_A)).toBe(1) assertion to state that only the trade emitted at T0+90_000 remains (the earlier trades at T0, T0+10_000 and T0+20_000 are older than maxAgeMs=60_000 when the last event is emitted), referencing the TradeTapeCollector instance (c), the size(TOKEN_A) call, and the timestamps T0, T0+10_000, T0+20_000, T0+90_000 so the comment accurately explains why the expected size is 1.



============================================================================
File: packages/domain/market-data/order-book/src/OrderBookHistory.ts
Line: 196 to 198
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/domain/market-data/order-book/src/OrderBookHistory.ts around lines 196 - 198, The getLast method can behave unexpectedly for n <= 0 or non-integers; validate and sanitize the n parameter before slicing: in OrderBookHistory.getLast, ensure n is a non-negative integer (e.g., if n <= 0 return an empty array, and coerce non-integers via Math.floor or reject), and clamp n to this._snapshots.length before using slice; then map to each snapshot (OrderBookSnapshot) as before to return the last n snapshots.



============================================================================
File: packages/application/balance-allocator/src/BalanceAllocator.ts
Line: 385 to 392
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/application/balance-allocator/src/BalanceAllocator.ts around lines 385 - 392, _calcAllocatedBalance currently ignores MoneyService.add failures, silently skipping allocations with currency mismatches; update this function to detect when MoneyService.add returns ok === false and surface that as an explicit failure (throw an Error or log and throw) including context (allocation value and _totalBalance currency) so invariant violations don't get silently excluded; reference the _calcAllocatedBalance method, MoneyService.add, this._totalBalance and this._allocations when making the change and ensure behavior matches invariants enforced in restoreAllocations and releaseWithPnL.



============================================================================
File: packages/application/event-bus/src/EventBus.ts
Line: 276 to 294
Type: potential_issue

Prompt for AI Agent:
Verify each finding against the current code and only fix it if needed.

In @packages/application/event-bus/src/EventBus.ts around lines 276 - 294, The loop handling Promise results in the EventBus method currently captures only the first critical error (hasCriticalError/criticalError) and drops subsequent critical failures; modify the loop so that for each result with status 'rejected' and entry.critical true you both record the first critical error to be re-thrown (criticalError) and also log or aggregate all subsequent critical errors (e.g., push to an array like criticalErrors or call this._logger.error with eventType and err) so no critical failure is silently dropped; ensure after the loop you still throw the primary criticalError but include or attach the aggregated errors (or ensure they are logged) so all critical failures are surfaced.



Review completed: 8 findings ✔
