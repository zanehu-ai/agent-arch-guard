import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { GuardConfig } from "./types.mts";

const DIFF_GIT_RE = /^diff --git a\/(.*) b\/(.*)$/;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const TEST_FILE_RE = /\.(test|spec|stories)\.[a-z0-9]+$/i;
const BUSINESS_EXTS = new Set([".ts", ".mts", ".tsx", ".js", ".jsx", ".css", ".scss"]);
const EXCLUDED_ROOT_CONFIGS = new Set([
  "next.config.ts",
  "next.config.mjs",
  "drizzle.config.ts",
  "vitest.config.ts",
  "vite.config.ts",
  "eslint.config.mjs",
  "postcss.config.mjs",
  "tailwind.config.ts",
]);

export interface GitCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function runGitReadOnly(cwd: string, args: string[], check = true): GitCommandResult {
  const res = spawnSync(
    "git",
    ["--no-optional-locks", "-c", "core.quotePath=false", "-C", cwd, ...args],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const status = res.status ?? 1;
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  if (check && status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit=${status}): ${stderr.trim()}`);
  }
  return { status, stdout, stderr };
}

export function splitLines(text: string): string[] {
  if (!text) {
    return [];
  }
  const trimmed = text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n") || text.endsWith("\r")
      ? text.slice(0, -1)
      : text;
  return trimmed.split(/\r\n|\r|\n/);
}

export function countLinesSafe(text: string): number {
  if (!text) {
    return 0;
  }
  const trimmed = text.endsWith("\r\n")
    ? text.slice(0, -2)
    : text.endsWith("\n") || text.endsWith("\r")
      ? text.slice(0, -1)
      : text;
  return trimmed.length === 0 ? 1 : trimmed.split(/\r\n|\r|\n/).length;
}

export function isRegularFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function matchesPrefix(relNorm: string, dirPrefix: string): boolean {
  const clean = dirPrefix.replace(/^\/+|\/+$/g, "");
  if (!clean || clean === ".") {
    return true;
  }
  return relNorm === clean || relNorm.startsWith(`${clean}/`);
}

export function isInBusinessScope(relPath: string, config: GuardConfig): boolean {
  const norm = relPath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!norm) {
    return false;
  }
  const parts = norm.split("/");
  for (const ex of config.excludedPaths) {
    const clean = ex.replace(/^\/+|\/+$/g, "");
    if (!clean) {
      continue;
    }
    if (norm.startsWith(`${clean}/`) || norm === clean) {
      return false;
    }
    if (parts.slice(0, -1).includes(clean)) {
      return false;
    }
  }
  if (parts.slice(0, -1).some((seg) => seg === "__tests__" || seg === "__mocks__" || seg === "tests")) {
    return false;
  }
  for (const shared of [...config.sharedUiDirs, ...config.coreDirs]) {
    if (matchesPrefix(norm, shared)) {
      return false;
    }
  }
  if (config.businessDirs.length > 0) {
    const insideBusiness = config.businessDirs.some((dir) => matchesPrefix(norm, dir));
    if (!insideBusiness) {
      return false;
    }
  }
  const fileName = path.posix.basename(norm);
  if (EXCLUDED_ROOT_CONFIGS.has(fileName) && parts.length <= 2) {
    return false;
  }
  if (norm.endsWith(".d.ts") || TEST_FILE_RE.test(norm)) {
    return false;
  }
  const ext = path.posix.extname(norm).toLowerCase();
  return BUSINESS_EXTS.has(ext);
}

export function parseUnifiedZeroDiff(diffText: string): Map<string, Array<[number, string]>> {
  const addedByFile = new Map<string, Array<[number, string]>>();
  let currentFile: string | null = null;
  let newLineno = 0;
  let inHunk = false;

  for (const rawLine of splitLines(diffText)) {
    const mGit = DIFF_GIT_RE.exec(rawLine);
    if (mGit) {
      currentFile = mGit[2] ?? null;
      inHunk = false;
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      const target = rawLine.slice(4).trim();
      if (target === "/dev/null") {
        currentFile = null;
      } else if (target.startsWith("b/")) {
        currentFile = target.slice(2);
      }
      continue;
    }
    const mHunk = HUNK_HEADER_RE.exec(rawLine);
    if (mHunk) {
      newLineno = Number.parseInt(mHunk[1] ?? "1", 10);
      inHunk = true;
      continue;
    }
    if (!inHunk || currentFile === null) {
      continue;
    }
    if (rawLine.startsWith("+")) {
      let list = addedByFile.get(currentFile);
      if (!list) {
        list = [];
        addedByFile.set(currentFile, list);
      }
      list.push([newLineno, rawLine.slice(1)]);
      newLineno += 1;
    } else if (rawLine.startsWith(" ")) {
      newLineno += 1;
    } else if (!rawLine.startsWith("-") && !rawLine.startsWith("\\")) {
      inHunk = false;
    }
  }
  return addedByFile;
}

export function resolveMergeBase(repoRoot: string, baseRef: string): string | null {
  for (const ref of [baseRef, `origin/${baseRef}`]) {
    const verify = runGitReadOnly(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], false);
    if (verify.status === 0) {
      const mb = runGitReadOnly(repoRoot, ["merge-base", ref, "HEAD"], false);
      if (mb.status === 0 && mb.stdout.trim()) {
        return mb.stdout.trim();
      }
      return verify.stdout.trim();
    }
  }
  const head = runGitReadOnly(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"], false);
  return head.status === 0 && head.stdout.trim() ? head.stdout.trim() : null;
}

export function getBaseFileLineCount(
  repoRoot: string,
  mergeBase: string | null,
  relPath: string,
): number | null {
  if (!mergeBase) {
    return null;
  }
  const res = runGitReadOnly(repoRoot, ["show", `${mergeBase}:${relPath}`], false);
  if (res.status !== 0) {
    return null;
  }
  return countLinesSafe(res.stdout);
}

export function walkScopedFiles(rootDir: string, config: GuardConfig): string[] {
  const results: string[] = [];

  function walk(absDir: string): void {
    const entries = readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = path.join(absDir, entry.name);
      const rel = path.relative(rootDir, absPath).split(path.sep).join("/");
      if (entry.name.startsWith(".git")) {
        continue;
      }
      if (entry.isDirectory()) {
        if (config.excludedPaths.includes(entry.name)) {
          continue;
        }
        walk(absPath);
      } else if (entry.isFile()) {
        if (isInBusinessScope(rel, config)) {
          results.push(rel);
        }
      }
    }
  }

  walk(rootDir);
  return results.sort();
}

export function readFileLinesSafe(absPath: string): string[] {
  return splitLines(readFileSync(absPath, "utf8"));
}
