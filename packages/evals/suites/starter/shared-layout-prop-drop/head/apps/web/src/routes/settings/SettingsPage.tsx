import { AppShell } from "../../layouts/AppShell";

export function SettingsPage() {
  return (
    <AppShell
      title="Settings"
      breadcrumbs={[{ label: "Home", href: "/" }, { label: "Settings" }]}
      actions={<button type="submit" form="settings-form">Save changes</button>}
    >
      <form id="settings-form">{/* fields */}</form>
    </AppShell>
  );
}
