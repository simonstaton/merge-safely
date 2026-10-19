import type { ReactNode } from "react";
import { Breadcrumbs, type Crumb } from "../../components/Breadcrumbs";
import { Sidebar } from "../../components/Sidebar";

export interface AppShellProps {
  title: string;
  breadcrumbs?: Crumb[];
  /** Page-level buttons rendered in the header, right aligned. */
  actions?: ReactNode;
  sidebarCollapsed?: boolean;
  children: ReactNode;
}

export function AppShell({ title, breadcrumbs, actions, sidebarCollapsed = false, children }: AppShellProps) {
  return (
    <div className="app-shell">
      <Sidebar collapsed={sidebarCollapsed} />
      <div className="app-shell__main">
        <header className="app-shell__header">
          {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
          <h1>{title}</h1>
          {actions && <div className="app-shell__actions">{actions}</div>}
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
