export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol>
        {items.map((c) => (
          <li key={c.label}>{c.href ? <a href={c.href}>{c.label}</a> : c.label}</li>
        ))}
      </ol>
    </nav>
  );
}
