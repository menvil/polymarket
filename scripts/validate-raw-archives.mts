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
import {
  RAW_ARCHIVE_FORMAT_VERSION,
  decodeRawArchive,
  detectRawArchiveFormat,
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
function validatePolymarketArchive(file: string, lines: string[], completed: boolean): FileReport {
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

  const meta = archive.format.header ?? {};
  const header = (meta['m'] ?? {}) as Record<string, unknown>;
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
  const timing = (header['timing'] ?? {}) as Record<string, unknown>;
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
  // ТОЛЬКО settlement-поток, и только в пределах grace.
  if (expiresAtMs !== undefined) {
    const lateMarket = marketObservations.filter(
      (observation) =>
        observation.timingQuality === 'EXACT_INGRESS' &&
        observation.ingress.createdAtUnixSeconds * 1000 > expiresAtMs,
    );
    if (lateMarket.length > 0) {
      violations.push(
        `${String(lateMarket.length)} CLOB observation(s) recorded after the market expiry boundary`,
      );
    }
  }

  if (completed) {
    const finalization = header['finalization'] as Record<string, unknown> | undefined;
    if (finalization === undefined) {
      violations.push('completed archive has no finalization section');
    } else {
      if (finalization['status'] !== 'complete' && finalization['status'] !== 'timeout') {
        violations.push(`completed archive finalization.status is ${String(finalization['status'])}`);
      }
      const winning = finalization['winning'] as Record<string, unknown> | undefined;
      if (isCrypto && winning === undefined) {
        violations.push('completed crypto archive has no winning outcome');
      }
      if (winning !== undefined && typeof winning['instrumentId'] !== 'string') {
        violations.push('winning outcome has no machine identity (instrumentId)');
      }
      const provenance = finalization['provenance'] as Record<string, unknown> | undefined;
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
    const late = archive.observations.filter(
      (observation) =>
        observation.timingQuality === 'EXACT_INGRESS' &&
        (observation.ingress.createdAtUnixSeconds * 1000 < header.windowStartMs ||
          observation.ingress.createdAtUnixSeconds * 1000 >= header.windowEndMs),
    );
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
 * @returns Сводный отчёт
 * @throws {Error} Если корень не существует
 */
export function validateDatasetRoot(root: string): ValidationReport {
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
    files.push(
      archiveKind(firstLine) === 'cex'
        ? validateCexPartition(relative, lines, completed)
        : validatePolymarketArchive(relative, lines, completed),
    );
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
      'usage: npx tsx scripts/validate-raw-archives.mts <dataset-root> [--json <report.json>]\n',
    );
    return 1;
  }
  const jsonIndex = rest.indexOf('--json');
  const jsonPath = jsonIndex === -1 ? undefined : rest[jsonIndex + 1];

  const report = validateDatasetRoot(path.resolve(rootArg));
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

process.exitCode = main();
