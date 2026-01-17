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
  console.warn(`[Smoke Setup] Не удалось загрузить ${envPath}: ${result.error.message}`);
  console.warn('[Smoke Setup] Убедитесь, что файл .env.smoke существует в корне проекта');
} else {
  console.log(`[Smoke Setup] Загружены переменные окружения из ${envPath}`);
}

// Увеличиваем таймаут для реальных API-вызовов
jest.setTimeout(30000);