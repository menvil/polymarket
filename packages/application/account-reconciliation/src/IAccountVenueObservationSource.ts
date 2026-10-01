/**
 * Порт authoritative-НАБЛЮДЕНИЙ аккаунта на площадке — финальная граница для
 * настоящего venue-адаптера.
 *
 * @remarks
 * ### Чем отличается от `IAccountReconciliationSource`
 *
 * ```text
 * IAccountReconciliationSource      готовое ЛОКАЛЬНОЕ состояние:
 *                                   Portfolio + Order + Fill
 * IAccountVenueObservationSource    ФАКТЫ площадки:
 *                                   collateral, владения, заявки, сделки
 *                                   со статусом площадки
 * ```
 *
 * Настоящая площадка не может вернуть наш `Portfolio`: резервации, FIFO-лоты
 * и локальные поля заявки — наша бухгалтерия, а не её знание. Адаптер,
 * обязанный отдать `Portfolio`, был бы вынужден их выдумать. Этот порт
 * требует от адаптера только того, что площадка действительно сообщает
 * (см. `AuthoritativeAccountObservation.ts`).
 *
 * Сегодня порт — подготовка: его не вызывает ни `AccountReconciler`, ни
 * runtime. Существующая сверка продолжает работать через
 * `IAccountReconciliationSource` без изменений. Порядок перехода:
 *
 * ```text
 * этот MR   контракт наблюдений (порт + DTO), без реализаций
 * далее     Polymarket-адаптер этого порта на официальном @polymarket/client
 * затем     matcher: сопоставление наблюдений с AccountHotState и коррекция;
 *           переключение AccountReconciler на этот порт
 * ```
 *
 * ### Граница
 *
 * Только canonical-типы. REST-DTO, сырого JSON, vendor-строк статусов, SDK-
 * типов и HTTP-клиента в сигнатурах нет — пакет сверки от инфраструктуры не
 * зависит.
 *
 * ### Ошибки — fail closed
 *
 * Ожидаемые отказы (сеть, авторизация, rate limit, оборванная пагинация,
 * ответ, который нельзя ОДНОЗНАЧНО перевести в canonical-форму) —
 * `Err(AccountReconciliationSourceError)` с `operation`, равным имени метода,
 * а не исключение и не «разумное значение по умолчанию».
 *
 * @example
 * ```typescript
 * class PolymarketAccountVenueObservationSource implements IAccountVenueObservationSource {
 *   async getAccountObservation(venueId, accountId) {
 *     // collateral + positions + open orders + account trades → один проход
 *   }
 *   // …
 * }
 * ```
 */
import type { AccountId, AssetId, OrderId, VenueId } from '@polymarket/ids';
import type { Result } from '@polymarket/result';
import type { Quantity } from '@polymarket/value-objects';
import type {
  AuthoritativeAccountObservation,
  AuthoritativeOrderObservation,
} from './AuthoritativeAccountObservation.js';
import type { AccountReconciliationSourceError } from './errors.js';

/**
 * Authoritative-наблюдения одного аккаунта на площадке.
 *
 * @remarks
 * Каждый метод адресует аккаунт ПАРОЙ `venueId + accountId` — той же, что и
 * приватное состояние: один строковый идентификатор на двух площадках — два
 * разных аккаунта.
 */
export interface IAccountVenueObservationSource {
  /**
   * Один логический проход наблюдения аккаунта.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @returns Наблюдение (collateral, владения, живые заявки, сделки со
   *   статусом площадки) либо отказ источника
   *
   * @remarks
   * Наблюдение НЕ атомарно на стороне площадки: адаптер собирает его
   * несколькими запросами. Обещание другое — каждый набор получен ОДИН раз за
   * проход, целиком (пагинация исчерпана) и сохранён как есть. Отказ ЛЮБОГО
   * набора — `Err` всего прохода: частичное наблюдение исправило бы одно и
   * молча оставило бы расходиться другое.
   *
   * @example
   * ```typescript
   * const observation = await source.getAccountObservation(venueId, accountId);
   * if (!observation.ok) return observation; // SOURCE_FAILED, коррекции нет
   * ```
   */
  getAccountObservation(
    venueId: VenueId,
    accountId: AccountId,
  ): Promise<Result<AuthoritativeAccountObservation, AccountReconciliationSourceError>>;

  /**
   * Состояние одной заявки на площадке.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт-владелец
   * @param orderId - Заявка
   * @returns Наблюдение заявки (в том числе терминальной); `undefined` —
   *   площадка такой заявки не знает; либо отказ источника
   *
   * @remarks
   * Нужен для локально открытой заявки, которой нет среди
   * `openOrders`: из «её нет среди живых» не вывести, что с ней стало.
   *
   * `undefined` — ответ «не знаю», а не «отменена»: интерпретировать его как
   * терминальный статус запрещено (fail closed). Вернувшееся наблюдение
   * обязано иметь `orderId`, равный запрошенному.
   *
   * @example
   * ```typescript
   * const result = await source.getOrderObservation(venueId, accountId, orderId);
   * if (result.ok && result.value?.status === 'CANCELED') {
   *   // площадка подтвердила отмену
   * }
   * ```
   */
  getOrderObservation(
    venueId: VenueId,
    accountId: AccountId,
    orderId: OrderId,
  ): Promise<Result<AuthoritativeOrderObservation | undefined, AccountReconciliationSourceError>>;

  /**
   * Независимое подтверждение владения одним outcome-активом.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @param asset - Outcome-актив (не collateral: он — в
   *   `AuthoritativeAccountObservation.collateralBalance`)
   * @returns Полное количество актива на аккаунте по данным площадки (`0`,
   *   если аккаунт его не держит) либо отказ источника
   *
   * @remarks
   * ### Что это значит
   *
   * Сколько актива ДЕРЖИТ аккаунт — полное владение. Это НЕ
   * `TokenBalance.available` и НЕ `TokenBalance.reserved`: площадка не знает
   * нашей резервации под открытые SELL. Позже сравнение будет таким:
   *
   * ```text
   * getAssetBalance(asset)
   *   ↕
   * TokenBalance.available + TokenBalance.reserved
   *   ↕
   * Position.quantity
   * ```
   *
   * а локальный `reserved` будет выводиться отдельно — из открытых SELL.
   *
   * ### Когда вызывать
   *
   * ТОЛЬКО при расхождении: количество позиции в наблюдении не совпало с
   * локальным, и нужно подтверждение из независимого источника площадки
   * (баланс расчётного слоя вместо агрегатора позиций). В обычном успешном
   * проходе для каждого актива его НЕ вызывают — это лишний запрос на актив
   * без новой информации.
   *
   * Количество — точное: базовые единицы площадки переводятся в `Quantity`
   * без промежуточного `number`.
   *
   * @example
   * ```typescript
   * const held = await source.getAssetBalance(venueId, accountId, upToken);
   * if (held.ok && !held.value.equals(localPosition.quantity)) {
   *   // POSITION_QUANTITY_MISMATCH подтверждён независимым источником
   * }
   * ```
   */
  getAssetBalance(
    venueId: VenueId,
    accountId: AccountId,
    asset: AssetId,
  ): Promise<Result<Quantity, AccountReconciliationSourceError>>;
}
