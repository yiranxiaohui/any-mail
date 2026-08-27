import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Toaster } from "@/components/ui/sonner";
import {
  Folder,
  Globe2,
  Inbox as InboxIcon,
  KeyRound,
  Languages,
  LogOut,
  Mail,
  Menu,
  Send,
  Settings2,
  Users,
} from "lucide-react";

export default function Layout() {
  const { t, i18n } = useTranslation();
  const { logout, user } = useAuth();
  const navigate = useNavigate();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  const toggleLang = () => {
    const next = i18n.language === "zh" ? "en" : "zh";
    i18n.changeLanguage(next);
    localStorage.setItem("anymail_lang", next);
  };

  // Close the mobile drawer (called on nav and backdrop tap).
  const closeDrawer = () => setDrawerOpen(false);

  const sidebar = (
    <>
      <div className="px-5 pb-5 pt-6">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Mail className="size-5" strokeWidth={2.2} />
          </div>
          <div className="min-w-0">
            <span className="block truncate text-[15px] font-bold tracking-tight">AnyMail</span>
            <span className="block text-xs text-muted-foreground">{t("nav.workspace")}</span>
          </div>
        </div>
      </div>
      <Separator />
      <div className="flex flex-1 flex-col gap-1 p-3">
        <SidebarLink to="/console" end onNavigate={closeDrawer}>
          <InboxIcon />
          {t("nav.inbox")}
        </SidebarLink>
        <SidebarLink to="/console/compose" onNavigate={closeDrawer}>
          <Send />
          {t("nav.compose")}
        </SidebarLink>
        <SidebarLink to="/console/accounts" onNavigate={closeDrawer}>
          <Users />
          {t("nav.accounts")}
        </SidebarLink>
        <SidebarLink to="/console/groups" onNavigate={closeDrawer}>
          <Folder />
          {t("nav.groups")}
        </SidebarLink>
        <SidebarLink to="/console/domains" onNavigate={closeDrawer}>
          <Globe2 />
          {t("nav.domains")}
        </SidebarLink>
        <SidebarLink to="/console/api-keys" onNavigate={closeDrawer}>
          <KeyRound />
          {t("nav.apiKeys")}
        </SidebarLink>
        <SidebarLink to="/console/settings" onNavigate={closeDrawer}>
          <Settings2 />
          {t("nav.settings")}
        </SidebarLink>
      </div>
      <Separator />
      <div className="space-y-2 p-3">
        {user?.email && (
          <div className="flex min-w-0 items-center gap-2.5 rounded-lg bg-muted/70 px-2.5 py-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
              {user.email.slice(0, 1).toUpperCase()}
            </div>
            <span className="truncate text-xs font-medium text-foreground/80">{user.email}</span>
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2.5 text-muted-foreground hover:text-foreground"
          onClick={toggleLang}
        >
          <Languages className="size-4" />
          {i18n.language === "zh" ? "English" : "中文"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2.5 text-muted-foreground hover:text-foreground"
          onClick={handleLogout}
        >
          <LogOut className="size-4" />
          {t("nav.logout")}
        </Button>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <nav className="hidden w-64 shrink-0 flex-col border-r bg-sidebar md:flex">
        {sidebar}
      </nav>

      {/* Mobile drawer + backdrop */}
      {drawerOpen && (
        <button
          aria-label="Close menu"
          className="fixed inset-0 z-40 bg-foreground/25 backdrop-blur-[2px] md:hidden"
          onClick={closeDrawer}
        />
      )}
      <nav
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col border-r bg-sidebar shadow-xl transition-transform duration-200 ease-out md:hidden",
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {sidebar}
      </nav>

      <div className="flex flex-1 flex-col min-w-0">
        {/* Mobile top bar */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card px-3 md:hidden">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open menu"
            onClick={() => setDrawerOpen(true)}
          >
            <Menu className="size-5" />
          </Button>
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Mail className="size-3.5" />
            </div>
            <span className="text-base font-bold tracking-tight">AnyMail</span>
          </div>
        </header>

        <main className="app-scrollbar min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  );
}

function SidebarLink({
  to,
  end,
  children,
  onNavigate,
}: {
  to: string;
  end?: boolean;
  children: React.ReactNode;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all",
          isActive
            ? "bg-primary text-primary-foreground shadow-sm"
            : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )
      }
    >
      {children}
    </NavLink>
  );
}
