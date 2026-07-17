/** Cloudflare Email Routing 标准 MX 主机 */
export const CF_EMAIL_MX = [
  { exchange: "route1.mx.cloudflare.net", priority: 13 },
  { exchange: "route2.mx.cloudflare.net", priority: 36 },
  { exchange: "route3.mx.cloudflare.net", priority: 66 },
] as const;

export interface MxRecord {
  exchange: string;
  priority: number;
}

export interface MxCheckResult {
  domain: string;
  ok: boolean;
  records: MxRecord[];
  matched: string[];
  missing: string[];
  extra: string[];
  message: string;
}

function normalizeDomain(input: string): string | null {
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (d.startsWith("*.")) d = d.slice(2);
  if (!d || d.includes(" ") || !d.includes(".")) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(d)) {
    return null;
  }
  return d;
}

function isCfEmailMx(exchange: string): boolean {
  const host = exchange.replace(/\.$/, "").toLowerCase();
  return host.endsWith(".mx.cloudflare.net") || host === "mx.cloudflare.net";
}

/** 通过 Google DNS-over-HTTPS 查询 MX 记录 */
export async function lookupMx(domain: string): Promise<MxRecord[]> {
  const url = `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`;
  const res = await fetch(url, {
    headers: { Accept: "application/dns-json" },
  });
  if (!res.ok) {
    throw new Error(`DNS lookup failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    Status: number;
    Answer?: { type: number; data: string }[];
  };

  // Status 0 = NOERROR；3 = NXDOMAIN（无记录时也可能无 Answer）
  if (data.Status !== 0 && data.Status !== 3) {
    throw new Error(`DNS query status ${data.Status}`);
  }

  const records: MxRecord[] = [];
  for (const ans of data.Answer ?? []) {
    if (ans.type !== 15) continue;
    // data 格式: "10 mail.example.com."
    const m = ans.data.trim().match(/^(\d+)\s+(\S+)$/);
    if (!m) continue;
    records.push({
      priority: parseInt(m[1]!, 10),
      exchange: m[2]!.replace(/\.$/, "").toLowerCase(),
    });
  }
  records.sort((a, b) => a.priority - b.priority);
  return records;
}

export async function checkDomainMx(rawDomain: string): Promise<MxCheckResult> {
  const domain = normalizeDomain(rawDomain);
  if (!domain) {
    return {
      domain: rawDomain.trim(),
      ok: false,
      records: [],
      matched: [],
      missing: CF_EMAIL_MX.map((r) => r.exchange),
      extra: [],
      message: "invalid domain",
    };
  }

  const records = await lookupMx(domain);
  const exchanges = records.map((r) => r.exchange);
  const matched = exchanges.filter(isCfEmailMx);
  const expected = CF_EMAIL_MX.map((r) => r.exchange);
  const missing = expected.filter((ex) => !exchanges.includes(ex));
  const extra = exchanges.filter((ex) => !isCfEmailMx(ex));

  // 至少命中一条 Cloudflare Email Routing MX 即视为生效
  const ok = matched.length > 0;

  let message: string;
  if (ok && missing.length === 0 && extra.length === 0) {
    message = "mx_ok";
  } else if (ok && extra.length > 0) {
    message = "mx_ok_with_extra";
  } else if (ok) {
    message = "mx_partial";
  } else if (records.length === 0) {
    message = "mx_empty";
  } else {
    message = "mx_not_cloudflare";
  }

  return { domain, ok, records, matched, missing, extra, message };
}

export function getMxGuide() {
  return {
    description:
      "Host the domain on this Cloudflare account (full NS), enable Email Routing, and point catch-all to the any-mail Worker.",
    steps: [
      "Import & enable: creates the zone on this account if missing.",
      "At the registrar, set nameservers to the Cloudflare NS returned by the API.",
      "When the zone status is active, retry Import & enable (or auto-enable).",
      "AnyMail enables Email Routing and sets catch-all → Worker any-mail.",
      "Create mailboxes; use Check MX to verify public DNS if needed.",
    ],
    required_mx: CF_EMAIL_MX.map((r) => ({
      type: "MX" as const,
      name: "@",
      exchange: r.exchange,
      priority: r.priority,
      ttl: "Auto / 3600",
    })),
    recommended_spf: {
      type: "TXT" as const,
      name: "@",
      value: "v=spf1 include:_spf.mx.cloudflare.net ~all",
    },
    notes: [
      "Full Email Routing requires Cloudflare nameservers on the account that owns the Worker (no cross-account Worker target).",
      "NS/MX propagation can take a few minutes to 48 hours depending on TTL.",
      "After enable, create mailboxes via Accounts or POST /api/accounts.",
    ],
  };
}

export { normalizeDomain };
