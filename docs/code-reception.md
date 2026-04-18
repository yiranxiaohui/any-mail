# 接码对接文档

AnyMail 提供一套基于 API key 的接口,供外部程序(注册脚本、自动化测试、接码平台等)接收验证码邮件。本文档面向调用方,涵盖从创建 key 到完整收码流程的所有细节。

> 本文档配套的完整 API 参考见 [`API.md`](./API.md)。

---

## 1. 方案概述

**工作模式**: 域名邮箱(Domain)接收的邮件由 Cloudflare Email Worker 实时推送入库,外部程序通过轮询接口读取。

**优点**
- 实时收信,无需依赖 IMAP / POP3
- 一个域名下可无限创建别名邮箱,天然适合一次性验证码场景
- API key 支持 scope 和 provider 限制,即便泄露影响可控

**限制**
- 接码仅支持域名邮箱(`provider=domain`),不支持 Gmail / Outlook
- 需要有一个已在 Cloudflare Email Routing 启用的域名

---

## 2. 准备工作

### 2.1 配置域名

在 AnyMail 管理后台 → Settings,配置 `EMAIL_DOMAINS`(或从 Cloudflare 同步),例如 `mail.example.com`。确保该域名已在 Cloudflare 开启 Email Routing,并将 catch-all 指向当前 Worker。

### 2.2 创建 API key

访问后台 `/api-keys` 页面,点击「创建密钥」:

| 字段 | 推荐值 | 说明 |
|---|---|---|
| 名称 | `code-bot` | 随意,便于识别 |
| Scopes | `emails:read` + `accounts:write` + `domains:read` | 读邮件 + 建/删邮箱 + 查可用域名 |
| 限定账号类型 | `Domain` | 必选,否则无法通过 API 创建邮箱 |
| 过期时间 | 视情况 | 建议设置,降低泄露风险 |

> `domains:read` 非必需。若你的程序已经硬编码了域名(如 `mail.example.com`),可以不加。动态拉取域名见 5.0。

**创建后明文仅显示一次**,形如:

```
ak_AbCdEfGh1234567890abcdefghijkABCDEFGH-_
```

请立即保存。丢失需重新创建。

### 2.3 仅读场景

如果你希望**接码平台只读取邮件,邮箱由人工预先建好**,可以只勾 `emails:read`,`accounts:write` 不选。此时 API key 无法创建 / 删除邮箱,只能读取已有域名邮箱的邮件。

---

## 3. 认证

所有接口(除 OAuth 跳转外)都需要在请求头携带:

```
Authorization: Bearer ak_xxxxxxxx...
```

- 401 `{"error":"invalid or expired api key"}` — key 不存在、被撤销或已过期
- 403 `{"error":"missing required scope: emails:read"}` — 该 key 未包含所需 scope
- 403 `{"error":"api keys cannot access this endpoint"}` — 该接口禁止 API key(如 `/api/keys`、`/api/settings`、`/api/sync`)

---

## 4. 典型接码流程

```
┌─────────────────┐
│ 1. 创建临时邮箱 │  POST   /api/accounts
└────────┬────────┘
         │  { id, email }
         ▼
┌─────────────────┐
│ 2. 提交给第三方 │  (注册、发验证码等,调用方自行处理)
└────────┬────────┘
         ▼
┌─────────────────┐
│ 3. 轮询收件     │  GET    /api/emails/latest?to=xxx&since=ISO&code_regex=
└────────┬────────┘
         │  命中后返回 emails[] 与提取出的 code
         ▼
┌─────────────────┐
│ 4. 回收邮箱     │  DELETE /api/accounts/:id   (可选)
└─────────────────┘
```

### 4.1 推荐轮询参数

- **`since`**: 技术上可选,但强烈建议传 —— 否则每次轮询都会翻历史邮件。**应在调用 `POST /api/accounts` 之前记录时间戳**,避免漏掉创建与首次轮询之间到达的邮件。
- **`limit`**: 默认 10,可省略。
- **`code_regex`**: 服务端正则匹配,命中时返回 `code` 字段;未命中返回 `"code": null`。常用:
  - 6 位数字:`\d{6}`
  - 带标签:`code[:：]\s*(\d{4,8})` —— 使用捕获组,返回第 1 组
  - 字母数字混合:`[A-Z0-9]{6}`

### 4.2 轮询频率与超时

- **间隔**: 2–5 秒一次。更快意义不大(邮件从到达到入库通常 1 秒内)。
- **超时**: 60–120 秒内收不到验证码视为失败,释放邮箱。
- **指数退避**: 网络报错时 1s → 2s → 4s → 放弃。

---

## 5. 核心接口

### 5.0 拉取可用域名(可选)

**`GET /api/domains`** · scope: `domains:read`

```bash
curl https://your-anymail.example.com/api/domains \
  -H "Authorization: Bearer ak_xxxxx"
```

**200**:
```json
{ "domains": [{ "name": "mail.example.com" }, { "name": "alt.example.com" }] }
```

用途:管理员在后台加 / 删域名后,客户端不需要改配置即可感知。若域名长期稳定,直接硬编码即可。

### 5.1 创建临时邮箱

**`POST /api/accounts`**

```bash
curl -X POST https://your-anymail.example.com/api/accounts \
  -H "Authorization: Bearer ak_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "u_abc123@mail.example.com",
    "expires_at": "2026-04-18T12:00:00.000Z"
  }'
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `email` | 是 | 完整邮箱地址。前缀建议加随机串避免冲突 |
| `expires_at` | 否 | ISO 时间,null 或省略表示永久 |

**200 / 201**:
```json
{
  "ok": true,
  "account": {
    "id": "8f3e2a...",
    "provider": "domain",
    "email": "u_abc123@mail.example.com",
    "expires_at": "2026-04-18T12:00:00.000Z"
  }
}
```

**错误**:
- `400 { "error": "invalid email" }` — 邮箱格式错误
- `409 { "error": "account already exists" }` — 已存在,改个前缀重试
- `403 { "error": "api key must be bound to provider=domain to create accounts" }` — key 未绑 domain

### 5.2 轮询最新邮件(接码核心)

**`GET /api/emails/latest`**

```bash
curl -G https://your-anymail.example.com/api/emails/latest \
  -H "Authorization: Bearer ak_xxxxx" \
  --data-urlencode "to=u_abc123@mail.example.com" \
  --data-urlencode "since=2026-04-18T10:00:00.000Z" \
  --data-urlencode "code_regex=\d{6}" \
  --data-urlencode "limit=5"
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `to` | — | 收件人 LIKE 匹配。建议传完整邮箱 |
| `since` | — | 仅返回 `received_at > since` 的邮件 |
| `limit` | 10 | 最大 50 |
| `code_regex` | — | 正则,匹配 `text_body` / `html_body` / `subject`。有捕获组时返回第 1 组,否则返回整段匹配 |

**200**:
```json
{
  "emails": [
    {
      "id": "...",
      "account_id": "...",
      "provider": "domain",
      "from_address": "noreply@service.com",
      "to_address": "u_abc123@mail.example.com",
      "subject": "Your code: 384729",
      "text_body": "Your verification code is 384729. Expires in 10 minutes.",
      "html_body": "",
      "received_at": "2026-04-18T10:05:23.000Z",
      "code": "384729"
    }
  ]
}
```

空命中时 `emails: []`,继续轮询即可。

**错误**:
- `400 { "error": "invalid code_regex" }` — 正则语法错

### 5.3 回收邮箱(可选)

**`DELETE /api/accounts/:id`**

```bash
curl -X DELETE https://your-anymail.example.com/api/accounts/8f3e2a... \
  -H "Authorization: Bearer ak_xxxxx"
```

同时删除该账号名下所有邮件。不主动删也没问题 —— `expires_at` 仅用于前端标记,**后端不会自动删除过期账号或其邮件**。若需要清理,自行调用本接口或在后台页面操作。

---

## 6. 代码示例

### 6.1 Python

```python
import httpx, time, uuid
from datetime import datetime, timezone

BASE = "https://your-anymail.example.com"
KEY = "ak_xxxxxxxxxxxx"
DOMAIN = "mail.example.com"

def headers():
    return {"Authorization": f"Bearer {KEY}"}

def create_mailbox() -> dict:
    local = uuid.uuid4().hex[:10]
    r = httpx.post(
        f"{BASE}/api/accounts",
        headers=headers(),
        json={"email": f"u_{local}@{DOMAIN}"},
        timeout=10,
    )
    r.raise_for_status()
    return r.json()["account"]

def poll_code(to: str, since: str, regex: str = r"\d{6}", timeout: int = 90) -> str | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = httpx.get(
            f"{BASE}/api/emails/latest",
            headers=headers(),
            params={"to": to, "since": since, "code_regex": regex, "limit": 5},
            timeout=10,
        )
        r.raise_for_status()
        emails = r.json()["emails"]
        for e in emails:
            if e.get("code"):
                return e["code"]
        time.sleep(3)
    return None

def delete_mailbox(account_id: str) -> None:
    httpx.delete(f"{BASE}/api/accounts/{account_id}", headers=headers(), timeout=10)

# 用法
since = datetime.now(timezone.utc).isoformat()  # 先记录时间,再建邮箱
acct = create_mailbox()
print(f"mailbox: {acct['email']}")
# ... 把 acct["email"] 提交给目标服务,让它发验证码 ...
code = poll_code(acct["email"], since)
print(f"code: {code}")
delete_mailbox(acct["id"])
```

### 6.2 Node.js (fetch)

```javascript
const BASE = "https://your-anymail.example.com";
const KEY = "ak_xxxxxxxxxxxx";
const DOMAIN = "mail.example.com";

const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function createMailbox() {
  const local = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  const res = await fetch(`${BASE}/api/accounts`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: `u_${local}@${DOMAIN}` }),
  });
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()).account;
}

async function pollCode(to, since, regex = "\\d{6}", timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = new URL(`${BASE}/api/emails/latest`);
    url.searchParams.set("to", to);
    url.searchParams.set("since", since);
    url.searchParams.set("code_regex", regex);
    url.searchParams.set("limit", "5");
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(await res.text());
    const { emails } = await res.json();
    for (const e of emails) {
      if (e.code) return e.code;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

async function deleteMailbox(id) {
  await fetch(`${BASE}/api/accounts/${id}`, { method: "DELETE", headers });
}

// 用法
const since = new Date().toISOString();  // 先记录时间,再建邮箱
const acct = await createMailbox();
// ... 触发目标服务发送验证码 ...
const code = await pollCode(acct.email, since);
console.log("code:", code);
await deleteMailbox(acct.id);
```

### 6.3 纯 curl(调试用)

```bash
KEY="ak_xxxxx"
BASE="https://your-anymail.example.com"

# 1. 先记录 since(建邮箱之前),避免漏掉竞态窗口里的邮件
SINCE=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# 2. 创建邮箱
curl -sX POST "$BASE/api/accounts" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"test01@mail.example.com"}' | jq

# 3. 轮询(5 秒间隔,最多 1 分钟)
for i in {1..12}; do
  RESP=$(curl -sG "$BASE/api/emails/latest" \
    -H "Authorization: Bearer $KEY" \
    --data-urlencode "to=test01@mail.example.com" \
    --data-urlencode "since=$SINCE" \
    --data-urlencode "code_regex=\d{6}")
  CODE=$(echo "$RESP" | jq -r '.emails[0].code // empty')
  [ -n "$CODE" ] && echo "Got code: $CODE" && break
  sleep 5
done
```

---

## 7. 错误码速查

| HTTP | 含义 | 处理建议 |
|---|---|---|
| 200 / 201 | 成功 | — |
| 400 | 请求参数错 | 检查 `email` / 正则语法 / 必填字段 |
| 401 | 认证失败 | key 被撤销、过期或拼写错误 |
| 403 | scope/provider 不足 | 用更高权限 key 重发,或确认 provider 绑定 |
| 404 | 资源不存在 | 账号 id 可能已被删除;跨 provider 的资源对当前 key 也会返 404 |
| 409 | 邮箱已存在 | 换一个本地部分重试 |
| 5xx | 服务端错误 | 指数退避重试 |

---

## 8. 最佳实践

1. **每次注册用不同邮箱**。前缀加随机串(UUID / 时间戳 + 随机数),避免与历史邮件混淆。
2. **`since` 应在调用 `POST /api/accounts` *之前* 记录**。若用首次轮询时的 `now()` 作为 `since`,会漏掉在"建邮箱完成 → 首次轮询"这段窗口内到达的邮件(这段窗口可能长达几百毫秒到几秒)。
3. **码提取尽量在服务端做**(传 `code_regex`)。不仅省一次往返,也可避免客户端正则差异。
4. **正则用捕获组**定位真正的码,例如 `code[^\d]*(\d{6})` 比 `\d{6}` 更准确,能避开日期数字。
5. **key 最小权限**。接码只读场景就别给 `accounts:write`;短期任务设 `expires_at`。
6. **key 泄露应急**:管理后台 `/api-keys` → 撤销,立即失效。
7. **不要把 key 写进前端代码 / Git 仓库**。CI 用环境变量、秘密管理服务(GitHub Actions Secrets、AWS Secrets Manager 等)。
8. **速率控制**: 单 key 的轮询 QPS 建议 ≤ 1 req/s。虽然现在没加限流,将来可能加。

---

## 9. 常见问题

**Q: 能否不创建新邮箱,直接监听整个域的邮件?**
A: 可以,但需要先手动建一个通配别名账号(例如 `catchall@mail.example.com`),然后把 catch-all 路由指向它。轮询时 `to` 过滤可用模糊匹配,但邮件检索粒度会变粗。推荐还是每次建独立邮箱。

**Q: 验证码可能在 HTML 而不是纯文本?**
A: `code_regex` 同时匹配 `text_body`、`html_body` 和 `subject`,任一命中即可。

**Q: 邮件什么时候会被清理?**
A: 目前不自动清理。`expires_at` 过期也只是标记,邮件仍保留。需要自己调用 `DELETE /api/accounts/:id` 或在后台手动删。

**Q: 能否用一把 key 管理多个域?**
A: 可以。`EMAIL_DOMAINS` 是全局的,一个 `provider=domain` 的 key 能跨所有已配置的域创建/读取邮箱。

**Q: Gmail / Outlook 邮箱能接码吗?**
A: 理论可以,但当前 API key 创建接口只放行 `provider=domain`。Gmail/Outlook 仍需先通过后台 OAuth 连接账号,然后给一把 `provider=gmail` / `outlook` + `emails:read` 的 key 去读。但轮询频率受限于各家 API 的配额,接码场景下体验不如域名邮箱。
