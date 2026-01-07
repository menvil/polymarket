/**
 * In-Memory Order Repository - реализация IOrderRepository
 *
 * @remarks
 * In-memory реализация репозитория ордеров для быстрого прототипирования и тестирования.
 * Хранит ордера в Map для O(1) доступа по ID.
 *
 * Особенности:
 * - Данные хранятся только в памяти (не персистентны)
 * - Высокая скорость операций
 * - Подходит для dev/test окружения
 * - Для production нужна реализация с БД (PostgreSQL, MongoDB и т.д.)
 *
 * Структура данных:
 * - Основное хранилище: Map<orderId, Order>
 * - Индексы для быстрого поиска:
 *   - По tokenId (для findByMarket)
 *   - По статусу (для findByStatus)
 *
 * @example
 * ```typescript
 * const repository = new InMemoryOrderRepository(logger);
 *
 * // Сохранение ордера
 * const order = Order.create({...});
 * await repository.save(order);
 *
 * // Поиск по ID
 * const found = await repository.findById(order.id);
 *
 * // Обновление статуса
 * const updated = order.withStatus('FILLED');
 * await repository.update(updated);
 *
 * // Поиск активных ордеров
 * const activeOrders = await repository.findByStatuses(['PENDING', 'OPEN']);
 * ```
 */

import { IOrderRepository } from '../../../domain/ports/IOrderRepository.js';
import { Order, OrderStatus } from '../../../domain/entities/Order.js';
import { ILogger } from '../../../domain/ports/ILogger.js';

/**
 * In-Memory Order Repository
 *
 * @remarks
 * Реализация IOrderRepository с хранением в памяти.
 * Thread-safe для single-threaded Node.js окружения.
 */
export class InMemoryOrderRepository implements IOrderRepository {
  /** Основное хранилище: orderId → Order */
  private readonly orders: Map<string, Order> = new Map();

  /** Индекс по tokenId для быстрого findByMarket */
  private readonly tokenIdIndex: Map<string, Set<string>> = new Map();

  /** Индекс по статусу для быстрого findByStatus */
  private readonly statusIndex: Map<OrderStatus, Set<string>> = new Map();

  /**
   * Создаёт новый In-Memory Order Repository
   *
   * @param logger - Логгер для отладки
   */
  constructor(private readonly logger: ILogger) {
    this.logger.info('InMemoryOrderRepository initialized');
  }

  /**
   * Сохраняет новый ордер
   *
   * @param order - Ордер для сохранения
   * @throws {Error} Если ордер с таким ID уже существует
   *
   * @remarks
   * Алгоритм:
   * 1. Проверяет, что ордер с таким ID не существует
   * 2. Сохраняет в основное хранилище
   * 3. Обновляет индексы (tokenId, status)
   *
   * @example
   * ```typescript
   * const order = Order.create({
   *   id: '0x123',
   *   tokenId: '0xabc',
   *   side: 'BUY',
   *   price: Price.fromNumber(0.55),
   *   size: Quantity.fromNumber(100),
   *   status: 'PENDING',
   *   timestamp: new Date()
   * });
   *
   * await repository.save(order);
   * console.log('Order saved');
   * ```
   */
  public async save(order: Order): Promise<void> {
    if (this.orders.has(order.id)) {
      throw new Error(`Order with ID ${order.id} already exists`);
    }

    this.orders.set(order.id, order);
    this.addToIndices(order);

    // Минимальный лог - детали уже логируются в orchestrator
    this.logger.debug(`Order saved to repository: ${order.id}`);
  }

  /**
   * Обновляет существующий ордер
   *
   * @param order - Ордер с обновлёнными данными
   * @throws {Error} Если ордер не найден
   *
   * @remarks
   * Алгоритм:
   * 1. Проверяет существование ордера
   * 2. Удаляет старые индексы
   * 3. Сохраняет новую версию
   * 4. Создаёт новые индексы
   *
   * @example
   * ```typescript
   * const order = await repository.findById('0x123');
   * const updated = order.withStatus('FILLED');
   * await repository.update(updated);
   * console.log('Order updated to FILLED');
   * ```
   */
  public async update(order: Order): Promise<void> {
    const existing = this.orders.get(order.id);
    if (!existing) {
      throw new Error(`Order with ID ${order.id} not found`);
    }

    // Удаляем старые индексы
    this.removeFromIndices(existing);

    // Обновляем ордер
    this.orders.set(order.id, order);

    // Добавляем новые индексы
    this.addToIndices(order);

    this.logger.debug(`Order updated: ${order.id}`);
  }

  /**
   * Находит ордер по ID
   *
   * @param orderId - ID ордера
   * @returns Order или null если не найден
   *
   * @remarks
   * O(1) сложность благодаря Map.
   *
   * @example
   * ```typescript
   * const order = await repository.findById('0x123');
   * if (order) {
   *   console.log(`Found: ${order.toString()}`);
   * } else {
   *   console.log('Order not found');
   * }
   * ```
   */
  public async findById(orderId: string): Promise<Order | null> {
    const order = this.orders.get(orderId);
    return order ?? null;
  }

  /**
   * Находит все ордера для конкретного токена
   *
   * @param tokenId - ID токена (YES или NO)
   * @returns Массив ордеров для этого токена
   *
   * @remarks
   * O(n) где n - количество ордеров для данного токена.
   * Использует tokenIdIndex для быстрого поиска.
   *
   * @example
   * ```typescript
   * const yesOrders = await repository.findByTokenId(market.yesTokenId);
   * const noOrders = await repository.findByTokenId(market.noTokenId);
   * console.log(`Found ${yesOrders.length} YES orders, ${noOrders.length} NO orders`);
   * ```
   */
  public async findByTokenId(tokenId: string): Promise<Order[]> {
    const orderIds = this.tokenIdIndex.get(tokenId);
    if (!orderIds) {
      return [];
    }

    const result: Order[] = [];
    for (const orderId of orderIds) {
      const order = this.orders.get(orderId);
      if (order) {
        result.push(order);
      }
    }

    return result;
  }

  /**
   * Находит все ордера для рынка (по обоим токенам YES и NO)
   *
   * @param yesTokenId - ID токена YES
   * @param noTokenId - ID токена NO
   * @returns Массив ордеров для обоих токенов
   *
   * @remarks
   * Объединяет результаты findByTokenId для YES и NO токенов.
   * Это правильный способ найти все ордера маркета.
   *
   * @example
   * ```typescript
   * const marketOrders = await repository.findByMarketTokens(
   *   market.yesTokenId,
   *   market.noTokenId
   * );
   * console.log(`Found ${marketOrders.length} orders for market`);
   * ```
   */
  public async findByMarketTokens(yesTokenId: string, noTokenId: string): Promise<Order[]> {
    const yesOrders = await this.findByTokenId(yesTokenId);
    const noOrders = await this.findByTokenId(noTokenId);
    return [...yesOrders, ...noOrders];
  }

  /**
   * Находит ордера по статусу
   *
   * @param status - Статус ордера
   * @returns Массив ордеров с указанным статусом
   *
   * @remarks
   * O(n) где n - количество ордеров с данным статусом.
   * Использует индекс для ускорения.
   *
   * @example
   * ```typescript
   * const openOrders = await repository.findByStatus('OPEN');
   * console.log(`${openOrders.length} open orders`);
   * ```
   */
  public async findByStatus(status: OrderStatus): Promise<Order[]> {
    const orderIds = this.statusIndex.get(status);
    if (!orderIds) {
      return [];
    }

    const result: Order[] = [];
    for (const orderId of orderIds) {
      const order = this.orders.get(orderId);
      if (order) {
        result.push(order);
      }
    }

    return result;
  }

  /**
   * Находит ордера по статусам
   *
   * @param statuses - Массив статусов
   * @returns Массив ордеров с любым из указанных статусов
   *
   * @remarks
   * Объединяет результаты findByStatus для каждого статуса.
   *
   * @example
   * ```typescript
   * const activeOrders = await repository.findByStatuses(['PENDING', 'OPEN']);
   * console.log(`${activeOrders.length} active orders`);
   * ```
   */
  public async findByStatuses(statuses: OrderStatus[]): Promise<Order[]> {
    const orderIdsSet = new Set<string>();

    // Собираем все orderIds для указанных статусов
    for (const status of statuses) {
      const orderIds = this.statusIndex.get(status);
      if (orderIds) {
        orderIds.forEach((id) => orderIdsSet.add(id));
      }
    }

    // Получаем ордера
    const result: Order[] = [];
    for (const orderId of orderIdsSet) {
      const order = this.orders.get(orderId);
      if (order) {
        result.push(order);
      }
    }

    return result;
  }

  /**
   * Удаляет ордер
   *
   * @param orderId - ID ордера для удаления
   *
   * @remarks
   * Алгоритм:
   * 1. Находит ордер
   * 2. Удаляет из индексов
   * 3. Удаляет из основного хранилища
   *
   * @example
   * ```typescript
   * await repository.delete('0x123');
   * console.log('Order deleted');
   * ```
   */
  public async delete(orderId: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (!order) {
      return; // Ордер уже не существует
    }

    // Удаляем из индексов
    this.removeFromIndices(order);

    // Удаляем из основного хранилища
    this.orders.delete(orderId);

    this.logger.debug(`Order deleted: ${orderId}`);
  }

  /**
   * Получает все ордера
   *
   * @returns Массив всех ордеров
   *
   * @remarks
   * Возвращает копию массива, не изменяя внутреннее хранилище.
   *
   * @example
   * ```typescript
   * const allOrders = await repository.findAll();
   * console.log(`Total orders: ${allOrders.length}`);
   * ```
   */
  public async findAll(): Promise<Order[]> {
    return Array.from(this.orders.values());
  }

  /**
   * Добавляет ордер в индексы
   *
   * @param order - Ордер для индексирования
   */
  private addToIndices(order: Order): void {
    // Индекс по tokenId
    let tokenOrders = this.tokenIdIndex.get(order.tokenId);
    if (!tokenOrders) {
      tokenOrders = new Set();
      this.tokenIdIndex.set(order.tokenId, tokenOrders);
    }
    tokenOrders.add(order.id);

    // Индекс по статусу
    let statusOrders = this.statusIndex.get(order.status);
    if (!statusOrders) {
      statusOrders = new Set();
      this.statusIndex.set(order.status, statusOrders);
    }
    statusOrders.add(order.id);
  }

  /**
   * Удаляет ордер из индексов
   *
   * @param order - Ордер для удаления из индексов
   */
  private removeFromIndices(order: Order): void {
    // Индекс по tokenId
    const tokenOrders = this.tokenIdIndex.get(order.tokenId);
    if (tokenOrders) {
      tokenOrders.delete(order.id);
      if (tokenOrders.size === 0) {
        this.tokenIdIndex.delete(order.tokenId);
      }
    }

    // Индекс по статусу
    const statusOrders = this.statusIndex.get(order.status);
    if (statusOrders) {
      statusOrders.delete(order.id);
      if (statusOrders.size === 0) {
        this.statusIndex.delete(order.status);
      }
    }
  }

  /**
   * Возвращает статистику репозитория
   *
   * @returns Объект со статистикой
   *
   * @remarks
   * Полезно для мониторинга и отладки.
   *
   * @example
   * ```typescript
   * const stats = repository.getStats();
   * console.log(`Total orders: ${stats.totalOrders}`);
   * console.log(`Open orders: ${stats.openOrders}`);
   * ```
   */
  public getStats(): {
    totalOrders: number;
    byStatus: Record<string, number>;
    byToken: Record<string, number>;
  } {
    const byStatus: Record<string, number> = {};
    this.statusIndex.forEach((orders, status) => {
      byStatus[status] = orders.size;
    });

    const byToken: Record<string, number> = {};
    this.tokenIdIndex.forEach((orders, tokenId) => {
      byToken[tokenId] = orders.size;
    });

    return {
      totalOrders: this.orders.size,
      byStatus,
      byToken,
    };
  }

  /**
   * Очищает все данные
   *
   * @remarks
   * Используется для тестов или сброса состояния.
   *
   * @example
   * ```typescript
   * repository.clear();
   * console.log('Repository cleared');
   * ```
   */
  public clear(): void {
    this.orders.clear();
    this.tokenIdIndex.clear();
    this.statusIndex.clear();
    this.logger.info('Repository cleared');
  }
}
