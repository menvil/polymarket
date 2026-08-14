/**
 * Architecture-инвариант: Foundation НЕ зависит от Domain.
 *
 * @remarks
 * Детерминированная проверка по package.json всех foundation-пакетов
 * (без dependency-analysis framework — простое чтение манифестов):
 *
 * 1. строится карта `@polymarket/<name>` → физическая директория по ВСЕМ
 *    workspace-манифестам репозитория;
 * 2. для каждого `packages/foundation/*` проверяется, что ни одна его
 *    dependency не резолвится в `packages/domain/**` (а заодно — в
 *    application/infrastructure/apps: foundation — нижний слой).
 *
 * Тест живёт в `@polymarket/messages`, потому что именно этот пакет был
 * источником единственного нарушения (messages → value-objects ради
 * Timestamp), исправленного переносом Timestamp в foundation.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** Корень монорепо: packages/foundation/messages/__tests__ → четыре уровня вверх. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

/** Рекурсивно собирает пути всех package.json под base (без node_modules/dist). */
function collectManifests(base: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === 'package.json') {
        out.push(full);
      }
    }
  };
  walk(base);
  return out;
}

/** Карта имени пакета → repo-относительная директория. */
function buildPackageMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const base of ['packages', 'apps']) {
    const dir = join(REPO_ROOT, base);
    if (!existsSync(dir)) continue;
    for (const manifest of collectManifests(dir)) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (parsed.name?.startsWith('@polymarket/')) {
        map.set(parsed.name, manifest.slice(REPO_ROOT.length + 1, -'/package.json'.length));
      }
    }
  }
  return map;
}

describe('Foundation dependency boundary', () => {
  const packageMap = buildPackageMap();
  const foundationDir = join(REPO_ROOT, 'packages', 'foundation');
  const foundationPackages = readdirSync(foundationDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(foundationDir, entry.name, 'package.json')))
    .map((entry) => join(foundationDir, entry.name, 'package.json'));

  it('карта пакетов и список foundation-манифестов непусты (sanity)', () => {
    expect(packageMap.size).toBeGreaterThan(10);
    expect(foundationPackages.length).toBeGreaterThan(5);
    expect(packageMap.get('@polymarket/timestamp')).toBe(['packages', 'foundation', 'timestamp'].join(sep));
  });

  it('ни один packages/foundation/* не зависит от пакета вне packages/foundation', () => {
    const violations: string[] = [];
    for (const manifest of foundationPackages) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: string;
        dependencies?: Record<string, string>;
      };
      for (const dep of Object.keys(parsed.dependencies ?? {})) {
        if (!dep.startsWith('@polymarket/')) continue;
        const target = packageMap.get(dep);
        if (target === undefined) {
          violations.push(`${parsed.name}: dependency ${dep} is not a workspace package`);
          continue;
        }
        if (!target.startsWith(['packages', 'foundation'].join(sep) + sep)) {
          violations.push(`${parsed.name} -> ${dep} (${target})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('@polymarket/messages не зависит от @polymarket/value-objects и зависит от @polymarket/timestamp', () => {
    const manifest = JSON.parse(
      readFileSync(join(foundationDir, 'messages', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    const deps = Object.keys(manifest.dependencies ?? {});
    expect(deps).not.toContain('@polymarket/value-objects');
    expect(deps).toContain('@polymarket/timestamp');
  });

  it('@polymarket/timestamp зависит только от foundation/external', () => {
    const manifest = JSON.parse(
      readFileSync(join(foundationDir, 'timestamp', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (!dep.startsWith('@polymarket/')) continue;
      const target = packageMap.get(dep);
      expect(target?.startsWith(['packages', 'foundation'].join(sep) + sep)).toBe(true);
    }
  });
});
