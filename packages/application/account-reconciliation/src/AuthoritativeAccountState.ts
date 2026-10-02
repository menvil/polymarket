/**
 * Authoritative ТЕКУЩЕЕ состояние аккаунта на площадке: факты площадки, а не
 * готовое локальное состояние.
 *
 * @remarks
 * ### Две дороги к одному состоянию
 *
 * ```text
 * private/live события            быстрый realtime-путь → provisional состояние
 * authoritative состояние venue   источник истины о ТЕКУЩЕМ состоянии аккаунта
 * AccountHotState                 наше лучшее текущее представление аккаунта
 * ```
 *
 * Состояние, выведенное из событий, обязано СОЙТИСЬ к authoritative
 * состоянию площадки. События — быстрый путь и источник provenance, но не
 * окончательная истина: если площадка authoritative сообщает, что сейчас
 * аккаунт держит, открыл или исполнил другое, побеждает площадка.
 *
 * ### Происхождение изменений сверке не нужно
 *
 * Аккаунт мог изменить наш рантайм, человек через UI площадки, другой
 * процесс, claim/redeem, merge, внешний перевод, коррекция площадки, упавшая
 * или откатившаяся сделка, reorg. Доказывать, кто и почему, не требуется:
 * заявка или исполнение в этом состоянии принадлежат АККАУНТУ, даже если наш
 * рантайм их не инициировал. `AccountHotState` моделирует аккаунт, а не
 * только нашего бота.
 *
 * Поэтому ни в одном DTO нет оси происхождения (`MANUAL`/`BOT`/`EXTERNAL`):
 * площадка не даёт её доказательства, а выдуманный origin был бы ложным
 * фактом. Исполнение не обязано ссылаться на локально созданную заявку.
 *
 * ### Это НЕ `Portfolio`
 *
 * Площадка знает факты: collateral, владения outcome-токенами, открытые
 * заявки, сделки и их on-chain статус. Нашу бухгалтерию она не знает:
 *
 * ```text
 * available / reserved      локальная форма представления: резервация под
 *                           открытые заявки
 * FIFO-лоты позиции         локальная provenance исполнений
 * strategyId, decisionId,   локальные поля намерения и заявки
 * intentId, reason
 * ```
 *
 * Адаптер, обязанный отдать `Portfolio`, был бы вынужден всё это выдумать.
 * Перевести факты площадки в локальную бухгалтерию — работа будущего
 * reconciler-а:
 *
 * ```text
 * collateralBalance        ↔  Balance.available + Balance.reserved
 * position.quantity        ↔  Position.quantity
 *                          ↔  TokenBalance.available + TokenBalance.reserved
 * открытые BUY             →  reserved cash
 * открытые SELL            →  reserved tokens
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
 * Outcome-актив состояния площадки — любой вариант `AssetId`, кроме
 * `CURRENCY`.
 *
 * @remarks
 * Заявки, позиции и адресная проверка владения на площадке относятся только к
 * outcome-токенам: collateral — это `AuthoritativeAccountState.collateralBalance`
 * (`Money`), а не позиция, не актив заявки и не количество токенов. Тип
 * запрещает `CURRENCY` на этапе компиляции, поэтому, например, USDC нельзя
 * запросить через `getAssetBalance`, который отдаёт `Quantity` без валюты.
 *
 * Canonical `AssetId` не меняется — это сужение на границе application.
 * Состав закреплён тестом (`OUTCOME_TOKEN | POLYMARKET_CTF_TOKEN`): новый
 * вариант `AssetId` не станет outcome-активом площадки молча.
 *
 * Адаптер, получивший числовой `tokenId`, сужает результат
 * `asPolymarketCtfToken` canonical-guard-ом `isPolymarketCtfToken`.
 *
 * @example
 * ```typescript
 * const asset = asPolymarketCtfToken(raw.tokenId);
 * if (asset === undefined || !isPolymarketCtfToken(asset)) return Err(mappingError);
 * const outcome: AuthoritativeOutcomeAssetId = asset;
 * ```
 */
export type AuthoritativeOutcomeAssetId = Exclude<AssetId, { readonly type: 'CURRENCY' }>;

/**
 * Статус заявки, который площадка способна подтвердить.
 *
 * @remarks
 * `PENDING` исключён: это локальный жизненный цикл ДО authoritative-приёма
 * заявки площадкой. Площадка не может сообщить «я твою заявку ещё не видела»
 * — для неё такой заявки просто нет.
 *
 * Если vendor-статус нельзя ОДНОЗНАЧНО привести к одному из этих значений,
 * адаптер возвращает `Err` (fail closed). Угадывать запрещено — в частности,
 * «неизвестный статус → `OPEN`», как делал legacy-маппер: угаданный `OPEN`
 * держал бы резервацию под заявкой, которой на площадке, возможно, уже нет.
 *
 * Состав типа закреплён тестом: новый статус в `OrderStatus` не станет
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
 * Статус ЖИВОЙ заявки — той, что может стоять в
 * `AuthoritativeAccountState.openOrders`.
 *
 * @remarks
 * Терминальные `FILLED`/`CANCELED`/`REJECTED`/`EXPIRED` в список открытых
 * заявок не попадают на этапе компиляции: заявка, которую площадка называет
 * терминальной, ничего не резервирует, и её место — в ответе
 * `getOrderState`, а не среди живых.
 *
 * @example
 * ```typescript
 * const status: AuthoritativeOpenOrderStatus = 'OPEN';
 * // const filled: AuthoritativeOpenOrderStatus = 'FILLED'; // ошибка компиляции
 * ```
 */
export type AuthoritativeOpenOrderStatus = Extract<AuthoritativeOrderStatus, 'OPEN' | 'PARTIALLY_FILLED'>;

/**
 * Заявка аккаунта так, как её видит площадка, — в любом authoritative
 * статусе, включая терминальный.
 *
 * @remarks
 * Это ответ `getOrderState`: адресный запрос обязан уметь вернуть и
 * `FILLED`/`CANCELED`/`REJECTED`/`EXPIRED`. Для списка живых заявок — более
 * узкий {@link AuthoritativeOpenOrderState}.
 *
 * ### Почему не canonical `Order`
 *
 * Неизменяемая идентичность `Order` (`findOrderIdentityDifference`) включает
 * поля, которых площадка не знает. Адаптер, вынужденный собрать `Order`,
 * поставил бы `strategyId: undefined` там, где локально стоит автор заявки, —
 * и canonical-сравнение дало бы ложный конфликт идентичности на каждой
 * заявке, выставленной стратегией.
 *
 * Поэтому здесь ТОЛЬКО факты, которыми владеет площадка. Намеренно
 * отсутствуют:
 *
 * ```text
 * strategyId, decisionId,  локальное намерение и его автор
 * intentId
 * timestamp                у локальной заявки — момент создания рантаймом,
 *                          у площадки — момент приёма: разные факты
 * reason, metadata         локальное объяснение и служебные данные
 * fillIds                  локальная связь; исполнения площадки — в
 *                          AuthoritativeAccountState.fills
 * accountId                состояние уже адресовано паре venueId + accountId
 * ```
 *
 * ### Заявка, которой локально нет, — заявка аккаунта
 *
 * Открытая заявка, которую наш рантайм никогда не создавал (UI площадки,
 * другой процесс), — не ошибка сверки: она резервирует деньги или токены
 * аккаунта так же, как наша. Ни одно поле не требует локального владения.
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
 * const venueOrder: AuthoritativeOrderState = {
 *   orderId,
 *   asset: yesToken,
 *   side: 'SELL',
 *   price: OutcomePrice.of(new Decimal('0.61')),
 *   size: Quantity.of(new Decimal('5')),
 *   filledSize: Quantity.of(new Decimal('0')),
 *   status: 'OPEN',
 * };
 * ```
 */
export interface AuthoritativeOrderState {
  /** Идентификатор заявки на площадке */
  readonly orderId: OrderId;
  /** Outcome-актив заявки (`CURRENCY` запрещён типом) */
  readonly asset: AuthoritativeOutcomeAssetId;
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
 * Живая заявка аккаунта на площадке — элемент
 * `AuthoritativeAccountState.openOrders`.
 *
 * @remarks
 * Те же факты, что у {@link AuthoritativeOrderState}, но статус сужен до
 * {@link AuthoritativeOpenOrderStatus}: терминальная заявка в списке открытых
 * не компилируется. Обратное присваивание разрешено — живая заявка является
 * частным случаем состояния заявки.
 *
 * @example
 * ```typescript
 * const live: AuthoritativeOpenOrderState = { ...venueOrder, status: 'PARTIALLY_FILLED' };
 * const any: AuthoritativeOrderState = live; // ок
 * ```
 */
export interface AuthoritativeOpenOrderState extends AuthoritativeOrderState {
  /** Только `OPEN` или `PARTIALLY_FILLED` */
  readonly status: AuthoritativeOpenOrderStatus;
}

/**
 * Текущее владение одним outcome-активом так, как его видит площадка.
 *
 * @remarks
 * ### `quantity` — authoritative текущий инвентарь
 *
 * Это ПОЛНОЕ количество, которое аккаунт держит СЕЙЧАС. Площадка не знает,
 * какая его часть локально зарезервирована под открытые SELL, поэтому оно
 * сравнивается с `Position.quantity` и с суммой
 * `TokenBalance.available + TokenBalance.reserved`, но НИКОГДА — с одним
 * `TokenBalance.available`. Если локальная позиция говорит другое, сверка в
 * итоге приводит локальный инвентарь к этому количеству.
 *
 * ### Текущий инвентарь ≠ accounting provenance
 *
 * FIFO-лоты — НЕ состояние площадки: она не знает, какие исполнения
 * образовали позицию. Поэтому запрещены ОБА искажения:
 *
 * ```text
 * quantity + averagePrice → синтетический единственный лот    выдуманная provenance
 * лоты восстановить нельзя → оставить неверное количество     выдуманный инвентарь
 * ```
 *
 * Правда о текущем инвентаре важнее полноты provenance. Пример: площадка
 * говорит 10, известные локальные лоты объясняют 8 — текущий инвентарь
 * всё равно 10, а provenance двух единиц требует отдельного представления.
 * Его форма — задача будущего рефакторинга `Position`; требование к нему:
 * неполная FIFO-provenance не может заставлять рантайм делать вид, что
 * инвентарь меньше настоящего.
 *
 * ### `averagePrice` и `entryCost` — справка, а не источник лотов
 *
 * - `averagePrice` НЕ является источником FIFO-лотов;
 * - `entryCost` НЕ является источником FIFO-лотов.
 *
 * Это числа ЕЁ модели учёта (комиссии, частичные закрытия и merge могут
 * учитываться иначе, чем в нашем FIFO). Расхождение `averagePrice` с
 * `Position.averageEntryPrice` при совпадающем количестве — не повод для
 * коррекции. Оба поля необязательны: площадка может их не сообщить, а
 * значение вне диапазона `OutcomePrice` адаптер вправе опустить.
 *
 * Поля `lots` здесь нет и не будет.
 *
 * @example
 * ```typescript
 * const venuePosition: AuthoritativePositionState = {
 *   asset: yesToken,
 *   quantity: Quantity.of(new Decimal('10')),
 *   averagePrice: OutcomePrice.of(new Decimal('0.42')), // только справка
 * };
 * ```
 */
export interface AuthoritativePositionState {
  /** Outcome-актив (`CURRENCY` запрещён типом) */
  readonly asset: AuthoritativeOutcomeAssetId;
  /** Полное текущее количество актива на аккаунте — authoritative инвентарь */
  readonly quantity: Quantity;
  /** Средняя цена входа по модели площадки — справка, НЕ источник лотов */
  readonly averagePrice?: OutcomePrice;
  /** Стоимость входа по модели площадки — справка, НЕ источник лотов */
  readonly entryCost?: Money;
}

/**
 * Метаданные authoritative-исполнения: canonical `ExecutionMetadata` с
 * ОБЯЗАТЕЛЬНЫМ статусом сделки на площадке.
 *
 * @remarks
 * В `ExecutionMetadata` `tradeStatus` необязателен: живой поток бывает и у
 * площадки без on-chain расчётов. Для authoritative-состояния Polymarket его
 * отсутствие означало бы потерю факта, без которого сверка не может решать:
 * сделка, которая есть в ответе площадки, ещё не обязательно финальна.
 *
 * Своих полей сверх canonical `ExecutionMetadata` здесь нет — в частности,
 * никакого origin/initiator. Vendor-статус, которого нет в `TradeStatus` (или
 * пустой), — `Err` адаптера, а не исполнение без статуса и не «ближайший
 * похожий» статус.
 *
 * @example
 * ```typescript
 * const metadata: AuthoritativeFillMetadata = { tradeStatus: 'MATCHED', liquidity: 'TAKER' };
 * ```
 */
export interface AuthoritativeFillMetadata extends ExecutionMetadata {
  /** Статус сделки на площадке — обязателен */
  readonly tradeStatus: TradeStatus;
}

/**
 * Исполнение аккаунта так, как его видит площадка: canonical `Fill` + статус
 * сделки на площадке.
 *
 * @remarks
 * ### Жизненный цикл сделки на площадке
 *
 * Присутствие сделки в ответе площадки НЕ означает финальности:
 *
 * ```text
 * MATCHED    матчинг наблюдался; годится для быстрого восстановления, НЕ финальность
 * MINED      расчётная транзакция продвигается в сети; НЕ финальность
 * CONFIRMED  authoritative финальное подтверждение
 * RETRYING   не разрешено; НЕ финальность
 * FAILED     площадка говорит: исполнение не выжило
 * ```
 *
 * Правило «сделка есть в ответе → `AccountFillStatus.CONFIRMED`» поэтому
 * запрещено. Это отдельная ось от рантаймовой:
 *
 * ```text
 * TradeStatus        MATCHED / MINED / RETRYING / CONFIRMED / FAILED   что говорит площадка
 * AccountFillStatus  APPLIED / CONFIRMED / REVERTED                    что сделал рантайм
 * ```
 *
 * Здесь — только первая, без потери информации.
 *
 * ### `FAILED` обязан уметь победить provisional-состояние
 *
 * ```text
 * WS: MATCHED → локальный fill APPLIED → Position увеличена
 * позже площадка: сделка FAILED, текущая позиция без неё
 * ```
 *
 * Оставить позицию навсегда увеличенной и просто стать `UNHEALTHY` нельзя:
 * задача сверки — вернуть `AccountHotState` к текущему состоянию площадки
 * (откат, перестроение или коррекция — решает будущий reconciler).
 *
 * ### Исполнение без локальной заявки — исполнение аккаунта
 *
 * `fill.orderId` не обязан ссылаться на заявку, созданную нашим рантаймом:
 * сделка из UI площадки или другого процесса — реальная активность аккаунта.
 * `fill.venueId` и `fill.accountId` совпадают с парой запроса.
 *
 * ### Идентичность исполнения
 *
 * Одна и та же сделка площадки, увиденная приватным WS и REST-ом, обязана
 * дать ОДИН И ТОТ ЖЕ canonical `Fill` (`FillId` и факт по
 * `findFillFactDifference`): иначе одна сделка стала бы двумя исполнениями.
 * Поэтому адаптер строит `Fill` тем же canonical-правилом, что и живой поток
 * (`FillMapper`: taker/maker, `maker_orders`, cross-outcome, составной
 * `FillId` при нескольких наших maker-заявках), а не вторым независимым
 * маппером. Одна сделка может дать НЕСКОЛЬКО исполнений — у всех один
 * `tradeStatus`, потому что статус принадлежит сделке.
 *
 * Владение maker-заявкой определяется по НАШЕЙ записи в списке maker-заявок
 * сделки, а не по полям верхнего уровня: в cross-outcome сделке они
 * принадлежат тейкеру.
 *
 * @example
 * ```typescript
 * const venueFill: AuthoritativeFillState = {
 *   fill,
 *   metadata: { tradeStatus: 'CONFIRMED', liquidity: 'TAKER', venueTradeId },
 * };
 * ```
 */
export interface AuthoritativeFillState {
  /** Canonical факт исполнения — та же идентичность, что у приватного потока */
  readonly fill: Fill;
  /** Метаданные исполнения с обязательным `tradeStatus` */
  readonly metadata: AuthoritativeFillMetadata;
}

/**
 * Authoritative текущее состояние аккаунта на площадке за один проход сверки.
 *
 * @remarks
 * ### Это НЕ снимок транзакции базы данных
 *
 * Будущий адаптер получит collateral, позиции, заявки и сделки РАЗНЫМИ
 * запросами, и площадка не гарантирует, что они описывают один момент.
 * Контракт означает один проход наблюдения сверки, и адаптер обязан:
 *
 * - получить каждый нужный набор ПОЛНОСТЬЮ — пагинация пройдена до конца;
 * - получить каждый набор ОДИН раз за проход и сохранить как есть;
 * - не возвращать частично успешное состояние: отказ любого набора — `Err`
 *   всего прохода;
 * - fail closed при schema drift, оборванной пагинации и ошибке маппинга:
 *   короткий список неотличим от «этого нет на площадке», а непонятая запись
 *   аккаунта — дефект маппинга, а не «чужая запись».
 *
 * ### `collateralBalance` — фактическое владение, а не `available`
 *
 * Текущее collateral-владение аккаунта, которое сообщает площадка. Это НЕ
 * `Balance.available` и НЕ `Balance.reserved`: резервация — наша форма
 * представления. Будущая сверка построит
 *
 * ```text
 * local total collateral = Balance.available + Balance.reserved
 * ```
 *
 * приведёт его к `collateralBalance`, а разделение выведет из authoritative
 * открытых BUY (`reserved = (size − filledSize) × price`). Полей
 * `availableCollateral`/`reservedCollateral` здесь нет сознательно.
 *
 * ### Наборы
 *
 * - `positions` — по одной записи на актив; актива нет в списке — площадка
 *   сообщает, что аккаунт его не держит (запись с нулевым `quantity` значит
 *   то же самое). Поэтому владение меньше любого порога «пыли» обязано здесь
 *   быть: адаптер не имеет права полагаться на фильтр площадки по умолчанию,
 *   иначе отсутствие записи занизило бы текущий инвентарь;
 * - `openOrders` — только живые заявки (`OPEN` либо `PARTIALLY_FILLED`, тип
 *   {@link AuthoritativeOpenOrderState} не пропускает терминальные), включая
 *   заявки, которые наш рантайм не создавал;
 * - `fills` — сделки аккаунта со статусом площадки, включая нефинальные и
 *   `FAILED`, включая инициированные не нами.
 *
 * @example
 * ```typescript
 * const result = await source.getAccountState(venueId, accountId);
 * if (result.ok) {
 *   const { collateralBalance, positions, openOrders, fills } = result.value;
 * }
 * ```
 */
export interface AuthoritativeAccountState {
  /** Текущее collateral-владение аккаунта по данным площадки (НЕ `available`) */
  readonly collateralBalance: Money;
  /** Текущие владения outcome-активами, по одной записи на актив */
  readonly positions: readonly AuthoritativePositionState[];
  /** Живые заявки аккаунта на площадке, кто бы их ни создал */
  readonly openOrders: readonly AuthoritativeOpenOrderState[];
  /** Сделки аккаунта с обязательным статусом на площадке */
  readonly fills: readonly AuthoritativeFillState[];
}
