import type { ReactNode } from "react";
import { Sidebar } from "../../components/Sidebar";
import { TopNav } from "../../components/TopNav";

// Redesign: navigation moves to a top bar; the header is now just the page title.
export type AppShellProps = {
  title: string;
  children: ReactNode;
} & Record<string, unknown>;

export function AppShell({ title, children }: AppShellProps) {
  return (
    <div className="app-shell app-shell--v2">
      <TopNav />
      <Sidebar collapsed={false} />
      <div className="app-shell__main">
        <header className="app-shell__header">
          <h1 className="app-shell__title">{title}</h1>
        </header>
        <main className="app-shell__content">{children}</main>
      </div>
    </div>
  );
}
