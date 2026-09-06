/**
 * Машинная проверка датасета реального прогона коллектора.
 *
 * @remarks
 * ### Зачем отдельный валидатор
 *
 * `checkpoint-raw-live.mts` поднимает контур и проверяет собственный короткий
 * прогон. Реальная квалификация — это прогон на многих рынках, который идёт
 * часами и падать на полпути из-за валидатора не должен. Поэтому проверка
 * артефактов вынесена в независимый инструмент: он читает УЖЕ ЗАПИСАННЫЙ
 * корень датасетов и не поднимает ни шину, ни источники.
 *
 * ### Что проверяется
 *
 * ```text
 * Polymarket market-архив           CEX-партиция
 * ─────────────────────────         ────────────────────────
 * LINE 1: formatVersion 2           LINE 1: formatVersion 2 + CEX identity
 * headerVersion 2 (canonical)       окно партиции и поток
 * conditionId/outcomes/timing
 * наблюдения V2: type + ingress     наблюдения V2: type + ingress
 * (runId, sequence)                 (runId, sequence)
 * опорный book-снапшот CLOB
 * RTDS-наблюдения, где ожидались
 * settlement TWAP, где ожидался
 * НЕТ строк после границы датасета  — окно партиции не переполнено
 * finalization + winner (.gz)
 * ```
 *
 * `lateObservations` в CEX-партициях и любые строки ПОСЛЕ границы датасета —
 * это FAIL, а не предупреждение: и то и другое означает, что граница записи
 * не сработала, а именно её и вводил этот этап.
 *
 * ### Что именно разрешено после `expiresAt`
 *
 * ```text
 * POLYMARKET_MARKET                  ← запрещено (CLOB отсекается на границе)
 * POLYMARKET_CRYPTO_BINANCE          ← запрещено (обычный spot-фид)
 * POLYMARKET_CRYPTO_CHAINLINK        ← запрещено (обычный spot-фид)
 * POLYMARKET_CRYPTO_CHAINLINK_TWAP   ← РАЗРЕШЕНО в пределах settlement grace
 * ```
 *
 * Ровно ради последней строки граница и не совпадает с `expiresAt`: RTDS
 * доставляет граничное наблюдение TWAP на 1.1–2.2 с позже, и датасет обязан
 * его дождаться. Всё остальное после истечения — признак того, что сужение
 * routing-а не сработало. Допуск для TWAP задаётся `--grace-ms` (дефолт
 * покрывает production-настройку `COLLECTOR_SETTLEMENT_GRACE_MS` с запасом).
 *
 * ### Чего валидатор НЕ делает
 *
 * Не сравнивает OLD и NEW датасеты и не считает статистику стратегий: это
 * следующий этап квалификации. Здесь — только «датасет структурно пригоден
 * к replay».
 *
 * Запуск из корня repo:
 *
 * ```bash
 * npx tsx scripts/validate-raw-archives.mts ./data/snapshots
 * npx tsx scripts/validate-raw-archives.mts ./data/snapshots --json report.json
 * ```
 *
 * Выход: код 0 — все инварианты выполнены; 1 — ошибка использования;
 * 2 — датасет не прошёл проверку (подробности в отчёте).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import {
  RAW_ARCHIVE_FORMAT_VERSION,
  decodeRawArchive,
  detectRawArchiveFormat,
  ingressEpochMilliseconds,
  readCexPartitionHeader,
} from '@polymarket/raw-archive-format';
import type { DecodedObservation } from '@polymarket/raw-archive-format';

/** Итог проверки одного файла. */
interface FileReport {
  /** Путь относительно корня датасетов. */
  readonly file: string;
  /** Вид артефакта. */
  readonly kind: 'polymarket' | 'cex';
  /** Завершённый архив (`.jsonl.gz`) либо ещё пишущийся `.jsonl`. */
  readonly completed: boolean;
  /** Наблюдений в файле. */
  readonly observations: number;
  /** Нарушения инвариантов (пустой массив — файл пригоден). */
  readonly violations: readonly string[];
  /** Не блокирующие замечания. */
  readonly warnings: readonly string[];
}

/** Сводный отчёт прогона. */
interface ValidationReport {
  readonly root: string;
  readonly checkedAtIso: string;
  readonly files: readonly FileReport[];
  readonly totals: {
    readonly polymarketArchives: number;
    readonly polymarketCompleted: number;
    readonly cexPartitions: number;
    readonly cexCompleted: number;
    readonly observations: number;
    readonly violations: number;
  };
  readonly verdict: 'PASS' | 'FAIL';
}

/** Расширения, которые валидатор считает архивами. */
const ARCHIVE_SUFFIXES = ['.jsonl', '.jsonl.gz'] as const;

/** Внешний discriminator официального settlement-потока рынка. */
const SETTLEMENT_TWAP_TYPE = 'POLYMARKET_CRYPTO_CHAINLINK_TWAP';

/**
 * Типы наблюдений, которым после `expiresAt` в датасете места нет.
 *
 * @remarks
 * И CLOB, и ОБЫЧНЫЕ RTDS-фиды отсекаются ровно на границе: spot-цены живут
 * ради других рынков актива, и их «хвост» в датасете истёкшего рынка делал бы
 * границу зависимой от того, кто ещё подписан.
 */
const POST_EXPIRY_FORBIDDEN_TYPES: readonly string[] = [
  'POLYMARKET_MARKET',
  'POLYMARKET_CRYPTO_BINANCE',
  'POLYMARKET_CRYPTO_CHAINLINK',
];

/**
 * Допуск для settlement-потока после истечения рынка (мс).
 *
 * @remarks
 * Production-дефолт `COLLECTOR_SETTLEMENT_GRACE_MS` — 5 с; здесь взят запас
 * ×3 на планировщик и сброс буфера, чтобы штатный прогон не давал ложных
 * нарушений. Точное значение прогона задаётся `--grace-ms`.
 */
const DEFAULT_SETTLEMENT_GRACE_ALLOWANCE_MS = 15_000;

/**
 * Приводит значение к объекту-словарю, отвергая `null` и массивы.
 *
 * @param value - Разобранное JSON-значение
 * @returns Словарь либо `undefined`, если это не объект
 *
 * @remarks
 * Валидатор читает ЧУЖИЕ файлы, в том числе повреждённые: `"finalization":
 * null` и `"winning": []` — не «поля нет», а «поле испорчено». Прямое
 * обращение по ключу превратило бы такой файл в падение процесса, а отчёт по
 * остальным файлам пропал бы целиком. Ответ обязан быть нарушением
 * КОНКРЕТНОГО файла.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Момент наблюдения в epoch ms, если он точно известен.
 *
 * @param observation - Декодированное наблюдение
 * @returns Момент ingress либо `undefined` для legacy-строки
 */
function observationAtMs(observation: DecodedObservation): number | undefined {
  return observation.timingQuality === 'EXACT_INGRESS'
    ? ingressEpochMilliseconds(observation.ingress)
    : undefined;
}

/**
 * Рекурсивно собирает файлы-архивы под корнем датасетов.
 *
 * @param root - Корень датасетов
 * @returns Абсолютные пути архивов
 */
function listArchives(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (ARCHIVE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Читает файл (при необходимости распаковывая) и разбивает на строки.
 *
 * @param file - Абсолютный путь архива
 * @returns Строки файла В ФАЙЛОВОМ ПОРЯДКЕ
 * @throws {Error} Если файл нечитаем либо gzip повреждён
 */
function readLines(file: string): string[] {
  const raw = fs.readFileSync(file);
  const text = file.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  // Meta-строка storage добита пробелами до фиксированного блока — их надо
  // срезать, иначе JSON.parse увидит хвост.
  return text.split('\n').map((line) => line.trimEnd());
}

/**
 * Определяет вид артефакта по его LINE 1.
 *
 * @param firstLine - Первая непустая строка файла (либо `undefined`)
 * @returns `'cex'` для партиции биржи, иначе `'polymarket'`
 *
 * @remarks
 * Различитель — сам header формата, а не путь файла: раскладка каталогов
 * может измениться, а identity артефакта записана внутри него.
 */
function archiveKind(firstLine: string | undefined): 'polymarket' | 'cex' {
  return readCexPartitionHeader(detectRawArchiveFormat(firstLine)) !== undefined
    ? 'cex'
    : 'polymarket';
}

/**
 * Проверяет общие для всех V2-архивов инварианты наблюдений.
 *
 * @param observations - Декодированные наблюдения
 * @param violations - Аккумулятор нарушений
 *
 * @remarks
 * `runId`/`sequence` — ключ порядка replay: без них наблюдения нельзя
 * упорядочить МЕЖДУ файлами (Polymarket и CEX пишутся раздельно, а
 * vendor-часы у них разные). Строгое возрастание `sequence` внутри одного
 * runId проверяется здесь же: перестановка означала бы, что порядок,
 * который replay обязан воспроизвести, уже потерян.
 */
function checkObservations(
  observations: readonly DecodedObservation[],
  violations: string[],
): void {
  const lastSequenceByRun = new Map<string, number>();
  let legacyLines = 0;
  for (const observation of observations) {
    if (observation.timingQuality !== 'EXACT_INGRESS') {
      legacyLines++;
      continue;
    }
    const { runId, sequence } = observation.ingress;
    const previous = lastSequenceByRun.get(runId);
    if (previous !== undefined && sequence <= previous) {
      violations.push(
        `observation sequence is not increasing within run ${runId}: ${String(previous)} → ${String(sequence)}`,
      );
    }
    lastSequenceByRun.set(runId, sequence);
  }
  if (legacyLines > 0) {
    violations.push(`${String(legacyLines)} observation(s) lack exact ingress (runId/sequence)`);
  }
}

/**
 * Проверяет Polymarket market-архив.
 *
 * @param file - Путь относительно корня
 * @param lines - Строки файла
 * @param completed - Завершённый архив (`.gz`)
 * @returns Отчёт по файлу
 */
function validatePolymarketArchive(
  file: string,
  lines: string[],
  completed: boolean,
  settlementGraceMs: number,
): FileReport {
  const violations: string[] = [];
  const warnings: string[] = [];
  const archive = decodeRawArchive(lines);

  if (archive.format.kind !== 'V2') {
    violations.push(`archive format is ${archive.format.kind}, expected V2`);
  }
  if (archive.format.formatVersion !== RAW_ARCHIVE_FORMAT_VERSION) {
    violations.push(`formatVersion is ${String(archive.format.formatVersion)}, expected 2`);
  }
  if (archive.malformedLines > 0) {
    violations.push(`${String(archive.malformedLines)} malformed line(s)`);
  }

  const meta = asRecord(archive.format.header) ?? {};
  const header = asRecord(meta['m']);
  if (header === undefined) {
    violations.push('meta line has no market header object (key "m")');
    return { file, kind: 'polymarket', completed, observations: archive.observations.length, violations, warnings };
  }
  if (header['headerVersion'] !== 2) {
    violations.push(`headerVersion is ${String(header['headerVersion'])}, expected canonical 2`);
  }
  if (typeof header['conditionId'] !== 'string' || header['conditionId'].length === 0) {
    violations.push('header has no conditionId');
  }
  const outcomes = header['outcomes'];
  if (!Array.isArray(outcomes) || outcomes.length === 0) {
    violations.push('header has no outcomes');
  }
  const timing = asRecord(header['timing']) ?? {};
  const expiresAtMs = typeof timing['expiresAt'] === 'number' ? timing['expiresAt'] : undefined;
  if (expiresAtMs === undefined) {
    violations.push('header timing has no expiresAt');
  }

  checkObservations(archive.observations, violations);

  // Опорный book-снапшот CLOB: без него стакан не реконструируется, потому
  // что последующие price_change — дельты.
  const marketObservations = archive.observations.filter(
    (observation) => observation.type === 'POLYMARKET_MARKET',
  );
  const hasInitialBook = marketObservations.some((observation) => {
    const payload = observation.payload as { type?: unknown } | null;
    return payload !== null && typeof payload === 'object' && payload.type === 'book';
  });
  if (!hasInitialBook) {
    violations.push('no initial CLOB book snapshot in dataset');
  }

  const rtdsObservations = archive.observations.filter(
    (observation) =>
      typeof observation.type === 'string' && observation.type.startsWith('POLYMARKET_CRYPTO_'),
  );
  const twapObservations = archive.observations.filter(
    (observation) => observation.type === 'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
  );
  const isCrypto = header['crypto'] !== undefined;
  if (isCrypto && rtdsObservations.length === 0) {
    violations.push('crypto market dataset has no RTDS observations');
  }

  // Граница датасета: после истечения рынка в файл имеет право попасть
  // ТОЛЬКО settlement-поток, и только в пределах grace. Проверяется КАЖДЫЙ
  // тип наблюдения, а не один CLOB: «хвост» общего spot-фида нарушает
  // границу ровно так же, как запоздавший price_change.
  if (expiresAtMs !== undefined) {
    const lateByType = new Map<string, number>();
    let lateSettlement = 0;
    for (const observation of archive.observations) {
      const atMs = observationAtMs(observation);
      if (atMs === undefined || atMs <= expiresAtMs) {
        continue;
      }
      const type = observation.type ?? 'unknown';
      if (POST_EXPIRY_FORBIDDEN_TYPES.includes(type)) {
        lateByType.set(type, (lateByType.get(type) ?? 0) + 1);
        continue;
      }
      if (type === SETTLEMENT_TWAP_TYPE) {
        // Настоящая причина, по которой граница не совпадает с expiresAt:
        // граничное наблюдение TWAP приходит на 1.1–2.2 с позже.
        if (atMs > expiresAtMs + settlementGraceMs) {
          lateSettlement++;
        }
        continue;
      }
      lateByType.set(type, (lateByType.get(type) ?? 0) + 1);
    }
    for (const [type, count] of [...lateByType.entries()].sort()) {
      violations.push(
        `${String(count)} ${type} observation(s) recorded after the market expiry boundary`,
      );
    }
    if (lateSettlement > 0) {
      violations.push(
        `${String(lateSettlement)} settlement TWAP observation(s) beyond the ` +
          `${String(settlementGraceMs)}ms settlement grace`,
      );
    }
  }

  if (completed) {
    // `null` и массив здесь — не «поля нет», а испорченный header: читать их
    // как объект значило бы уронить процесс и потерять отчёт по остальным
    // файлам вместо нарушения по конкретному.
    const finalization = asRecord(header['finalization']);
    if (finalization === undefined) {
      violations.push(
        header['finalization'] === undefined
          ? 'completed archive has no finalization section'
          : 'completed archive has a malformed finalization section (not an object)',
      );
    } else {
      if (finalization['status'] !== 'complete' && finalization['status'] !== 'timeout') {
        violations.push(`completed archive finalization.status is ${String(finalization['status'])}`);
      }
      const winning = asRecord(finalization['winning']);
      if (winning === undefined && finalization['winning'] !== undefined) {
        violations.push('winning outcome is malformed (not an object)');
      } else if (isCrypto && winning === undefined) {
        violations.push('completed crypto archive has no winning outcome');
      }
      if (winning !== undefined && typeof winning['instrumentId'] !== 'string') {
        violations.push('winning outcome has no machine identity (instrumentId)');
      }
      const provenance = asRecord(finalization['provenance']);
      if (provenance === undefined && finalization['provenance'] !== undefined) {
        violations.push('resolution provenance is malformed (not an object)');
      }
      if (isCrypto && provenance?.['resolution'] === undefined) {
        violations.push('completed crypto archive has no resolution provenance');
      }
      if (isCrypto && twapObservations.length === 0 && provenance?.['resolution'] === 'fallback-chainlink-twap') {
        violations.push('fallback resolution claims recorded TWAP, but dataset has none');
      }
    }
  } else {
    warnings.push('dataset is still being written (.jsonl): finalization not checked');
  }

  return {
    file,
    kind: 'polymarket',
    completed,
    observations: archive.observations.length,
    violations,
    warnings,
  };
}

/**
 * Проверяет CEX-партицию.
 *
 * @param file - Путь относительно корня
 * @param lines - Строки файла
 * @param completed - Завершённая партиция (`.gz`)
 * @returns Отчёт по файлу
 */
function validateCexPartition(file: string, lines: string[], completed: boolean): FileReport {
  const violations: string[] = [];
  const warnings: string[] = [];
  const archive = decodeRawArchive(lines);

  if (archive.format.kind !== 'V2') {
    violations.push(`partition format is ${archive.format.kind}, expected V2`);
  }
  if (archive.malformedLines > 0) {
    violations.push(`${String(archive.malformedLines)} malformed line(s)`);
  }

  const header = readCexPartitionHeader(archive.format);
  if (header === undefined) {
    violations.push('partition header is not a CEX V2 header');
  } else {
    checkObservations(archive.observations, violations);
    // Окно партиции — часть её идентичности: наблюдение вне окна означает,
    // что оконная политика записи разошлась с ingress наблюдения.
    const late = archive.observations.filter((observation) => {
      const atMs = observationAtMs(observation);
      return atMs !== undefined && (atMs < header.windowStartMs || atMs >= header.windowEndMs);
    });
    if (late.length > 0) {
      violations.push(`${String(late.length)} observation(s) outside the declared partition window`);
    }
    if (archive.observations.length === 0) {
      warnings.push('partition has no observations');
    }
  }

  if (!completed) {
    warnings.push('partition is still being written (.jsonl)');
  }

  return {
    file,
    kind: 'cex',
    completed,
    observations: archive.observations.length,
    violations,
    warnings,
  };
}

/**
 * Проверяет весь корень датасетов.
 *
 * @param root - Корень датасетов реального прогона
 * @param options - Допуск settlement-потока после истечения рынка
 * @returns Сводный отчёт
 * @throws {Error} Если корень не существует
 *
 * @remarks
 * Отказ на ОДНОМ файле не прерывает проход: валидатор читает чужие,
 * потенциально повреждённые артефакты, и падение процесса лишило бы отчёта
 * все остальные файлы. Любое неожиданное исключение становится нарушением
 * своего файла.
 *
 * @example
 * ```typescript
 * const report = validateDatasetRoot('./data/snapshots');
 * if (report.verdict === 'FAIL') process.exitCode = 2;
 * ```
 */
export function validateDatasetRoot(
  root: string,
  options: { readonly settlementGraceMs?: number } = {},
): ValidationReport {
  const settlementGraceMs = options.settlementGraceMs ?? DEFAULT_SETTLEMENT_GRACE_ALLOWANCE_MS;
  if (!fs.existsSync(root)) {
    throw new Error(`Dataset root does not exist: ${root}`);
  }
  const files: FileReport[] = [];
  for (const absolute of listArchives(root)) {
    const relative = path.relative(root, absolute);
    const completed = absolute.endsWith('.gz');
    let lines: string[];
    try {
      lines = readLines(absolute);
    } catch (error) {
      files.push({
        file: relative,
        kind: 'polymarket',
        completed,
        observations: 0,
        violations: [`unreadable: ${error instanceof Error ? error.message : String(error)}`],
        warnings: [],
      });
      continue;
    }
    const firstLine = lines.find((line) => line.length > 0);
    try {
      files.push(
        archiveKind(firstLine) === 'cex'
          ? validateCexPartition(relative, lines, completed)
          : validatePolymarketArchive(relative, lines, completed, settlementGraceMs),
      );
    } catch (error) {
      files.push({
        file: relative,
        kind: 'polymarket',
        completed,
        observations: 0,
        violations: [
          `validation failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
        warnings: [],
      });
    }
  }

  const polymarket = files.filter((report) => report.kind === 'polymarket');
  const cex = files.filter((report) => report.kind === 'cex');
  const violations = files.reduce((sum, report) => sum + report.violations.length, 0);
  return {
    root,
    checkedAtIso: new Date().toISOString(),
    files,
    totals: {
      polymarketArchives: polymarket.length,
      polymarketCompleted: polymarket.filter((report) => report.completed).length,
      cexPartitions: cex.length,
      cexCompleted: cex.filter((report) => report.completed).length,
      observations: files.reduce((sum, report) => sum + report.observations, 0),
      violations,
    },
    verdict: violations === 0 && files.length > 0 ? 'PASS' : 'FAIL',
  };
}

/**
 * Точка входа CLI.
 *
 * @returns Код выхода процесса
 */
function main(): number {
  const [rootArg, ...rest] = process.argv.slice(2);
  if (rootArg === undefined) {
    process.stderr.write(
      'usage: npx tsx scripts/validate-raw-archives.mts <dataset-root> ' +
        '[--json <report.json>] [--grace-ms <ms>]\n',
    );
    return 1;
  }
  const jsonIndex = rest.indexOf('--json');
  const jsonPath = jsonIndex === -1 ? undefined : rest[jsonIndex + 1];
  const graceIndex = rest.indexOf('--grace-ms');
  const graceRaw = graceIndex === -1 ? undefined : rest[graceIndex + 1];
  const settlementGraceMs = graceRaw === undefined ? undefined : Number(graceRaw);
  if (settlementGraceMs !== undefined && (!Number.isFinite(settlementGraceMs) || settlementGraceMs < 0)) {
    process.stderr.write(`--grace-ms must be a finite number >= 0, got ${String(graceRaw)}\n`);
    return 1;
  }

  const report = validateDatasetRoot(
    path.resolve(rootArg),
    settlementGraceMs === undefined ? {} : { settlementGraceMs },
  );
  for (const file of report.files) {
    if (file.violations.length === 0) {
      continue;
    }
    process.stdout.write(`FAIL ${file.file}\n`);
    for (const violation of file.violations) {
      process.stdout.write(`  - ${violation}\n`);
    }
  }
  process.stdout.write(
    `\n${report.verdict}: ${String(report.totals.polymarketArchives)} PM archive(s) ` +
      `(${String(report.totals.polymarketCompleted)} completed), ` +
      `${String(report.totals.cexPartitions)} CEX partition(s) ` +
      `(${String(report.totals.cexCompleted)} completed), ` +
      `${String(report.totals.observations)} observation(s), ` +
      `${String(report.totals.violations)} violation(s)\n`,
  );
  if (jsonPath !== undefined) {
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`report written to ${jsonPath}\n`);
  }
  return report.verdict === 'PASS' ? 0 : 2;
}

/**
 * Запускает CLI только при ПРЯМОМ запуске файла.
 *
 * @remarks
 * Без этой проверки любой `import` модуля (в том числе из теста) выполнял бы
 * `main()` со случайным `process.argv` и менял бы `exitCode` процесса.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
