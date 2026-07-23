/**
 * Иммутабельная валидированная риск-политика.
 *
 * @remarks
 * ### Зачем нужна:
 * `RiskParams` — «сырой» вход (может прийти из конфига/env). Прежде чем передать
 * его в `OrderRiskChecker`, параметры ОБЯЗАНЫ быть провалидированы: невалидный
 * лимит (NaN, Infinity, отрицательное число, дробный integer-счётчик) молча
 * отключил бы или исказил бы защиту. `RiskPolicy.create` возвращает `Result` —
 * невалидная конфигурация приводит к явному отказу на этапе создания (обычно —
 * fail-fast на старте приложения), а не к тихому багу в runtime.
 *
 * ### Иммутабельность:
 * После `create()` параметры заморожены (`Object.freeze`) и не могут меняться.
 * Runtime-обновление (`updateParams`) намеренно убрано из checker — политика
 * фиксируется на всё время жизни. Если политику нужно поменять — создаётся новый
 * `OrderRiskChecker` с новой `RiskPolicy` (atomic swap на уровне композиции).
 *
 * ### Правила валидации:
 * - вход обязан быть **plain object** (`Object.prototype` или `null` prototype):
 *   `Date`, массив, примитив, экземпляр класса → отказ;
 * - учитываются только **own**-свойства (унаследованные/prototype-pollution
 *   поля игнорируются, а не подставляются);
 * - `maxOpenOrders` — целое число >= 0 (счётчик ордеров);
 * - `minTimeToExpiryMs` — целое число >= 0 (миллисекунды);
 * - Decimal-лимиты (`maxPositionSize`, `maxTotalExposure`, `maxOrderNotional`,
 *   `minAvailableBalance`) — finite (не NaN, не Infinity) и >= 0.
 * - `undefined` допустим только для ИЗВЕСТНОГО поля (лимит не задан); неизвестный
 *   ключ отклоняется независимо от значения, включая `undefined`.
 *
 * ### Номинальность (compile-time):
 * `RiskPolicy` помечена приватным brand-полем — структурно совместимый plain
 * object нельзя присвоить типу `RiskPolicy` (защита от подделки на уровне
 * TypeScript-компилятора; это НЕ runtime-гарантия против произвольного JS).
 *
 * @example
 * ```typescript
 * const result = RiskPolicy.create({ maxOpenOrders: 10, maxOrderNotional: new Decimal(5000) });
 * if (!result.ok) {
 *   throw new Error(`Invalid risk config: ${result.error.message}`);
 * }
 * const checker = new OrderRiskChecker(result.value, logger);
 * ```
 */
import Decimal from 'decimal.js';
import { Ok, Err } from '@polymarket/result';
import type { Result } from '@polymarket/result';
import type { RiskParams } from './RiskParams.js';

/**
 * Ошибка невалидной риск-конфигурации.
 *
 * @remarks
 * Возвращается из `RiskPolicy.create` через `Result`. `field` указывает на
 * конкретный невалидный параметр (для точной диагностики в логах/на старте).
 */
export class RiskConfigError extends Error {
  /** Имя невалидного поля `RiskParams`. */
  public readonly field: string;

  /**
   * @param field - Имя невалидного поля
   * @param message - Человекочитаемое описание (English)
   */
  constructor(field: string, message: string) {
    super(message);
    this.name = 'RiskConfigError';
    this.field = field;
  }
}

/**
 * Валидированная иммутабельная риск-политика.
 *
 * @remarks
 * Единственный способ получить экземпляр — статический `create()`, который
 * возвращает `Result`. Конструктор приватный: снаружи невозможно создать
 * невалидную/непроверенную политику.
 */
/** Разрешённые integer-поля (счётчики). */
const INTEGER_FIELDS = ['maxOpenOrders', 'minTimeToExpiryMs'] as const;
/** Разрешённые Decimal-поля (лимиты). */
const DECIMAL_FIELDS = [
  'maxPositionSize',
  'maxTotalExposure',
  'maxOrderNotional',
  'minAvailableBalance',
] as const;
/** Полный набор разрешённых полей `RiskParams` (whitelist). */
const ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>([...INTEGER_FIELDS, ...DECIMAL_FIELDS]);

export class RiskPolicy {
  /**
   * Compile-time brand: делает `RiskPolicy` номинальным типом. `declare` — поле
   * существует только на уровне типов (нет runtime-представления, конструктор
   * его не инициализирует). Структурно совместимый plain object без этого поля
   * нельзя присвоить `RiskPolicy`. Это TypeScript-гарантия, НЕ защита в runtime.
   */
  declare private readonly _riskPolicyBrand: void;

  /**
   * @param params - Уже провалидированные и замороженные параметры
   */
  private constructor(public readonly params: Readonly<RiskParams>) {}

  /**
   * Валидирует сырой конфиг и создаёт иммутабельную `RiskPolicy`.
   *
   * @param params - Сырой конфиг (runtime-граница: тип `unknown` до валидации)
   * @returns `Ok(RiskPolicy)` при валидной конфигурации, иначе
   *   `Err(RiskConfigError)` с именем первого невалидного/неизвестного поля
   *
   * @remarks
   * ### Полноценная runtime-валидация (не только compile-time):
   * `params` может прийти из внешнего источника (env/JSON/`as any`/Proxy),
   * поэтому проверки НЕ доверяют статическому типу:
   * - вход обязан быть **plain object** (prototype === `Object.prototype` или
   *   `null`): `Date`, экземпляр класса, массив, примитив → `Err('<root>')`;
   * - учитываются только **own**-свойства (`hasOwnProperty`): унаследованные и
   *   prototype-pollution поля игнорируются, а не подставляются;
   * - каждое поле читается ОДИН раз (устойчиво к getter'ам с side-effects);
   * - неизвестный own-ключ → `Err` независимо от значения (включая `undefined`);
   * - integer-поля — `typeof === 'number'`, finite, целые, `>= 0`;
   * - Decimal-поля — сначала `Decimal.isDecimal(value)` (иначе `value.isNaN()`
   *   бросил бы `TypeError`), затем finite и `>= 0`;
   * - собирается НОВЫЙ объект ТОЛЬКО из провалидированных whitelisted own-полей.
   *
   * ### Никогда не бросает:
   * все ошибки — через `Result`. Если runtime-introspection (`Object.keys`,
   * `Object.getPrototypeOf`, getter, Proxy-trap) бросает — возвращается
   * `Err(RiskConfigError('<root>'))`. Сообщения об ошибках НЕ включают полное
   * raw-значение конфига (только тип/имя поля).
   *
   * @example
   * ```typescript
   * RiskPolicy.create({ maxOpenOrders: -1 });          // Err(field='maxOpenOrders')
   * RiskPolicy.create({ maxTotalExposure: 100 });       // Err (не Decimal), НЕ throw
   * RiskPolicy.create({ maxDrawdown: '0.2' } as never); // Err(field='maxDrawdown', unknown)
   * RiskPolicy.create(new Date());                       // Err('<root>')
   * ```
   */
  public static create(params: unknown): Result<RiskPolicy, RiskConfigError> {
    try {
      return RiskPolicy._validateAndBuild(params);
    } catch {
      // Runtime introspection бросил (throwing getter / Proxy trap /
      // getPrototypeOf). Fail-closed. НЕ включаем raw-значение и сообщение
      // исходной ошибки (могут содержать чувствительные данные).
      return Err(new RiskConfigError('<root>', 'Failed to introspect risk config (introspection threw)'));
    }
  }

  /**
   * Внутренняя валидация + сборка (может бросить на introspection — ловится в `create`).
   *
   * @param params - Сырой конфиг
   * @returns `Result<RiskPolicy, RiskConfigError>`
   */
  private static _validateAndBuild(params: unknown): Result<RiskPolicy, RiskConfigError> {
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      return Err(new RiskConfigError('<root>', `RiskParams must be a plain object, got ${describe(params)}`));
    }
    // Только plain object: Object.prototype или null-prototype. Date/экземпляр
    // класса/Object.create(<non-plain>) отклоняем (их поля не доверяем).
    const proto = Object.getPrototypeOf(params);
    if (proto !== Object.prototype && proto !== null) {
      return Err(new RiskConfigError('<root>', 'RiskParams must be a plain object (class instance / non-plain prototype rejected)'));
    }
    const raw = params as Record<string, unknown>;

    // Неизвестные own-ключи отклоняем — независимо от значения (включая undefined).
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_FIELDS.has(key)) {
        return Err(new RiskConfigError(key, `Unknown risk parameter: ${key}`));
      }
    }

    const validated: {
      -readonly [K in keyof RiskParams]: RiskParams[K];
    } = {};

    for (const field of INTEGER_FIELDS) {
      // Только own-свойства: защита от prototype pollution (унаследованный
      // maxOpenOrders на Object.prototype в own-ключах не появится).
      if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
      const value = raw[field]; // читаем ОДИН раз
      if (value === undefined) continue; // лимит не задан
      const error = RiskPolicy._validateNonNegativeInteger(field, value);
      if (error) return Err(error);
      validated[field] = value as number;
    }

    for (const field of DECIMAL_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
      const value = raw[field]; // читаем ОДИН раз
      if (value === undefined) continue; // лимит не задан
      const error = RiskPolicy._validateNonNegativeFiniteDecimal(field, value);
      if (error) return Err(error);
      validated[field] = value as Decimal;
    }

    // Замораживаем НОВЫЙ объект (только whitelisted validated own-поля) — внешние
    // мутации и посторонние ключи в политику не попадают.
    return Ok(new RiskPolicy(Object.freeze(validated)));
  }

  /**
   * Проверяет, что значение (если задано) — number, finite, целое и >= 0.
   *
   * @param field - Имя поля (для ошибки)
   * @param value - Сырое значение (unknown) или undefined
   * @returns `RiskConfigError` при нарушении, иначе `undefined`
   */
  private static _validateNonNegativeInteger(
    field: string,
    value: unknown,
  ): RiskConfigError | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number') {
      return new RiskConfigError(field, `${field} must be a number, got ${describe(value)}`);
    }
    if (!Number.isFinite(value)) {
      return new RiskConfigError(field, `${field} must be a finite number, got ${value}`);
    }
    if (!Number.isInteger(value)) {
      return new RiskConfigError(field, `${field} must be an integer, got ${value}`);
    }
    if (value < 0) {
      return new RiskConfigError(field, `${field} must be >= 0, got ${value}`);
    }
    return undefined;
  }

  /**
   * Проверяет, что значение (если задано) — Decimal, finite и >= 0.
   *
   * @param field - Имя поля (для ошибки)
   * @param value - Сырое значение (unknown) или undefined
   * @returns `RiskConfigError` при нарушении, иначе `undefined`
   *
   * @remarks
   * `Decimal.isDecimal(value)` проверяется ПЕРВЫМ: без этого `value.isNaN()` на
   * не-Decimal (например `number`/`string`) бросил бы `TypeError`.
   */
  private static _validateNonNegativeFiniteDecimal(
    field: string,
    value: unknown,
  ): RiskConfigError | undefined {
    if (value === undefined) return undefined;
    if (!Decimal.isDecimal(value)) {
      return new RiskConfigError(field, `${field} must be a Decimal, got ${describe(value)}`);
    }
    const dec = value as Decimal;
    if (dec.isNaN() || !dec.isFinite()) {
      return new RiskConfigError(field, `${field} must be a finite decimal, got ${dec.toString()}`);
    }
    if (dec.isNegative()) {
      return new RiskConfigError(field, `${field} must be >= 0, got ${dec.toString()}`);
    }
    return undefined;
  }
}

/**
 * Короткое описание ТИПА значения для сообщений об ошибках.
 *
 * @param value - Любое значение
 * @returns Категория/тип значения (без самого значения — не логируем raw config)
 *
 * @remarks
 * Возвращает только тип (`'number'`, `'string'`, `'object'`, …), а не само
 * значение — чтобы диагностические сообщения не раскрывали содержимое конфига.
 * Диапазонные ошибки (`must be >= 0, got -1`) показывают конкретный числовой
 * лимит отдельно (это не чувствительные данные).
 */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
