# Security

Creator Inbox is self-hosted. It stores **platform cookies in SQLite** so it can collect comments and DMs on your behalf. Treat the data directory like a password manager export.

## What to assume

- `inbox.db` contains session cookies in plaintext. The process `chmod 600`s the file when the OS allows it. Backup copies inherit whatever mode you give them — keep backups private.
- If `AUTH_TOKEN` is **unset**, every `/api/*` route is open to anyone who can reach the port. That is acceptable on `localhost`. On a NAS or LAN, set `AUTH_TOKEN`.
- When `AUTH_TOKEN` is set, `<img>` / `<video>` URLs also accept `?token=`. Tokens in query strings show up in reverse-proxy logs, browser history, and Referer. Prefer a trusted LAN; do not put this service on the public internet.
- Cookies are a BYO credential. A stolen DB is equivalent to a stolen creator login for the connected platforms. Rotate the platform session (re-login) if the DB leaks.

## Recommended deploy

```bash
docker run -d -p 8877:8877 \
  -v /path/to/data:/app/data \
  -e AUTH_TOKEN=$(openssl rand -hex 16) \
  creator-inbox
```

Bind to a tailnet / LAN, not `0.0.0.0` on a public host. Put a reverse proxy with TLS in front only if you still require `AUTH_TOKEN` (the UI will prompt once and remember it in `localStorage` for that origin).

## Reporting

Open a private report to the maintainer via GitHub security advisories on [XinYaoDev/creator-inbox](https://github.com/XinYaoDev/creator-inbox), or an issue if the finding is not exploitable.
