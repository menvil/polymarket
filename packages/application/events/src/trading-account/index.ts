/**
 * Application-события ПРИВАТНОГО контура — фактов о нашем торговом аккаунте.
 *
 * @remarks
 * Публичный и приватный контуры разделены сознательно:
 *
 * ```text
 * TRADING_MARKET_*    что происходит с РЫНКОМ   → TradingHotState
 * TRADING_ACCOUNT_*   что происходит с НАМИ     → AccountHotState
 * ```
 *
 * Это два разных read-model, и они не объединяются в одно гигантское
 * состояние: стакан и лента — публичные наблюдения, доступные любому
 * участнику, а баланс, заявки и исполнения — приватные факты одного
 * аккаунта. Согласованный снимок из обоих позже соберёт
 * `TradingContextBuilder`.
 *
 * ### Все события — POST-COMMIT
 *
 * ```text
 * приватное наблюдение / команда
 *   ↓
 * domain/execution processing        ← здесь считается экономика
 *   ↓
 * post-commit Order / Portfolio / Fill
 *   ↓
 * TRADING_ACCOUNT_*                  ← здесь уже только итог
 *   ↓
 * IEventBus → AccountStateProjector → AccountHotState
 * ```
 *
 * Ни одно из этих событий не является «входом на обработку». Резервации,
 * FIFO-лоты, BUY/SELL-учёт, допустимость перехода заявки — всё посчитано ДО
 * публикации. Проекция материализует готовые immutable snapshot'ы и ничего
 * не вычисляет.
 *
 * ### Почему не переиспользованы старые события
 *
 * ```text
 * FILL_RECEIVED           исполнение получено и ЕЩЁ должно быть обработано
 * FILL_CONFIRMED          finality в терминах старого use-case flow
 * FILL_FAILED             откат считает подписчик
 * DIRECT_FILL_APPLIED     эффект применён вне обычного flow
 * ORDER_UPDATE_RECEIVED   сырое venue-обновление, БЕЗ Order и Portfolio
 * ```
 *
 * Все они — вход старого контура обработки, а не его итог. Построить на них
 * новое состояние значило бы унаследовать чужие гарантии. Старые события
 * остаются своим потребителям без изменения семантики.
 *
 * ### Подписчики
 * - `AccountStateProjector` (`@polymarket/account-state`) — единственный
 *   писатель приватного состояния; подписки critical.
 *
 * ### Producer
 * Пока нет: приватный процессор и account reconciler — следующие MR.
 */
export type { TradingAccountInitializedEvent } from './TradingAccountInitializedEvent.js';
export type { TradingAccountOrderCommittedEvent } from './TradingAccountOrderCommittedEvent.js';
export type { TradingAccountFillAppliedEvent } from './TradingAccountFillAppliedEvent.js';
export type { TradingAccountFillConfirmedEvent } from './TradingAccountFillConfirmedEvent.js';
export type { TradingAccountFillRevertedEvent } from './TradingAccountFillRevertedEvent.js';
