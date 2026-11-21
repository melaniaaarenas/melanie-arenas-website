# Melanie Arenas: portfolio

A one-page portfolio with a private editor at `/admin`. Runs on Node.js 22+ with no npm packages.

## Run it on your computer

```bash
npm run set-password   # one time: choose your admin password (10+ characters)
npm start              # then open http://localhost:3000
```

- Public site: http://localhost:3000
- Editor: http://localhost:3000/admin (log in, edit, click **Save changes**)

## Where things live

| Path | What it is | Public? |
|---|---|---|
| `public/` | Site page, editor and login pages, profile photo, resume PDF, starter photos | Yes |
| `data/content.json` | All your site text and photo lists (created on first start from `content.seed.json`) | No |
| `data/content.json.bak` | The previous version, saved automatically on each save | No |
| `data/uploads/` | Photos you upload in the editor (served at `/uploads/...`) | Photos only |
| `config/admin.json` | Your password **hash** (never the password itself) | No |

Back up `data/`. It holds your edits and photos.

## Changing the password

Run `npm run set-password` again. It takes effect right away. Restarting the server logs out any open sessions.

## Security notes

- Passwords are hashed with scrypt and checked on the server.
- Sessions use an HttpOnly, SameSite=Strict cookie that lasts 8 hours. It is marked Secure automatically on HTTPS requests.
- 5 wrong passwords lock that IP out for 15 minutes.
- Every editing request requires a logged-in session. Cross-site requests are rejected.

## Deploying (Ubuntu 24.04 + nginx + pm2)

**1. Node 22+.** Ubuntu's own `nodejs` package is too old (v18). The server refuses to start on anything below 22.
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx
sudo npm install -g pm2
```

**2. Copy the code.** Run this from your Mac. It leaves out your local `config/` and `.env`. Leave `data/` in only on the very first upload, to bring your current content.
```bash
rsync -av --exclude config --exclude .env --exclude .DS_Store --exclude 'photoo*.png' \
  ./ you@SERVER_IP:~/portfolio/
```
For **later** updates, also add `--exclude data`. Otherwise you'll overwrite edits you made on the live site. Never use `--delete` without excluding `data` and `config`.

**3. Set the admin password on the server**, as the same user that runs pm2 (not with `sudo`, or the app can't read the file):
```bash
cd ~/portfolio && npm run set-password
```

**4. Start with pm2.** The settings are in `ecosystem.config.js`: localhost-only, port 3000, trust nginx, automatic Secure cookies.
```bash
pm2 start ecosystem.config.js
pm2 save && pm2 startup     # run the command it prints, so the site comes back after a reboot
pm2 logs portfolio          # the startup lines show data dir, proxy and cookie settings
```
Keep it at **one instance** (no `-i max` or cluster mode). Logins and the lockout counter live in memory.

**5. nginx.** Follow the steps at the top of `deploy/nginx-portfolio.conf`. The important lines are `proxy_set_header Host $host` (login is refused without it) and `client_max_body_size 16m` (photo uploads fail without it).

**6. Firewall.** Allow only SSH and web traffic. Port 3000 stays private.
```bash
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

**7. HTTPS later:** `sudo certbot --nginx -d yourdomain.com`. No app changes are needed. After switching, log in again once (the HTTPS cookie has a different name).

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the app listens on (match nginx `proxy_pass`) |
| `HOST` | `127.0.0.1` | Interface to listen on. Keep localhost behind nginx. |
| `TRUST_PROXY` | off | `1` = use nginx's `X-Real-IP` / `X-Forwarded-Proto`, accepted only from this machine |
| `COOKIE_SECURE` | `auto` | `auto` = Secure on HTTPS, plain on HTTP. `1` = always Secure. `0` = never. |
| `DATA_DIR` | `./data` | Where content and uploads are stored |
| `ADMIN_PASSWORD_HASH` | none | Alternative to `config/admin.json` (the line printed by `set-password`) |

### Backups

Back up `data/` (content, the previous version, uploads) and `config/admin.json`, for example with a nightly `tar czf ~/backups/portfolio-$(date +%F).tgz -C ~/portfolio data config` from cron, or Linode Backups.
