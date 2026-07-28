# 写邮件本地草稿暂存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 写邮件页内容自动/手动暂存到 localStorage，刷新不丢，发送成功后清除。

**Architecture:** 新增纯函数模块 `web/src/lib/composeDraft.ts` 封装 localStorage 读写（try/catch 降级）；`Compose.tsx` 挂载时按 URL 参数决定是否恢复草稿，字段变更防抖 800ms 自动保存，另加手动"暂存"按钮；发送成功后清除。

**Tech Stack:** React 19 + Vite + react-i18next + shadcn/ui（base-ui 变体）+ sonner toast。

## Global Constraints

- 仅改前端：`web/src/lib/composeDraft.ts`（新建）、`web/src/pages/Compose.tsx`、`web/src/locales/zh.json`、`web/src/locales/en.json`。无后端改动。
- localStorage key 固定为 `anymail_compose_draft`。
- 项目无前端测试框架，**不新增测试依赖**；每个任务的验证 = `cd web && bunx tsc -b` 通过（+ 最终手动流程验证）。
- 包管理只用 bun；不跑 `bun run build`。
- shadcn/ui 是 base-ui 变体：Button 无 `asChild`。
- 提交信息结尾带 Happy/Claude 双署名（见任务中的 commit 命令）。

---

### Task 1: 草稿存储模块 + i18n 文案

**Files:**
- Create: `web/src/lib/composeDraft.ts`
- Modify: `web/src/locales/zh.json`（compose 段）
- Modify: `web/src/locales/en.json`（compose 段）

**Interfaces:**
- Produces:
  - `interface ComposeDraft { from: string; to: string; subject: string; body: string; savedAt: string }`
  - `loadDraft(): ComposeDraft | null` — 解析失败/无草稿/localStorage 异常均返回 null
  - `saveDraft(d: Omit<ComposeDraft, "savedAt">): ComposeDraft | null` — 四字段全为空(trim 后)时执行清除并返回 null；否则写入并返回带 savedAt 的完整对象；localStorage 异常返回 null
  - `clearDraft(): void`
  - i18n 键：`compose.saveDraft`、`compose.draftSaved`、`compose.autoSaved`（带 `{{time}}` 插值）

- [ ] **Step 1: 新建 `web/src/lib/composeDraft.ts`**

```ts
const DRAFT_KEY = "anymail_compose_draft";

export interface ComposeDraft {
  from: string;
  to: string;
  subject: string;
  body: string;
  savedAt: string;
}

export function loadDraft(): ComposeDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (typeof d !== "object" || d === null) return null;
    return {
      from: typeof d.from === "string" ? d.from : "",
      to: typeof d.to === "string" ? d.to : "",
      subject: typeof d.subject === "string" ? d.subject : "",
      body: typeof d.body === "string" ? d.body : "",
      savedAt: typeof d.savedAt === "string" ? d.savedAt : "",
    };
  } catch {
    return null;
  }
}

export function saveDraft(d: Omit<ComposeDraft, "savedAt">): ComposeDraft | null {
  const empty =
    !d.from.trim() && !d.to.trim() && !d.subject.trim() && !d.body.trim();
  try {
    if (empty) {
      localStorage.removeItem(DRAFT_KEY);
      return null;
    }
    const full: ComposeDraft = { ...d, savedAt: new Date().toISOString() };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(full));
    return full;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}
```

- [ ] **Step 2: locale 文案**

`web/src/locales/zh.json` 的 `compose` 对象末尾（`"required"` 之后）追加：

```json
"saveDraft": "暂存",
"draftSaved": "草稿已暂存",
"autoSaved": "已自动保存 {{time}}"
```

`web/src/locales/en.json` 同位置追加：

```json
"saveDraft": "Save draft",
"draftSaved": "Draft saved",
"autoSaved": "Auto-saved at {{time}}"
```

- [ ] **Step 3: 类型检查**

Run: `cd web && bunx tsc -b`
Expected: 无输出（通过）

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/composeDraft.ts web/src/locales/zh.json web/src/locales/en.json
git commit -m "feat: 草稿存储模块与 i18n 文案

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

### Task 2: Compose 页面集成（恢复 / 自动保存 / 暂存按钮 / 发送后清除）

**Files:**
- Modify: `web/src/pages/Compose.tsx`

**Interfaces:**
- Consumes: Task 1 的 `loadDraft` / `saveDraft` / `clearDraft` / `ComposeDraft` 与三个 i18n 键。

**行为要求（对应 spec）：**
1. URL 无 `from`/`to`/`subject` 任一参数且有草稿 → 初始 state 用草稿填充（含 body）。
2. URL 带任一参数 → 参数优先，不读草稿，不删草稿。
3. 任一字段变更后防抖 800ms 调 `saveDraft`；成功后更新"已自动保存 HH:mm"提示。
4. "暂存"按钮：立即 `saveDraft`，成功 toast `compose.draftSaved`。
5. 发送成功：`clearDraft()` 后再 `navigate("/console")`。

- [ ] **Step 1: 改写 `web/src/pages/Compose.tsx`**

在现有文件基础上做以下修改（其余 JSX 结构保持不变）：

导入部分：

```tsx
import { useEffect, useRef, useState } from "react";
import { loadDraft, saveDraft, clearDraft } from "@/lib/composeDraft";
```

初始 state（替换现有四个 useState 的初始化逻辑）：

```tsx
  const hasParams =
    searchParams.has("from") || searchParams.has("to") || searchParams.has("subject");
  const [initialDraft] = useState(() => (hasParams ? null : loadDraft()));

  const [from, setFrom] = useState(searchParams.get("from") || initialDraft?.from || "");
  const [to, setTo] = useState(searchParams.get("to") || initialDraft?.to || "");
  const [subject, setSubject] = useState(
    searchParams.get("subject") || initialDraft?.subject || ""
  );
  const [body, setBody] = useState(initialDraft?.body || "");
  const [sending, setSending] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(initialDraft?.savedAt || null);
```

自动保存（useState 之后加）。注意用 ref 跳过首次渲染，避免刚恢复草稿就立刻重写：

```tsx
  const skipFirstSave = useRef(true);
  useEffect(() => {
    if (skipFirstSave.current) {
      skipFirstSave.current = false;
      return;
    }
    const timer = setTimeout(() => {
      const saved = saveDraft({ from, to, subject, body });
      setSavedAt(saved ? saved.savedAt : null);
    }, 800);
    return () => clearTimeout(timer);
  }, [from, to, subject, body]);
```

手动暂存 handler（`handleSend` 旁）：

```tsx
  const handleSaveDraft = () => {
    const saved = saveDraft({ from, to, subject, body });
    if (saved) {
      setSavedAt(saved.savedAt);
      toast.success(t("compose.draftSaved"));
    }
  };
```

发送成功清草稿（`handleSend` 内，`toast.success` 之前加一行）：

```tsx
      await sendEmail({ from, to, subject, text: body });
      clearDraft();
      toast.success(t("compose.sent"));
```

底部按钮区（替换现有 `<div className="flex justify-end">` 一段）：

```tsx
          <div className="flex items-center justify-end gap-3">
            {savedAt && (
              <span className="text-xs text-muted-foreground">
                {t("compose.autoSaved", {
                  time: new Date(savedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                })}
              </span>
            )}
            <Button variant="outline" onClick={handleSaveDraft} disabled={sending}>
              {t("compose.saveDraft")}
            </Button>
            <Button onClick={handleSend} disabled={sending}>
              {/* 原有发送按钮内容保持不变 */}
            </Button>
          </div>
```

（`{/* 原有发送按钮内容保持不变 */}` 处保留现有 `sending ? ... : ...` 的完整 JSX，不要删。）

- [ ] **Step 2: 类型检查**

Run: `cd web && bunx tsc -b`
Expected: 无输出（通过）

- [ ] **Step 3: 手动验证（dev 环境走一遍）**

启动 `bun run dev`（根目录，:8787）与 `cd web && bun run dev`（:5173），浏览器验证：
1. 打开 `/console/compose`，输入内容，等 1 秒 → 出现"已自动保存 HH:mm"；刷新页面 → 内容恢复。
2. 点"暂存" → toast "草稿已暂存"。
3. 带参数打开 `/console/compose?to=a@b.c` → 显示参数值而非草稿。
4. 清空全部字段等 1 秒 → localStorage 中 `anymail_compose_draft` 被移除（DevTools 确认）。
5. 发送一封成功 → 跳回收件箱，localStorage 草稿已清除。

（无法起浏览器时，1/3/4 可用 DevTools console 直接检查 localStorage 行为，发送流程用已有环境验证。）

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/Compose.tsx
git commit -m "feat: 写邮件页支持草稿自动/手动暂存

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```
