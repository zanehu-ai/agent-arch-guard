import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  buildAstGrepInlineRules,
  runFallbackRegexOnFiles,
  type RawAstMatch,
} from "./ast-rules.mts";
import { isRegularFile } from "./git-diff.mts";

export type { RawAstMatch } from "./ast-rules.mts";

export interface AstScanOutcome {
  engine: "ast-grep" | "fallback-regex";
  matchesByFile: Map<string, RawAstMatch[]>;
}

interface AstGrepCliMatch {
  ruleId: string;
  file: string;
  text: string;
  lines: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

export function resolveAstGrepBinary(overrideBin?: string): string | null {
  if (overrideBin === "__missing__") {
    return null;
  }
  if (overrideBin) {
    const check = spawnSync(overrideBin, ["--version"], { encoding: "utf8" });
    return check.status === 0 ? overrideBin : null;
  }
  for (const absCand of ["/opt/homebrew/bin/ast-grep", "/usr/local/bin/ast-grep"]) {
    if (isRegularFile(absCand)) {
      return absCand;
    }
  }
  for (const cand of ["ast-grep", "sg"]) {
    const res = spawnSync(cand, ["--version"], { encoding: "utf8" });
    if (res.status === 0) {
      return cand;
    }
  }
  return null;
}

export function scanCodePatterns(
  rootDir: string,
  relPaths: string[],
  options: { requireAstGrep?: boolean; astGrepBinOverride?: string } = {},
): AstScanOutcome {
  const astGrepBin = resolveAstGrepBinary(options.astGrepBinOverride);
  if (!astGrepBin) {
    if (options.requireAstGrep) {
      throw new Error(
        "ast-grep CLI not found and --require-ast-grep is enabled. Install @ast-grep/cli or ast-grep.",
      );
    }
    return {
      engine: "fallback-regex",
      matchesByFile: runFallbackRegexOnFiles(rootDir, relPaths),
    };
  }

  const byRelPath = new Map<string, RawAstMatch[]>();
  if (relPaths.length === 0) {
    return { engine: "ast-grep", matchesByFile: byRelPath };
  }

  const inlineRules = buildAstGrepInlineRules();
  const chunkSize = 150;

  for (let i = 0; i < relPaths.length; i += chunkSize) {
    const chunk = relPaths.slice(i, i + chunkSize);
    const absFiles = chunk.map((rel) => path.join(rootDir, rel));
    const res = spawnSync(
      astGrepBin,
      [
        "scan",
        "--no-ignore=hidden",
        "--no-ignore=dot",
        "--no-ignore=vcs",
        "--inline-rules",
        inlineRules,
        "--json=compact",
        "--",
        ...absFiles,
      ],
      {
        cwd: rootDir,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      },
    );

    if (res.error) {
      throw new Error(`Failed to execute ${astGrepBin}: ${res.error.message}`);
    }
    const stdout = (res.stdout ?? "").trim();
    if (!stdout) {
      continue;
    }

    let parsed: AstGrepCliMatch[];
    try {
      parsed = JSON.parse(stdout) as AstGrepCliMatch[];
    } catch (err) {
      throw new Error(
        `Failed to parse ast-grep JSON output (exit=${res.status}): ${
          err instanceof Error ? err.message : String(err)
        }\n${res.stderr ?? ""}`,
      );
    }

    for (const m of parsed) {
      const absMatched = path.isAbsolute(m.file) ? m.file : path.resolve(rootDir, m.file);
      const rel = path.relative(rootDir, absMatched).split(path.sep).join("/");
      let arr = byRelPath.get(rel);
      if (!arr) {
        arr = [];
        byRelPath.set(rel, arr);
      }
      arr.push({
        ruleId: m.ruleId,
        file: rel,
        text: m.text,
        startLine: m.range.start.line + 1,
        endLine: m.range.end.line + 1,
      });
    }
  }

  return { engine: "ast-grep", matchesByFile: byRelPath };
}
