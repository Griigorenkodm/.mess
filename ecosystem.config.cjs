/**
 * Запуск с автоперезапуском (VPS / свой ПК):
 *   npx pm2-runtime start ecosystem.config.cjs
 * или в фоне:
 *   npx pm2 start ecosystem.config.cjs
 */
module.exports = {
  apps: [
    {
      name: "mess",
      script: "server/server.js",
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      min_uptime: "5s",
      exp_backoff_restart_delay: 200,
      max_memory_restart: "400M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
