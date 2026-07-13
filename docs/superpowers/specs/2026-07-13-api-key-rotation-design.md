# API Key 轮换（Rotation）设计

日期：2026-07-13
状态：已确认

## 背景与目标

API key 创建后目前只能编辑元数据或删除重建。删除重建会丢失 id、`created_at`、`last_used_at`，且外部系统若记录了 key id 会失效。目标：支持对现有 key 轮换密文——保留 id、name、scopes、provider、address、expires_at 等全部配置，仅替换密钥本身。

## 决策

- **轮换语义：立即失效。** 旧密钥在轮换成功的瞬间不可用，无宽限期。实现上直接覆盖 `key_hash`/`key_prefix`，无需数据库迁移。
- **API 形态：专用端点 `POST /api/keys/:id/rotate`。** 不复用 PATCH（PATCH 继续只管元数据），不采用前端删建。

## 后端设计

文件：`src/routes/api-keys.ts`

新增路由 `POST /:id/rotate`：

1. 走已有的 `requireJwt()` 中间件（挂在 `keys.use("*")` 上，自动生效）。API key 不能自我轮换，与其他 key 管理操作一致。
2. 按 `id + user_id` 查询该 key；不存在返回 `404 { error: "key not found" }`。
3. 调用已有 `generateApiKey()` 生成新的 `{ plaintext, hash, prefix }`。
4. `UPDATE api_keys SET key_hash = ?, key_prefix = ? WHERE id = ? AND user_id = ?`。
5. 返回结构与创建接口一致：

```json
{
  "ok": true,
  "key": { "id", "name", "key_prefix", "scopes", "provider", "address", "expires_at" },
  "plaintext": "ak_..."
}
```

明文仅本次响应返回，不落库（沿用现有约定：DB 只存 SHA-256）。

## 前端设计

- `web/src/lib/api.ts`：新增 `rotateApiKey(id)`，POST 到 `/api/keys/${id}/rotate`，返回类型与 `createApiKey` 的响应一致（`{ key, plaintext }`）。
- `web/src/pages/ApiKeys.tsx`：
  - 每行 key 的操作区新增「轮换」按钮（置于编辑与撤销之间）。
  - 点击后 `confirm()` 确认，文案提示旧密钥将立即失效。
  - 成功后复用现有的明文一次性展示 Dialog（`plaintext` state），并刷新 key 列表、toast 提示成功。
- i18n：新增轮换按钮、确认提示、成功 toast 的中英文案。

## 错误处理

- key 不存在或不属于当前用户：404。
- 使用 API key 调用该端点：被 `requireJwt()` 拒绝（403，沿用现有行为）。
- 前端请求失败：沿用现有 toast 错误提示模式。

## 验证标准

1. 创建 key，用旧明文调用 API 成功。
2. 轮换后：旧明文返回 401；新明文可用；key 的 id、name、scopes、provider、address、expires_at 均不变；列表中 `key_prefix` 更新。
3. PATCH / DELETE 行为不受影响。
4. `bunx tsc --noEmit`（后端）与 `bunx tsc -b`（前端）通过。

## 不做的事（YAGNI）

- 无宽限期 / 双密钥并存（如未来需要多客户端平滑切换再加列实现）。
- 无轮换历史 / 审计日志。
- 不允许 API key 自我轮换。
