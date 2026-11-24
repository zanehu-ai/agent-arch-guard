import { existsSync } from "node:fs";
import path from "node:path";
import { scanCodePatterns } from "./ast-engine.mts";
import { loadConfig } from "./config.mts";
import {
  getBaseFileLineCount,
  isInBusinessScope,
  isRegularFile,
  parseUnifiedZeroDiff,
  readFileLinesSafe,
  resolveMergeBase,
  runGitReadOnly,
  splitLines,
  walkScopedFiles,
} from "./git-diff.mts";
import { checkCssFile, mapAstMatchToViolation } from "./rule-helpers.mts";
import type { CheckReport, RuleViolation } from "./types.mts";

export interface CheckArchitectureOptions {
  cwd: string;
  base?: string;
  all?: boolean;
  configPath?: string;
  requireAstGrep?: boolean;
  astGrepBinOverride?: string;
}

export function checkArchitecture(options: CheckArchitectureOptions): CheckReport {
  const resolvedCwd = path.resolve(options.cwd);
  if (!existsSync(resolvedCwd)) {
    throw new Error(`Target directory does not exist: ${resolvedCwd}`);
  }

  const config = loadConfig(resolvedCwd, options.configPath);
  const mode: "diff" | "all" = options.all ? "all" : "diff";
  const baseRef = options.base ?? "main";

  let repoRoot = resolvedCwd;
  let currentBranch = "FILESYSTEM";
  let mergeBase: string | null = null;
  const addedByFile = new Map<string, Array<[number, string]>>();
  const newFiles = new Set<string>();
  const touchedFiles = new Set<string>();

  if (mode === "all") {
    const gitTop = runGitReadOnly(resolvedCwd, ["rev-parse", "--show-toplevel"], false);
    if (gitTop.status === 0 && gitTop.stdout.trim()) {
      const br = runGitReadOnly(gitTop.stdout.trim(), ["symbolic-ref", "--short", "-q", "HEAD"], false);
      currentBranch = br.status === 0 && br.stdout.trim() ? br.stdout.trim() : "DETACHED";
    }
    for (const rel of walkScopedFiles(resolvedCwd, config)) {
      touchedFiles.add(rel);
      newFiles.add(rel);
      const lines = readFileLinesSafe(path.join(resolvedCwd, rel));
      addedByFile.set(
        rel,
        lines.map((line, idx) => [idx + 1, line]),
      );
    }
  } else {
    const top = runGitReadOnly(resolvedCwd, ["rev-parse", "--show-toplevel"], false);
    if (top.status !== 0 || !top.stdout.trim()) {
      throw new Error(`--base diff mode requires a valid Git repository: ${resolvedCwd}`);
    }
    repoRoot = path.resolve(top.stdout.trim());
    const br = runGitReadOnly(repoRoot, ["symbolic-ref", "--short", "-q", "HEAD"], false);
    currentBranch = br.status === 0 && br.stdout.trim() ? br.stdout.trim() : "DETACHED";
    mergeBase = resolveMergeBase(repoRoot, baseRef);

    if (mergeBase) {
      const nsRes = runGitReadOnly(repoRoot, ["diff", "--name-status", mergeBase, "--"], true);
      for (const line of splitLines(nsRes.stdout)) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        const status = (parts[0] ?? "").trim();
        const rel = (parts[parts.length - 1] ?? "").trim();
        if (!rel || status.startsWith("D")) continue;
        touchedFiles.add(rel);
        if (status.startsWith("A")) newFiles.add(rel);
      }
      const diffRes = runGitReadOnly(repoRoot, ["diff", "--unified=0", "--no-color", mergeBase, "--"], true);
      for (const [rel, lines] of parseUnifiedZeroDiff(diffRes.stdout)) {
        addedByFile.set(rel, lines);
      }
    }

    const untracked = runGitReadOnly(repoRoot, ["ls-files", "--others", "--exclude-standard"], true);
    for (const rawRel of splitLines(untracked.stdout)) {
      const rel = rawRel.trim();
      if (!rel) continue;
      touchedFiles.add(rel);
      newFiles.add(rel);
      const absFile = path.join(repoRoot, rel);
      if (isRegularFile(absFile) && isInBusinessScope(rel, config)) {
        const lines = readFileLinesSafe(absFile);
        addedByFile.set(
          rel,
          lines.map((line, idx) => [idx + 1, line]),
        );
      }
    }
  }

  const rootForFiles = mode === "all" ? resolvedCwd : repoRoot;
  const scopedFiles = Array.from(touchedFiles)
    .filter((f) => isInBusinessScope(f, config) && isRegularFile(path.join(rootForFiles, f)))
    .sort();
  const codeFiles = scopedFiles.filter((f) => {
    const ext = path.posix.extname(f).toLowerCase();
    return ext === ".ts" || ext === ".mts" || ext === ".tsx" || ext === ".js" || ext === ".jsx";
  });

  const scanOutcome = scanCodePatterns(rootForFiles, codeFiles, {
    requireAstGrep: options.requireAstGrep,
    astGrepBinOverride: options.astGrepBinOverride,
  });

  const violations: RuleViolation[] = [];
  const ratchetImprovements: string[] = [];

  for (const relPath of scopedFiles) {
    const ext = path.posix.extname(relPath).toLowerCase();
    const addedLines = addedByFile.get(relPath) ?? [];
    if (ext === ".css" || ext === ".scss") {
      checkCssFile(rootForFiles, relPath, newFiles.has(relPath), addedLines, config, violations);
      continue;
    }

    const fileLines = readFileLinesSafe(path.join(rootForFiles, relPath));
    const addedLineSet = new Set<number>(addedLines.map(([lineno]) => lineno));
    const isViewFile = ext === ".tsx" || ext === ".jsx";

    for (const m of scanOutcome.matchesByFile.get(relPath) ?? []) {
      if (!addedLineSet.has(m.startLine)) continue;
      const violation = mapAstMatchToViolation(m, relPath, fileLines, config, isViewFile);
      if (violation) violations.push(violation);
    }

    if (!config.rules["file-line-ratchet"]) continue;
    const totalLines = fileLines.length;
    if (mode === "all") {
      if (totalLines > config.maxFileLines) {
        violations.push({
          rule: "file-line-ratchet",
          file: relPath,
          line: config.maxFileLines + 1,
          snippet: `${relPath} has ${totalLines} lines (limit: ${config.maxFileLines})`,
          suggestion: `Split large modules into cohesive domain helpers or shared primitives (<= ${config.maxFileLines} lines).`,
        });
      }
      continue;
    }

    const baseCount = getBaseFileLineCount(repoRoot, mergeBase, relPath);
    if (baseCount === null && totalLines > config.maxFileLines) {
      violations.push({
        rule: "file-line-ratchet",
        file: relPath,
        line: config.maxFileLines + 1,
        snippet: `New file ${relPath} has ${totalLines} lines (limit: ${config.maxFileLines})`,
        suggestion: `Keep new modules modular and under ${config.maxFileLines} lines by splitting UI containers, hooks, and pure helpers.`,
      });
    } else if (baseCount !== null && totalLines > config.maxFileLines) {
      if (totalLines > baseCount) {
        violations.push({
          rule: "file-line-ratchet",
          file: relPath,
          line: baseCount + 1,
          snippet: `Oversized file grew from ${baseCount} to ${totalLines} lines (limit: ${config.maxFileLines})`,
          suggestion: `File already exceeds ${config.maxFileLines} lines. Ratchet rule blocks net line growth; extract logic rather than appending.`,
        });
      } else if (totalLines < baseCount) {
        ratchetImprovements.push(`${relPath}: ${baseCount} -> ${totalLines} lines`);
      }
    }
  }

  return {
    ok: violations.length === 0,
    mode,
    engine: scanOutcome.engine,
    cwd: rootForFiles,
    branch: currentBranch,
    base: mode === "diff" ? baseRef : null,
    mergeBase,
    filesChecked: scopedFiles,
    ratchetImprovements,
    violationCount: violations.length,
    violations,
  };
}
