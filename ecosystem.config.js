// pm2 process file.  Start with:  pm2 start ecosystem.config.js
// Keep instances at 1 in "fork" mode: logins and the lockout counter live in this one process's
// memory, so cluster mode (several copies) would randomly log you out and weaken the lockout.
module.exports = {
  apps: [
    {
      name: 'portfolio',
      script: 'server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      kill_timeout: 6000,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',   // only nginx can reach the app
        PORT: '3000',        // must match proxy_pass in the nginx config
        TRUST_PROXY: '1',    // real visitor IPs + HTTPS detection from nginx headers
        COOKIE_SECURE: 'auto', // works on HTTP now; Secure cookie automatically once HTTPS is on
        // DATA_DIR: '/var/lib/portfolio',  // optional: keep site content outside the code folder
      },
    },
  ],
};
