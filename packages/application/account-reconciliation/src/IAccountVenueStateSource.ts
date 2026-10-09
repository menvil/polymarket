/**
 * Порт authoritative ТЕКУЩЕГО состояния аккаунта на площадке — целевая
 * production-граница для настоящего venue-адаптера.
 *
 * @remarks
 * ### Transitional и target
 *
 * ```text
 * IAccountReconciliationSource   transitional-контракт текущей сверки:
 *                                готовый ЛОКАЛЬНЫЙ Portfolio + Order + Fill
 * IAccountVenueStateSource       target production-граница площадки:
 *                                ФАКТЫ площадки в пределах текущего
 *                                торгового контура
 * ```
 *
 * Настоящая площадка не может вернуть наш `Portfolio`: резервации, FIFO-лоты
 * и локальные поля заявки — наша бухгалтерия, а не её знание. Этот порт
 * требует от адаптера только то, что площадка действительно сообщает
 * (см. `AuthoritativeAccountState.ts`).
 *
 * Production-реализация — `PolymarketAccountVenueStateSource` в
 * `@polymarket/polymarket-v2/account`. Сверка порт пока НЕ вызывает: ни
 * `AccountReconciler`, ни runtime. Существующая сверка работает через
 * `IAccountReconciliationSource` без изменений до миграционного шага.
 *
 * ### Состояние текущего торгового контура, а не история аккаунта
 *
 * Источник отвечает в пределах `AccountVenueStateScope`, который задаёт
 * вызывающий, — обычно 1–4 рынка и их outcome-токены:
 *
 * ```text
 * на весь аккаунт        collateralBalance, openOrders
 * в пределах scope       assetBalances (каждый актив scope, ноль явно)
 * ограниченный хвост     recentFills на рынках scope
 * ```
 *
 * Сканирования позиций и исполнений за всю жизнь аккаунта нет, и от полноты
 * account-wide листинга позиций контракт не зависит: баланс каждого
 * известного токена — адресный запрос. Отдельного метода «баланс одного
 * актива» поэтому тоже нет: это и есть `assetBalances` основной операции.
 *
 * ### Сверка будет state-based
 *
 * Будущий reconciler спрашивает не только «какие события мы пропустили?», а
 * «какое состояние аккаунта должно существовать СЕЙЧАС по authoritative
 * фактам площадки?». Пропущенные исполнения и заявки помогают сохранить
 * provenance, но не единственный источник коррекции: текущее состояние
 * площадки побеждает противоречащую ему историю событий, а текущий баланс
 * актива — `recentFills`.
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
 *   async getAccountState(venueId, accountId, scope) {
 *     // collateral + балансы scope.assets + open orders + свежий хвост сделок
 *     // на scope.marketIds → один проход
 *   }
 *   async getOrderState(venueId, accountId, orderId) {
 *     // адресный запрос одной заявки
 *   }
 * }
 * ```
 */
import type { AccountId, OrderId, VenueId } from '@polymarket/ids';
import type { Result } from '@polymarket/result';
import type {
  AccountVenueStateScope,
  AuthoritativeAccountState,
  AuthoritativeOrderState,
} from './AuthoritativeAccountState.js';
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
   * Текущее состояние аккаунта в пределах scope за один проход сверки.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @param scope - Рынки и outcome-активы текущего торгового контура; задаёт
   *   вызывающий, а не источник
   * @returns Account-wide collateral и живые заявки, балансы ровно активов
   *   scope и свежий хвост сделок на рынках scope либо отказ источника
   *
   * @remarks
   * Не снимок транзакции площадки: адаптер собирает состояние несколькими
   * запросами. Обещание другое — каждый набор получен ОДИН раз за проход и
   * сохранён как есть. Отказ ЛЮБОГО набора — `Err` всего прохода: частичное
   * состояние исправило бы одно и молча оставило бы расходиться другое.
   *
   * `set(assetBalances.asset) == set(scope.assets)`: по каждому активу scope
   * ровно одна запись, ноль явно, лишних нет.
   *
   * @example
   * ```typescript
   * const state = await source.getAccountState(venueId, accountId, {
   *   marketIds: [market],
   *   assets: [yesToken, noToken],
   * });
   * if (!state.ok) return state; // SOURCE_FAILED, коррекции нет
   * ```
   */
  getAccountState(
    venueId: VenueId,
    accountId: AccountId,
    scope: AccountVenueStateScope,
  ): Promise<Result<AuthoritativeAccountState, AccountReconciliationSourceError>>;

  /**
   * Состояние одной заявки на площадке — адресный запрос.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт-владелец
   * @param orderId - Заявка
   * @returns Полное состояние заявки — в том числе терминальное, поэтому
   *   `AuthoritativeOrderState`, а не `AuthoritativeOpenOrderState`; `undefined` —
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
}
