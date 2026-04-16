# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AnyMail is a unified email inbox that aggregates emails from three sources:
- **Domain emails** via Cloudflare Email Workers (push, real-time)
- **Gmail** via Gmail API OAuth2 (poll, 1-minute cron)
- **Outlook** via Microsoft Graph API OAuth2 (poll, 1-minute cron)

Monorepo with a Cloudflare Workers backend (`/src`) and a React frontend (`/web`).

## Commands

### Backend (root)
```bash
bun run dev                # Start Worker dev server on :8787
bun run deploy             # Deploy to Cloudflare
bun run db:migrate:local   # Run D1 migrations locally
bun run db:migrate:remote  # Run D1 migrations on production
```

### Frontend (`/web`)
```bash
cd web
bun run dev      # Vite dev server on :5173 (proxies /api → :8787)
bun run build    # tsc + vite build
bun run lint     # ESLint
```

### Type checking
```bash
# Backend (from root)
bunx tsc --noEmit

# Frontend (from web/)
bunx tsc -b
```

## Architecture

### Backend (`/src`) — Hono on Cloudflare Workers

- **`index.ts`** — Entry point. Exports three handlers: `fetch` (HTTP via Hono), `email` (Cloudflare Email Worker), `scheduled` (Cron Trigger every 1 min).
- **`auth.ts`** — Custom JWT (HMAC-SHA256 via Web Crypto). Single admin password. `authMiddleware()` protects all `/api/*` except `/api/auth/login` and `/api/oauth/*`.
- **`providers/`** — Each provider handles OAuth token lifecycle, token refresh, and email sync:
  - `domain.ts` — Parses raw MIME via `postal-mime`, auto-creates account on first email.
  - `gmail.ts` — Gmail API, fetches last 10 messages, recursively extracts MIME parts, base64url decoding.
  - `outlook.ts` — Microsoft Graph API, fetches last 10 messages, handles text/html body types.
- **`routes/`** — Hono route handlers for `emails`, `accounts`, `oauth`.

### Frontend (`/web/src`) — React 19 + Vite + shadcn/ui

- **`lib/auth.tsx`** — React Context for auth state, token in localStorage (`anymail_token`).
- **`lib/api.ts`** — API client that auto-attaches Bearer token; 401 responses redirect to `/login`.
- **`App.tsx`** — `ProtectedRoute`/`PublicRoute` wrappers around React Router.
- **`pages/`** — Login, Inbox (with account filter + search), EmailDetail (text/html tabs), Accounts (OAuth connect buttons).
- **`components/ui/`** — shadcn/ui components (base-ui variant, not Radix). Button has no `asChild` prop; use `render` prop or plain `<a>` tags instead. Select `onValueChange` passes `(value: string | null, eventDetails)`.

### Database — Cloudflare D1 (SQLite)

Two tables: `accounts` and `emails`. Schema in `/migrations/0001_init.sql`. Email deduplication uses `message_id` per account.

### Auth Flow

Single admin password (`ADMIN_PASSWORD` env var) → JWT token (7-day expiry, signed with `JWT_SECRET`). No user/role system.

## Environment Variables

Required secrets (set via `wrangler secret put` or `.dev.vars` for local):

```
ADMIN_PASSWORD, JWT_SECRET, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, OAUTH_REDIRECT_BASE
```

## Key Constraints

- **shadcn/ui uses @base-ui/react**, not Radix. Component APIs differ from older shadcn examples (no `asChild`, different callback signatures).
- **TypeScript 6.0** in frontend — `baseUrl` in tsconfig is deprecated; use `paths` without `baseUrl`.
- Path alias `@/*` maps to `./src/*` in frontend code.
- Wrangler `database_id` in `wrangler.toml` is a placeholder; must be replaced after `wrangler d1 create`.
