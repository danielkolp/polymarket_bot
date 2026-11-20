/**
 * pm2 process file: keeps the Next.js server (and therefore the bot loop) alive.
 *
 *   npm run build
 *   npx pm2 start ecosystem.config.cjs
 *   npx pm2 save && npx pm2 startup   # survive reboots
 *
 * A bot that was running resumes automatically when the server restarts
 * (see src/instrumentation.ts); panic stops are never auto-resumed.
 */
module.exports = {
  apps: [
    {
      name: "polymarket-bot",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      cwd: __dirname,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 1000,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: "1G",
      env: { NODE_ENV: "production" },
    },
  ],
};
