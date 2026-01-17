/**
 * Типы для Polymarket REST API
 *
 * @remarks
 * Общие типы для реализации Polymarket REST.
 */

/**
 * Учетные данные для Polymarket L2 API
 */
export interface PolymarketL2Credentials {
  /** Ключ API (формат UUID) */
  apiKey: string;

  /** Секрет API (закодирован в base64url - может содержать символы - и _) */
  secret: string;

  /** Пароль API (hex-строка) */
  passphrase: string;
}

/**
 * Тип подписи для ордеров Polymarket
 *
 * @remarks
 * Определяет, какой тип кошелька используется для подписи:
 * - EOA (0): Стандартный Ethereum аккаунт (MetaMask, аппаратный кошелек)
 * - POLY_PROXY (1): Прокси-кошелек Polymarket (при использовании адреса спонсора)
 * - POLY_GNOSIS_SAFE (2): Мультиподпись Gnosis Safe
 */
export enum SignatureType {
  /** Стандартный EOA (Externally Owned Account) */
  EOA = 0,
  /** Прокси-кошелек Polymarket (адрес спонсора) */
  POLY_PROXY = 1,
  /** Мультиподпись Gnosis Safe */
  POLY_GNOSIS_SAFE = 2,
}

/**
 * Конфигурация Polymarket REST Client
 */
export interface PolymarketRestConfig {
  /** Базовый URL для CLOB API */
  baseUrl: string;

  /** Приватный ключ для подписи запросов */
  privateKey: string;

  /** ID сети (137 для Polygon) */
  chainId: number;

  /** Учетные данные L2 API (apiKey, secret, passphrase) */
  l2Credentials?: PolymarketL2Credentials;

  /**
   * Тип подписи для кошелька
   *
   * @remarks
   * Используйте POLY_PROXY (1) при использовании адреса спонсора (прокси-кошелек).
   * Используйте EOA (0) для стандартных кошельков.
   *
   * @default SignatureType.EOA (0)
   */
  signatureType?: SignatureType;

  /**
   * Адрес спонсора (для прокси-кошельков)
   *
   * @remarks
   * При использовании типа подписи POLY_PROXY это адрес мейкера/спонсора.
   * Если не указан, используется адрес кошелька.
   */
  funderAddress?: string;

  /** Таймаут запроса в миллисекундах */
  timeout?: number;

  /** Максимальное количество попыток повтора */
  maxRetries?: number;

  /** Задержка перед повтором в миллисекундах */
  retryDelay?: number;
}

/**
 * Ответ об ошибке API
 */
export interface ApiErrorResponse {
  /** Сообщение об ошибке */
  error: string;

  /** Код ошибки */
  code?: string;

  /** Дополнительные детали */
  details?: unknown;
}
