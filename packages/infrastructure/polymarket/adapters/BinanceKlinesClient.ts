/**
 * REST-клиент Binance для получения исторических свечей (klines).
 *
 * @remarks
 * Используется для получения:
 * - **Strike price** (open свечи на eventStartTime) — цена открытия окна
 * - **Resolution price** (close свечи на endDate) — финальная цена для settlement
 *
 * ### API endpoint:
 * `GET https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime={ms}&limit=1`
 *
 * Бесплатный, без авторизации, rate limit 1200 req/min.
 *
 * @example
 * ```typescript
 * const client = new BinanceKlinesClient(logger);
 * const kline = await client.getKline('BTCUSDT', 1773266400000, '1h');
 * console.log(`Open: ${kline.open}, Close: ${kline.close}`);
 * ```
 */

import type { ILogger } from '@polymarket/logger';

/**
 * Данные одной свечи Binance.
 *
 * @param openTimeMs - Время открытия свечи (epoch ms)
 * @param open - Цена открытия
 * @param high - Максимальная цена
 * @param low - Минимальная цена
 * @param close - Цена закрытия
 * @param closeTimeMs - Время закрытия свечи (epoch ms)
 */
export interface KlineData {
  readonly openTimeMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly closeTimeMs: number;
}

/**
 * REST-клиент для Binance klines API.
 *
 * @remarks
 * Минимальный клиент: один метод getKline() для получения одной свечи.
 * Без авторизации, без retry — простой fetch().
 */
export class BinanceKlinesClient {
  private readonly _logger: ILogger;
  private readonly _baseUrl: string;

  /**
   * Создаёт BinanceKlinesClient.
   *
   * @param logger - Логгер
   * @param baseUrl - Базовый URL Binance API (по умолчанию https://api.binance.com)
   */
  constructor(logger: ILogger, baseUrl = 'https://api.binance.com') {
    this._logger = logger.child({ component: 'BinanceKlinesClient' });
    this._baseUrl = baseUrl;
  }

  /**
   * Получает одну свечу для указанного символа и времени начала.
   *
   * @param symbol - Символ Binance (e.g. 'BTCUSDT')
   * @param startTimeMs - Время начала свечи (epoch ms)
   * @param interval - Интервал свечи (e.g. '1m', '5m', '15m', '1h')
   * @returns Данные свечи
   * @throws {Error} При сетевой ошибке или отсутствии данных
   *
   * @example
   * ```typescript
   * const kline = await client.getKline('BTCUSDT', 1773266400000, '1h');
   * // kline.open = 70741.27
   * // kline.close = 70373.01
   * ```
   */
  async getKline(symbol: string, startTimeMs: number, interval: string): Promise<KlineData> {
    const url = `${this._baseUrl}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&startTime=${startTimeMs}&limit=1`;

    this._logger.debug('Fetching Binance kline', { symbol, startTimeMs, interval });

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Binance klines API error: ${response.status} ${text}`);
    }

    const data = await response.json() as unknown[][];
    if (!data || data.length === 0) {
      throw new Error(`Binance klines: no data for ${symbol} at ${startTimeMs} (${interval})`);
    }

    const kline = data[0]!;
    // Binance kline array format:
    // [0] Open time, [1] Open, [2] High, [3] Low, [4] Close, [5] Volume,
    // [6] Close time, [7] Quote asset volume, ...
    const result: KlineData = {
      openTimeMs: kline[0] as number,
      open: Number(kline[1]),
      high: Number(kline[2]),
      low: Number(kline[3]),
      close: Number(kline[4]),
      closeTimeMs: kline[6] as number,
    };

    this._logger.info('Binance kline fetched', {
      symbol,
      interval,
      open: result.open,
      close: result.close,
      openTime: new Date(result.openTimeMs).toISOString(),
    });

    return result;
  }
}
