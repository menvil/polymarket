/**
 * Data Recorder - реализация IDataRecorder для записи market data в файлы
 *
 * @remarks
 * Записывает raw WebSocket события в файлы для последующего анализа.
 *
 * Ключевые особенности:
 * - Буферизация: 100 событий ИЛИ 10 секунд
 * - Один файл на маркет в папке даты старта
 * - Санитизация имён файлов для безопасности
 * - Сжатие gzip при финализации (опционально)
 * - Cleanup incomplete данных при старте
 *
 * Формат файла: {question}___{slug}.{ext}[.gz]
 *
 * @example
 * ```typescript
 * const recorder = new DataRecorder(config, formatter, compressor, logger);
 *
 * await recorder.cleanup();  // Удалить incomplete
 *
 * recorder.registerMarket('btc-up', 'Bitcoin Up', rawData, ['0xyes', '0xno']);
 * recorder.recordRawEvent('0xyes', { event_type: 'book', ... });
 *
 * await recorder.finalizeMarket('btc-up', true);  // Маркет истёк
 * await recorder.close();
 * ```
 *
 * @module infrastructure/persistence/data-collection
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ILogger } from '../../../domain/ports/ILogger.js';
import type {
  IDataRecorder,
  RawWsEvent,
  RecordedMarketInfo,
  RecorderStats,
} from '../../../domain/ports/IDataRecorder.js';
import type { GammaMarketData } from '../../../domain/services/market-discovery/types.js';
import type { IFormatter } from './formatters/IFormatter.js';
import type { GzipCompressor, CompressionType } from './compression/GzipCompressor.js';

/**
 * Конфигурация DataRecorder
 */
export interface DataRecorderConfig {
  /** Включена ли запись */
  enabled: boolean;
  /** Директория для snapshots */
  outputDir: string;
  /** Размер буфера (количество событий) */
  bufferSize: number;
  /** Интервал flush (мс) */
  flushIntervalMs: number;
  /** Тип сжатия */
  compression: CompressionType;
}

/**
 * Информация о writer для маркета
 */
interface MarketWriter {
  /** Slug маркета */
  slug: string;
  /** Question маркета */
  question: string;
  /** Путь к файлу */
  filePath: string;
  /** Дата старта записи */
  startDate: string;
  /** Дата окончания маркета */
  endDate: Date;
  /** Token IDs */
  tokenIds: string[];
  /** Буфер событий */
  buffer: string[];
  /** Время последнего flush */
  lastFlushTime: number;
  /** Всего записано событий */
  eventsRecorded: number;
  /** File stream (для streaming форматов) */
  stream: fs.WriteStream | null;
}

/**
 * Data Recorder Implementation
 *
 * @remarks
 * Реализует IDataRecorder порт для записи market data в файлы.
 */
export class DataRecorder implements IDataRecorder {
  private readonly config: DataRecorderConfig;
  private readonly formatter: IFormatter;
  private readonly compressor: GzipCompressor | null;
  private readonly logger: ILogger;

  /** Маппинг slug → writer */
  private readonly writers: Map<string, MarketWriter> = new Map();

  /** Маппинг tokenId → slug */
  private readonly tokenToSlug: Map<string, string> = new Map();

  /** Общее количество записанных событий */
  private totalEventsRecorded = 0;

  /** Таймер периодического flush */
  private flushTimer: NodeJS.Timeout | null = null;

  /**
   * Создаёт новый DataRecorder
   *
   * @param config - Конфигурация
   * @param formatter - Форматтер для сериализации
   * @param compressor - Компрессор (или null если сжатие выключено)
   * @param logger - Логгер
   */
  constructor(
    config: DataRecorderConfig,
    formatter: IFormatter,
    compressor: GzipCompressor | null,
    logger: ILogger
  ) {
    this.config = config;
    this.formatter = formatter;
    this.compressor = compressor;
    this.logger = logger;

    if (config.enabled) {
      this.startFlushTimer();
      this.logger.info('DataRecorder initialized', {
        outputDir: config.outputDir,
        format: formatter.format,
        compression: config.compression,
        bufferSize: config.bufferSize,
        flushIntervalMs: config.flushIntervalMs,
      });
    }
  }

  /**
   * Проверить, включена ли запись
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Очистка incomplete данных при старте
   */
  async cleanup(): Promise<void> {
    if (!this.config.enabled) return;

    const incompleteDir = path.join(this.config.outputDir, '.incomplete');

    if (fs.existsSync(incompleteDir)) {
      this.logger.info('Cleaning up incomplete data', { dir: incompleteDir });

      const files = await fs.promises.readdir(incompleteDir);
      for (const file of files) {
        const filePath = path.join(incompleteDir, file);
        await fs.promises.unlink(filePath);
        this.logger.debug('Deleted incomplete file', { file });
      }

      // Удаляем пустую папку
      await fs.promises.rmdir(incompleteDir);
      this.logger.info('Incomplete data cleaned up', { filesDeleted: files.length });
    }
  }

  /**
   * Регистрирует маркет для записи
   */
  registerMarket(
    slug: string,
    question: string,
    rawMarket: GammaMarketData,
    tokenIds: string[]
  ): void {
    if (!this.config.enabled) return;

    // Проверяем, существует ли уже writer
    if (this.writers.has(slug)) {
      // Файл уже существует - удаляем и начинаем заново (без дырок)
      const existingWriter = this.writers.get(slug)!;
      this.logger.warn('Market already registered, restarting', { slug });

      // Закрываем stream
      if (existingWriter.stream) {
        existingWriter.stream.end();
      }

      // Удаляем файл
      if (fs.existsSync(existingWriter.filePath)) {
        fs.unlinkSync(existingWriter.filePath);
      }

      // Очищаем mapping
      for (const tokenId of existingWriter.tokenIds) {
        this.tokenToSlug.delete(tokenId);
      }
      this.writers.delete(slug);
    }

    // Создаём папку для текущей даты
    const startDate = this.getCurrentDateDir();
    const dateDir = path.join(this.config.outputDir, startDate);
    fs.mkdirSync(dateDir, { recursive: true });

    // Санитизируем имя файла: {question}___{slug}.{ext}
    const safeQuestion = this.sanitizeFilename(question);
    const safeSlug = this.sanitizeFilename(slug);
    const filename = `${safeQuestion}___${safeSlug}.${this.formatter.extension}`;
    const filePath = path.join(dateDir, filename);

    // Проверяем, не существует ли файл (от предыдущего запуска)
    if (fs.existsSync(filePath)) {
      this.logger.warn('File already exists, removing', { filePath });
      fs.unlinkSync(filePath);
    }

    // Создаём stream
    const stream = fs.createWriteStream(filePath, { flags: 'a' });

    // Записываем meta событие первым
    const metaRecord = {
      t: 'meta',
      ts: Date.now(),
      m: rawMarket,
    };
    const metaLine = this.formatter.formatRecord(metaRecord);

    // Cork stream to buffer the meta event, then uncork to flush it immediately
    // This ensures meta event is written to disk before we continue
    stream.cork();
    stream.write(metaLine);
    stream.uncork();

    // Создаём writer
    const writer: MarketWriter = {
      slug,
      question,
      filePath,
      startDate,
      endDate: new Date(rawMarket.endDate),
      tokenIds,
      buffer: [],
      lastFlushTime: Date.now(),
      eventsRecorded: 1, // meta event
      stream,
    };

    this.writers.set(slug, writer);

    // Маппинг tokenId → slug
    for (const tokenId of tokenIds) {
      this.tokenToSlug.set(tokenId, slug);
    }

    this.logger.info('Market registered for recording', {
      slug,
      question: question.substring(0, 50),
      filePath,
      tokenIds: tokenIds.map((t) => t.substring(0, 16) + '...'),
      fullTokenIds: tokenIds, // Log full tokenIds for debugging
    });
  }

  /**
   * Записывает raw WebSocket событие
   */
  recordRawEvent(tokenId: string, rawEvent: RawWsEvent): void {
    if (!this.config.enabled) return;

    const slug = this.tokenToSlug.get(tokenId);
    if (!slug) {
      // Неизвестный tokenId - игнорируем
      this.logger.warn('Received event for unknown tokenId', {
        tokenId: tokenId.substring(0, 16) + '...',
        eventType: rawEvent.event_type,
        knownTokenIds: Array.from(this.tokenToSlug.keys()).map(t => t.substring(0, 16) + '...'),
      });
      return;
    }

    const writer = this.writers.get(slug);
    if (!writer) {
      this.logger.warn('No writer found for slug', { slug, tokenId: tokenId.substring(0, 16) + '...' });
      return;
    }

    // Форматируем и добавляем в буфер
    const line = this.formatter.formatRecord(rawEvent);
    writer.buffer.push(typeof line === 'string' ? line : line.toString());

    this.logger.trace('Event buffered', {
      slug,
      eventType: rawEvent.event_type,
      bufferSize: writer.buffer.length,
      totalRecorded: writer.eventsRecorded,
    });

    // Проверяем условия flush
    const now = Date.now();
    const bufferFull = writer.buffer.length >= this.config.bufferSize;
    const timeElapsed = now - writer.lastFlushTime >= this.config.flushIntervalMs;

    if (bufferFull || timeElapsed) {
      this.logger.debug('Flushing buffer', {
        slug,
        reason: bufferFull ? 'buffer_full' : 'time_elapsed',
        bufferSize: writer.buffer.length,
      });
      this.flushWriter(writer);
    }
  }

  /**
   * Финализирует маркет
   */
  async finalizeMarket(slug: string, expired: boolean): Promise<void> {
    const writer = this.writers.get(slug);
    if (!writer) {
      this.logger.warn('Cannot finalize - market not found', { slug });
      return;
    }

    // Flush оставшиеся данные
    this.flushWriter(writer);

    // Закрываем stream
    if (writer.stream) {
      await new Promise<void>((resolve) => {
        writer.stream!.end(() => resolve());
      });
    }

    if (expired) {
      // Маркет истёк - данные валидны
      this.logger.info('Market finalized (expired)', {
        slug,
        eventsRecorded: writer.eventsRecorded,
        filePath: writer.filePath,
      });

      // Сжимаем если нужно
      if (this.compressor && this.config.compression === 'gzip') {
        try {
          const gzPath = await this.compressor.compressFile(writer.filePath);
          this.logger.info('File compressed', { gzPath });
        } catch (error) {
          this.logger.error('Failed to compress file', { error, filePath: writer.filePath });
        }
      }
    } else {
      // Маркет не истёк - перемещаем в .incomplete
      const incompleteDir = path.join(this.config.outputDir, '.incomplete');
      fs.mkdirSync(incompleteDir, { recursive: true });

      const incompletePath = path.join(incompleteDir, path.basename(writer.filePath));
      await fs.promises.rename(writer.filePath, incompletePath);

      this.logger.warn('Market finalized (incomplete)', {
        slug,
        eventsRecorded: writer.eventsRecorded,
        movedTo: incompletePath,
      });
    }

    // Очищаем mapping
    for (const tokenId of writer.tokenIds) {
      this.tokenToSlug.delete(tokenId);
    }
    this.writers.delete(slug);
  }

  /**
   * Принудительный flush всех буферов
   */
  async flush(): Promise<void> {
    for (const writer of this.writers.values()) {
      this.flushWriter(writer);
    }
  }

  /**
   * Закрыть все файлы
   */
  async close(): Promise<void> {
    // Останавливаем таймер
    this.stopFlushTimer();

    const now = Date.now();

    // Финализируем все маркеты
    for (const [slug, writer] of this.writers) {
      const expired = now >= writer.endDate.getTime();
      await this.finalizeMarket(slug, expired);
    }

    this.logger.info('DataRecorder closed', {
      totalEventsRecorded: this.totalEventsRecorded,
    });
  }

  /**
   * Получить статистику
   */
  getStats(): RecorderStats {
    const markets: RecordedMarketInfo[] = [];
    let bufferedEvents = 0;

    for (const writer of this.writers.values()) {
      bufferedEvents += writer.buffer.length;
      markets.push({
        slug: writer.slug,
        question: writer.question,
        startDate: new Date(writer.startDate),
        filePath: writer.filePath,
        endDate: writer.endDate,
        tokenIds: writer.tokenIds,
      });
    }

    return {
      activeMarkets: this.writers.size,
      totalEventsRecorded: this.totalEventsRecorded,
      bufferedEvents,
      markets,
    };
  }

  /**
   * Flush буфера конкретного writer
   */
  private flushWriter(writer: MarketWriter): void {
    if (writer.buffer.length === 0) return;

    // Записываем буфер в stream
    if (writer.stream) {
      const data = writer.buffer.join('');

      // Cork stream to buffer all data, then uncork to flush
      writer.stream.cork();
      writer.stream.write(data);
      writer.stream.uncork();
    }

    // Обновляем счётчики
    writer.eventsRecorded += writer.buffer.length;
    this.totalEventsRecorded += writer.buffer.length;

    this.logger.trace('Buffer flushed', {
      slug: writer.slug,
      events: writer.buffer.length,
      totalEvents: writer.eventsRecorded,
    });

    // Очищаем буфер
    writer.buffer = [];
    writer.lastFlushTime = Date.now();
  }

  /**
   * Запускает таймер периодического flush
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      for (const writer of this.writers.values()) {
        const now = Date.now();
        if (now - writer.lastFlushTime >= this.config.flushIntervalMs) {
          this.flushWriter(writer);
        }
      }
    }, this.config.flushIntervalMs);
  }

  /**
   * Останавливает таймер
   */
  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Получает текущую дату для директории
   */
  private getCurrentDateDir(): string {
    return new Date().toISOString().split('T')[0]; // "2026-01-02"
  }

  /**
   * Санитизирует строку для использования в имени файла
   *
   * @remarks
   * Заменяет запрещённые символы на underscore.
   * Убирает пробелы и запятые для удобства в командной строке.
   * Ограничивает длину до 100 символов.
   *
   * @example
   * "Bitcoin Up, Down" → "Bitcoin_Up_Down"
   */
  private sanitizeFilename(str: string): string {
    return str
      .replace(/[<>:"/\\|?*]/g, '_') // Запрещённые в Windows/Linux
      .replace(/[\x00-\x1f]/g, '') // Control characters
      .replace(/\.+$/g, '') // Точки в конце
      .replace(/,/g, '') // Убираем запятые
      .replace(/\s+/g, '_') // Пробелы → underscore
      .replace(/_+/g, '_') // Множественные _ → один _
      .trim()
      .substring(0, 100);
  }
}
