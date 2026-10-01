/**
 * Порт authoritative ТЕКУЩЕГО состояния аккаунта на площадке — целевая
 * production-граница для настоящего venue-адаптера.
 *
 * @remarks
 * ### Transitional и target
 *
 * ```text
 * IAccountReconciliationSource   transitional-контракт коррекции #106:
 *                                готовый ЛОКАЛЬНЫЙ Portfolio + Order + Fill
 * IAccountVenueStateSource       target production-граница площадки:
 *                                ФАКТЫ площадки — collateral, владения,
 *                                заявки, сделки со статусом площадки
 * ```
 *
 * Настоящая площадка не может вернуть наш `Portfolio`: резервации, FIFO-лоты
 * и локальные поля заявки — наша бухгалтерия, а не её знание. Этот порт
 * требует от адаптера только то, что площадка действительно сообщает
 * (см. `AuthoritativeAccountState.ts`).
 *
 * Сегодня порт — подготовка: его не вызывает ни `AccountReconciler`, ни
 * runtime, реализаций нет. Существующая сверка работает через
 * `IAccountReconciliationSource` без изменений до миграционного шага.
 *
 * ### Сверка будет state-based
 *
 * Будущий reconciler спрашивает не только «какие события мы пропустили?», а
 * «какое состояние аккаунта должно существовать СЕЙЧАС по authoritative
 * фактам площадки?». Пропущенные исполнения и заявки помогают сохранить
 * provenance, но не единственный источник коррекции: текущее состояние
 * площадки побеждает противоречащую ему историю событий.
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
 * schema drift, ответ, который нельзя ОДНОЗНАЧНО перевести в canonical-форму)
 * — `Err(AccountReconciliationSourceError)` с `operation`, равным имени
 * метода, а не исключение и не «разумное значение по умолчанию».
 *
 * @example
 * ```typescript
 * class PolymarketAccountVenueStateSource implements IAccountVenueStateSource {
 *   async getAccountState(venueId, accountId) {
 *     // collateral + positions + open orders + account trades → один проход
 *   }
 *   // …
 * }
 * ```
 */
import type { AccountId, AssetId, OrderId, VenueId } from '@polymarket/ids';
import type { Result } from '@polymarket/result';
import type { Quantity } from '@polymarket/value-objects';
import type { AuthoritativeAccountState, AuthoritativeOrderState } from './AuthoritativeAccountState.js';
import type { AccountReconciliationSourceError } from './errors.js';

/**
 * Authoritative текущее состояние одного аккаунта на площадке.
 *
 * @remarks
 * Каждый метод адресует аккаунт ПАРОЙ `venueId + accountId` — той же, что и
 * приватное состояние: один строковый идентификатор на двух площадках — два
 * разных аккаунта.
 */
export interface IAccountVenueStateSource {
  /**
   * Текущее состояние аккаунта за один проход сверки.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @returns Collateral, владения, живые заявки и сделки со статусом площадки
   *   либо отказ источника
   *
   * @remarks
   * Не снимок транзакции площадки: адаптер собирает состояние несколькими
   * запросами. Обещание другое — каждый набор получен ОДИН раз за проход,
   * целиком (пагинация пройдена) и сохранён как есть. Отказ ЛЮБОГО набора —
   * `Err` всего прохода: частичное состояние исправило бы одно и молча
   * оставило бы расходиться другое.
   *
   * @example
   * ```typescript
   * const state = await source.getAccountState(venueId, accountId);
   * if (!state.ok) return state; // SOURCE_FAILED, коррекции нет
   * ```
   */
  getAccountState(
    venueId: VenueId,
    accountId: AccountId,
  ): Promise<Result<AuthoritativeAccountState, AccountReconciliationSourceError>>;

  /**
   * Состояние одной заявки на площадке — адресный запрос.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт-владелец
   * @param orderId - Заявка
   * @returns Состояние заявки (в том числе терминальное); `undefined` —
   *   источник не может доказать её состояние; либо отказ источника
   *
   * @remarks
   * `openOrders` содержит только живые заявки, и из «локально `OPEN`, а среди
   * живых её нет» вывести, что с ней стало, нельзя. Поэтому для такой заявки
   * сверка спрашивает её адресно:
   *
   * ```text
   * FILLED / CANCELED / EXPIRED / REJECTED   authoritative терминальное состояние
   * undefined                                отдельный неразрешённый случай
   * ```
   *
   * Терминальный статус по `undefined` угадывать запрещено. Вернувшееся
   * состояние обязано иметь `orderId`, равный запрошенному.
   *
   * @example
   * ```typescript
   * const result = await source.getOrderState(venueId, accountId, orderId);
   * if (result.ok && result.value?.status === 'CANCELED') {
   *   // площадка подтвердила отмену
   * }
   * ```
   */
  getOrderState(
    venueId: VenueId,
    accountId: AccountId,
    orderId: OrderId,
  ): Promise<Result<AuthoritativeOrderState | undefined, AccountReconciliationSourceError>>;

  /**
   * Независимая проверка текущего владения одним outcome-активом.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @param asset - Outcome-актив (не collateral: он — в
   *   `AuthoritativeAccountState.collateralBalance`)
   * @returns Фактическое текущее количество актива на аккаунте (`0`, если
   *   аккаунт его не держит) либо отказ источника
   *
   * @remarks
   * ### Что это значит
   *
   * Сколько актива аккаунт ДЕРЖИТ сейчас — полное владение. Это НЕ
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
   * ### Когда вызывать
   *
   * Прежде всего как более сильная проверка при расхождении: количество в
   * `positions` не совпало с локальным, и нужно подтверждение из независимого
   * источника площадки (баланс расчётного слоя вместо агрегатора позиций).
   * Обязательным для каждого токена в каждом проходе он НЕ является.
   *
   * «Площадка не знает такой актив» и «аккаунт держит 0» — разные ответы:
   * первое — `Err`. Количество точное: базовые единицы площадки переводятся в
   * `Quantity` без промежуточного `number`.
   *
   * @example
   * ```typescript
   * const held = await source.getAssetBalance(venueId, accountId, yesToken);
   * if (held.ok && !held.value.equals(localPosition.quantity)) {
   *   // расхождение подтверждено независимым источником площадки
   * }
   * ```
   */
  getAssetBalance(
    venueId: VenueId,
    accountId: AccountId,
    asset: AssetId,
  ): Promise<Result<Quantity, AccountReconciliationSourceError>>;
}
