import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getAccountTags, createTagGroup, deleteTagGroup, renameTagGroup } from "@/lib/api";

type GroupStat = { tag: string; count: number };

export default function Groups() {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<GroupStat[]>([]);
  const [untaggedCount, setUntaggedCount] = useState(0);
  const [loading, setLoading] = useState(true);

  // create
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  // rename
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);

  const fetchGroups = async () => {
    setLoading(true);
    try {
      const data = await getAccountTags();
      const list: GroupStat[] = [];
      let untagged = 0;
      for (const r of data.tags) {
        if (r.tag === null) untagged = r.count;
        else list.push({ tag: r.tag, count: r.count });
      }
      list.sort((a, b) => a.tag.localeCompare(b.tag));
      setGroups(list);
      setUntaggedCount(untagged);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGroups();
  }, []);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await createTagGroup(name);
      toast.success(t("groups.created", { name }));
      setCreateOpen(false);
      setNewName("");
      await fetchGroups();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("groups.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const openRename = (name: string) => {
    setRenameTarget(name);
    setRenameValue(name);
  };

  const handleRename = async () => {
    if (!renameTarget) return;
    const next = renameValue.trim();
    if (!next || next === renameTarget) {
      setRenameTarget(null);
      return;
    }
    setRenaming(true);
    try {
      const res = await renameTagGroup(renameTarget, next);
      toast.success(
        res.merged
          ? t("groups.merged", { from: renameTarget, to: next })
          : t("groups.renamed", { from: renameTarget, to: next })
      );
      setRenameTarget(null);
      await fetchGroups();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("groups.renameFailed"));
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async (name: string, count: number) => {
    const message =
      count > 0
        ? t("groups.deleteConfirmWithAccounts", { name, count })
        : t("groups.deleteConfirm", { name });
    if (!confirm(message)) return;
    try {
      await deleteTagGroup(name);
      toast.success(t("groups.deleted", { name }));
      await fetchGroups();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("groups.deleteFailed"));
    }
  };

  const totalTagged = groups.reduce((sum, g) => sum + g.count, 0);

  return (
    <div className="flex flex-col h-[calc(100dvh-80px)] sm:h-[calc(100dvh-96px)] md:h-[calc(100vh-48px)] gap-6">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("groups.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("groups.description")}</p>
        </div>
        <Button onClick={() => { setNewName(""); setCreateOpen(true); }}>
          <svg className="mr-1.5 h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" x2="12" y1="5" y2="19" />
            <line x1="5" x2="19" y1="12" y2="12" />
          </svg>
          {t("groups.new")}
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-3 shrink-0">
        <StatCard label={t("groups.stats.groups")} value={groups.length} />
        <StatCard label={t("groups.stats.tagged")} value={totalTagged} />
        <StatCard label={t("groups.stats.untagged")} value={untaggedCount} />
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { if (!open) setCreateOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("groups.newTitle")}</DialogTitle>
            <DialogDescription>{t("groups.newDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <Input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
              placeholder={t("groups.namePlaceholder")}
            />
            <Button className="w-full" onClick={handleCreate} disabled={creating || !newName.trim()}>
              {creating ? t("groups.creating") : t("groups.create")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => { if (!open) setRenameTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("groups.renameTitle")}</DialogTitle>
            <DialogDescription>
              {t("groups.renameDesc", { name: renameTarget ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <Input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleRename(); }}
              placeholder={t("groups.namePlaceholder")}
            />
            {renameValue.trim() && renameValue.trim() !== renameTarget && groups.some(g => g.tag === renameValue.trim()) && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {t("groups.mergeWarn", { name: renameValue.trim() })}
              </p>
            )}
            <Button
              className="w-full"
              onClick={handleRename}
              disabled={renaming || !renameValue.trim() || renameValue.trim() === renameTarget}
            >
              {renaming ? t("groups.saving") : t("groups.save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Card className="flex flex-col min-h-0 flex-1">
        <CardHeader className="shrink-0">
          <CardTitle className="text-base">{t("groups.listTitle")}</CardTitle>
          <CardDescription>{t("groups.listDesc", { count: groups.length })}</CardDescription>
        </CardHeader>
        <Separator />
        {loading ? (
          <CardContent className="flex items-center justify-center py-12 text-muted-foreground">
            <svg className="mr-2 h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            {t("inbox.loading")}
          </CardContent>
        ) : (
          <div className="divide-y overflow-y-auto flex-1 min-h-0">
            <GroupRow
              name={t("groups.untagged")}
              count={untaggedCount}
              viewHref="/console/accounts?tag=__untagged__"
              special
              viewLabel={t("groups.view")}
            />
            {groups.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <svg className="mb-3 h-10 w-10 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7h16M4 12h16M4 17h10" />
                </svg>
                <p className="text-sm font-medium">{t("groups.empty")}</p>
                <p className="text-xs mt-1">{t("groups.emptyHint")}</p>
              </div>
            ) : (
              groups.map((g) => (
                <GroupRow
                  key={g.tag}
                  name={g.tag}
                  count={g.count}
                  viewHref={`/console/accounts?tag=${encodeURIComponent(g.tag)}`}
                  viewLabel={t("groups.view")}
                  onRename={() => openRename(g.tag)}
                  onDelete={() => handleDelete(g.tag, g.count)}
                  renameLabel={t("groups.rename")}
                  deleteLabel={t("groups.delete")}
                />
              ))
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold tracking-tight mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}

function GroupRow({
  name,
  count,
  viewHref,
  viewLabel,
  onRename,
  onDelete,
  renameLabel,
  deleteLabel,
  special,
}: {
  name: string;
  count: number;
  viewHref: string;
  viewLabel: string;
  onRename?: () => void;
  onDelete?: () => void;
  renameLabel?: string;
  deleteLabel?: string;
  special?: boolean;
}) {
  return (
    <div className="flex items-center justify-between px-6 py-4 gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <div className={`size-8 rounded-md flex items-center justify-center shrink-0 ${special ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary"}`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{name}</div>
          <div className="text-xs text-muted-foreground">{count}</div>
        </div>
      </div>
      <div className="flex gap-1 shrink-0">
        <Link
          to={viewHref}
          className="inline-flex items-center justify-center rounded-md px-2.5 h-7 text-[0.8rem] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          {viewLabel}
        </Link>
        {onRename && renameLabel && (
          <Button variant="ghost" size="sm" onClick={onRename}>
            {renameLabel}
          </Button>
        )}
        {onDelete && deleteLabel && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={onDelete}
          >
            {deleteLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
