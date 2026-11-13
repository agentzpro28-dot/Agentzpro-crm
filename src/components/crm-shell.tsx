"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, CalendarCheck, ClipboardList, Link2 } from "lucide-react";
import { useLayoutEffect } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { CompanySwitcher } from "@/components/company-switcher";
import { FacebookReconnectBanner } from "@/components/facebook-reconnect-banner";
import { TaskAlertsProvider } from "@/components/task-bell";
import { SidebarCollapseButton, SidebarExpandButton } from "@/components/sidebar-toggle";
import { UserMenu } from "@/components/user-menu";
import { clearConnectionChecks } from "@/services/crm-api-client";

const navigation = [
  { href: "/leads", label: "Leads", icon: ClipboardList },
  { href: "/tasks", label: "Tasks", icon: CalendarCheck },
  { href: "/dashboard", label: "Dashboard", icon: BarChart3 },
  { href: "/connection", label: "Integrations", icon: Link2 },
] as const;

export interface CrmShellProps {
  children: React.ReactNode;
  fullName: string;
  tenantName: string;
}

export function CrmShell({ children, fullName, tenantName }: Readonly<CrmShellProps>) {
  const pathname = usePathname();
  // The shared connection checks belong to the session this shell shows: start empty and forget them when the shell
  // goes, since login, logout and idle logout all navigate in-page. A layout effect, so it runs before any check starts.
  useLayoutEffect(() => {
    clearConnectionChecks();
    return clearConnectionChecks;
  }, []);

  return (
    <TaskAlertsProvider>
    <div className="mvp-shell">
      <SidebarExpandButton />
      <aside className="mvp-sidebar" id="primary-sidebar" aria-label="Primary navigation">
        <SidebarCollapseButton />
        <Link className="mvp-sidebar__brand" href="/leads" aria-label="Go to Leads">
          <BrandLogo />
        </Link>
        <CompanySwitcher tenantName={tenantName} />
        <nav className="mvp-sidebar__nav">
          {navigation.map(({ href, label, icon: Icon }) => (
            <Link
              className={pathname === href ? "mvp-nav-link mvp-nav-link--active" : "mvp-nav-link"}
              href={href}
              key={href}
              title={label}
            >
              <Icon size={19} aria-hidden="true" />
              <span className="mvp-nav-link__label">{label}</span>
            </Link>
          ))}
        </nav>
        <UserMenu fullName={fullName} tenantName={tenantName} />
      </aside>
      <main className="mvp-main">
        <FacebookReconnectBanner />
        {children}
      </main>
    </div>
    </TaskAlertsProvider>
  );
}
