/**
 * Setup для smoke-тестов
 *
 * @remarks
 * Загружает переменные окружения из .env.smoke перед запуском тестов.
 * Запускается автоматически через setupFilesAfterEnv в jest.smoke.config.js
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

// Загружаем .env.smoke из корня проекта
const envPath = path.join(rootDir, '.env.smoke');
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.warn(`[Smoke Setup] Failed to load ${envPath}: ${result.error.message}`);
  console.warn('[Smoke Setup] Make sure the .env.smoke file exists in the project root');
} else {
  console.log(`[Smoke Setup] Environment variables loaded from ${envPath}`);
}

// Увеличиваем таймаут для реальных API-вызовов
jest.setTimeout(30000);