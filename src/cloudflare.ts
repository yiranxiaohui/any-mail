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

export interface ZoneInfo {
  id: string;
  name: string;
  status: string;
  name_servers: string[];
}

export interface AutoEnableResult {
  ok: boolean;
  domain: string;
  zone_id?: string;
  zone_status?: string;
  nameservers?: string[];
  worker: string;
  steps: AutoEnableStep[];
  error?: string;
  /** zone 刚创建或尚未 active，需用户在注册商改 NS */
  pending_ns?: boolean;
  zone_created?: boolean;
}

type CfResponse<T> = {
  success: boolean;
  result?: T;
  errors?: { code?: number; message: string }[];
};

type CfZoneResult = {
  id: string;
  name: string;
  status: string;
  name_servers?: string[];
  original_name_servers?: string[];
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

function toZoneInfo(z: CfZoneResult): ZoneInfo {
  return {
    id: z.id,
    name: z.name,
    status: z.status,
    name_servers: z.name_servers ?? [],
  };
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

/** 按 id 拉取 Zone 详情（补全 name_servers） */
async function getZoneById(zoneId: string, creds: CfCredentials): Promise<ZoneInfo | null> {
  const { data } = await cfFetch<CfZoneResult>(`/zones/${zoneId}`, creds.apiToken);
  if (!data.success || !data.result) return null;
  return toZoneInfo(data.result);
}

/** 按域名查找 Zone（精确匹配，含 name_servers） */
export async function findZoneByName(
  domain: string,
  creds: CfCredentials,
): Promise<ZoneInfo | null> {
  const candidates = domainCandidates(domain);
  for (const name of candidates) {
    const { data } = await cfFetch<CfZoneResult[]>(
      `/zones?name=${encodeURIComponent(name)}&account.id=${encodeURIComponent(creds.accountId)}&per_page=5`,
      creds.apiToken,
    );
    if (!data.success) continue;
    const exact = (data.result ?? []).find((z) => z.name.toLowerCase() === name);
    if (!exact) continue;
    const info = toZoneInfo(exact);
    if (info.name_servers.length === 0) {
      const full = await getZoneById(info.id, creds);
      if (full) return full;
    }
    return info;
  }
  return null;
}

/** 创建 Zone（full setup），返回分配的 NS */
export async function createZone(
  domain: string,
  creds: CfCredentials,
): Promise<{ zone?: ZoneInfo; error?: string; detail?: string }> {
  // 只为 apex 建区：取最短候选（最后一级 eTLD 前的整域）
  const apex = domainCandidates(domain)[0] ?? domain.toLowerCase();
  const { data } = await cfFetch<CfZoneResult>("/zones", creds.apiToken, {
    method: "POST",
    body: JSON.stringify({
      name: apex,
      account: { id: creds.accountId },
      type: "full",
      jump_start: false,
    }),
  });

  if (!data.success || !data.result) {
    return {
      error: "create_zone_failed",
      detail: cfError(data, "failed to create zone"),
    };
  }
  return { zone: toZoneInfo(data.result) };
}

/**
 * 确保域名 Zone 在当前账号：不存在则创建；已存在则返回。
 * Token 需 Zone:Edit（创建）/ Zone:Read。
 */
export async function ensureZone(
  domain: string,
  creds: CfCredentials,
  opts?: { createIfMissing?: boolean },
): Promise<{
  zone: ZoneInfo | null;
  created: boolean;
  steps: AutoEnableStep[];
  error?: string;
}> {
  const steps: AutoEnableStep[] = [];
  const createIfMissing = opts?.createIfMissing !== false;

  let zone = await findZoneByName(domain, creds);
  if (zone) {
    steps.push({
      step: "find_zone",
      ok: true,
      detail: `${zone.name} (${zone.id}) status=${zone.status}`,
    });
    return { zone, created: false, steps };
  }

  steps.push({
    step: "find_zone",
    ok: false,
    detail: "zone not found in this Cloudflare account",
  });

  if (!createIfMissing) {
    return { zone: null, created: false, steps, error: "zone_not_found" };
  }

  const created = await createZone(domain, creds);
  if (!created.zone) {
    steps.push({
      step: "create_zone",
      ok: false,
      detail: created.detail ?? "failed to create zone",
    });
    return { zone: null, created: false, steps, error: created.error ?? "create_zone_failed" };
  }

  zone = created.zone;
  steps.push({
    step: "create_zone",
    ok: true,
    detail: `${zone.name} (${zone.id}) status=${zone.status}`,
  });
  if (zone.name_servers.length > 0) {
    steps.push({
      step: "nameservers",
      ok: true,
      detail: zone.name_servers.join(", "),
    });
  }
  return { zone, created: true, steps };
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
 * 默认：Zone 不存在时在本账号创建（full 托管），返回 NS 供用户在注册商修改；
 * Zone 未 active 时返回 pending_ns，不继续改 Email Routing。
 */
export async function autoEnableEmailRouting(
  domain: string,
  creds: CfCredentials,
  opts?: { createIfMissing?: boolean },
): Promise<AutoEnableResult> {
  const worker = creds.workerName;
  const createIfMissing = opts?.createIfMissing !== false;

  // 1) 确保 Zone 在本账号
  const ensured = await ensureZone(domain, creds, { createIfMissing });
  const steps = [...ensured.steps];

  if (!ensured.zone) {
    return {
      ok: false,
      domain,
      worker,
      steps,
      error: ensured.error ?? "zone_not_found",
    };
  }

  const zone = ensured.zone;
  const nameservers = zone.name_servers;

  // Zone 未 active：无法可靠启用 Email Routing，提示改 NS
  if (zone.status !== "active") {
    steps.push({
      step: "zone_active",
      ok: false,
      detail: `status=${zone.status}; update registrar NS then retry`,
    });
    return {
      ok: false,
      domain,
      zone_id: zone.id,
      zone_status: zone.status,
      nameservers,
      worker,
      steps,
      error: "pending_ns",
      pending_ns: true,
      zone_created: ensured.created,
    };
  }

  steps.push({ step: "zone_active", ok: true, detail: "active" });

  // 2) 读取当前 Email Routing 状态
  const { data: statusData } = await cfFetch<{
    enabled: boolean;
    status?: string;
    name: string;
  }>(`/zones/${zone.id}/email/routing`, creds.apiToken);

  if (!statusData.success) {
    steps.push({ step: "get_routing", ok: false, detail: cfError(statusData, "failed to get email routing") });
    return {
      ok: false,
      domain,
      zone_id: zone.id,
      zone_status: zone.status,
      nameservers,
      worker,
      steps,
      error: "get_routing_failed",
    };
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
        return {
          ok: false,
          domain,
          zone_id: zone.id,
          zone_status: zone.status,
          nameservers,
          worker,
          steps,
          error: "enable_routing_failed",
        };
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
    return {
      ok: false,
      domain,
      zone_id: zone.id,
      zone_status: zone.status,
      nameservers,
      worker,
      steps,
      error: "get_catch_all_failed",
    };
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
      return {
        ok: false,
        domain,
        zone_id: zone.id,
        zone_status: zone.status,
        nameservers,
        worker,
        steps,
        error: "set_catch_all_failed",
      };
    }
    steps.push({ step: "set_catch_all", ok: true, detail: `catch-all → worker ${worker}` });
  }

  return {
    ok: true,
    domain,
    zone_id: zone.id,
    zone_status: zone.status,
    nameservers,
    worker,
    steps,
    zone_created: ensured.created,
  };
}
