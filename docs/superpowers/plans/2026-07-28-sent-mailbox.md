# 收件箱「已发送」tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收件箱页加「收件箱 / 已发送」切换 tab（URL 持久化），发送成功落地已发送视图，收件视图默认排除已发送。

**Architecture:** 后端 `GET /api/emails` 新增 `box` 参数（`sent` → 只看 resend；默认无 provider 时排除 resend）；前端 Inbox 加 tab state 同步 URL，Compose 发送后跳 `/console?box=sent`。无迁移。

**Tech Stack:** Hono + D1（后端）；React 19 + react-router（前端）；bun/bunx。

**Spec:** `docs/superpowers/specs/2026-07-28-sent-mailbox-design.md`

## Global Constraints

- 显式 `provider`（query 或 API key 绑定）存在时行为与现在完全一致，`box` 忽略。
- 不新增组件库依赖，tab 用现有 Button/样式实现。
- i18n 新增 `inbox.tabInbox`（收件箱/Inbox）、`inbox.tabSent`（已发送/Sent），zh/en 都加。
- 验证：`bunx tsc --noEmit`（根目录）、`cd web && bunx tsc -b`；不跑打包构建。
- 提交信息结尾带：
  ```
  Generated with [Claude Code](https://claude.ai/code)
  via [Happy](https://happy.engineering)

  Co-Authored-By: Claude <noreply@anthropic.com>
  Co-Authored-By: Happy <yesreply@happy.engineering>
  ```

---

### Task 1: 后端 box 参数

**Files:**
- Modify: `src/routes/emails.ts:9-40`（GET `/` handler）

**Interfaces:**
- Produces: `GET /api/emails?box=sent` → 只含 `provider='resend'`；无 `box` 且最终 provider 为空 → 排除 resend；`provider=...` 优先且不受 box 影响。响应结构不变。

- [ ] **Step 1: 实现**

在 `src/routes/emails.ts` GET `/` 中，`const providerQuery = ...` 之后加一行读取 box：

```ts
  const box = c.req.query("box");
```

把现有的 `if (provider) { ... }` 块（35-40 行）替换为：

```ts
  if (provider) {
    sql += " AND provider = ?";
    countSql += " AND provider = ?";
    params.push(provider);
    countParams.push(provider);
  } else if (box === "sent") {
    // 已发送视图：只看通过 Resend 发出的
    sql += " AND provider = 'resend'";
    countSql += " AND provider = 'resend'";
  } else {
    // 收件视图（默认）：排除已发送
    sql += " AND provider != 'resend'";
    countSql += " AND provider != 'resend'";
  }
```

- [ ] **Step 2: 类型检查**

Run: `cd /opt/any-mail && bunx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 本地验证**

```bash
bun run dev &   # :8787，等就绪
TOKEN=$(curl -s -X POST http://localhost:8787/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@local","password":"admin"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
# 默认：不含 resend
curl -s "http://localhost:8787/api/emails?limit=50" -H "Authorization: Bearer $TOKEN" | grep -c '"provider":"resend"' || echo "0 resend (OK)"
# box=sent：全是 resend（本地可能 0 条，total 应为 resend 行数）
curl -s "http://localhost:8787/api/emails?box=sent&limit=50" -H "Authorization: Bearer $TOKEN"
# provider 显式传参不受影响
curl -s "http://localhost:8787/api/emails?provider=domain&limit=1" -H "Authorization: Bearer $TOKEN" | head -c 200
```

Expected: 第一条无 resend 行；第二条只含 resend（或空）；第三条正常返回 domain 行。验证后停掉 dev 进程。

- [ ] **Step 4: Commit**

```bash
git add src/routes/emails.ts
git commit -m "feat(api): 邮件列表 box 参数区分收件/已发送"
```

---

### Task 2: 前端 tab 与跳转

**Files:**
- Modify: `web/src/lib/api.ts:113-123`（getEmails）
- Modify: `web/src/pages/Inbox.tsx`（tab state + UI + 请求参数）
- Modify: `web/src/pages/Compose.tsx:31`（发送成功跳转）
- Modify: `web/src/locales/zh.json`、`web/src/locales/en.json`（inbox 段）

**Interfaces:**
- Consumes: Task 1 的 `box` 参数。
- Produces: URL `?box=sent` 持久化的已发送视图。

- [ ] **Step 1: api.ts 增加 box 参数**

`getEmails` 参数类型加 `box?: string`，并在函数体 `if (params?.q) ...` 后加：

```ts
  if (params?.box) q.set("box", params.box);
```

签名改为：

```ts
export function getEmails(params?: { account_id?: string; to?: string; q?: string; box?: string; limit?: number; offset?: number }) {
```

- [ ] **Step 2: Inbox.tsx 加 tab**

1. `useSearchParams` 改为可写：`const [searchParams, setSearchParams] = useSearchParams();`
2. state 区（`filterProvider` 之后）加：

```ts
  const box = searchParams.get("box") === "sent" ? "sent" : "inbox";
  const switchBox = (b: "inbox" | "sent") => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (b === "sent") next.set("box", "sent");
      else next.delete("box");
      return next;
    });
    setPage(1);
  };
```

3. `fetchEmails` 里 `if (filterProvider) params.provider = filterProvider;` 改为：

```ts
      if (box === "sent") params.box = "sent";
      else if (filterProvider) params.provider = filterProvider;
```

4. 请求触发的 `useEffect` 依赖数组加 `box`：`[filterAccount, filterProvider, box, page, pageSize]`。
5. Filters 区（`{/* Filters */}` div 上方）插入 tab UI：

```tsx
      {/* Box tabs */}
      <div className="flex gap-1 shrink-0">
        <Button variant={box === "inbox" ? "secondary" : "ghost"} size="sm" onClick={() => switchBox("inbox")}>
          {t("inbox.tabInbox")}
        </Button>
        <Button variant={box === "sent" ? "secondary" : "ghost"} size="sm" onClick={() => switchBox("sent")}>
          {t("inbox.tabSent")}
        </Button>
      </div>
```

6. provider `<select>` 包裹条件渲染：`{box === "inbox" && (<select ...>...</select>)}`（已发送视图隐藏 provider 下拉，账号筛选保留）。

- [ ] **Step 3: Compose.tsx 跳转**

`navigate("/console")` → `navigate("/console?box=sent")`。

- [ ] **Step 4: locales**

`zh.json` 的 `"inbox": {` 段内加：

```json
    "tabInbox": "收件箱",
    "tabSent": "已发送",
```

`en.json` 对应段内加：

```json
    "tabInbox": "Inbox",
    "tabSent": "Sent",
```

- [ ] **Step 5: 类型检查**

Run: `cd /opt/any-mail/web && bunx tsc -b`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/api.ts web/src/pages/Inbox.tsx web/src/pages/Compose.tsx web/src/locales/zh.json web/src/locales/en.json
git commit -m "feat(web): 收件箱加已发送 tab，发送后落地已发送视图"
```

---

### Task 3: 收尾验证与发布

**Files:** 无新改动。

- [ ] **Step 1: 双端类型检查**

```bash
cd /opt/any-mail && bunx tsc --noEmit && cd web && bunx tsc -b
```

Expected: 均通过。

- [ ] **Step 2: 推送发布**

合并到 main 并 push（CI 自动迁移+部署，本次无新迁移）：

```bash
git push origin main
```

等 Deploy workflow 成功。

- [ ] **Step 3: 生产冒烟**

请用户在生产验证：收件箱顶部有两个 tab；切「已发送」能看到今天修复后发出的邮件；发一封测试邮件后自动落地已发送视图；URL 带 `?box=sent` 刷新仍停留。
