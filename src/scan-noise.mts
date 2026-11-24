import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mts";
import { isInBusinessScope, splitLines, walkScopedFiles } from "./git-diff.mts";
import type {
  DuplicateHelperFinding,
  FunctionCloneGroup,
  NoiseReport,
  OrphanModuleFinding,
  OversizedFileFinding,
} from "./types.mts";

export interface ScanNoiseOptions {
  cwd: string;
  configPath?: string;
}

const HELPER_NAME_RE =
  /^(?:export\s+)?(?:async\s+)?function\s+(format[A-Z0-9][A-Za-z0-9_]*|parse[A-Z0-9][A-Za-z0-9_]*|readableError)\s*\(|^(?:export\s+)?const\s+(format[A-Z0-9][A-Za-z0-9_]*|parse[A-Z0-9][A-Za-z0-9_]*|readableError)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z0-9_]+\s*=>)/;

const FUNCTION_SIG_RE =
  /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)[^{]*\{|^(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=>\s*\{/;

const IMPORT_RE =
  /(?:import|export)\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function listFilesWithRipgrep(rootDir: string): string[] | null {
  const res = spawnSync("rg", ["--files", "--hidden", "--glob", "!.git/**"], {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0 || res.error) {
    return null;
  }
  return splitLines(res.stdout)
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter(Boolean);
}

function normalizeBodyForHash(bodyLines: string[]): string {
  const cleaned = bodyLines
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

function extractFunctionBlocks(
  lines: string[],
): Array<{ name: string; line: number; bodyLines: string[] }> {
  const results: Array<{ name: string; line: number; bodyLines: string[] }> = [];

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();
    const m = FUNCTION_SIG_RE.exec(trimmed);
    if (!m) {
      continue;
    }
    const fnName = m[1] ?? m[2] ?? "anonymous";
    let depth = 0;
    let started = false;
    const collected: string[] = [];

    for (let j = i; j < lines.length; j += 1) {
      const curr = lines[j] ?? "";
      for (const ch of curr) {
        if (ch === "{") {
          depth += 1;
          started = true;
        } else if (ch === "}") {
          depth -= 1;
        }
      }
      if (j > i) {
        collected.push(curr);
      }
      if (started && depth <= 0) {
        if (collected.filter((l) => l.trim().length > 0).length >= 4) {
          results.push({ name: fnName, line: i + 1, bodyLines: collected });
        }
        i = j;
        break;
      }
    }
  }

  return results;
}

function resolveImportCandidates(fromRel: string, specifier: string): string[] {
  if (!specifier.startsWith(".")) {
    return [];
  }
  const dir = path.posix.dirname(fromRel);
  const rawJoined = path.posix.normalize(path.posix.join(dir, specifier));
  const stripped = rawJoined.replace(/\.(js|jsx|ts|tsx|mjs|mts)$/, "");
  return [
    rawJoined,
    `${stripped}.ts`,
    `${stripped}.mts`,
    `${stripped}.tsx`,
    `${stripped}.js`,
    `${stripped}.jsx`,
    `${stripped}/index.ts`,
    `${stripped}/index.mts`,
    `${stripped}/index.tsx`,
    `${stripped}/index.js`,
  ];
}

export function scanCodeNoise(options: ScanNoiseOptions): NoiseReport {
  const resolvedCwd = path.resolve(options.cwd);
  if (!existsSync(resolvedCwd)) {
    throw new Error(`Target directory does not exist: ${resolvedCwd}`);
  }
  const config = loadConfig(resolvedCwd, options.configPath);

  const rgFiles = listFilesWithRipgrep(resolvedCwd);
  const scanner: "ripgrep" | "fs" = rgFiles ? "ripgrep" : "fs";
  const allScoped = (
    rgFiles ? rgFiles.filter((f) => isInBusinessScope(f, config)).sort() : walkScopedFiles(resolvedCwd, config)
  ).filter((f) => {
    const ext = path.posix.extname(f).toLowerCase();
    return ext === ".ts" || ext === ".mts" || ext === ".tsx" || ext === ".js" || ext === ".jsx";
  });

  const helperLocations = new Map<string, Array<{ file: string; line: number }>>();
  const cloneBuckets = new Map<
    string,
    { lineCount: number; occurrences: Array<{ file: string; name: string; line: number }> }
  >();
  const oversizedFiles: OversizedFileFinding[] = [];
  const inboundReferences = new Set<string>();
  const codeSet = new Set(allScoped);

  for (const relPath of allScoped) {
    const text = readFileSync(path.join(resolvedCwd, relPath), "utf8");
    const lines = splitLines(text);

    if (lines.length > config.maxFileLines) {
      oversizedFiles.push({
        file: relPath,
        lines: lines.length,
        limit: config.maxFileLines,
      });
    }

    for (let idx = 0; idx < lines.length; idx += 1) {
      const m = HELPER_NAME_RE.exec((lines[idx] ?? "").trim());
      if (m) {
        const sym = m[1] ?? m[2] ?? "";
        if (sym) {
          const list = helperLocations.get(sym) ?? [];
          list.push({ file: relPath, line: idx + 1 });
          helperLocations.set(sym, list);
        }
      }
    }

    for (const block of extractFunctionBlocks(lines)) {
      const normalized = normalizeBodyForHash(block.bodyLines);
      if (normalized.length < 48) {
        continue;
      }
      const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
      const bucket = cloneBuckets.get(hash) ?? {
        lineCount: block.bodyLines.length,
        occurrences: [],
      };
      bucket.occurrences.push({ file: relPath, name: block.name, line: block.line });
      cloneBuckets.set(hash, bucket);
    }

    IMPORT_RE.lastIndex = 0;
    let imp: RegExpExecArray | null = IMPORT_RE.exec(text);
    while (imp !== null) {
      const spec = imp[1] ?? imp[2] ?? "";
      for (const candidate of resolveImportCandidates(relPath, spec)) {
        if (codeSet.has(candidate)) {
          inboundReferences.add(candidate);
        }
      }
      imp = IMPORT_RE.exec(text);
    }
  }

  const duplicateHelpers: DuplicateHelperFinding[] = [];
  for (const [symbol, locations] of helperLocations.entries()) {
    const distinctFiles = new Set(locations.map((l) => l.file));
    if (distinctFiles.size > 1) {
      duplicateHelpers.push({ symbol, locations });
    }
  }
  duplicateHelpers.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const cloneGroups: FunctionCloneGroup[] = [];
  for (const [hash, bucket] of cloneBuckets.entries()) {
    if (bucket.occurrences.length > 1) {
      cloneGroups.push({
        hash,
        lineCount: bucket.lineCount,
        occurrences: bucket.occurrences,
      });
    }
  }
  cloneGroups.sort((a, b) => b.occurrences.length - a.occurrences.length);

  const orphanModules: OrphanModuleFinding[] = [];
  for (const relPath of allScoped) {
    const base = path.posix.basename(relPath).toLowerCase();
    const isEntrypoint =
      base.startsWith("index.") ||
      base === "cli.mts" ||
      base === "cli.ts" ||
      base === "page.tsx" ||
      base === "layout.tsx" ||
      base === "route.ts" ||
      base === "main.ts" ||
      base === "main.mts" ||
      relPath.startsWith("examples/");
    if (!isEntrypoint && !inboundReferences.has(relPath)) {
      const lines = splitLines(readFileSync(path.join(resolvedCwd, relPath), "utf8")).length;
      orphanModules.push({ file: relPath, lines });
    }
  }

  const ok =
    duplicateHelpers.length === 0 &&
    cloneGroups.length === 0 &&
    oversizedFiles.length === 0 &&
    orphanModules.length === 0;

  return {
    ok,
    cwd: resolvedCwd,
    scanner,
    totalFilesScanned: allScoped.length,
    duplicateHelpers,
    cloneGroups,
    oversizedFiles,
    orphanModules,
  };
}
