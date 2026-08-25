/**
 * PM2-конфигурация для Polymarket data-collector.
 *
 * Запуск:
 *   npm run build
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs polymarket-collector
 *   pm2 stop polymarket-collector
 *
 * Почему fork, а не cluster:
 *   Сервис держит глобальное состояние (подписки источников, открытые окна
 *   записи, идущие финализации). Cluster-режим породил бы N копий, которые
 *   подписались бы на одни и те же рынки и писали бы в одни и те же файлы.
 */
module.exports = {
  apps: [
    {
      name: 'polymarket-collector',
      cwd: __dirname,
      script: 'dist/main.js',

      // --max-old-space-size=4096 согласован с npm run start.
      // --expose-gc полезен для ручного global.gc() при отладке утечек.
      node_args: '--max-old-space-size=4096 --expose-gc --env-file=.env',

      exec_mode: 'fork',
      instances: 1,

      // Чуть ниже max-old-space-size (4096 MB) — чтобы pm2 успел перезапустить
      // до того, как V8 упадёт в OOM.
      max_memory_restart: '3500M',

      autorestart: true,
      // Бэкофф между рестартами, чтобы не долбить API при сломанной конфигурации.
      restart_delay: 5000,
      // Если процесс упал >10 раз подряд менее чем за 60s — стопаем (видимо, баг).
      max_restarts: 10,
      min_uptime: '60s',

      // Graceful shutdown: коллектор гасит источники, дренирует общий bus в
      // recorder, закрывает окна записи и снимает сессии. На production-масштабе
      // (100 рынков, 6 бирж, ~1.4M записей) замерено 79 секунд до «Shutdown
      // complete», поэтому прежних 30 секунд не хватало — SIGKILL приходил
      // ПОСРЕДИ финализации и терял текущие окна.
      //
      // После завершения работы процесс не выходит сам: keep-alive пул
      // официального SDK-клиента закрыть нечем (у него нет метода закрытия), и
      // финальный SIGKILL от pm2 штатен — к этому моменту все архивы уже на
      // диске. Маскировать это process.exit() нельзя: он скрыл бы и настоящие
      // утечки таймеров/потоков.
      kill_timeout: 180000,
      wait_ready: false,

      watch: false,

      // Общий лог; stderr и stdout склеены.
      merge_logs: true,
      log_date_format: 'DD-MM HH:mm:ss Z',
      log_type: 'raw',
      out_file: './logs/collector.log',
      error_file: './logs/collector-error.log',

      env: {
        NODE_ENV: 'production',
        // LOG_LEVEL, CEX_CONFIG, прочее — берутся из .env (--env-file).
      },
    },
  ],
};
