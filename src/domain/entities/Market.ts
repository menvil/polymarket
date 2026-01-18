/**
 * Сущность Market, представляющая рынок предсказаний
 *
 * @remarks
 * Представляет неизменяемый рынок предсказаний с бинарными исходами.
 * Каждый рынок имеет уникальный ID условия, вопрос, два токена исходов,
 * и статус жизненного цикла (ACTIVE, CLOSED или RESOLVED).
 *
 * Исходы хранятся как кортеж из двух объектов OutcomeToken,
 * где каждый токен имеет ID и читаемое название (например, "Up", "Down").
 *
 * Неизменяемость обеспечивает потокобезопасность и предотвращает случайные изменения состояния.
 * Используйте фабричный метод `create()` для создания новых рынков.
 *
 * @example
 * ```typescript
 * const market = Market.create({
 *   id: '0x123...',
 *   question: 'Bitcoin Up or Down?',
 *   outcomes: [
 *     { tokenId: '0xabc...', name: 'Up' },
 *     { tokenId: '0xdef...', name: 'Down' }
 *   ],
 *   expirationDate: new Date('2024-12-31T23:59:59Z'),
 *   status: 'ACTIVE'
 * });
 *
 * console.log(market.outcomes[0].name); // "Up"
 * console.log(market.outcomes[1].name); // "Down"
 * ```
 */
import { MarketNotFoundError } from '../../shared/errors/TradingError.js';

/**
 * Тип статуса рынка
 *
 * @remarks
 * - ACTIVE: Рынок открыт и принимает сделки
 * - CLOSED: Рынок закрыт, новые сделки не разрешены
 * - RESOLVED: Исход рынка определён
 */
export type MarketStatus = 'ACTIVE' | 'CLOSED' | 'RESOLVED';

/**
 * Тип индекса исхода (0 или 1 для бинарных рынков)
 */
export type OutcomeIndex = 0 | 1;

/**
 * Информация о токене исхода
 *
 * @remarks
 * Представляет один исход в бинарном рынке.
 * Содержит ID токена и читаемое название.
 */
export interface OutcomeToken {
  /** ID токена для этого исхода */
  readonly tokenId: string;
  /** Читаемое название исхода (например, "Up", "Down", "Yes", "No") */
  readonly name: string;
}

/**
 * Параметры создания рынка
 */
export interface MarketProps {
  readonly id: string;
  readonly question: string;
  readonly marketUrl?: string;
  /** Кортеж из двух токенов исходов [outcome0, outcome1] */
  readonly outcomes: readonly [OutcomeToken, OutcomeToken];
  readonly expirationDate: Date;
  readonly status: MarketStatus;
  /** Индекс разрешённого исхода (0 или 1), null если не разрешён */
  readonly resolvedOutcomeIndex?: OutcomeIndex | null;
}

/**
 * Сущность Market
 *
 * @remarks
 * Неизменяемая сущность, представляющая рынок предсказаний.
 * Все свойства readonly для обеспечения неизменяемости.
 * Используйте фабричный метод `create()` для создания экземпляра.
 */
export class Market {
  /** Уникальный идентификатор рынка (ID условия) */
  public readonly id: string;

  /** Вопрос или описание рынка */
  public readonly question: string;

  /** URL рынка на Polymarket */
  public readonly marketUrl: string | null;

  /**
   * Исходы рынка как кортеж из двух токенов
   *
   * @remarks
   * - outcomes[0]: Первый исход (например, "Up", "Yes")
   * - outcomes[1]: Второй исход (например, "Down", "No")
   */
  public readonly outcomes: readonly [OutcomeToken, OutcomeToken];

  /** Дата/время истечения рынка (внутреннее хранилище) */
  private readonly _expirationDate: Date;

  /** Текущий статус рынка */
  public readonly status: MarketStatus;

  /** Индекс разрешённого исхода (0 или 1), null если не разрешён */
  public readonly resolvedOutcomeIndex: OutcomeIndex | null;

  private constructor(props: MarketProps) {
    this.id = props.id;
    this.question = props.question;
    this.marketUrl = props.marketUrl ?? null;
    // Защитное копирование и заморозка исходов для предотвращения внешней мутации
    this.outcomes = Object.freeze([
      Object.freeze({ ...props.outcomes[0] }),
      Object.freeze({ ...props.outcomes[1] }),
    ]) as readonly [OutcomeToken, OutcomeToken];
    // Защитное копирование Date для предотвращения внешней мутации
    this._expirationDate = new Date(props.expirationDate.getTime());
    this.status = props.status;
    this.resolvedOutcomeIndex = props.resolvedOutcomeIndex ?? null;
  }

  /**
   * Фабричный метод для создания экземпляра Market
   *
   * @param props - Свойства рынка
   * @returns Новый экземпляр Market
   * @throws {MarketNotFoundError} Если обязательные свойства отсутствуют или невалидны
   *
   * @example
   * ```typescript
   * const market = Market.create({
   *   id: '0x1234567890abcdef',
   *   question: 'Bitcoin Up or Down?',
   *   outcomes: [
   *     { tokenId: '0xabc...', name: 'Up' },
   *     { tokenId: '0xdef...', name: 'Down' }
   *   ],
   *   expirationDate: new Date('2024-12-31'),
   *   status: 'ACTIVE'
   * });
   * ```
   */
  public static create(props: MarketProps): Market {
    // Валидация обязательных полей
    if (!props.id || props.id.trim() === '') {
      throw new MarketNotFoundError('invalid-id');
    }

    if (!props.question || props.question.trim() === '') {
      throw new MarketNotFoundError(props.id);
    }

    // Валидация исходов
    if (!props.outcomes || props.outcomes.length !== 2) {
      throw new MarketNotFoundError(props.id);
    }

    if (!props.outcomes[0]?.tokenId || props.outcomes[0].tokenId.trim() === '') {
      throw new MarketNotFoundError(props.id);
    }

    if (!props.outcomes[1]?.tokenId || props.outcomes[1].tokenId.trim() === '') {
      throw new MarketNotFoundError(props.id);
    }

    if (!props.outcomes[0]?.name || props.outcomes[0].name.trim() === '') {
      throw new MarketNotFoundError(props.id);
    }

    if (!props.outcomes[1]?.name || props.outcomes[1].name.trim() === '') {
      throw new MarketNotFoundError(props.id);
    }

    if (!props.expirationDate || !(props.expirationDate instanceof Date) || isNaN(props.expirationDate.getTime())) {
      throw new MarketNotFoundError(props.id);
    }

    // Валидация статуса
    const validStatuses: MarketStatus[] = ['ACTIVE', 'CLOSED', 'RESOLVED'];
    if (!validStatuses.includes(props.status)) {
      throw new MarketNotFoundError(props.id);
    }

    // Для не-RESOLVED рынков resolvedOutcomeIndex должен быть null/undefined
    if (props.status !== 'RESOLVED' && props.resolvedOutcomeIndex != null) {
      throw new MarketNotFoundError(props.id);
    }

    // Если разрешён, должен иметь валидный индекс исхода (0 или 1)
    if (props.status === 'RESOLVED') {
      if (props.resolvedOutcomeIndex === undefined || props.resolvedOutcomeIndex === null) {
        throw new MarketNotFoundError(props.id);
      }
      if (typeof props.resolvedOutcomeIndex !== 'number' ||
          (props.resolvedOutcomeIndex !== 0 && props.resolvedOutcomeIndex !== 1)) {
        throw new MarketNotFoundError(props.id);
      }
    }

    return new Market(props);
  }

  /**
   * Получает исход по индексу
   *
   * @param index - Индекс исхода (0 или 1)
   * @returns OutcomeToken для указанного индекса
   *
   * @example
   * ```typescript
   * const firstOutcome = market.getOutcome(0);
   * console.log(firstOutcome.name); // "Up"
   * console.log(firstOutcome.tokenId); // "0xabc..."
   * ```
   */
  public getOutcome(index: OutcomeIndex): OutcomeToken {
    return this.outcomes[index];
  }

  /**
   * Получает индекс исхода по ID токена
   *
   * @param tokenId - ID токена для поиска
   * @returns Индекс исхода (0 или 1), или null если не найден
   *
   * @example
   * ```typescript
   * const index = market.getOutcomeIndexByTokenId('0xabc...');
   * if (index !== null) {
   *   console.log(market.outcomes[index].name); // "Up"
   * }
   * ```
   */
  public getOutcomeIndexByTokenId(tokenId: string): OutcomeIndex | null {
    if (this.outcomes[0].tokenId === tokenId) return 0;
    if (this.outcomes[1].tokenId === tokenId) return 1;
    return null;
  }

  /**
   * Получает исход по ID токена
   *
   * @param tokenId - ID токена для поиска
   * @returns OutcomeToken или null если не найден
   *
   * @example
   * ```typescript
   * const outcome = market.getOutcomeByTokenId('0xabc...');
   * if (outcome) {
   *   console.log(outcome.name); // "Up"
   * }
   * ```
   */
  public getOutcomeByTokenId(tokenId: string): OutcomeToken | null {
    const index = this.getOutcomeIndexByTokenId(tokenId);
    return index !== null ? this.outcomes[index] : null;
  }

  /**
   * Дата/время истечения рынка
   *
   * @returns Защитная копия даты истечения (внешние мутации не затронут Market)
   */
  public get expirationDate(): Date {
    return new Date(this._expirationDate.getTime());
  }

  /**
   * Проверяет, истёк ли срок рынка
   *
   * @returns True если текущее время >= дата истечения (inclusive boundary)
   *
   * @remarks
   * Граница истечения ВКЛЮЧИТЕЛЬНАЯ: в момент expirationDate рынок
   * считается истёкшим и торговля запрещена. Это стандартная семантика
   * для рынков предсказаний.
   *
   * Связь с timeToExpiry(): isExpired() === (timeToExpiry() <= 0)
   *
   * @example
   * ```typescript
   * if (market.isExpired()) {
   *   console.log('Market has expired - trading disabled');
   * }
   * ```
   */
  public isExpired(): boolean {
    // >= для inclusive boundary: в момент истечения рынок уже недоступен
    return Date.now() >= this._expirationDate.getTime();
  }

  /**
   * Вычисляет оставшееся время до истечения
   *
   * @returns Миллисекунды до истечения (0 или отрицательное если истёк)
   *
   * @remarks
   * - Положительное значение: рынок активен, столько мс до истечения
   * - Ноль: рынок только что истёк (inclusive boundary)
   * - Отрицательное: рынок истёк, столько мс назад
   *
   * Связь с isExpired(): isExpired() === (timeToExpiry() <= 0)
   *
   * @example
   * ```typescript
   * const msRemaining = market.timeToExpiry();
   * if (msRemaining > 0) {
   *   const hoursRemaining = msRemaining / (1000 * 60 * 60);
   *   console.log(`Hours remaining: ${hoursRemaining.toFixed(2)}`);
   * } else {
   *   console.log('Market expired');
   * }
   * ```
   */
  public timeToExpiry(): number {
    return this._expirationDate.getTime() - Date.now();
  }

  /**
   * Проверяет, разрешён ли рынок
   *
   * @returns True если статус рынка RESOLVED
   *
   * @example
   * ```typescript
   * if (market.isResolved()) {
   *   const winningOutcome = market.getResolvedOutcome();
   *   console.log(`Winner: ${winningOutcome?.name}`);
   * }
   * ```
   */
  public isResolved(): boolean {
    return this.status === 'RESOLVED';
  }

  /**
   * Получает разрешённый исход (если рынок разрешён)
   *
   * @returns OutcomeToken выигравшего исхода, или null если не разрешён
   *
   * @example
   * ```typescript
   * const winner = market.getResolvedOutcome();
   * if (winner) {
   *   console.log(`Winning outcome: ${winner.name}`);
   * }
   * ```
   */
  public getResolvedOutcome(): OutcomeToken | null {
    if (this.resolvedOutcomeIndex === null) return null;
    return this.outcomes[this.resolvedOutcomeIndex];
  }

  /**
   * Проверяет, активен ли рынок
   *
   * @returns True если статус рынка ACTIVE
   *
   * @example
   * ```typescript
   * if (market.isActive() && !market.isExpired()) {
   *   console.log('Market is open for trading');
   * }
   * ```
   */
  public isActive(): boolean {
    return this.status === 'ACTIVE';
  }

  /**
   * Проверяет, может ли рынок принимать новые сделки
   *
   * @returns True если рынок активен и не истёк
   *
   * @example
   * ```typescript
   * if (market.canTrade()) {
   *   // Place order
   * }
   * ```
   */
  public canTrade(): boolean {
    return this.isActive() && !this.isExpired();
  }

  /**
   * Конвертирует рынок в строковое представление
   *
   * @returns Строковое представление рынка
   *
   * @example
   * ```typescript
   * console.log(market.toString());
   * // Output: "Market[0x123...]: Bitcoin Up or Down? [Up/Down] (ACTIVE)"
   * ```
   */
  public toString(): string {
    const outcomeNames = `[${this.outcomes[0].name}/${this.outcomes[1].name}]`;
    return `Market[${this.id}]: ${this.question} ${outcomeNames} (${this.status})`;
  }
}
