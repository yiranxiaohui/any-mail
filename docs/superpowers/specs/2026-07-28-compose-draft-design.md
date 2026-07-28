# 写邮件本地草稿暂存 — 设计

日期：2026-07-28
范围：仅前端（`web/src/pages/Compose.tsx` + locale 文件），无后端改动。

## 目标

写邮件页面的内容在刷新、误关页面后不丢失：自动暂存到浏览器本地，并提供手动"暂存"按钮。

## 存储

- localStorage，key：`anymail_compose_draft`
- 值：JSON `{ from, to, subject, body, savedAt }`（`savedAt` 为 ISO 时间戳）
- 单份草稿，不区分用户（同浏览器多账号共享一份，接受此限制）

## 行为

### 恢复（进入页面时）
- URL 不带任何预填参数（`from`/`to`/`subject` 均无）且存在草稿 → 静默把四个字段填回表单。
- URL 带任一预填参数 → 以参数为准，不读草稿，也不主动删除已有草稿。

### 自动保存
- 任一字段（from/to/subject/body）变更后防抖约 800ms 写入 localStorage。
- 四个字段全为空时删除草稿（removeItem）。
- 表单下方显示一行小字："已自动保存 HH:mm"（有保存动作后才显示）。

### 手动暂存
- 发送按钮旁新增"暂存"按钮（outline 样式），点击立即写入并 toast 提示"草稿已暂存"。

### 清除
- 发送成功后删除草稿（在 `navigate("/console")` 前执行）。

## i18n

`web/src/locales` 中英文各新增：

- `compose.saveDraft`：暂存 / Save draft
- `compose.draftSaved`：草稿已暂存 / Draft saved
- `compose.autoSaved`：已自动保存 {{time}} / Auto-saved at {{time}}

（键名以实际 locale 文件结构为准。）

## 错误处理

- localStorage 读写包 try/catch（隐私模式/配额异常时静默降级，不影响写信与发送）。
- 解析草稿 JSON 失败视为无草稿。

## 验证

- `bunx tsc -b`（web/）通过。
- 手动流程：输入 → 刷新页面 → 内容恢复；点"暂存"→ toast；发送成功 → localStorage 中草稿被清除；带 `?to=...` 进入 → 参数优先。
