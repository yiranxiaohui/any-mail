import type { Env } from "./types";

const CF_API = "https://api.cloudflare.com/client/v4";
const DEFAULT_WORKER = "any-mail";

export interface CfCredentials {
  apiToken: string;
  accountId: string;
  workerName: string;
}

export interface AutoEnableStep {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface AutoEnableResult {
  ok: boolean;
  domain: string;
  zone_id?: string;
  worker: string;
  steps: AutoEnableStep[];
  error?: string;
}

type CfResponse<T> = {
  success: boolean;
  result?: T;
  errors?: { code?: number; message: string }[];
};

async function cfFetch<T>(
  path: string,
  apiToken: string,
  init?: RequestInit,
): Promise<{ data: CfResponse<T>; status: number }> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const data = (await res.json()) as CfResponse<T>;
  return { data, status: res.status };
}

function cfError(data: CfResponse<unknown>, fallback: string): string {
  return data.errors?.[0]?.message || fallback;
}

/** 从 env / settings 读取 CF 凭据 */
export async function getCloudflareCredentials(env: Env): Promise<CfCredentials | null> {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_WORKER')"
  ).all<{ key: string; value: string }>();
  const map = new Map(rows.results.map((r) => [r.key, r.value]));

  const apiToken = env.CLOUDFLARE_API_TOKEN || map.get("CLOUDFLARE_API_TOKEN");
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || map.get("CLOUDFLARE_ACCOUNT_ID");
  const workerName = map.get("CLOUDFLARE_EMAIL_WORKER")?.trim() || DEFAULT_WORKER;

  if (!apiToken || !accountId) return null;
  return { apiToken, accountId, workerName };
}

/** 按域名查找 Zone（精确匹配） */
export async function findZoneByName(
  domain: string,
  creds: CfCredentials,
): Promise<{ id: string; name: string; status: string } | null> {
  // 先精确查；失败再向上查父域（子域场景）
  const candidates = domainCandidates(domain);
  for (const name of candidates) {
    const { data } = await cfFetch<{ id: string; name: string; status: string }[]>(
      `/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(creds.accountId)}&per_page=5`,
      creds.apiToken,
    );
    if (!data.success) continue;
    const exact = (data.result ?? []).find((z) => z.name.toLowerCase() === name);
    if (exact) return exact;
  }
  return null;
}

function domainCandidates(domain: string): string[] {
  const parts = domain.toLowerCase().split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    out.push(parts.slice(i).join("."));
  }
  return out;
}

/**
 * 自动启用 Email Routing 并将 catch-all 指向 Worker。
 * 前提：域名 Zone 已在当前 Cloudflare 账号下（NS 已托管）。
 */
export async function autoEnableEmailRouting(
  domain: string,
  creds: CfCredentials,
): Promise<AutoEnableResult> {
  const steps: AutoEnableStep[] = [];
  const worker = creds.workerName;

  // 1) 查找 Zone
  const zone = await findZoneByName(domain, creds);
  if (!zone) {
    return {
      ok: false,
      domain,
      worker,
      steps: [{ step: "find_zone", ok: false, detail: "zone not found in this Cloudflare account" }],
      error: "zone_not_found",
    };
  }
  steps.push({ step: "find_zone", ok: true, detail: `${zone.name} (${zone.id})` });

  // 2) 读取当前 Email Routing 状态
  const { data: statusData } = await cfFetch<{
    enabled: boolean;
    status?: string;
    name: string;
  }>(`/zones/${zone.id}/email/routing`, creds.apiToken);

  if (!statusData.success) {
    steps.push({ step: "get_routing", ok: false, detail: cfError(statusData, "failed to get email routing") });
    return { ok: false, domain, zone_id: zone.id, worker, steps, error: "get_routing_failed" };
  }
  steps.push({
    step: "get_routing",
    ok: true,
    detail: `enabled=${statusData.result?.enabled} status=${statusData.result?.status ?? "unknown"}`,
  });

  // 3) 若未启用则启用（会写入并锁定 MX/SPF）
  if (!statusData.result?.enabled) {
    const { data: enableData } = await cfFetch<{ enabled: boolean; status?: string }>(
      `/zones/${zone.id}/email/routing/enable`,
      creds.apiToken,
      { method: "POST", body: "{}" },
    );
    // 部分账号用 dns 端点
    if (!enableData.success) {
      const { data: dnsEnable } = await cfFetch<{ enabled: boolean }>(
        `/zones/${zone.id}/email/routing/dns`,
        creds.apiToken,
        { method: "POST", body: JSON.stringify({ name: zone.name }) },
      );
      if (!dnsEnable.success) {
        steps.push({
          step: "enable_routing",
          ok: false,
          detail: cfError(enableData, cfError(dnsEnable, "failed to enable email routing")),
        });
        return { ok: false, domain, zone_id: zone.id, worker, steps, error: "enable_routing_failed" };
      }
      steps.push({ step: "enable_routing", ok: true, detail: "enabled via /email/routing/dns" });
    } else {
      steps.push({
        step: "enable_routing",
        ok: true,
        detail: `enabled status=${enableData.result?.status ?? "ok"}`,
      });
    }
  } else {
    steps.push({ step: "enable_routing", ok: true, detail: "already enabled" });
  }

  // 4) 配置 catch-all → Worker
  const { data: catchGet } = await cfFetch<{
    id?: string;
    enabled?: boolean;
    actions?: { type: string; value?: string[] }[];
    matchers?: { type: string }[];
  }>(`/zones/${zone.id}/email/routing/rules/catch_all`, creds.apiToken);

  if (!catchGet.success) {
    steps.push({ step: "get_catch_all", ok: false, detail: cfError(catchGet, "failed to get catch-all") });
    return { ok: false, domain, zone_id: zone.id, worker, steps, error: "get_catch_all_failed" };
  }

  const currentAction = catchGet.result?.actions?.[0];
  const alreadyWorker =
    currentAction?.type === "worker" &&
    (currentAction.value?.[0] ?? "").toLowerCase() === worker.toLowerCase() &&
    catchGet.result?.enabled === true;

  if (alreadyWorker) {
    steps.push({ step: "set_catch_all", ok: true, detail: `already → worker ${worker}` });
  } else {
    const { data: catchPut } = await cfFetch<unknown>(
      `/zones/${zone.id}/email/routing/rules/catch_all`,
      creds.apiToken,
      {
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          name: `AnyMail → ${worker}`,
          matchers: [{ type: "all" }],
          actions: [{ type: "worker", value: [worker] }],
        }),
      },
    );
    if (!catchPut.success) {
      steps.push({
        step: "set_catch_all",
        ok: false,
        detail: cfError(catchPut, "failed to set catch-all to worker"),
      });
      return { ok: false, domain, zone_id: zone.id, worker, steps, error: "set_catch_all_failed" };
    }
    steps.push({ step: "set_catch_all", ok: true, detail: `catch-all → worker ${worker}` });
  }

  return { ok: true, domain, zone_id: zone.id, worker, steps };
}
