export function Sidebar({ collapsed }: { collapsed: boolean }) {
  return <aside className={collapsed ? "sidebar sidebar--collapsed" : "sidebar"} aria-label="Main navigation" />;
}
