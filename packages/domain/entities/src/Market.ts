/**
 * Market entity - рынок предсказаний
 *
 * @remarks
 * Представляет immutable рынок предсказаний с бинарными исходами.
 * Каждый рынок имеет уникальный ID, вопрос, два outcome токена,
 * и статус lifecycle (ACTIVE, CLOSED, RESOLVED).
 *
 * Outcomes хранятся как tuple из двух OutcomeToken объектов,
 * где каждый токен имеет ID и человеко-читаемое имя (например, "Up", "Down").
 *
 * Immutability обеспечивает thread-safety и предотвращает случайные мутации состояния.
 * Используйте factory метод `create()` для создания новых рынков.
 *
 * @example
 * ```typescript
 * const result = Market.create({
 *   id: 'market-123',
 *   slug: 'btc-100k-2024',
 *   question: 'Will BTC reach $100k in 2024?',
 *   outcomeNames: ['Up', 'Down'],
 *   expirationDate: new Date('2024-12-31T23:59:59Z'),
 *   status: 'ACTIVE'
 * });
 *
 * if (result.ok) {
 *   const market = result.value;
 *   console.log(market.outcomeTokens[0].name); // "Up"
 *   console.log(market.marketUrl); // "https://polymarket.com/event/btc-100k-2024"
 * }
 * ```
 */
import { MarketValidationError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';
import { OutcomeToken, type OutcomeIndex } from './OutcomeToken.js';

/**
 * Статус рынка
 *
 * @remarks
 * - ACTIVE: Рынок открыт и принимает сделки
 * - CLOSED: Рынок закрыт, новые сделки не принимаются
 * - RESOLVED: Исход рынка определен
 */
export type MarketStatus = 'ACTIVE' | 'CLOSED' | 'RESOLVED';

/**
 * Параметры для создания Market
 *
 * @remarks
 * Используется в factory методе create().
 * OutcomeTokens создаются автоматически из outcomeNames и outcomeTokenIds.
 */
export interface MarketProps {
  /** Уникальный идентификатор рынка */
  readonly id: string;
  /** URL-friendly строка для генерации marketUrl */
  readonly slug: string;
  /** Вопрос рынка */
  readonly question: string;
  /** Массив из двух названий исходов ["Up", "Down"] */
  readonly outcomeNames: readonly [string, string];
  /** Массив из двух ID токенов исходов */
  readonly outcomeTokenIds: readonly [string, string];
  /** Дата окончания рынка */
  readonly expirationDate: Date;
  /** Текущий статус рынка */
  readonly status: MarketStatus;
  /** Индекс разрешенного исхода (0 или 1), null если не разрешен */
  readonly resolvedOutcomeIndex?: OutcomeIndex | null;
}

/**
 * Внутренние параметры для создания Market (после валидации)
 *
 * @internal
 */
interface InternalMarketProps {
  readonly id: string;
  readonly slug: string;
  readonly question: string;
  readonly outcomeTokens: readonly [OutcomeToken, OutcomeToken];
  readonly expirationDate: Date;
  readonly status: MarketStatus;
  readonly resolvedOutcomeIndex: OutcomeIndex | null;
}

/**
 * Market entity
 *
 * @remarks
 * Immutable entity представляющая рынок предсказаний.
 * Все свойства readonly для обеспечения неизменяемости.
 * Используйте factory метод `create()` для создания.
 */
export class Market {
  /** Уникальный идентификатор рынка (condition ID) */
  public readonly id: string;

  /** URL-friendly slug для генерации marketUrl */
  public readonly slug: string;

  /** Вопрос или описание рынка */
  public readonly question: string;

  /**
   * Outcome токены рынка как tuple из двух токенов
   *
   * @remarks
   * - outcomeTokens[0]: Первый исход (например, "Up")
   * - outcomeTokens[1]: Второй исход (например, "Down")
   */
  public readonly outcomeTokens: readonly [OutcomeToken, OutcomeToken];

  /** Дата/время окончания рынка */
  public readonly expirationDate: Date;

  /** Текущий статус рынка */
  public readonly status: MarketStatus;

  /** Индекс разрешенного исхода (0 или 1), null если не разрешен */
  public readonly resolvedOutcomeIndex: OutcomeIndex | null;

  /**
   * Приватный конструктор
   *
   * @remarks
   * Используется только внутри класса после валидации в create().
   * Внешний код должен использовать Market.create().
   */
  private constructor(props: InternalMarketProps) {
    this.id = props.id;
    this.slug = props.slug;
    this.question = props.question;
    this.outcomeTokens = props.outcomeTokens;
    this.expirationDate = props.expirationDate;
    this.status = props.status;
    this.resolvedOutcomeIndex = props.resolvedOutcomeIndex;
  }

  /**
   * Getter для URL рынка на Polymarket
   *
   * @returns URL рынка, сгенерированный из slug
   *
   * @remarks
   * Автоматически генерирует URL из slug.
   * Формат: https://polymarket.com/event/{slug}
   *
   * @example
   * ```typescript
   * const market = Market.create({
   *   slug: 'btc-100k-2024',
   *   // ... другие параметры
   * });
   * console.log(market.value.marketUrl);
   * // "https://polymarket.com/event/btc-100k-2024"
   * ```
   */
  public get marketUrl(): string {
    return `https://polymarket.com/event/${this.slug}`;
  }

  /**
   * Factory метод для создания Market с валидацией
   *
   * @param props - Параметры рынка
   * @returns Result<Market, MarketValidationError> - Ok(market) или Err(error)
   *
   * @remarks
   * Валидирует все обязательные поля и бизнес-правила:
   * 1. ID не пустой
   * 2. Slug не пустой (для генерации marketUrl)
   * 3. Question не пустой
   * 4. Ровно 2 outcome names
   * 5. Ровно 2 outcome token IDs
   * 6. Outcome names не пустые
   * 7. Outcome token IDs не пустые
   * 8. ExpirationDate валидная дата
   * 9. Status один из: ACTIVE, CLOSED, RESOLVED
   * 10. Если RESOLVED, то resolvedOutcomeIndex должен быть указан
   *
   * Если все валидации пройдены, создает OutcomeToken entities и возвращает Ok(Market).
   * При ошибке валидации возвращает Err(MarketValidationError).
   *
   * @example
   * ```typescript
   * const result = Market.create({
   *   id: 'market-123',
   *   slug: 'btc-100k-2024',
   *   question: 'Will BTC reach $100k in 2024?',
   *   outcomeNames: ['Up', 'Down'],
   *   outcomeTokenIds: ['token-yes-123', 'token-no-456'],
   *   expirationDate: new Date('2024-12-31T23:59:59Z'),
   *   status: 'ACTIVE'
   * });
   *
   * if (result.ok) {
   *   const market = result.value;
   *   console.log(market.marketUrl);
   *   // "https://polymarket.com/event/btc-100k-2024"
   * } else {
   *   console.error('Validation failed:', result.error.message);
   * }
   * ```
   */
  public static create(props: MarketProps): Result<Market, MarketValidationError> {
    // Валидация ID
    if (!props.id || typeof props.id !== 'string' || props.id.trim() === '') {
      return Err(
        new MarketValidationError(
          'Market ID must be a non-empty string',
          {
            context: { field: 'id', value: props.id }
          }
        )
      );
    }

    // Валидация slug
    if (!props.slug || typeof props.slug !== 'string' || props.slug.trim() === '') {
      return Err(
        new MarketValidationError(
          'Market slug must be a non-empty string',
          {
            context: { field: 'slug', marketId: props.id, value: props.slug }
          }
        )
      );
    }

    // Валидация question
    if (!props.question || typeof props.question !== 'string' || props.question.trim() === '') {
      return Err(
        new MarketValidationError(
          'Market question must be a non-empty string',
          {
            context: { field: 'question', marketId: props.id, value: props.question }
          }
        )
      );
    }

    // Валидация outcomeNames
    if (!props.outcomeNames || !Array.isArray(props.outcomeNames) || props.outcomeNames.length !== 2) {
      return Err(
        new MarketValidationError(
          'Market must have exactly 2 outcome names',
          {
            context: {
              field: 'outcomeNames',
              marketId: props.id,
              count: props.outcomeNames?.length ?? 0
            }
          }
        )
      );
    }

    // Валидация outcomeTokenIds
    if (
      !props.outcomeTokenIds ||
      !Array.isArray(props.outcomeTokenIds) ||
      props.outcomeTokenIds.length !== 2
    ) {
      return Err(
        new MarketValidationError(
          'Market must have exactly 2 outcome token IDs',
          {
            context: {
              field: 'outcomeTokenIds',
              marketId: props.id,
              count: props.outcomeTokenIds?.length ?? 0
            }
          }
        )
      );
    }

    // Валидация outcome names не пустые
    if (!props.outcomeNames[0] || props.outcomeNames[0].trim() === '') {
      return Err(
        new MarketValidationError(
          'Outcome name at index 0 must be a non-empty string',
          {
            context: { field: 'outcomeNames[0]', marketId: props.id }
          }
        )
      );
    }

    if (!props.outcomeNames[1] || props.outcomeNames[1].trim() === '') {
      return Err(
        new MarketValidationError(
          'Outcome name at index 1 must be a non-empty string',
          {
            context: { field: 'outcomeNames[1]', marketId: props.id }
          }
        )
      );
    }

    // Валидация outcome token IDs не пустые
    if (!props.outcomeTokenIds[0] || props.outcomeTokenIds[0].trim() === '') {
      return Err(
        new MarketValidationError(
          'Outcome token ID at index 0 must be a non-empty string',
          {
            context: { field: 'outcomeTokenIds[0]', marketId: props.id }
          }
        )
      );
    }

    if (!props.outcomeTokenIds[1] || props.outcomeTokenIds[1].trim() === '') {
      return Err(
        new MarketValidationError(
          'Outcome token ID at index 1 must be a non-empty string',
          {
            context: { field: 'outcomeTokenIds[1]', marketId: props.id }
          }
        )
      );
    }

    // Валидация expirationDate
    if (
      !props.expirationDate ||
      !(props.expirationDate instanceof Date) ||
      isNaN(props.expirationDate.getTime())
    ) {
      return Err(
        new MarketValidationError(
          'Market expiration date must be a valid Date',
          {
            context: { field: 'expirationDate', marketId: props.id }
          }
        )
      );
    }

    // Валидация status
    const validStatuses: MarketStatus[] = ['ACTIVE', 'CLOSED', 'RESOLVED'];
    if (!validStatuses.includes(props.status)) {
      return Err(
        new MarketValidationError(
          `Invalid market status: ${props.status}`,
          {
            context: {
              field: 'status',
              marketId: props.id,
              value: props.status,
              validValues: validStatuses
            }
          }
        )
      );
    }

    // Если RESOLVED, должен быть указан resolvedOutcomeIndex
    if (props.status === 'RESOLVED' && props.resolvedOutcomeIndex === undefined) {
      return Err(
        new MarketValidationError(
          'Resolved market must have resolvedOutcomeIndex',
          {
            context: { field: 'resolvedOutcomeIndex', marketId: props.id, status: props.status }
          }
        )
      );
    }

    // Создаем OutcomeToken entities (без валидации, так как уже валидировали)
    const outcomeToken0 = OutcomeToken.createTrusted({
      id: props.outcomeTokenIds[0],
      marketId: props.id,
      outcomeIndex: 0,
      name: props.outcomeNames[0]
    });

    const outcomeToken1 = OutcomeToken.createTrusted({
      id: props.outcomeTokenIds[1],
      marketId: props.id,
      outcomeIndex: 1,
      name: props.outcomeNames[1]
    });

    // Создаем Market instance
    return Ok(
      new Market({
        id: props.id,
        slug: props.slug,
        question: props.question,
        outcomeTokens: [outcomeToken0, outcomeToken1] as const,
        expirationDate: props.expirationDate,
        status: props.status,
        resolvedOutcomeIndex: props.resolvedOutcomeIndex ?? null
      })
    );
  }

  /**
   * Получает outcome токен по индексу
   *
   * @param index - Индекс исхода (0 или 1)
   * @returns OutcomeToken для указанного индекса
   *
   * @example
   * ```typescript
   * const firstOutcome = market.getOutcomeToken(0);
   * console.log(firstOutcome.name); // "Up"
   * console.log(firstOutcome.id); // "token-yes-123"
   * ```
   */
  public getOutcomeToken(index: OutcomeIndex): OutcomeToken {
    return this.outcomeTokens[index];
  }

  /**
   * Получает индекс исхода по ID токена
   *
   * @param tokenId - ID токена для поиска
   * @returns Индекс исхода (0 или 1), или null если не найден
   *
   * @example
   * ```typescript
   * const index = market.getOutcomeIndexByTokenId('token-yes-123');
   * if (index !== null) {
   *   console.log(market.outcomeTokens[index].name); // "Up"
   * }
   * ```
   */
  public getOutcomeIndexByTokenId(tokenId: string): OutcomeIndex | null {
    if (this.outcomeTokens[0].id === tokenId) return 0;
    if (this.outcomeTokens[1].id === tokenId) return 1;
    return null;
  }

  /**
   * Получает outcome токен по ID токена
   *
   * @param tokenId - ID токена для поиска
   * @returns OutcomeToken или null если не найден
   *
   * @example
   * ```typescript
   * const outcome = market.getOutcomeTokenById('token-yes-123');
   * if (outcome) {
   *   console.log(outcome.name); // "Up"
   * }
   * ```
   */
  public getOutcomeTokenById(tokenId: string): OutcomeToken | null {
    const index = this.getOutcomeIndexByTokenId(tokenId);
    return index !== null ? this.outcomeTokens[index] : null;
  }

  /**
   * Проверяет, истек ли срок рынка
   *
   * @returns True если текущее время позже даты окончания
   *
   * @example
   * ```typescript
   * if (market.isExpired()) {
   *   console.log('Market has expired');
   * }
   * ```
   */
  public isExpired(): boolean {
    return Date.now() > this.expirationDate.getTime();
  }

  /**
   * Вычисляет оставшееся время до окончания
   *
   * @returns Миллисекунды до окончания (отрицательное если истек)
   *
   * @example
   * ```typescript
   * const msRemaining = market.timeToExpiry();
   * const hoursRemaining = msRemaining / (1000 * 60 * 60);
   * console.log(`Hours remaining: ${hoursRemaining.toFixed(2)}`);
   * ```
   */
  public timeToExpiry(): number {
    return this.expirationDate.getTime() - Date.now();
  }

  /**
   * Проверяет, разрешен ли рынок
   *
   * @returns True если статус рынка RESOLVED
   *
   * @example
   * ```typescript
   * if (market.isResolved()) {
   *   const winningOutcome = market.getResolvedOutcomeToken();
   *   console.log(`Winner: ${winningOutcome?.name}`);
   * }
   * ```
   */
  public isResolved(): boolean {
    return this.status === 'RESOLVED';
  }

  /**
   * Получает разрешенный outcome (если рынок разрешен)
   *
   * @returns OutcomeToken выигравшего исхода, или null если не разрешен
   *
   * @example
   * ```typescript
   * const winner = market.getResolvedOutcomeToken();
   * if (winner) {
   *   console.log(`Winning outcome: ${winner.name}`);
   * }
   * ```
   */
  public getResolvedOutcomeToken(): OutcomeToken | null {
    if (this.resolvedOutcomeIndex === null) return null;
    return this.outcomeTokens[this.resolvedOutcomeIndex];
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
   * @returns True если рынок активен и не истек
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
   * Закрывает рынок (переводит в статус CLOSED)
   *
   * @returns Result<Market, MarketValidationError> - Ok(market) со статусом CLOSED
   *
   * @remarks
   * Lifecycle метод для перехода из ACTIVE → CLOSED.
   * Возвращает новый instance (immutable pattern).
   * Закрытый рынок не принимает новые сделки, но еще не разрешен.
   * resolvedOutcomeIndex сбрасывается в null, так как рынок еще не разрешен.
   *
   * @example
   * ```typescript
   * const activeMarket = Market.create({ status: 'ACTIVE', ... }).value;
   * const result = activeMarket.close();
   * if (result.ok) {
   *   const closedMarket = result.value;
   *   console.log(closedMarket.status); // "CLOSED"
   *   console.log(closedMarket.canTrade()); // false
   *   console.log(closedMarket.resolvedOutcomeIndex); // null
   * }
   * ```
   */
  public close(): Result<Market, MarketValidationError> {
    return Ok(new Market({
      id: this.id,
      slug: this.slug,
      question: this.question,
      outcomeTokens: this.outcomeTokens,
      expirationDate: this.expirationDate,
      status: 'CLOSED',
      resolvedOutcomeIndex: null
    }));
  }

  /**
   * Разрешает рынок с указанным исходом (переводит в статус RESOLVED)
   *
   * @param outcomeIndex - Индекс выигравшего исхода (0 или 1)
   * @returns Result<Market, MarketValidationError> - Ok(market) со статусом RESOLVED или Err(error)
   *
   * @remarks
   * Lifecycle метод для перехода в RESOLVED.
   * Валидирует что outcomeIndex это 0 или 1.
   * Возвращает новый instance (immutable pattern).
   * Разрешенный рынок имеет определенный выигравший исход.
   *
   * @example
   * ```typescript
   * const market = Market.create({ status: 'CLOSED', ... }).value;
   * const result = market.resolve(0); // Outcome 0 wins ("Up")
   *
   * if (result.ok) {
   *   const resolvedMarket = result.value;
   *   console.log(resolvedMarket.status); // "RESOLVED"
   *   console.log(resolvedMarket.getResolvedOutcomeToken()?.name); // "Up"
   * }
   * ```
   */
  public resolve(outcomeIndex: OutcomeIndex): Result<Market, MarketValidationError> {
    // Валидация outcomeIndex
    if (outcomeIndex !== 0 && outcomeIndex !== 1) {
      return Err(
        new MarketValidationError(
          `Invalid outcome index: ${outcomeIndex}. Must be 0 or 1`,
          {
            context: {
              field: 'outcomeIndex',
              marketId: this.id,
              value: outcomeIndex,
              validValues: [0, 1]
            }
          }
        )
      );
    }

    return Ok(
      new Market({
        id: this.id,
        slug: this.slug,
        question: this.question,
        outcomeTokens: this.outcomeTokens,
        expirationDate: this.expirationDate,
        status: 'RESOLVED',
        resolvedOutcomeIndex: outcomeIndex
      })
    );
  }

  /**
   * Сериализует Market в JSON объект
   *
   * @returns JSON представление рынка
   *
   * @remarks
   * Преобразует все поля в JSON-совместимый формат:
   * - Date → ISO string
   * - OutcomeToken[] → объекты с полями
   * - Включает вычисляемое поле marketUrl
   *
   * Используется для:
   * - Сохранения состояния в storage
   * - Передачи через API
   * - Логирования
   *
   * @example
   * ```typescript
   * const json = market.toJSON();
   * console.log(JSON.stringify(json, null, 2));
   * // {
   * //   "id": "market-123",
   * //   "slug": "btc-100k-2024",
   * //   "marketUrl": "https://polymarket.com/event/btc-100k-2024",
   * //   "question": "Will BTC reach $100k?",
   * //   "outcomeTokens": [
   * //     { "id": "token-up", "marketId": "market-123", "outcomeIndex": 0, "name": "Up" },
   * //     { "id": "token-down", "marketId": "market-123", "outcomeIndex": 1, "name": "Down" }
   * //   ],
   * //   "expirationDate": "2024-12-31T23:59:59.000Z",
   * //   "status": "ACTIVE",
   * //   "resolvedOutcomeIndex": null
   * // }
   * ```
   */
  public toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      slug: this.slug,
      marketUrl: this.marketUrl,
      question: this.question,
      outcomeTokens: [
        {
          id: this.outcomeTokens[0].id,
          marketId: this.outcomeTokens[0].marketId,
          outcomeIndex: this.outcomeTokens[0].outcomeIndex,
          name: this.outcomeTokens[0].name
        },
        {
          id: this.outcomeTokens[1].id,
          marketId: this.outcomeTokens[1].marketId,
          outcomeIndex: this.outcomeTokens[1].outcomeIndex,
          name: this.outcomeTokens[1].name
        }
      ],
      expirationDate: this.expirationDate.toISOString(),
      status: this.status,
      resolvedOutcomeIndex: this.resolvedOutcomeIndex
    };
  }

  /**
   * Десериализует Market из JSON объекта
   *
   * @param json - JSON представление рынка
   * @returns Result<Market, MarketValidationError> - Ok(market) или Err(error)
   *
   * @remarks
   * Парсит JSON и создает Market instance через create().
   * Выполняет полную валидацию всех полей.
   *
   * Ожидаемый формат JSON:
   * - id: string
   * - slug: string
   * - question: string
   * - outcomeTokens: [{ id, name }, { id, name }]
   * - expirationDate: ISO date string
   * - status: MarketStatus
   * - resolvedOutcomeIndex?: number | null
   *
   * @example
   * ```typescript
   * const json = {
   *   id: 'market-123',
   *   slug: 'btc-100k-2024',
   *   question: 'Will BTC reach $100k?',
   *   outcomeTokens: [
   *     { id: 'token-up', name: 'Up' },
   *     { id: 'token-down', name: 'Down' }
   *   ],
   *   expirationDate: '2024-12-31T23:59:59.000Z',
   *   status: 'ACTIVE'
   * };
   *
   * const result = Market.fromJSON(json);
   * if (result.ok) {
   *   const market = result.value;
   *   console.log(market.question); // "Will BTC reach $100k?"
   * }
   * ```
   */
  public static fromJSON(json: unknown): Result<Market, MarketValidationError> {
    // Проверка что json это объект
    if (typeof json !== 'object' || json === null) {
      return Err(
        new MarketValidationError(
          'JSON must be an object',
          {
            context: { value: json }
          }
        )
      );
    }

    const obj = json as Record<string, unknown>;

    // Парсинг expirationDate
    let expirationDate: Date;
    try {
      if (typeof obj.expirationDate !== 'string') {
        throw new Error('expirationDate must be a string');
      }
      expirationDate = new Date(obj.expirationDate);
      if (isNaN(expirationDate.getTime())) {
        throw new Error('Invalid date format');
      }
    } catch (error) {
      return Err(
        new MarketValidationError(
          `Invalid expiration date: ${error instanceof Error ? error.message : 'unknown error'}`,
          {
            context: { field: 'expirationDate', value: obj.expirationDate }
          }
        )
      );
    }

    // Парсинг outcomeTokens
    if (!Array.isArray(obj.outcomeTokens) || obj.outcomeTokens.length !== 2) {
      return Err(
        new MarketValidationError(
          'outcomeTokens must be an array of 2 elements',
          {
            context: {
              field: 'outcomeTokens',
              value: obj.outcomeTokens,
              count: Array.isArray(obj.outcomeTokens) ? obj.outcomeTokens.length : 0
            }
          }
        )
      );
    }

    const token0 = obj.outcomeTokens[0] as Record<string, unknown>;
    const token1 = obj.outcomeTokens[1] as Record<string, unknown>;

    // Создаем Market через create() для полной валидации
    return Market.create({
      id: obj.id as string,
      slug: obj.slug as string,
      question: obj.question as string,
      outcomeNames: [token0.name as string, token1.name as string] as const,
      outcomeTokenIds: [token0.id as string, token1.id as string] as const,
      expirationDate,
      status: obj.status as MarketStatus,
      resolvedOutcomeIndex:
        obj.resolvedOutcomeIndex === null || obj.resolvedOutcomeIndex === undefined
          ? undefined
          : (obj.resolvedOutcomeIndex as OutcomeIndex)
    });
  }

  /**
   * Конвертирует рынок в строковое представление
   *
   * @returns Строковое представление рынка
   *
   * @example
   * ```typescript
   * console.log(market.toString());
   * // Output: "Market[market-123]: Will BTC reach $100k? [Up/Down] (ACTIVE)"
   * ```
   */
  public toString(): string {
    const outcomeNames = `[${this.outcomeTokens[0].name}/${this.outcomeTokens[1].name}]`;
    return `Market[${this.id}]: ${this.question} ${outcomeNames} (${this.status})`;
  }
}
