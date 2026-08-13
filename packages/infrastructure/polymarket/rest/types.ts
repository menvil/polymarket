/**
 * Типы Polymarket REST API
 *
 * @remarks
 * Общие типы для реализации Polymarket REST.
 */

/**
 * Учётные данные Polymarket L2 API
 */
export interface PolymarketL2Credentials {
  /** API ключ (формат UUID) */
  apiKey: string;

  /** API секрет (base64url — может содержать символы - и _) */
  secret: string;

  /** API пароль (hex-строка) */
  passphrase: string;
}

/**
 * Тип подписи для ордеров Polymarket
 *
 * @remarks
 * Определяет, какой тип кошелька используется для подписи:
 * - EOA (0): Стандартный аккаунт Ethereum (MetaMask, аппаратный кошелёк)
 * - POLY_PROXY (1): Proxy-кошелёк Polymarket (при использовании адреса фандера)
 * - POLY_GNOSIS_SAFE (2): Gnosis Safe мультиподпись
 */
export enum SignatureType {
  /** Стандартный EOA (Externally Owned Account) */
  EOA = 0,
  /** Proxy-кошелёк Polymarket (адрес фандера) */
  POLY_PROXY = 1,
  /** Gnosis Safe мультиподпись */
  POLY_GNOSIS_SAFE = 2,
}

/**
 * Конфигурация Polymarket REST-клиента
 */
export interface PolymarketRestConfig {
  /** Базовый URL для CLOB API */
  baseUrl: string;

  /** Приватный ключ для подписи запросов */
  privateKey: string;

  /** ID сети (137 для Polygon) */
  chainId: number;

  /** L2 API учётные данные (apiKey, secret, passphrase) */
  l2Credentials?: PolymarketL2Credentials;

  /**
   * Тип подписи кошелька
   *
   * @remarks
   * Используйте POLY_PROXY (1) при использовании адреса фандера (proxy-кошелёк).
   * Используйте EOA (0) для стандартных кошельков.
   *
   * @default SignatureType.EOA (0)
   */
  signatureType?: SignatureType;

  /**
   * Адрес фандера (для proxy-кошельков)
   *
   * @remarks
   * При использовании типа подписи POLY_PROXY это адрес maker/funder.
   * Если не указан, используется адрес кошелька.
   */
  funderAddress?: string;

  /**
   * Builder code для атрибуции ордеров (CLOB V2)
   *
   * @remarks
   * Bytes32 hex-строка, выданная Polymarket на странице Builder Profile.
   * Включается в каждый подписанный ордер автоматически.
   *
   * @example '0x2035099b0edacd0717f653f7c81078ef9e2b301f858e45cbb02c46377d001300'
   */
  builderCode?: string;

  /** Таймаут запроса в миллисекундах */
  timeout?: number;

  /** Максимальное количество повторных попыток */
  maxRetries?: number;

  /** Задержка повтора в миллисекундах */
  retryDelay?: number;
}

/**
 * Ответ с ошибкой API
 */
export interface ApiErrorResponse {
  /** Сообщение об ошибке */
  error: string;

  /** Код ошибки */
  code?: string;

  /** Дополнительные детали */
  details?: unknown;
}
