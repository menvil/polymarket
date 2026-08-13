/**
 * DecisionJournalRecorder — запись решений стратегии в NDJSON-файлы.
 *
 * @remarks
 * Реализует `IDecisionJournal` из `@polymarket/ports`.
 * Один файл на рынок, отдельная директория от рыночных данных.
 *
 * ### Структура файлов:
 * ```
 * journalDir/
 *   2026-04-01/
 *     Bitcoin_Up___0xabc.journal.jsonl
 *   2026-04-02/
 *     ...
 * ```
 *
 * ### Типы записей:
 * - `session_start` — метаданные сессии (конфиг стратегии, рынок)
 * - `decision` — решение стратегии (BUY/HOLD/SKIP с полным состоянием)
 * - `fill` — исполнение ордера
 * - `resolution` — разрешение рынка (PnL)
 * - `session_end` — завершение сессии
 *
 * ### Буферизация:
 * - Записи накапливаются в памяти
 * - Сброс при `buffer.length >= 50` или каждые 5 секунд
 * - `record*` методы синхронные, fire-and-forget
 *
 * @example
 * ```typescript
 * const journal = new DecisionJournalRecorder({ journalDir: './data/journals' }, logger);
 * journal.startSession({ marketId, mode: 'paper', ... });
 * journal.recordDecision({ marketId, action: 'BUY', state: {...}, ... });
 * await journal.endSession(marketId, 'EXPIRED');
 * await journal.close();
 * ```
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ILogger } from '@polymarket/logger';
import type { MarketId } from '@polymarket/ids';
import type {
  IDecisionJournal,
  SessionMeta,
  DecisionEntry,
  OrderEntry,
  FillEntry,
  ResolutionEntry,
  SignalEntry,
  CancelEntry,
} from '@polymarket/ports';

// ── Конфигурация ─────────────────────────────────────────────────────────────

/**
 * Конфигурация журнала решений.
 *
 * @param journalDir - Директория для файлов журнала
 */
export interface DecisionJournalConfig {
  readonly journalDir: string;
}

// ── Внутренние типы ──────────────────────────────────────────────────────────

interface JournalWriter {
  readonly marketId: string;
  readonly filePath: string;
  buffer: string[];
  stream: fs.WriteStream | null;
  eventsRecorded: number;
}

// ── Реализация ───────────────────────────────────────────────────────────────

/** Размер буфера перед автоматическим flush. */
const BUFFER_SIZE = 50;
/** Интервал периодического flush (мс). */
const FLUSH_INTERVAL_MS = 5_000;

export class DecisionJournalRecorder implements IDecisionJournal {
  private readonly _logger: ILogger;
  private readonly _writers = new Map<string, JournalWriter>();
  /** Обратный индекс: instrumentId → marketId (для стратегий которые знают только instrumentId) */
  private readonly _instrumentIndex = new Map<string, string>();
  private _flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly _config: DecisionJournalConfig,
    logger: ILogger,
  ) {
    this._logger = logger.child({ component: 'DecisionJournal' });
    this._flushTimer = setInterval(() => { this._flushAll(); }, FLUSH_INTERVAL_MS);
    this._flushTimer.unref();
  }

  // ── startSession ─────────────────────────────────────────────────────────

  /**
   * Начинает сессию: создаёт файл, записывает SESSION_START.
   *
   * @param meta - Метаданные сессии
   */
  public startSession(meta: SessionMeta): void {
    const key = meta.marketId;
    if (this._writers.has(key)) return;

    const filePath = this._buildFilePath(meta.marketId, meta.marketQuestion);

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      const record = {
        t: 'session_start' as const,
        ts: Date.now(),
        ...meta,
      };
      fs.writeFileSync(filePath, JSON.stringify(record) + '\n', { flag: 'a' });

      const stream = fs.createWriteStream(filePath, { flags: 'a' });
      stream.on('error', (err) => {
        this._logger.error('Journal write stream error', { marketId: key, err });
      });

      this._writers.set(key, {
        marketId: key,
        filePath,
        buffer: [],
        stream,
        eventsRecorded: 0,
      });

      // Обратный индекс: instrumentId и все tokenIds → marketId
      if (meta.instrumentId) this._instrumentIndex.set(meta.instrumentId, key);
      for (const tokenId of meta.tokenIds) {
        this._instrumentIndex.set(tokenId, key);
      }

      this._logger.debug('Journal session started', { marketId: key, filePath });
    } catch (err) {
      this._logger.error('Failed to start journal session', { marketId: key, err });
    }
  }

  // ── record* (fire-and-forget) ──────────────────────────────────────────

  /**
   * Записывает решение стратегии (синхронно, fire-and-forget).
   *
   * @param entry - Данные решения
   */
  public recordDecision(entry: DecisionEntry): void {
    this._appendRecord(entry.marketId, { t: 'decision', ...entry });
  }

  /**
   * Записывает размещение ордера (синхронно, fire-and-forget).
   *
   * @param entry - Данные ордера
   */
  public recordOrder(entry: OrderEntry): void {
    this._appendRecord(entry.marketId, { t: 'order', ...entry });
  }

  /**
   * Записывает событие жизненного цикла сигнала (синхронно, fire-and-forget).
   *
   * @param entry - Данные события сигнала
   */
  public recordSignalEvent(entry: SignalEntry): void {
    this._appendRecord(entry.marketId, { t: 'signal_event', ...entry });
  }

  /**
   * Записывает снятие ордера с контекстом drift (синхронно, fire-and-forget).
   *
   * @param entry - Данные снятия ордера
   */
  public recordCancel(entry: CancelEntry): void {
    this._appendRecord(entry.marketId, { t: 'cancel', ...entry });
  }

  /**
   * Записывает fill (синхронно, fire-and-forget).
   *
   * @param entry - Данные fill
   */
  public recordFill(entry: FillEntry): void {
    this._appendRecord(entry.marketId, { t: 'fill', ...entry });
  }

  /**
   * Записывает разрешение рынка (синхронно, fire-and-forget).
   *
   * @param entry - Данные разрешения
   */
  public recordResolution(entry: ResolutionEntry): void {
    this._appendRecord(entry.marketId, { t: 'resolution', ...entry });
  }

  // ── endSession ───────────────────────────────────────────────────────────

  /**
   * Завершает сессию: записывает SESSION_END, сбрасывает буфер, закрывает файл.
   *
   * @param marketId - ID рынка
   * @param reason - Причина завершения
   */
  public async endSession(marketId: MarketId, reason: string): Promise<void> {
    const key = String(marketId);
    const writer = this._writers.get(key);
    if (!writer) return;

    this._appendRecord(key, { t: 'session_end', ts: Date.now(), marketId: key, reason });
    this._flushWriter(writer);
    this._writers.delete(key);

    if (writer.stream) {
      await new Promise<void>((resolve, reject) => {
        writer.stream!.end(() => resolve());
        writer.stream!.on('error', reject);
      });
    }

    this._logger.debug('Journal session ended', {
      marketId: key,
      events: writer.eventsRecorded,
      reason,
    });
  }

  // ── close ────────────────────────────────────────────────────────────────

  /**
   * Завершает работу: закрывает все сессии.
   */
  public async close(): Promise<void> {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }

    const keys = Array.from(this._writers.keys());
    for (const key of keys) {
      // `_writers` хранит ключи как string (см. _appendRecord: lookup идёт и по marketId,
      // и по instrumentId/tokenId через _instrumentIndex) — небезопасный каст здесь корректен,
      // т.к. каждый ключ либо пришёл из уже валидного SessionMeta.marketId: MarketId
      // (startSession), либо является instrumentId-строкой, зарегистрированной под тем же
      // писателем. Не входит в мандат Этапа 10c (см. план миграции, находка A.4).
      await this.endSession(key as MarketId, 'SHUTDOWN');
    }
  }

  // ── Приватные методы ─────────────────────────────────────────────────────

  private _appendRecord(marketId: string, record: Record<string, unknown>): void {
    // Поиск: сначала по marketId (conditionId), потом по instrumentId/tokenId через индекс
    let writer = this._writers.get(marketId);
    if (!writer) {
      const resolvedKey = this._instrumentIndex.get(marketId);
      if (resolvedKey) writer = this._writers.get(resolvedKey);
    }
    if (!writer) return;

    try {
      const line = JSON.stringify(record) + '\n';
      writer.buffer.push(line);
      writer.eventsRecorded++;

      if (writer.buffer.length >= BUFFER_SIZE) {
        this._flushWriter(writer);
      }
    } catch {
      // fire-and-forget: не бросаем
    }
  }

  private _flushWriter(writer: JournalWriter): void {
    if (writer.buffer.length === 0 || !writer.stream) return;

    const data = writer.buffer.join('');
    writer.buffer = [];
    writer.stream.write(data);
  }

  private _flushAll(): void {
    for (const writer of this._writers.values()) {
      this._flushWriter(writer);
    }
  }

  /**
   * Строит путь к файлу журнала.
   *
   * @remarks
   * Формат: `journalDir/YYYY-MM-DD/{sanitizedQuestion}___{marketId}.journal.jsonl`
   */
  private _buildFilePath(marketId: string, question: string): string {
    const date = new Date().toISOString().slice(0, 10);
    const sanitized = question
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 80);
    const shortId = marketId.slice(0, 40);
    return path.join(this._config.journalDir, date, `${sanitized}___${shortId}.journal.jsonl`);
  }
}
