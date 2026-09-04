/**
 * RawArchiveObservationReader — canonical file-level reader raw-архивов.
 *
 * @remarks
 * ### Место в архитектуре
 *
 * ```text
 * archive file (.jsonl / .jsonl.gz)
 *        ↓ ISnapshotReader (строки)
 * RawArchiveObservationReader (этот класс)   ← persistence/replay boundary
 *        ↓ DecodedObservation {type, ingress, payload, timingQuality}
 * Replay Source → ТОТ ЖЕ ExternalMessageBus → ТЕ ЖЕ Semantic Adapters
 * ```
 *
 * Формат определяется ПО HEADER-у (LINE 1), а не по имени файла и не по
 * форме первой data-строки — ровно ради этого header и добавлен в V2. Само
 * распознавание и декодирование живут в `@polymarket/raw-archive-format`;
 * этот класс добавляет только file/stream-механику.
 *
 * ### Что делает с legacy
 *
 * Legacy-архивы (market-файлы старого коллектора без `formatVersion` и
 * CEX-партиции вовсе без header-а) читаются ТЕМ ЖЕ вызовом и получают
 * `timingQuality: 'LEGACY_APPROXIMATE'`. Порядок строк файла сохраняется
 * строго: никакой пересортировки по vendor-timestamp, никакого выдуманного
 * `sequence`, никакой latency-модели. Файлы не переписываются и не
 * мигрируются.
 *
 * ### Чего НЕ делает
 *
 * Не создаёт `ExternalMessage` и не выдаёт исторический `ingress` за
 * metadata нового replay-runtime; не планирует воспроизведение (это дело
 * будущего replay scheduler-а); не сливает несколько файлов в один поток.
 *
 * @example
 * ```typescript
 * const reader = new RawArchiveObservationReader(factory.create(filePath));
 * try {
 *   const header = await reader.readHeader(); // meta-строка либо undefined
 *   for await (const observation of reader.readObservations()) {
 *     if (observation.timingQuality === 'EXACT_INGRESS') {
 *       scheduler.enqueue(observation.ingress, observation.type, observation.payload);
 *     }
 *   }
 * } finally {
 *   await reader.close();
 * }
 * ```
 */
import {
  decodeRawArchiveLine,
  detectRawArchiveFormat,
} from '@polymarket/raw-archive-format';
import type { DecodedObservation, RawArchiveFormat } from '@polymarket/raw-archive-format';
import type { ISnapshotReader } from './ISnapshotReader.js';

export class RawArchiveObservationReader {
  private readonly _source: ISnapshotReader;
  /** Итератор строк файла: открывается один раз и потребляется один раз. */
  private _lines: AsyncGenerator<string, void, undefined> | undefined;
  /** Формат, определённый по первой непустой строке. */
  private _format: RawArchiveFormat | undefined;
  /**
   * Первая строка, если она оказалась DATA (legacy-партиция без header-а):
   * её обязан вернуть первый же `readObservations()`, а не пропустить.
   */
  private _pendingFirstLine: string | undefined;
  private _malformedLines = 0;

  /**
   * @param source - Открытый построчный читатель файла (`SnapshotReaderFactory`)
   */
  constructor(source: ISnapshotReader) {
    this._source = source;
  }

  /** Путь читаемого файла. */
  public get filePath(): string {
    return this._source.getFilePath();
  }

  /** Число строк, которые не удалось декодировать (наблюдаемость потерь). */
  public get malformedLines(): number {
    return this._malformedLines;
  }

  /**
   * Читает объявленный формат архива (LINE 1) — идемпотентно.
   *
   * @returns Формат архива: версия, была ли meta-строка, точность тайминга
   *
   * @remarks
   * Вызывать необязательно: {@link readObservations} определит формат сам.
   * Публичен для случаев, когда решение (например, «эта партиция про
   * `binance/swap/orderbook`?») принимается ДО чтения наблюдений.
   */
  public async readFormat(): Promise<RawArchiveFormat> {
    if (this._format !== undefined) {
      return this._format;
    }
    const lines = this._openLines();
    let firstLine: string | undefined;
    for (;;) {
      const next = await lines.next();
      if (next.done === true) {
        break;
      }
      if (next.value.length > 0) {
        firstLine = next.value;
        break;
      }
    }
    const format = detectRawArchiveFormat(firstLine);
    this._format = format;
    if (firstLine !== undefined && !format.headerConsumedFirstLine) {
      // Header-а нет: первая строка — уже наблюдение, отдадим её читателю
      this._pendingFirstLine = firstLine;
    }
    return format;
  }

  /**
   * Читает meta-строку архива (если она есть).
   *
   * @returns Разобранная meta-строка либо `undefined` — архив её не имеет
   *   (legacy-партиция)
   */
  public async readHeader(): Promise<Readonly<Record<string, unknown>> | undefined> {
    return (await this.readFormat()).header;
  }

  /**
   * Итерирует наблюдения архива В ФАЙЛОВОМ ПОРЯДКЕ строк.
   *
   * @returns Async-генератор прочитанных наблюдений
   *
   * @remarks
   * Нечитаемые строки пропускаются и считаются в {@link malformedLines} —
   * повреждение одной строки не обрывает чтение архива, но и не выдаётся
   * за наблюдение. Порядок строк НЕ меняется.
   */
  public async *readObservations(): AsyncGenerator<DecodedObservation, void, undefined> {
    const format = await this.readFormat();

    const pending = this._pendingFirstLine;
    if (pending !== undefined) {
      this._pendingFirstLine = undefined;
      const observation = decodeRawArchiveLine(pending, format);
      if (observation === undefined) {
        this._malformedLines++;
      } else {
        yield observation;
      }
    }

    for await (const line of this._openLines()) {
      if (line.length === 0) {
        continue;
      }
      const observation = decodeRawArchiveLine(line, format);
      if (observation === undefined) {
        this._malformedLines++;
        continue;
      }
      yield observation;
    }
  }

  /**
   * Закрывает ресурсы нижележащего читателя.
   *
   * @returns Promise завершения закрытия
   *
   * @remarks
   * ОБЯЗАТЕЛЕН к вызову: `GzipJsonlSnapshotReader` удаляет временный файл.
   */
  public async close(): Promise<void> {
    await this._source.close();
  }

  /** Ленивый единственный итератор строк файла. */
  private _openLines(): AsyncGenerator<string, void, undefined> {
    this._lines ??= this._source.readLines();
    return this._lines;
  }
}
