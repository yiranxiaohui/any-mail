# AnyMail API Documentation

Base URL: `https://any-mail.<your-subdomain>.workers.dev`

## Authentication

All `/api/*` routes (except login and OAuth callbacks) require a Bearer token:

```
Authorization: Bearer <token>
```

Obtain a token via the login endpoint. Tokens expire after 7 days.

Unauthorized requests return:

```json
{ "error": "unauthorized" }
```

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
  "meta": { "limit": 50, "offset": 0 }
}
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

List all connected accounts.

**Response:**

```json
{
  "accounts": [
    {
      "id": "uuid",
      "provider": "domain|gmail|outlook",
      "email": "user@example.com",
      "expires_at": "2026-01-01T00:00:00.000Z|null",
      "created_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

#### `GET /api/accounts/:id`

Get a single account.

**Response (200):** Account object

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
  "text": "user1@outlook.com----password1----client_id_1----refresh_token_1\nuser2@hotmail.com----password2----client_id_2----refresh_token_2"
}
```

**Format:** One account per line, fields separated by `----`:

| Field | Position | Stored | Description |
|-------|----------|--------|-------------|
| Email | 1 | Yes | Account email address |
| Password | 2 | No | Not stored |
| Client ID | 3 | Yes | Per-account OAuth client ID (SSID) |
| Refresh Token | 4 | Yes | OAuth refresh token |

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

> Duplicate emails are upserted (refresh_token and client_id updated).

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

#### `GET /api/oauth/outlook`

Redirects to Microsoft OAuth consent screen.

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

#### `PUT /api/settings`

Update settings. Only allowed keys are accepted, others are silently ignored.

**Allowed Keys:**

| Key | Description |
|-----|-------------|
| `ADMIN_PASSWORD` | Admin login password |
| `RESEND_API_KEY` | Resend API key for sending emails |
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
| GET | `/api/emails` | Yes | List emails |
| GET | `/api/emails/:id` | Yes | Get email detail |
| POST | `/api/emails/send` | Yes | Send email (Resend) |
| DELETE | `/api/emails/:id` | Yes | Delete email |
| GET | `/api/accounts` | Yes | List accounts |
| GET | `/api/accounts/:id` | Yes | Get account detail |
| POST | `/api/accounts` | Yes | Create domain email |
| POST | `/api/accounts/import` | Yes | Bulk import Microsoft accounts |
| DELETE | `/api/accounts/:id` | Yes | Delete account + emails |
| GET | `/api/oauth/gmail` | No | Gmail OAuth redirect |
| GET | `/api/oauth/gmail/callback` | No | Gmail OAuth callback |
| GET | `/api/oauth/outlook` | No | Outlook OAuth redirect |
| GET | `/api/oauth/outlook/callback` | No | Outlook OAuth callback |
| GET | `/api/settings` | Yes | Get settings |
| PUT | `/api/settings` | Yes | Update settings |
| POST | `/api/sync` | Yes | Trigger email sync |
