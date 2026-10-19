import { AppShell } from "../../layouts/AppShell";

export function DashboardPage() {
  return (
    <AppShell title="Dashboard" actions={<a href="/posts/new">New post</a>}>
      <section>{/* widgets */}</section>
    </AppShell>
  );
}
