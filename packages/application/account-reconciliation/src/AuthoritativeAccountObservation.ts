/**
 * Authoritative-наблюдения аккаунта: ФАКТЫ площадки, а не готовое локальное
 * состояние.
 *
 * @remarks
 * Площадка authoritative знает внешние факты:
 *
 * ```text
 * сколько collateral лежит на аккаунте
 * сколько каждого outcome-токена аккаунт держит
 * какие заявки открыты и в каком они состоянии
 * какие сделки аккаунта прошли и где они в on-chain жизненном цикле
 * ```
 *
 * Но она НЕ знает нашей бухгалтерии:
 *
 * ```text
 * разделения available / reserved   локальная резервация под открытые заявки
 * FIFO-лотов позиции                локальная provenance: какие исполнения
 *                                   образовали позицию и в каком порядке
 * strategyId, reason, version       локальные поля canonical Order
 * ```
 *
 * Поэтому DTO этого модуля — НЕ `Portfolio`, НЕ `Position` и НЕ `Order`.
 * Адаптер площадки, который собрал бы из её ответа `Portfolio`, был бы обязан
 * ВЫДУМАТЬ то, чего площадка не сообщала: резервации, лоты, автора заявки. Из
 * выдуманного не вывести верного: синтетический лот на `currentSize ×
 * avgPrice` уничтожает FIFO-provenance, и первое же закрытие посчитало бы
 * неверный realized PnL.
 *
 * Сопоставление фактов площадки с локальной бухгалтерией — работа будущего
 * matcher-а сверки, а не адаптера и не этого контракта:
 *
 * ```text
 * collateralBalance        ↔  Balance.available + Balance.reserved
 * position.quantity        ↔  Position.quantity
 *                          ↔  TokenBalance.available + TokenBalance.reserved
 * открытые BUY             →  локальный reserved cash
 * открытые SELL            →  локальные reserved tokens
 * fill + venue status      ↔  AccountFillRecord
 * ```
 *
 * Все поля — canonical value objects и идентификаторы. Никаких REST-DTO,
 * vendor-строк статусов и чисел с плавающей точкой: перевод формата площадки
 * в эти типы — обязанность Infrastructure-адаптера.
 */
import type { AssetId, OrderId } from '@polymarket/ids';
import type { ExecutionMetadata, Fill, TradeStatus } from '@polymarket/fill';
import type { OrderStatus } from '@polymarket/order';
import type { Money, OutcomePrice, Quantity, Side } from '@polymarket/value-objects';

/**
 * Статус заявки, который площадка способна подтвердить.
 *
 * @remarks
 * `PENDING` исключён: это локальное состояние рантайма — заявка отправлена,
 * но площадка её ещё не приняла. Площадка не может authoritative сообщить
 * «я твою заявку ещё не видела»: для неё такой заявки просто нет.
 *
 * Если vendor-статус нельзя ОДНОЗНАЧНО привести к одному из этих значений,
 * адаптер возвращает `Err` (fail closed). Угадывать запрещено — в частности,
 * «неизвестный статус → `OPEN`», как делал legacy-маппер: угаданный `OPEN`
 * держал бы резервацию под заявкой, которой на площадке, возможно, уже нет.
 *
 * Состав типа зафиксирован тестом: новый статус в `OrderStatus` не станет
 * authoritative молча — тест сломается и потребует решения, локальный он или
 * подтверждаемый площадкой.
 *
 * @example
 * ```typescript
 * const status: AuthoritativeOrderStatus = 'PARTIALLY_FILLED';
 * // const pending: AuthoritativeOrderStatus = 'PENDING'; // ошибка компиляции
 * ```
 */
export type AuthoritativeOrderStatus = Exclude<OrderStatus, 'PENDING'>;

/**
 * Заявка аккаунта так, как её видит площадка.
 *
 * @remarks
 * ### Почему не canonical `Order`
 *
 * Неизменяемая идентичность `Order` (`findOrderIdentityDifference`) включает
 * поля, которых площадка не знает. Адаптер, вынужденный собрать `Order`,
 * поставил бы `strategyId: undefined` там, где локально стоит автор заявки, —
 * и canonical-сравнение дало бы ложный конфликт идентичности на каждой
 * заявке, выставленной стратегией.
 *
 * Поэтому здесь ТОЛЬКО поля, известные площадке. Намеренно отсутствуют:
 *
 * ```text
 * strategyId   автор заявки — локальное знание
 * timestamp    у локальной заявки — момент создания рантаймом, у площадки —
 *              момент приёма; это разные факты, и их сравнение дало бы
 *              ложный конфликт
 * reason       локальное объяснение перехода
 * fillIds      локальная связь с исполнениями; исполнения площадки — в
 *              AuthoritativeAccountObservation.fills
 * accountId    наблюдение уже адресовано паре venueId + accountId запроса
 * ```
 *
 * ### Инварианты, которые обязан соблюсти адаптер
 *
 * - `filledSize ≤ size`;
 * - `status` согласован с исполнением: `OPEN` — ничего не исполнено,
 *   `PARTIALLY_FILLED` — исполнено частично, `FILLED` — `filledSize == size`;
 * - `price` и `size` — исходные лимитные параметры заявки, а не цена или
 *   объём какого-то исполнения.
 *
 * Нарушение — противоречие источника: адаптер возвращает `Err`, а не
 * «исправляет» ответ площадки.
 *
 * @example
 * ```typescript
 * const observed: AuthoritativeOrderObservation = {
 *   orderId,
 *   asset: upToken,
 *   side: 'BUY',
 *   price: OutcomePrice.of(new Decimal('0.42')),
 *   size: Quantity.of(new Decimal('10')),
 *   filledSize: Quantity.of(new Decimal('4')),
 *   status: 'PARTIALLY_FILLED',
 * };
 * ```
 */
export interface AuthoritativeOrderObservation {
  /** Идентификатор заявки на площадке — тот же, что у локального `Order` */
  readonly orderId: OrderId;
  /** Outcome-актив заявки */
  readonly asset: AssetId;
  /** Сторона заявки */
  readonly side: Side;
  /** Лимитная цена заявки */
  readonly price: OutcomePrice;
  /** Исходный объём заявки */
  readonly size: Quantity;
  /** Исполненная часть объёма по данным площадки */
  readonly filledSize: Quantity;
  /** Статус, подтверждаемый площадкой ({@link AuthoritativeOrderStatus}) */
  readonly status: AuthoritativeOrderStatus;
}

/**
 * Владение одним outcome-активом так, как его видит площадка.
 *
 * @remarks
 * ### Authoritative-факт — только `asset + quantity`
 *
 * `quantity` — ПОЛНОЕ количество, которое держит аккаунт: площадка не знает,
 * какая его часть локально зарезервирована под открытые SELL. Поэтому позже
 * оно сравнивается с `Position.quantity` и с суммой
 * `TokenBalance.available + TokenBalance.reserved`, но НИКОГДА — с одним
 * `TokenBalance.available`.
 *
 * ### `averagePrice` и `entryCost` — диагностика, а не источник лотов
 *
 * - `averagePrice` НЕ является источником FIFO-лотов;
 * - `entryCost` НЕ является источником FIFO-лотов.
 *
 * Это справочные числа площадки, посчитанные по ЕЁ модели учёта (средняя
 * цена, учёт комиссий, частичных закрытий и слияний может отличаться от
 * нашего FIFO). Расхождение `averagePrice` с `Position.averageEntryPrice` при
 * совпадающем количестве — не повод для коррекции.
 *
 * Будущая политика сверки инвентаря:
 *
 * ```text
 * quantity == Position.quantity   существующие локальные лоты СОХРАНЯЮТСЯ,
 *                                 даже если средняя цена площадки другая
 * quantity != Position.quantity   ищется недостающее authoritative-исполнение
 *                                 в fills[]; лоты восстанавливаются только из
 *                                 настоящего Fill
 * не объяснилось                  POSITION_QUANTITY_MISMATCH → fail closed
 * ```
 *
 * Синтетический лот на разницу запрещён. Поля `lots` здесь нет и не будет:
 * площадка лотов не знает.
 *
 * Оба диагностических поля необязательны: площадка может их не сообщить, а
 * значение вне диапазона `OutcomePrice` адаптер вправе опустить — от них не
 * зависит ни одно решение сверки.
 *
 * @example
 * ```typescript
 * const observed: AuthoritativePositionObservation = {
 *   asset: upToken,
 *   quantity: Quantity.of(new Decimal('10')),
 *   averagePrice: OutcomePrice.of(new Decimal('0.41')), // только диагностика
 * };
 * ```
 */
export interface AuthoritativePositionObservation {
  /** Outcome-актив */
  readonly asset: AssetId;
  /** Полное количество актива на аккаунте по данным площадки */
  readonly quantity: Quantity;
  /** Средняя цена входа по модели площадки — диагностика, НЕ источник лотов */
  readonly averagePrice?: OutcomePrice;
  /** Стоимость входа по модели площадки — диагностика, НЕ источник лотов */
  readonly entryCost?: Money;
}

/**
 * Метаданные authoritative-исполнения: canonical `ExecutionMetadata` с
 * ОБЯЗАТЕЛЬНЫМ статусом сделки на площадке.
 *
 * @remarks
 * В `ExecutionMetadata` `tradeStatus` необязателен: живой поток бывает и у
 * площадки без on-chain расчётов. Для authoritative-наблюдения Polymarket его
 * отсутствие означало бы потерю факта, без которого сверка не может решать:
 * сделка, которая есть в списке площадки, ещё не обязательно финальна.
 *
 * Vendor-статус, которого нет в `TradeStatus` (или пустой), — `Err`
 * адаптера, а не наблюдение без статуса и не «ближайший похожий» статус.
 */
export type AuthoritativeExecutionMetadata = ExecutionMetadata & {
  /** Статус сделки на площадке — обязателен */
  readonly tradeStatus: TradeStatus;
};

/**
 * Исполнение аккаунта так, как его видит площадка: canonical `Fill` + статус
 * сделки на площадке.
 *
 * @remarks
 * ### Почему не голый `Fill`
 *
 * Сделка аккаунта на Polymarket проходит on-chain жизненный цикл, и
 * присутствие её в ответе площадки НЕ означает финальности:
 *
 * ```text
 * MATCHED    матчинг произошёл; годится для восстановления пропущенного,
 *            но это ещё НЕ финальность
 * MINED      расчётная транзакция попала в блок; ещё НЕ финальность
 * RETRYING   расчёт повторяется; НЕ финальность
 * CONFIRMED  финальное подтверждение площадки
 * FAILED     площадка сообщает, что исполнение окончательно не состоялось
 * ```
 *
 * Правило «сделка есть в ответе → `AccountFillStatus.CONFIRMED`» поэтому
 * запрещено: `MATCHED`-сделка ещё может упасть, а `FAILED`-сделка есть в
 * ответе именно как несостоявшаяся. `FAILED` после локального `APPLIED` —
 * случай отката/конфликта, который решает matcher, а не адаптер.
 *
 * ### Две разные оси — не смешивать
 *
 * ```text
 * TradeStatus        MATCHED / MINED / RETRYING / CONFIRMED / FAILED   что говорит площадка
 * AccountFillStatus  APPLIED / CONFIRMED / REVERTED                    что сделал рантайм
 * ```
 *
 * Здесь — только первая. Во вторую её переводит будущий matcher.
 *
 * ### Идентичность исполнения
 *
 * `fill` обязан иметь ТУ ЖЕ canonical-идентичность (`FillId` и факт по
 * `findFillFactDifference`), что и исполнение, пришедшее приватным потоком:
 * иначе одна сделка, увиденная дважды, стала бы двумя исполнениями. Поэтому
 * адаптер строит `Fill` тем же canonical-правилом, что и живой поток
 * (`FillMapper`), а не своим. Одна сделка площадки может дать НЕСКОЛЬКО
 * наблюдений (несколько наших maker-заявок в одной сделке) — у всех один
 * `tradeStatus`, потому что статус принадлежит сделке.
 *
 * Владение maker-заявкой определяется по НАШЕЙ записи в списке maker-заявок
 * сделки, а не по полям верхнего уровня: в cross-outcome сделке они
 * принадлежат тейкеру. Чужая maker-заявка, принятая за свою, — чужие токены
 * в нашем портфеле.
 *
 * `fill.venueId` и `fill.accountId` совпадают с парой запроса.
 *
 * @example
 * ```typescript
 * const observed: AuthoritativeFillObservation = {
 *   fill,
 *   metadata: { tradeStatus: 'MATCHED', liquidity: 'TAKER', venueTradeId },
 * };
 * ```
 */
export interface AuthoritativeFillObservation {
  /** Canonical факт исполнения — та же идентичность, что у приватного потока */
  readonly fill: Fill;
  /** Метаданные исполнения с обязательным `tradeStatus` */
  readonly metadata: AuthoritativeExecutionMetadata;
}

/**
 * Один логический проход наблюдения аккаунта на площадке.
 *
 * @remarks
 * ### Это НЕ `Portfolio`
 *
 * Здесь нет ни резерваций, ни лотов, ни локальных заявок — только то, что
 * площадка сообщает о себе сама (см. заголовок модуля).
 *
 * ### Это НЕ атомарная транзакция площадки
 *
 * Будущий адаптер соберёт наблюдение НЕСКОЛЬКИМИ запросами (баланс, позиции,
 * заявки, сделки — разные эндпоинты), и площадка не гарантирует, что они
 * описывают один и тот же момент. Контракт обещает другое: каждый набор
 * получен ОДИН раз за проход и сохранён здесь как есть. Повторно дочитывать
 * «на всякий случай» посреди сверки нельзя — иначе внутри одного прохода
 * появились бы две версии одного факта.
 *
 * ### `collateralBalance` — полное владение, а не `available`
 *
 * Сколько collateral держит аккаунт по данным площадки. Это НЕ
 * `Balance.available` и НЕ `Balance.reserved`: у площадки нет нашей локальной
 * резервации. Позже сверка будет проверять
 *
 * ```text
 * collateralBalance ≈ Balance.available + Balance.reserved
 * ```
 *
 * а локальный `reserved` выводить из открытых BUY-заявок. Полей
 * `availableCollateral`/`reservedCollateral` здесь нет сознательно: их пришлось
 * бы выдумать.
 *
 * ### Полнота наборов
 *
 * Каждый список — ПОЛНЫЙ ответ площадки за проход: пагинация исчерпана.
 * Оборвавшаяся пагинация — `Err`, а не короткий список: короткий список
 * неотличим от «этого нет на площадке». Запись, которую адаптер не смог
 * перевести в canonical-форму, — тоже `Err`, а не пропуск: площадка отдаёт
 * только сделки аккаунта, и непонятая запись — дефект маппинга, а не «чужая
 * сделка».
 *
 * - `positions` — по одной записи на актив; актива нет в списке — площадка
 *   сообщает, что аккаунт его не держит (запись с нулевым `quantity`
 *   означает то же самое);
 * - `openOrders` — только живые заявки: статус `OPEN` либо
 *   `PARTIALLY_FILLED`;
 * - `fills` — сделки аккаунта вместе с их статусом на площадке, включая
 *   нефинальные и `FAILED`.
 *
 * @example
 * ```typescript
 * const result = await source.getAccountObservation(venueId, accountId);
 * if (result.ok) {
 *   const { collateralBalance, positions, openOrders, fills } = result.value;
 * }
 * ```
 */
export interface AuthoritativeAccountObservation {
  /** Полное collateral-владение аккаунта по данным площадки (НЕ `available`) */
  readonly collateralBalance: Money;
  /** Владения outcome-активами, по одной записи на актив */
  readonly positions: readonly AuthoritativePositionObservation[];
  /** Живые заявки аккаунта на площадке */
  readonly openOrders: readonly AuthoritativeOrderObservation[];
  /** Сделки аккаунта с обязательным статусом на площадке */
  readonly fills: readonly AuthoritativeFillObservation[];
}
