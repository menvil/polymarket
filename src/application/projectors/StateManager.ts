/**
 * StateManager - Управление Map<assetId, Aggregate>
 *
 * @remarks
 * Простой менеджер состояния для projector'ов.
 * Владеет Map<assetId, MarketDataSubscriptionAggregate> но не содержит бизнес-логику.
 *
 * ## Ответственность:
 *
 * ✅ Создаёт и хранит aggregates для каждого assetId
 * ✅ Предоставляет get/getOrCreate/has методы
 * ✅ Позволяет очистить состояние (для тестов)
 *
 * ## Что НЕ делает:
 *
 * ❌ Не применяет события (это делают Projector'ы)
 * ❌ Не подписывается на EventBus
 * ❌ Не вызывает callbacks
 * ❌ Не публикует события
 * ❌ Не содержит бизнес-логику
 *
 * ## Изоляция состояния:
 *
 * - Каждый assetId имеет свой собственный Aggregate
 * - Ошибка в одном aggregate не влияет на другие
 * - Легко запросить состояние для конкретного маркета
 *
 * @example
 * ```typescript
 * const stateManager = new StateManager();
 *
 * // Получить или создать aggregate
 * const aggregate1 = stateManager.getOrCreate('asset-123');
 * const aggregate2 = stateManager.getOrCreate('asset-456');
 *
 * // Проверить существование
 * if (stateManager.has('asset-123')) {
 *   const aggregate = stateManager.get('asset-123');
 *   console.log(aggregate.getStatus());
 * }
 *
 * // Получить все tracked asset IDs
 * const assetIds = stateManager.getTrackedAssetIds();
 * // ['asset-123', 'asset-456']
 *
 * // Очистить (для тестов)
 * stateManager.clear();
 * ```
 */

import { MarketDataSubscriptionAggregate } from '../../domain/aggregates/MarketDataSubscriptionAggregate.js';

/**
 * StateManager
 *
 * @remarks
 * Менеджер для Map<assetId, Aggregate>.
 * Не содержит бизнес-логики - только управление коллекцией.
 */
export class StateManager {
  /**
   * Map assetId → Aggregate
   *
   * @remarks
   * Каждый assetId имеет свой изолированный aggregate.
   */
  private readonly aggregates: Map<string, MarketDataSubscriptionAggregate> =
    new Map();

  /**
   * Получает aggregate для assetId или создаёт новый
   *
   * @param assetId - Asset ID
   * @returns Aggregate (существующий или только что созданный)
   *
   * @remarks
   * Идемпотентный метод:
   * - Первый вызов с assetId → создаёт новый aggregate
   * - Последующие вызовы → возвращают существующий
   *
   * @example
   * ```typescript
   * const aggregate = stateManager.getOrCreate('asset-123');
   * const sameAggregate = stateManager.getOrCreate('asset-123');
   * // aggregate === sameAggregate (true)
   * ```
   */
  public getOrCreate(assetId: string): MarketDataSubscriptionAggregate {
    let aggregate = this.aggregates.get(assetId);

    if (!aggregate) {
      aggregate = MarketDataSubscriptionAggregate.create(assetId);
      this.aggregates.set(assetId, aggregate);
    }

    return aggregate;
  }

  /**
   * Получает aggregate для assetId
   *
   * @param assetId - Asset ID
   * @returns Aggregate или null если не существует
   *
   * @remarks
   * Не создаёт aggregate если его нет.
   * Используйте getOrCreate() если нужно создать.
   *
   * @example
   * ```typescript
   * const aggregate = stateManager.get('asset-123');
   * if (aggregate) {
   *   console.log(aggregate.getOrderbook());
   * }
   * ```
   */
  public get(assetId: string): MarketDataSubscriptionAggregate | null {
    return this.aggregates.get(assetId) ?? null;
  }

  /**
   * Проверяет существует ли aggregate для assetId
   *
   * @param assetId - Asset ID
   * @returns true если aggregate существует
   *
   * @example
   * ```typescript
   * if (stateManager.has('asset-123')) {
   *   console.log('Aggregate exists');
   * }
   * ```
   */
  public has(assetId: string): boolean {
    return this.aggregates.has(assetId);
  }

  /**
   * Получает список всех tracked asset IDs
   *
   * @returns Массив asset IDs которые имеют aggregates
   *
   * @example
   * ```typescript
   * const assetIds = stateManager.getTrackedAssetIds();
   * console.log(`Tracking ${assetIds.length} markets`);
   * ```
   */
  public getTrackedAssetIds(): string[] {
    return Array.from(this.aggregates.keys());
  }

  /**
   * Получает количество tracked aggregates
   *
   * @returns Количество aggregates в Map
   *
   * @example
   * ```typescript
   * console.log(`Tracking ${stateManager.count()} markets`);
   * ```
   */
  public count(): number {
    return this.aggregates.size;
  }

  /**
   * Очищает все aggregates
   *
   * @remarks
   * Удаляет все aggregates из Map.
   * Полезно для cleanup в тестах.
   *
   * @example
   * ```typescript
   * // После тестов
   * stateManager.clear();
   * ```
   */
  public clear(): void {
    this.aggregates.clear();
  }
}
