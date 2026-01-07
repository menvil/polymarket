/**
 * Data Recorder Port - интерфейс для записи raw market data
 *
 * @remarks
 * Определяет контракт для записи данных с рынков.
 * Реализация может быть файловой, БД, или mock для тестов.
 *
 * Используется DataCollectorService для записи:
 * - Raw WebSocket events (orderbook, trade)
 * - Метаданные маркетов (GammaMarketData)
 *
 * @example
 * ```typescript
 * const recorder: IDataRecorder = new DataRecorder(config, logger);
 *
 * // При старте - очистка incomplete данных
 * await recorder.cleanup();
 *
 * // Регистрация маркета (пишет meta событие)
 * recorder.registerMarket('btc-up-down', 'Bitcoin Up or Down', rawMarketData);
 *
 * // Запись raw событий
 * recorder.recordRawEvent('0xyes123...', { event_type: 'book', ... });
 *
 * // При истечении маркета
 * await recorder.finalizeMarket('btc-up-down', true);
 *
 * // При shutdown
 * await recorder.close();
 * ```
 *
 * @module domain/ports/IDataRecorder
 */

import type { GammaMarketData } from '../services/market-discovery/types.js';

/**
 * Raw WebSocket event от Polymarket
 *
 * @remarks
 * Сохраняем как есть, без преобразований.
 * Может быть book, trade, или last_trade_price.
 */
export interface RawWsEvent {
  /** Тип события: book | trade | last_trade_price */
  event_type: string;
  /** Token ID (YES или NO) */
  asset_id: string;
  /** Остальные поля зависят от типа события */
  [key: string]: unknown;
}

/**
 * Информация о записываемом маркете
 */
export interface RecordedMarketInfo {
  /** Slug маркета (используется в имени файла) */
  slug: string;
  /** Question маркета */
  question: string;
  /** Дата начала записи */
  startDate: Date;
  /** Путь к файлу */
  filePath: string;
  /** Дата окончания маркета */
  endDate: Date;
  /** Token IDs */
  tokenIds: string[];
}

/**
 * Статистика записи
 */
export interface RecorderStats {
  /** Количество активных маркетов */
  activeMarkets: number;
  /** Всего записано событий */
  totalEventsRecorded: number;
  /** Событий в буфере (ожидают flush) */
  bufferedEvents: number;
  /** Информация по маркетам */
  markets: RecordedMarketInfo[];
}

/**
 * Data Recorder Interface (Port)
 *
 * @remarks
 * Порт для записи raw market data.
 * Следует Dependency Inversion Principle - domain определяет интерфейс,
 * infrastructure предоставляет реализацию.
 */
export interface IDataRecorder {
  /**
   * Очистка incomplete данных при старте
   *
   * @remarks
   * Удаляет все файлы из директории .incomplete/
   * Вызывается при запуске если сбор данных включен.
   */
  cleanup(): Promise<void>;

  /**
   * Регистрирует маркет для записи
   *
   * @param slug - Slug маркета (для имени файла)
   * @param question - Question маркета (для имени файла)
   * @param rawMarket - Raw данные маркета из Gamma API
   * @param tokenIds - Token IDs (YES и NO)
   *
   * @remarks
   * Алгоритм:
   * 1. Если файл уже существует - удалить (перезапись без дырок)
   * 2. Создать папку snapshots/{date}/
   * 3. Создать файл {question}|{slug}.{ext}
   * 4. Записать meta событие с rawMarket
   * 5. Запомнить tokenId → slug mapping
   */
  registerMarket(
    slug: string,
    question: string,
    rawMarket: GammaMarketData,
    tokenIds: string[]
  ): void;

  /**
   * Записывает raw WebSocket событие
   *
   * @param tokenId - Token ID из события (asset_id)
   * @param rawEvent - Raw событие как пришло от WebSocket
   *
   * @remarks
   * Событие добавляется в буфер.
   * Flush происходит когда:
   * - Буфер достиг BUFFER_SIZE (default: 100)
   * - Прошло FLUSH_INTERVAL_MS (default: 10000)
   */
  recordRawEvent(tokenId: string, rawEvent: RawWsEvent): void;

  /**
   * Финализирует маркет (закрывает файл)
   *
   * @param slug - Slug маркета
   * @param expired - Истёк ли маркет (endDate < now)
   *
   * @remarks
   * Если expired=true:
   * - Flush буфер
   * - Сжать файл (если включено)
   * - Закрыть stream
   * - Файл остаётся в snapshots/
   *
   * Если expired=false:
   * - Переместить в .incomplete/
   */
  finalizeMarket(slug: string, expired: boolean): Promise<void>;

  /**
   * Принудительный flush всех буферов
   */
  flush(): Promise<void>;

  /**
   * Закрыть все файлы и освободить ресурсы
   *
   * @remarks
   * Вызывается при shutdown.
   * Для каждого активного маркета:
   * - Если now < endDate → переместить в .incomplete/
   * - Если now >= endDate → flush, compress, keep
   */
  close(): Promise<void>;

  /**
   * Получить статистику записи
   */
  getStats(): RecorderStats;

  /**
   * Проверить, включена ли запись
   */
  isEnabled(): boolean;
}
