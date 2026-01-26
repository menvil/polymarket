/**
 * OutcomeToken entity - токен исхода бинарного рынка
 *
 * @remarks
 * Представляет один из двух возможных исходов бинарного рынка предсказаний.
 * Каждый токен имеет уникальный идентификатор, принадлежит определенному рынку
 * и имеет позицию (индекс) 0 или 1.
 *
 * **Почему Entity, а не Value Object?**
 * - Имеет уникальную идентичность (id)
 * - Привязан к конкретному рынку (marketId)
 * - Позиция в рынке важна для бизнес-логики (outcomeIndex)
 * - Сравнение по идентичности, а не по значению
 *
 * **Lifecycle:**
 * - Создается вместе с Market (как часть aggregate)
 * - Существует пока существует Market
 * - Не может быть создан отдельно от Market
 *
 * **Aggregate Root:**
 * Market является aggregate root, OutcomeToken - часть aggregate.
 * Поэтому OutcomeToken создается только через Market.create() и использует
 * внутренний метод createTrusted() без валидации (валидация на уровне Market).
 *
 * @example
 * ```typescript
 * // OutcomeToken создается внутри Market aggregate
 * const market = Market.create({
 *   id: 'market-123',
 *   slug: 'btc-100k-2024',
 *   question: 'Will BTC reach $100k in 2024?',
 *   outcomeNames: ['Up', 'Down'],
 *   // ...
 * });
 *
 * // Получение токена из рынка
 * const upToken = market.getOutcomeToken(0);
 * console.log(upToken.name); // "Up"
 * console.log(upToken.outcomeIndex); // 0
 *
 * // Сравнение токенов
 * const anotherToken = market.getOutcomeToken(1);
 * console.log(upToken.equals(anotherToken)); // false
 * ```
 */

/**
 * Индекс исхода в бинарном рынке
 *
 * @remarks
 * Бинарные рынки имеют ровно 2 исхода:
 * - 0: Первый исход (например, "Up")
 * - 1: Второй исход (например, "Down")
 */
export type OutcomeIndex = 0 | 1;

/**
 * Параметры для создания OutcomeToken
 *
 * @remarks
 * Используется только внутри aggregate (Market).
 * Внешний код не должен создавать токены напрямую.
 */
export interface OutcomeTokenProps {
  /** Уникальный идентификатор токена (asset_id в Polymarket API) */
  readonly id: string;
  /** ID рынка к которому принадлежит токен */
  readonly marketId: string;
  /** Индекс исхода (0 или 1) */
  readonly outcomeIndex: OutcomeIndex;
  /** Человеко-читаемое название исхода (например, "Up", "Down") */
  readonly name: string;
}

/**
 * OutcomeToken entity
 *
 * @remarks
 * Immutable entity представляющая токен исхода бинарного рынка.
 * Все свойства readonly для обеспечения неизменяемости.
 *
 * **Важно:** OutcomeToken является частью Market aggregate и создается
 * только через внутренний метод createTrusted(). Внешний код получает
 * токены через методы Market entity.
 */
export class OutcomeToken {
  /** Уникальный идентификатор токена (asset_id) */
  public readonly id: string;

  /** ID рынка к которому принадлежит токен */
  public readonly marketId: string;

  /** Индекс исхода (0 или 1) */
  public readonly outcomeIndex: OutcomeIndex;

  /** Человеко-читаемое название исхода */
  public readonly name: string;

  /**
   * Приватный конструктор
   *
   * @remarks
   * Конструктор приватный чтобы предотвратить создание токенов
   * вне контекста Market aggregate. Используйте createTrusted()
   * внутри Market или получайте токены через Market.getOutcomeToken().
   *
   * @param props - Параметры токена
   */
  private constructor(props: OutcomeTokenProps) {
    this.id = props.id;
    this.marketId = props.marketId;
    this.outcomeIndex = props.outcomeIndex;
    this.name = props.name;
  }

  /**
   * Создает OutcomeToken без валидации (внутренний метод)
   *
   * @remarks
   * Этот метод предназначен для использования **только внутри Market aggregate**.
   * Он создает токен без валидации, предполагая что данные уже валидированы
   * на уровне Market.create().
   *
   * **Не используйте этот метод напрямую!** Вместо этого создавайте Market
   * через Market.create(), который автоматически создаст токены.
   *
   * @param props - Параметры токена (должны быть уже валидированы)
   * @returns Новый экземпляр OutcomeToken
   *
   * @internal
   *
   * @example
   * ```typescript
   * // ❌ НЕ ДЕЛАЙТЕ ТАК в application коде:
   * const token = OutcomeToken.createTrusted({...});
   *
   * // ✅ ПРАВИЛЬНО - создавайте через Market:
   * const market = Market.create({
   *   id: 'market-123',
   *   outcomeNames: ['Up', 'Down'],
   *   // ... другие параметры
   * });
   * const token = market.getOutcomeToken(0);
   * ```
   */
  public static createTrusted(props: OutcomeTokenProps): OutcomeToken {
    return new OutcomeToken(props);
  }

  /**
   * Проверяет равенство токенов по идентичности
   *
   * @remarks
   * Два токена считаются равными если у них одинаковый id.
   * Это сравнение по идентичности (Entity), а не по значению (Value Object).
   *
   * @param other - Другой токен для сравнения
   * @returns true если токены имеют одинаковый id
   *
   * @example
   * ```typescript
   * const token1 = market.getOutcomeToken(0);
   * const token2 = market.getOutcomeToken(0);
   * const token3 = market.getOutcomeToken(1);
   *
   * console.log(token1.equals(token2)); // true (один и тот же токен)
   * console.log(token1.equals(token3)); // false (разные токены)
   * ```
   */
  public equals(other: OutcomeToken): boolean {
    return this.id === other.id;
  }

  /**
   * Возвращает строковое представление токена
   *
   * @returns Строковое представление токена
   *
   * @example
   * ```typescript
   * const token = market.getOutcomeToken(0);
   * console.log(token.toString());
   * // Output: "OutcomeToken[token-up]: Up (index: 0, market: market-123)"
   * ```
   */
  public toString(): string {
    return `OutcomeToken[${this.id}]: ${this.name} (index: ${this.outcomeIndex}, market: ${this.marketId})`;
  }
}
