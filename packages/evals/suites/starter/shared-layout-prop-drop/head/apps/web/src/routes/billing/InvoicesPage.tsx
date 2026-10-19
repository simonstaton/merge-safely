import { AppShell } from "../../layouts/AppShell";

export function InvoicesPage() {
  return (
    <AppShell
      title="Invoices"
      sidebarCollapsed
      breadcrumbs={[{ label: "Billing", href: "/billing" }, { label: "Invoices" }]}
      actions={<a href="/billing/invoices/export.csv">Export CSV</a>}
    >
      <table>{/* rows */}</table>
    </AppShell>
  );
}
