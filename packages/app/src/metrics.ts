/**
 * In-process Prometheus counters and the text exposition format (no external dependency).
 * Gauges that must survive restarts (jobs by state, spend) are read from the database at scrape time.
 */
import type { MetricEvent, Metrics } from "@merge-safely/core";

type Labels = Record<string, string>;

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}="${escapeLabel(labels[k] ?? "")}"`).join(",")}}`;
}

interface Family {
  help: string;
  type: "counter" | "gauge";
  values: Map<string, number>;
}

export class MetricsRegistry {
  private readonly families = new Map<string, Family>();

  private family(name: string, type: Family["type"], help: string): Family {
    let f = this.families.get(name);
    if (!f) {
      f = { help, type, values: new Map() };
      this.families.set(name, f);
    }
    return f;
  }

  inc(name: string, help: string, labels: Labels = {}, by = 1): void {
    const f = this.family(name, "counter", help);
    const k = labelKey(labels);
    f.values.set(k, (f.values.get(k) ?? 0) + by);
  }

  set(name: string, help: string, labels: Labels, value: number): void {
    this.family(name, "gauge", help).values.set(labelKey(labels), value);
  }

  /** Drop a gauge family's values (before re-filling it at scrape time). */
  clear(name: string): void {
    this.families.get(name)?.values.clear();
  }

  get(name: string, labels: Labels = {}): number | undefined {
    return this.families.get(name)?.values.get(labelKey(labels));
  }

  render(): string {
    const out: string[] = [];
    for (const [name, f] of [...this.families.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      out.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} ${f.type}`);
      for (const [k, v] of f.values) out.push(`${name}${k} ${Number.isFinite(v) ? v : 0}`);
    }
    return `${out.join("\n")}\n`;
  }
}

/** The core's Metrics port: event names only (tags can be high-cardinality: repo, sha, seat). */
export function gateMetrics(reg: MetricsRegistry): Metrics {
  return {
    emit(m: MetricEvent): void {
      const name = m.name.replace(/[^a-zA-Z0-9_]/g, "_");
      reg.inc("merge_safely_gate_events_total", "Metric events emitted by the gate, summed by name", { name }, m.value);
    },
  };
}
