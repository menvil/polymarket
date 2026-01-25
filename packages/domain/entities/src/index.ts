/**
 * @polymarket/entities - Domain entities для торгового бота
 *
 * @remarks
 * Entities представляют бизнес-объекты системы Polymarket:
 * - Order - ордера на покупку/продажу
 * - Position - позиции пользователя
 * - Market - предсказательные рынки
 * - Trade - исполненные сделки
 * - OrderBook - книга ордеров
 * - User - пользователи с балансом
 *
 * Все entities следуют паттернам:
 * - Factory Method для создания (static create())
 * - Валидация при создании через Result<T, E>
 * - Immutability (private readonly поля)
 * - Бизнес-логика внутри entity
 *
 * @example
 * ```typescript
 * import { Order } from '@polymarket/entities';
 * import Decimal from 'decimal.js';
 *
 * const order = Order.create(
 *   new Decimal('0.75'),
 *   new Decimal(100),
 *   'buy'
 * ).unwrap();
 *
 * console.log(order.total.toString()); // "75"
 * ```
 *
 * @packageDocumentation
 */

// Пока пусто - будут добавлены entities по мере разработки
// export { Order } from './Order.js';
// export { Position } from './Position.js';
// export { Market } from './Market.js';
// export { Trade } from './Trade.js';
// export { OrderBook } from './OrderBook.js';
// export { User } from './User.js';