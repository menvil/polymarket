/**
 * IOrderRepository port
 *
 * @remarks
 * Интерфейс для хранения и извлечения ордеров.
 * Реализация находится в infrastructure layer (БД/in-memory).
 *
 * Responsibilities:
 * - Сохранение ордеров
 * - Поиск по различным критериям
 * - Обновление статусов
 *
 * @example
 * ```typescript
 * class InMemoryOrderRepository implements IOrderRepository {
 *   private orders = new Map<string, Order>();
 *
 *   async save(order: Order): Promise<void> {
 *     this.orders.set(order.id, order);
 *   }
 * }
 * ```
 */
import { Order, OrderStatus } from '../entities/Order.js';

/**
 * Order repository interface
 *
 * @remarks
 * Domain layer определяет интерфейс, infrastructure предоставляет реализацию.
 */
export interface IOrderRepository {
  /**
   * Сохраняет новый ордер
   *
   * @param order - Ордер для сохранения
   * @returns void
   * @throws {Error} Если ордер уже существует
   *
   * @remarks
   * - Создаёт новую запись в хранилище
   * - Выбрасывает ошибку при дублировании ID
   */
  save(order: Order): Promise<void>;

  /**
   * Обновляет существующий ордер
   *
   * @param order - Ордер с обновлёнными данными
   * @returns void
   * @throws {Error} Если ордер не найден
   *
   * @remarks
   * - Обновляет запись в хранилище
   * - Используется для обновления статуса, filledSize и т.д.
   */
  update(order: Order): Promise<void>;

  /**
   * Находит ордер по ID
   *
   * @param orderId - ID ордера
   * @returns Order или null если не найден
   *
   * @remarks
   * - Выполняет поиск по первичному ключу
   * - Возвращает null если ордер не существует
   */
  findById(orderId: string): Promise<Order | null>;

  /**
   * Находит все ордера для конкретного токена
   *
   * @param tokenId - ID токена (YES или NO)
   * @returns Массив ордеров для этого токена
   *
   * @remarks
   * - Использует индекс по tokenId для быстрого поиска
   * - Возвращает пустой массив если ордеров нет
   */
  findByTokenId(tokenId: string): Promise<Order[]>;

  /**
   * Находит все ордера для рынка (по обоим токенам YES и NO)
   *
   * @param yesTokenId - ID токена YES
   * @param noTokenId - ID токена NO
   * @returns Массив ордеров для обоих токенов
   *
   * @remarks
   * - Объединяет результаты для YES и NO токенов
   * - Правильный способ найти все ордера маркета
   */
  findByMarketTokens(yesTokenId: string, noTokenId: string): Promise<Order[]>;

  /**
   * Находит ордера по статусу
   *
   * @param status - Статус ордера
   * @returns Массив ордеров с указанным статусом
   *
   * @remarks
   * - Фильтрует по полю status
   * - Полезно для получения всех OPEN или PENDING ордеров
   */
  findByStatus(status: OrderStatus): Promise<Order[]>;

  /**
   * Находит ордера по статусам
   *
   * @param statuses - Массив статусов
   * @returns Массив ордеров с любым из указанных статусов
   *
   * @remarks
   * - Фильтрует по нескольким статусам
   * - Полезно для получения активных ордеров (PENDING | OPEN)
   */
  findByStatuses(statuses: OrderStatus[]): Promise<Order[]>;

  /**
   * Удаляет ордер
   *
   * @param orderId - ID ордера для удаления
   * @returns void
   *
   * @remarks
   * - Удаляет запись из хранилища
   * - Обычно не используется (предпочитаем обновление статуса)
   */
  delete(orderId: string): Promise<void>;

  /**
   * Получает все ордера
   *
   * @returns Массив всех ордеров
   *
   * @remarks
   * - Возвращает полный список
   * - Осторожно с большими БД (может быть медленно)
   */
  findAll(): Promise<Order[]>;
}
