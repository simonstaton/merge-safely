import type { ChangedFile, FileStatus } from "@merge-safely/core";

export interface FileContents {
  path: string;
  /** Contents before the change; omit for an added file. */
  before?: string;
  /** Contents after the change; omit for a removed file. */
  after?: string;
  /** Old path for a rename. */
  previousPath?: string;
}

export interface DiffResult {
  /** The whole change as a unified diff (`git diff` format, applies with `git apply`). */
  diff: string;
  /** One ChangedFile per input, with counts and `patch` (hunks only, as GitHub returns it). */
  files: ChangedFile[];
}

const CONTEXT = 3;

/** Lines with their terminator, so a missing final newline is a real difference. */
function tokens(s: string | undefined): string[] {
  if (!s) return [];
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

type Op = { t: " " | "-" | "+"; line: string; a: number; b: number };

/** Line diff by longest common subsequence. Fixtures are small; O(n*m) is fine. */
function editScript(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as number[];
    const next = dp[i + 1] as number[];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] as string, a: i++, b: j++ });
    } else if (i < n && (j >= m || (dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0))) {
      // Deletions before additions, as git prints them.
      ops.push({ t: "-", line: a[i] as string, a: i++, b: j });
    } else {
      ops.push({ t: "+", line: b[j] as string, a: i, b: j++ });
    }
  }
  return ops;
}

function range(start: number, len: number): string {
  // A zero-length range names the line before it (0 for an empty file), as git does.
  return `${len === 0 ? start : start + 1},${len}`;
}

function renderLine(op: Op): string {
  const text = op.line.endsWith("\n") ? op.line.slice(0, -1) : op.line;
  const out = `${op.t}${text}\n`;
  return op.line.endsWith("\n") ? out : `${out}\\ No newline at end of file\n`;
}

/** Hunk text (each starting with "@@") for one file. Empty when the contents are identical. */
export function hunksFor(before: string | undefined, after: string | undefined): string {
  const ops = editScript(tokens(before), tokens(after));
  const changed = ops.map((o, k) => (o.t === " " ? -1 : k)).filter((k) => k >= 0);
  if (changed.length === 0) return "";
  // Group changes whose context windows touch.
  const groups: Array<[number, number]> = [];
  for (const k of changed) {
    const last = groups[groups.length - 1];
    if (last && k - last[1] <= CONTEXT * 2 + 1) last[1] = k;
    else groups.push([k, k]);
  }
  let out = "";
  for (const [first, lastChange] of groups) {
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(ops.length - 1, lastChange + CONTEXT);
    const slice = ops.slice(from, to + 1);
    const head = slice[0] as Op;
    const oldLen = slice.filter((o) => o.t !== "+").length;
    const newLen = slice.filter((o) => o.t !== "-").length;
    out += `@@ -${range(head.a, oldLen)} +${range(head.b, newLen)} @@\n`;
    for (const o of slice) out += renderLine(o);
  }
  return out;
}

function statusOf(f: FileContents): FileStatus {
  if (f.before === undefined && f.after !== undefined) return "added";
  if (f.after === undefined && f.before !== undefined) return "removed";
  if (f.previousPath && f.previousPath !== f.path) return "renamed";
  return "modified";
}

/** Build a valid unified diff and the matching ChangedFile list from before/after contents. */
export function diffFromFiles(files: FileContents[]): DiffResult {
  let diff = "";
  const changed: ChangedFile[] = [];
  for (const f of files) {
    if (f.before === undefined && f.after === undefined) throw new Error(`${f.path}: give before, after or both`);
    const status = statusOf(f);
    const oldPath = f.previousPath ?? f.path;
    const patch = hunksFor(f.before, f.after);
    if (!patch && status === "modified") continue; // identical: git would print nothing
    let header = `diff --git a/${oldPath} b/${f.path}\n`;
    if (status === "added") header += "new file mode 100644\n";
    if (status === "removed") header += "deleted file mode 100644\n";
    if (status === "renamed") {
      header += `similarity index ${patch ? 90 : 100}%\nrename from ${oldPath}\nrename to ${f.path}\n`;
    }
    if (patch) {
      header += `--- ${status === "added" ? "/dev/null" : `a/${oldPath}`}\n`;
      header += `+++ ${status === "removed" ? "/dev/null" : `b/${f.path}`}\n`;
    }
    diff += header + patch;
    const lines = patch.split("\n");
    changed.push({
      path: f.path,
      ...(status === "renamed" ? { previousPath: oldPath } : {}),
      status,
      additions: lines.filter((l) => l.startsWith("+")).length,
      deletions: lines.filter((l) => l.startsWith("-")).length,
      ...(patch ? { patch } : {}),
    });
  }
  return { diff, files: changed };
}

export interface ParsedHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface ParsedFileDiff {
  oldPath: string | null;
  newPath: string | null;
  hunks: ParsedHunk[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Minimal strict unified-diff parser for assertions. Throws when a hunk's line counts do not match its header,
 * which is the usual way a hand-written fixture diff is broken.
 */
export function parseUnifiedDiff(diff: string): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = [];
  const lines = diff.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let file: ParsedFileDiff | undefined;
  let hunk: (ParsedHunk & { seenOld: number; seenNew: number }) | undefined;
  const close = () => {
    if (hunk && (hunk.seenOld !== hunk.oldLines || hunk.seenNew !== hunk.newLines)) {
      throw new Error(
        `hunk -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} has ${hunk.seenOld} old / ${hunk.seenNew} new lines`,
      );
    }
    hunk = undefined;
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      close();
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = { oldPath: m?.[1] ?? null, newPath: m?.[2] ?? null, hunks: [] };
      files.push(file);
      continue;
    }
    if (!file) throw new Error(`diff text before the first "diff --git" header: ${line}`);
    const h = HUNK.exec(line);
    if (h) {
      close();
      hunk = {
        oldStart: Number(h[1]),
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === undefined ? 1 : Number(h[4]),
        lines: [],
        seenOld: 0,
        seenNew: 0,
      };
      file.hunks.push(hunk);
      continue;
    }
    if (hunk && (hunk.seenOld < hunk.oldLines || hunk.seenNew < hunk.newLines || line.startsWith("\\"))) {
      const c = line[0];
      if (c === " " || c === "-") hunk.seenOld++;
      if (c === " " || c === "+") hunk.seenNew++;
      if (c !== " " && c !== "-" && c !== "+" && c !== "\\") throw new Error(`bad hunk line: ${line}`);
      hunk.lines.push(line);
      continue;
    }
    close();
    if (line.startsWith("--- ")) file.oldPath = line === "--- /dev/null" ? null : line.replace(/^--- a\//, "");
    else if (line.startsWith("+++ ")) file.newPath = line === "+++ /dev/null" ? null : line.replace(/^\+\+\+ b\//, "");
  }
  close();
  // ParsedHunk only: drop the counters.
  return files.map((f) => ({
    ...f,
    hunks: f.hunks.map(({ oldStart, oldLines, newStart, newLines, lines: l }) => ({
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: l,
    })),
  }));
}
