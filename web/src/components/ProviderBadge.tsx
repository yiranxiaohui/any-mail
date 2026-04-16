import { Badge } from "@/components/ui/badge";

const config: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; className: string }> = {
  gmail: { label: "Gmail", variant: "secondary", className: "bg-red-50 text-red-700 border-red-200 hover:bg-red-100" },
  outlook: { label: "Outlook", variant: "secondary", className: "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100" },
  domain: { label: "Domain", variant: "secondary", className: "bg-violet-50 text-violet-700 border-violet-200 hover:bg-violet-100" },
};

export default function ProviderBadge({ provider }: { provider: string }) {
  const c = config[provider] ?? config.domain!;
  return (
    <Badge variant={c.variant} className={c.className}>
      {c.label}
    </Badge>
  );
}
