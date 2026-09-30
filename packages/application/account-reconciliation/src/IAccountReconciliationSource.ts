/**
 * Узкий порт authoritative-источника состояния аккаунта.
 *
 * @remarks
 * Это НЕ широкий `IExchangeClient` с десятками методов. Сверке нужно ровно
 * четыре чтения, и порт содержит ровно их: всё остальное (постановка и отмена
 * заявок, подписки, рыночные данные) — чужие обязанности, и тащить их в
 * границу сверки значило бы связать её с каждым изменением торгового клиента.
 *
 * ### Граница возвращает ТОЛЬКО canonical domain-сущности
 *
 * ```text
 * Portfolio   деньги + позиции + токенные балансы, инварианты уже выполнены
 * Order       canonical заявка со своим настоящим статусом
 * Fill        canonical факт исполнения
 * ```
 *
 * Никаких REST-DTO, сырого JSON, vendor-строк статусов и `Response`-объектов
 * HTTP-клиента: перевод vendor-формата в canonical — обязанность адаптера
 * источника (Infrastructure), а не application-пакета. Поэтому пакет сверки от
 * инфраструктуры Polymarket не зависит вовсе.
 *
 * ### Требование к будущему адаптеру: настоящие лоты
 *
 * `Position` в `Portfolio` лотовая: количество, средняя цена и FIFO-закрытие
 * выводятся из лотов. Адаптер НЕ имеет права собирать «позицию» из пары
 * `quantity + averagePrice`, которую отдаёт REST площадки: такая позиция
 * выглядела бы валидной, но её лоты были бы выдуманы, и первое же FIFO-
 * закрытие посчитало бы неверный realized PnL. Для materialization настоящего
 * authoritative-портфеля адаптеру нужна достаточная история исполнений
 * (provenance), из которой строятся настоящие лоты. В этом MR адаптера нет —
 * тестовый источник отдаёт заранее собранный валидный `Portfolio`.
 *
 * ### Ошибки
 *
 * Ожидаемые отказы (сеть, авторизация, rate limit, непонятный ответ) —
 * `Err(AccountReconciliationSourceError)`, а не исключения. Отказ ЛЮБОГО
 * обязательного чтения означает, что снимок неполон, и коррекция не
 * публикуется вовсе.
 *
 * @example
 * ```typescript
 * class PolymarketAccountSource implements IAccountReconciliationSource {
 *   async getPortfolio(venueId, accountId) {
 *     // REST → canonical Portfolio с настоящими лотами
 *   }
 *   // …
 * }
 * ```
 */
import type { AccountId, OrderId, VenueId } from '@polymarket/ids';
import type { Fill } from '@polymarket/fill';
import type { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';
import type { Result } from '@polymarket/result';
import type { AccountReconciliationSourceError } from './errors.js';

/**
 * Authoritative-чтения состояния одного аккаунта.
 *
 * @remarks
 * Каждый метод адресует аккаунт ПАРОЙ `venueId + accountId` — той же, что и
 * приватное состояние: один строковый идентификатор на двух площадках — два
 * разных аккаунта.
 *
 * Согласованность снимка МЕЖДУ вызовами (портфель прочитан до исполнения,
 * список исполнений — после) порт не гарантирует: это свойство конкретного
 * источника, и отвечает за него адаптер.
 */
export interface IAccountReconciliationSource {
  /**
   * Authoritative-портфель аккаунта.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @returns Canonical `Portfolio` либо отказ источника
   *
   * @remarks
   * Портфель принимается сверкой ЦЕЛИКОМ и из заявок/исполнений не
   * пересчитывается, поэтому он обязан быть экономически полным — включая
   * настоящие лоты позиций (см. заголовок модуля).
   */
  getPortfolio(
    venueId: VenueId,
    accountId: AccountId,
  ): Promise<Result<Portfolio, AccountReconciliationSourceError>>;

  /**
   * Заявки аккаунта, открытые на площадке сейчас.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @returns Canonical заявки в их настоящих статусах либо отказ источника
   *
   * @remarks
   * Отсутствие заявки в этом списке НЕ означает ни отмены, ни исполнения, ни
   * отказа: из «её тут нет» вывести, что с ней стало, нельзя. Поэтому для
   * каждой локально открытой заявки, которой здесь не оказалось, сверка
   * отдельно спрашивает {@link getOrder}.
   */
  getOpenOrders(
    venueId: VenueId,
    accountId: AccountId,
  ): Promise<Result<readonly Order[], AccountReconciliationSourceError>>;

  /**
   * Исполнения аккаунта, существующие на площадке.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт
   * @returns Canonical факты исполнений либо отказ источника
   *
   * @remarks
   * Присутствие исполнения здесь — authoritative-подтверждение его
   * существования: на оси рантайма оно становится `CONFIRMED`.
   */
  getFills(
    venueId: VenueId,
    accountId: AccountId,
  ): Promise<Result<readonly Fill[], AccountReconciliationSourceError>>;

  /**
   * Настоящее состояние одной заявки.
   *
   * @param venueId - Площадка аккаунта
   * @param accountId - Аккаунт-владелец
   * @param orderId - Заявка
   * @returns Canonical заявка; `undefined` — источник такой заявки не знает;
   *   либо отказ источника
   *
   * @remarks
   * `undefined` — это ответ «не знаю», а не «отменена». Сверка его НЕ
   * интерпретирует: локально открытая заявка, неизвестная источнику, делает
   * снимок неполным, и коррекция не публикуется (fail closed).
   */
  getOrder(
    venueId: VenueId,
    accountId: AccountId,
    orderId: OrderId,
  ): Promise<Result<Order | undefined, AccountReconciliationSourceError>>;
}
