# AnyMail API Documentation

Base URL: `https://any-mail.<your-subdomain>.workers.dev`

## Authentication

All `/api/*` routes (except login and OAuth callbacks) require a Bearer token:

```
Authorization: Bearer <token>
```

Two token types are accepted:

- **JWT** (admin session) — obtained via `POST /api/auth/login`. 7-day expiry. Full access.
- **API key** (`ak_...` prefix) — created via the API Keys page / `POST /api/keys`. Restricted by configured scopes and optional `provider` filter. Long-lived, intended for external program use (e.g. verification-code reception).

Unauthorized requests return:

```json
{ "error": "unauthorized" }
```

API keys rejected at route level return `403`:

```json
{ "error": "missing required scope: emails:read" }
```

```json
{ "error": "api keys cannot access this endpoint" }
```

### Scopes

| Scope | Grants |
|-------|--------|
| `emails:read` | List / get emails, `GET /api/emails/latest` |
| `emails:send` | `POST /api/emails/send` |
| `emails:delete` | `DELETE /api/emails/:id` |
| `accounts:read` | List / get accounts |
| `accounts:write` | Create / import / edit / reauth / sync / delete accounts |
| `domains:read` | `GET /api/domains` (list configured email domains) |
| `*` | All of the above |

### Provider restriction

When an API key has `provider` set (`domain` / `gmail` / `outlook`):

- Listing endpoints auto-filter results to that provider.
- Detail / mutation endpoints on resources of other providers return `404 { "error": "not found" }`.
- `POST /api/accounts` — requires `provider=domain` on the key.
- `POST /api/accounts/import` — requires `provider=outlook` on the key.
- `POST /api/sync` (global) is JWT-only regardless of scopes.

---

## Endpoints

### Health Check

#### `GET /`

Returns service status.

**Response:**

```json
{ "name": "any-mail", "status": "ok" }
```

---

### Auth

#### `POST /api/auth/login`

**Auth:** Not required

**Request Body:**

```json
{ "password": "your-admin-password" }
```

**Response (200):**

```json
{ "token": "eyJ..." }
```

**Response (401):**

```json
{ "error": "invalid password" }
```

> Default password is `admin`. Change it in Settings after first login.

---

### Emails

#### `GET /api/emails`

List emails with optional filters and pagination.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `account_id` | string | — | Filter by account ID |
| `provider` | string | — | Filter by provider (`domain`, `gmail`, `outlook`, `resend`) |
| `to` | string | — | Search by recipient (LIKE match) |
| `limit` | integer | 50 | Max 100 |
| `offset` | integer | 0 | Pagination offset |

**Response:**

```json
{
  "emails": [
    {
      "id": "uuid",
      "account_id": "uuid",
      "message_id": "string|null",
      "provider": "domain|gmail|outlook|resend",
      "from_address": "sender@example.com",
      "to_address": "recipient@example.com",
      "subject": "Hello",
      "text_body": "...",
      "html_body": "...",
      "raw_headers": "{}",
      "received_at": "2026-01-01T00:00:00.000Z",
      "created_at": "2026-01-01T00:00:00.000Z"
    }
  ],
  "meta": { "limit": 50, "offset": 0, "total": 123 }
}
```

#### `GET /api/emails/latest`

Polling-friendly endpoint for external clients (verification-code reception, etc). Returns newest emails matching the filter, optionally with a regex-extracted `code` field.

**Required scope:** `emails:read`

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `to` | string | — | LIKE match on recipient |
| `since` | ISO datetime | — | Only return emails with `received_at > since` |
| `limit` | integer | 10 | Max 50 |
| `code_regex` | string | — | If set, apply regex to `text_body` / `html_body` / `subject`; captured group 1 (or full match) is returned as `code`. On no match, `code` is `null`. When omitted, the `code` field is not included at all |

If the key is bound to a `provider`, results are automatically filtered to that provider.

**Response (200):**

```json
{
  "emails": [
    {
      "id": "uuid",
      "account_id": "uuid",
      "provider": "domain",
      "from_address": "noreply@example.com",
      "to_address": "user+tag@yourdomain.com",
      "subject": "Your code: 123456",
      "text_body": "Your verification code is 123456",
      "html_body": "",
      "received_at": "2026-04-18T10:30:00.000Z",
      "code": "123456"
    }
  ]
}
```

**Response (400):**

```json
{ "error": "invalid code_regex" }
```

#### `GET /api/emails/:id`

Get a single email by ID.

**Response (200):** Full email object (same shape as list item)

**Response (404):**

```json
{ "error": "not found" }
```

#### `POST /api/emails/send`

Send an email via Resend.

> Requires `RESEND_API_KEY` configured in Settings.

**Request Body:**

```json
{
  "from": "you@yourdomain.com",
  "to": "recipient@example.com",
  "subject": "Hello",
  "text": "Plain text body",
  "html": "<p>HTML body</p>"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `from` | Yes | Sender address (must be verified in Resend) |
| `to` | Yes | Recipient address |
| `subject` | Yes | Email subject |
| `text` | No | Plain text body |
| `html` | No | HTML body |

**Response (200):**

```json
{ "ok": true, "id": "resend-message-id" }
```

> Sent messages are also persisted into the `emails` table with `provider = "resend"`.

**Response (400):**

```json
{ "error": "from, to, subject are required" }
```

```json
{ "error": "Resend API key not configured. Set it in Settings." }
```

**Response (500):**

```json
{ "error": "Resend error: <details>" }
```

#### `DELETE /api/emails/:id`

Delete a single email.

**Response:**

```json
{ "ok": true }
```

---

### Accounts

#### `GET /api/accounts`

List connected accounts with optional filtering and pagination.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `search` | string | — | LIKE match on email |
| `provider` | string | — | Filter by provider (`domain`, `gmail`, `outlook`) |
| `tag` | string | — | Filter by tag (exact match). Special value `__untagged__` returns accounts with no tag. Omit to return all. |
| `limit` | integer | 20 | Max 100 |
| `offset` | integer | 0 | Pagination offset |

**Response:**

```json
{
  "accounts": [
    {
      "id": "uuid",
      "provider": "domain|gmail|outlook",
      "email": "user@example.com",
      "expires_at": "2026-01-01T00:00:00.000Z|null",
      "tag": "service-a|null",
      "created_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-01T00:00:00.000Z"
    }
  ],
  "meta": { "limit": 20, "offset": 0, "total": 42 }
}
```

#### `GET /api/accounts/tags`

List all tag groups with account counts. Combines user-created empty groups (`tag_groups` table) and tags actually in use on accounts. If the API key is bound to a provider, counts only include that provider.

**Required scope:** `accounts:read`

**Response:**

```json
{
  "tags": [
    { "tag": null, "count": 5 },
    { "tag": "service-a", "count": 12 },
    { "tag": "service-b", "count": 0 }
  ]
}
```

The `tag: null` entry (if present) represents untagged accounts. Other entries are sorted alphabetically. Groups with `count: 0` are user-created empty groups still registered in `tag_groups`.

#### `POST /api/accounts/tags`

Create an empty tag group. Idempotent — re-creating an existing group returns success without error.

**Required scope:** `accounts:write`

**Request Body:**

```json
{ "name": "service-a" }
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Group name, 1–50 chars (trimmed) |

**Response (200):**

```json
{ "ok": true, "name": "service-a" }
```

**Response (400):**

```json
{ "error": "name required" }
```

```json
{ "error": "name too long" }
```

#### `DELETE /api/accounts/tags/:name`

Delete a tag group. Removes the group from `tag_groups` and clears the `tag` field on any accounts currently assigned to it (accounts themselves are **not** deleted).

**Required scope:** `accounts:write`

**Response (200):**

```json
{ "ok": true }
```

**Response (400):**

```json
{ "error": "name required" }
```

#### `POST /api/accounts/bulk-tag`

Bulk-assign or clear a tag on multiple accounts. If the target tag doesn't exist as a group yet, it's auto-registered in `tag_groups` so it appears stably in `GET /api/accounts/tags`.

**Required scope:** `accounts:write`

**Request Body:**

```json
{
  "ids": ["uuid1", "uuid2", "uuid3"],
  "tag": "service-a"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `ids` | Yes | Non-empty array of account IDs |
| `tag` | Yes | Tag name, or `null` to clear the tag on all listed accounts |

If the API key is bound to a provider, only accounts of that provider are affected (others silently skipped).

**Response (200):**

```json
{ "ok": true, "updated": 3 }
```

**Response (400):**

```json
{ "error": "ids required" }
```

#### `GET /api/accounts/:id`

Get a single account. Includes sensitive fields (`password`, `client_id`, `refresh_token`) used by the Accounts page for edit/reauth operations.

**Response (200):**

```json
{
  "id": "uuid",
  "provider": "domain|gmail|outlook",
  "email": "user@example.com",
  "password": "string|null",
  "client_id": "string|null",
  "refresh_token": "string|null",
  "expires_at": "2026-01-01T00:00:00.000Z|null",
  "tag": "service-a|null",
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:00.000Z"
}
```

**Response (404):**

```json
{ "error": "not found" }
```

#### `POST /api/accounts`

Create a domain email account.

**Request Body:**

```json
{
  "email": "hello@yourdomain.com",
  "expires_at": "2026-01-02T00:00:00.000Z"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `email` | Yes | Full email address (must contain `@`) |
| `expires_at` | No | ISO datetime string, or `null` for permanent |

**Response (201):**

```json
{
  "ok": true,
  "account": {
    "id": "uuid",
    "provider": "domain",
    "email": "hello@yourdomain.com",
    "expires_at": "2026-01-02T00:00:00.000Z"
  }
}
```

**Response (400):**

```json
{ "error": "invalid email" }
```

**Response (409):**

```json
{ "error": "account already exists" }
```

#### `POST /api/accounts/import`

Bulk import Microsoft (Outlook/Hotmail/Live) accounts.

**Request Body:**

```json
{
  "text": "user1@outlook.com----password1----client_id_1----refresh_token_1\nuser2@hotmail.com----client_id_2----refresh_token_2"
}
```

**Format:** One account per line, fields separated by `----`. Two formats are accepted:

**4-field format** (with password):

| Field | Position | Stored | Description |
|-------|----------|--------|-------------|
| Email | 1 | Yes | Account email address |
| Password | 2 | Yes | Used later for ROPC reauth |
| Client ID | 3 | Yes | Per-account OAuth client ID |
| Refresh Token | 4 | Yes | OAuth refresh token |

**3-field format** (no password):

| Field | Position | Stored | Description |
|-------|----------|--------|-------------|
| Email | 1 | Yes | Account email address |
| Client ID | 2 | Yes | Per-account OAuth client ID |
| Refresh Token | 3 | Yes | OAuth refresh token |

**Response (200):**

```json
{
  "ok": true,
  "total": 2,
  "success": 2,
  "results": [
    { "email": "user1@outlook.com", "status": "ok" },
    { "email": "user2@hotmail.com", "status": "ok" }
  ]
}
```

Possible `status` values: `ok`, `invalid format`, `invalid email`

**Response (400):**

```json
{ "error": "empty input" }
```

> Duplicate emails are upserted (`password`, `client_id`, `refresh_token` updated).

#### `PATCH /api/accounts/:id`

Update editable account fields. Only fields present in the request body are modified.

**Request Body (all optional):**

```json
{
  "email": "new@example.com",
  "password": "new-password",
  "expires_at": "2026-06-01T00:00:00.000Z",
  "client_id": "client-id",
  "refresh_token": "refresh-token",
  "tag": "service-a"
}
```

Nullable fields (`password`, `expires_at`, `client_id`, `refresh_token`, `tag`) accept `null` to clear the value. Setting `tag` to an empty string also clears it.

**Response (200):**

```json
{ "ok": true }
```

**Response (400):**

```json
{ "error": "no fields to update" }
```

#### `POST /api/accounts/:id/reauth`

Re-acquire a refresh token for a Microsoft account using stored `email`, `password`, and `client_id` (ROPC flow). Tenant is inferred: `consumers` for personal domains (`hotmail.com`, `outlook.com`, `live.com`, `msn.com`), otherwise `organizations`.

**Response (200):**

```json
{ "ok": true, "email": "user@outlook.com" }
```

**Response (400):**

```json
{ "error": "no password stored for this account" }
```

```json
{ "error": "no client_id stored for this account" }
```

```json
{ "error": "<error_description from Microsoft>" }
```

**Response (404):**

```json
{ "error": "not found" }
```

#### `POST /api/accounts/:id/sync`

Manually sync a single Gmail or Outlook account.

**Response (200):**

```json
{ "ok": true, "email": "user@gmail.com", "provider": "gmail", "synced": 3 }
```

**Response (400):**

```json
{ "error": "domain accounts receive email passively" }
```

**Response (404):**

```json
{ "error": "not found" }
```

**Response (500):**

```json
{ "ok": false, "email": "user@outlook.com", "provider": "outlook", "synced": 0, "error": "token expired" }
```

#### `DELETE /api/accounts/:id`

Delete an account and all its emails.

**Response:**

```json
{ "ok": true }
```

---

### OAuth

> OAuth endpoints do **not** require authentication.

#### `GET /api/oauth/gmail`

Redirects to Google OAuth consent screen.

> Requires `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` configured in Settings.

#### `GET /api/oauth/gmail/callback`

Google OAuth callback. Exchanges authorization code for tokens and creates the Gmail account.

**Query Parameters:**

| Param | Description |
|-------|-------------|
| `code` | Authorization code from Google |

**Response (200):**

```json
{
  "ok": true,
  "account": { "id": "uuid", "email": "user@gmail.com", "provider": "gmail" }
}
```

**Response (400):**

```json
{ "error": "missing code" }
```

#### `GET /api/oauth/outlook`

Redirects to Microsoft OAuth consent screen (shared app, uses `OUTLOOK_CLIENT_ID` / `OUTLOOK_CLIENT_SECRET`).

> Requires `OUTLOOK_CLIENT_ID` and `OUTLOOK_CLIENT_SECRET` configured in Settings.

#### `GET /api/oauth/outlook/callback`

Microsoft OAuth callback. Exchanges authorization code for tokens and creates the Outlook account.

**Query Parameters:**

| Param | Description |
|-------|-------------|
| `code` | Authorization code from Microsoft |

**Response (200):**

```json
{
  "ok": true,
  "account": { "id": "uuid", "email": "user@outlook.com", "provider": "outlook" }
}
```

**Response (400):**

```json
{ "error": "missing code" }
```

#### `GET /api/oauth/outlook/reauth`

Start a PKCE reauth flow using a per-account `client_id` (no client secret required). Redirects to Microsoft consent.

**Query Parameters:**

| Param | Required | Description |
|-------|----------|-------------|
| `client_id` | Yes | Per-account OAuth client ID |

**Response (400):**

```json
{ "error": "missing client_id" }
```

> The `code_verifier` is kept in an in-memory map keyed by `state` for 5 minutes. Because Workers isolates are not shared, the PKCE callback must land on the same isolate; this is usually fine for short flows.

#### `GET /api/oauth/outlook/pkce-callback`

PKCE callback. On success, redirects to the frontend:

```
/accounts?reauth=success&email=<email>
```

On failure, redirects with:

```
/accounts?reauth=error&message=<error>
```

**Query Parameters:**

| Param | Description |
|-------|-------------|
| `code` | Authorization code from Microsoft |
| `state` | PKCE state token issued by `/outlook/reauth` |

**Response (400):**

```json
{ "error": "missing code or state" }
```

```json
{ "error": "invalid or expired state" }
```

---

### Settings

#### `GET /api/settings`

Get all settings. Sensitive values are masked (first 4 chars + `****`).

**Response:**

```json
{
  "settings": {
    "ADMIN_PASSWORD": {
      "value": "mypassword",
      "masked": "mypa****",
      "updated_at": "2026-01-01 00:00:00"
    },
    "RESEND_API_KEY": {
      "value": "re_xxxxx",
      "masked": "re_x****",
      "updated_at": "2026-01-01 00:00:00"
    }
  }
}
```

Keys masked to `<prefix>****` (when value length > 4):
- `ADMIN_PASSWORD`
- `RESEND_API_KEY`
- `CLOUDFLARE_API_TOKEN`
- Any key containing `SECRET`

Other keys return the raw value in both `value` and `masked`.

#### `PUT /api/settings`

Update settings. Only allowed keys are accepted; others are silently ignored.

**Allowed Keys:**

| Key | Description |
|-----|-------------|
| `ADMIN_PASSWORD` | Admin login password |
| `RESEND_API_KEY` | Resend API key for sending emails |
| `EMAIL_DOMAINS` | Comma-separated list of managed email domains |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token (for domain sync) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID (for domain sync) |
| `GMAIL_CLIENT_ID` | Google OAuth Client ID |
| `GMAIL_CLIENT_SECRET` | Google OAuth Client Secret |
| `OUTLOOK_CLIENT_ID` | Microsoft OAuth Client ID |
| `OUTLOOK_CLIENT_SECRET` | Microsoft OAuth Client Secret |

**Request Body:**

```json
{
  "ADMIN_PASSWORD": "newpassword",
  "RESEND_API_KEY": "re_xxxx"
}
```

**Response:**

```json
{ "ok": true }
```

#### `GET /api/settings/domains`

Return the list of configured email domains (parsed from the `EMAIL_DOMAINS` setting).

**Response:**

```json
{
  "domains": [
    { "name": "example.com" },
    { "name": "mail.example.com" }
  ]
}
```

Empty list when `EMAIL_DOMAINS` is unset.

#### `POST /api/settings/domains/sync`

Fetch zones (and MX subdomain records) from the Cloudflare API and overwrite `EMAIL_DOMAINS`. Uses `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` from settings (falls back to Worker env vars).

**Response (200):**

```json
{
  "ok": true,
  "domains": ["example.com", "mail.example.com"]
}
```

**Response (400):**

```json
{ "error": "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required." }
```

**Response (500):**

```json
{ "error": "<cloudflare api error message>" }
```

---

### API Keys

> All `/api/keys` endpoints are **JWT-only** — API keys cannot manage keys (prevents self-escalation).

#### `GET /api/keys`

List all API keys. Plaintext values and hashes are never returned.

**Response:**

```json
{
  "keys": [
    {
      "id": "uuid",
      "name": "code-reception-script",
      "key_prefix": "ak_AbCdEfGh",
      "scopes": "emails:read,accounts:write",
      "provider": "domain",
      "expires_at": null,
      "last_used_at": "2026-04-18T10:00:00.000Z",
      "created_at": "2026-04-10T08:00:00.000Z"
    }
  ]
}
```

#### `POST /api/keys`

Create a new API key. The plaintext value is returned **only once** in this response — store it immediately.

**Request Body:**

```json
{
  "name": "code-reception-script",
  "scopes": ["emails:read", "accounts:write"],
  "provider": "domain",
  "expires_at": null
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Human-readable label |
| `scopes` | Yes | Non-empty array. Valid: `emails:read`, `emails:send`, `emails:delete`, `accounts:read`, `accounts:write`, `*` |
| `provider` | No | `domain` \| `gmail` \| `outlook` \| `null`. `null` = no provider restriction |
| `expires_at` | No | ISO datetime or `null` for never |

**Response (201):**

```json
{
  "ok": true,
  "key": {
    "id": "uuid",
    "name": "code-reception-script",
    "key_prefix": "ak_AbCdEfGh",
    "scopes": ["emails:read", "accounts:write"],
    "provider": "domain",
    "expires_at": null
  },
  "plaintext": "ak_AbCdEfGh1234567890abcdef..."
}
```

**Response (400):**

```json
{ "error": "name is required" }
```

```json
{ "error": "at least one scope is required" }
```

```json
{ "error": "invalid provider" }
```

#### `PATCH /api/keys/:id`

Update editable fields on an API key. Only provided fields are modified.

**Request Body (all optional):**

```json
{
  "name": "new-name",
  "scopes": ["emails:read"],
  "provider": "domain",
  "expires_at": "2026-12-31T23:59:59.000Z"
}
```

Provide `provider: null` or `expires_at: null` to clear them.

**Response:**

```json
{ "ok": true }
```

#### `DELETE /api/keys/:id`

Revoke (delete) an API key. Subsequent requests using it return `401`.

**Response:**

```json
{ "ok": true }
```

---

### Domains (public)

#### `GET /api/domains`

Return the list of configured email domains. Intended for external clients (e.g. code-reception scripts) that need to discover which domains they can create mailboxes under.

**Required scope:** `domains:read`

**Response:**

```json
{
  "domains": [
    { "name": "mail.example.com" },
    { "name": "alt.example.com" }
  ]
}
```

Empty list when no domains are configured. Same data as the admin-only `GET /api/settings/domains`, but exposed through a dedicated scope so API keys can call it without touching settings.

---

### Sync

#### `POST /api/sync`

Manually trigger email sync for all Gmail and Outlook accounts.

> This also runs automatically every minute via Cloudflare Cron Trigger.

**Response:**

```json
{
  "ok": true,
  "results": [
    { "email": "user@gmail.com", "provider": "gmail", "synced": 3 },
    { "email": "user@outlook.com", "provider": "outlook", "synced": 1 },
    { "email": "user@hotmail.com", "provider": "outlook", "synced": 0, "error": "token expired" }
  ]
}
```

---

## Summary

| Method | Path | Auth | Description |
|--------|------|:----:|-------------|
| GET | `/` | No | Health check |
| POST | `/api/auth/login` | No | Login, get JWT token |
| GET | `/api/emails` | Yes | List emails (scope: `emails:read`) |
| GET | `/api/emails/latest` | Yes | Poll newest emails for code reception (scope: `emails:read`) |
| GET | `/api/emails/:id` | Yes | Get email detail (scope: `emails:read`) |
| POST | `/api/emails/send` | Yes | Send email via Resend (scope: `emails:send`) |
| DELETE | `/api/emails/:id` | Yes | Delete email (scope: `emails:delete`) |
| GET | `/api/accounts` | Yes | List accounts (scope: `accounts:read`) |
| GET | `/api/accounts/tags` | Yes | List tag groups with counts (scope: `accounts:read`) |
| POST | `/api/accounts/tags` | Yes | Create empty tag group (scope: `accounts:write`) |
| DELETE | `/api/accounts/tags/:name` | Yes | Delete tag group, clear on accounts (scope: `accounts:write`) |
| POST | `/api/accounts/bulk-tag` | Yes | Bulk set/clear tag on accounts (scope: `accounts:write`) |
| GET | `/api/accounts/:id` | Yes | Get account detail (scope: `accounts:read`) |
| POST | `/api/accounts` | Yes | Create domain email (scope: `accounts:write`, provider=domain) |
| POST | `/api/accounts/import` | Yes | Bulk import Outlook accounts (scope: `accounts:write`, provider=outlook) |
| PATCH | `/api/accounts/:id` | Yes | Edit account fields (scope: `accounts:write`) |
| POST | `/api/accounts/:id/reauth` | Yes | ROPC reauth (scope: `accounts:write`) |
| POST | `/api/accounts/:id/sync` | Yes | Sync a single account (scope: `accounts:write`) |
| DELETE | `/api/accounts/:id` | Yes | Delete account + emails (scope: `accounts:write`) |
| GET | `/api/oauth/gmail` | No | Gmail OAuth redirect |
| GET | `/api/oauth/gmail/callback` | No | Gmail OAuth callback |
| GET | `/api/oauth/outlook` | No | Outlook OAuth redirect |
| GET | `/api/oauth/outlook/callback` | No | Outlook OAuth callback |
| GET | `/api/oauth/outlook/reauth` | No | Outlook PKCE reauth (per-account client) |
| GET | `/api/oauth/outlook/pkce-callback` | No | Outlook PKCE callback |
| GET | `/api/settings` | Yes | Get settings (JWT only) |
| PUT | `/api/settings` | Yes | Update settings (JWT only) |
| GET | `/api/settings/domains` | Yes | List configured email domains (JWT only) |
| POST | `/api/settings/domains/sync` | Yes | Sync domains from Cloudflare (JWT only) |
| GET | `/api/keys` | Yes | List API keys (JWT only) |
| POST | `/api/keys` | Yes | Create API key (JWT only) |
| PATCH | `/api/keys/:id` | Yes | Update API key (JWT only) |
| DELETE | `/api/keys/:id` | Yes | Revoke API key (JWT only) |
| GET | `/api/domains` | Yes | List configured email domains (scope: `domains:read`) |
| POST | `/api/sync` | Yes | Trigger email sync for all accounts (JWT only) |
