import { readFileSync } from "node:fs";
import path from "node:path";
import type { RawAstMatch } from "./ast-engine.mts";
import { splitLines } from "./git-diff.mts";
import type { GuardConfig, RuleViolation } from "./types.mts";

const IMPORTANT_RE = /!\s*important\b/i;

export function isServerEndpointFile(relPath: string, config: GuardConfig): boolean {
  const norm = relPath.replaceAll("\\", "/");
  const fname = path.posix.basename(norm);
  return config.serverPathPatterns.some((pat) => {
    if (pat.includes("/")) {
      return norm.includes(pat);
    }
    return fname === pat || norm.includes(pat);
  });
}

export function isEnvConfigFile(relPath: string, config: GuardConfig): boolean {
  const norm = relPath.replaceAll("\\", "/").toLowerCase();
  const parts = norm.split("/");
  const fname = path.posix.basename(norm);
  return config.envConfigPatterns.some((pat) => {
    const lower = pat.toLowerCase();
    return parts.slice(0, -1).includes(lower) || fname.includes(lower);
  });
}

export function isSharedFormatterFile(relPath: string, config: GuardConfig): boolean {
  const fname = path.posix.basename(relPath.replaceAll("\\", "/"));
  return (
    config.sharedFormatterNames.includes(fname) ||
    fname.endsWith("Format.ts") ||
    fname.endsWith("-format.ts") ||
    fname.endsWith("_format.ts") ||
    fname.endsWith("Format.mts")
  );
}

function stripCssCommentsPreservingLines(fullText: string): string[] {
  const withoutBlock = fullText.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\r\n]/g, " "),
  );
  return splitLines(withoutBlock);
}

export function hasAllowDirective(
  fileLines: string[],
  startLine1Based: number,
  endLine1Based: number,
  directive: string,
): boolean {
  const fromIdx = Math.max(0, startLine1Based - 2);
  const toIdx = Math.min(fileLines.length - 1, endLine1Based - 1);
  for (let idx = fromIdx; idx <= toIdx; idx += 1) {
    if ((fileLines[idx] ?? "").includes(directive)) {
      return true;
    }
  }
  return false;
}

export function formatSnippet(text: string, fallback: string): string {
  return (text || fallback).replace(/\s+/g, " ").trim().slice(0, 120);
}

export function checkCssFile(
  rootDir: string,
  relPath: string,
  isNewFile: boolean,
  addedLines: Array<[number, string]>,
  config: GuardConfig,
  violations: RuleViolation[],
): void {
  const filename = path.posix.basename(relPath.replaceAll("\\", "/")).toLowerCase();
  const allowedCss = new Set(config.allowedGlobalCssNames.map((n) => n.toLowerCase()));
  const fullText = readFileSync(path.join(rootDir, relPath), "utf8");
  const rawLines = splitLines(fullText);
  const headerSlice = rawLines.slice(0, 5).join("\n");

  if (
    config.rules["no-scattered-css"] &&
    isNewFile &&
    !allowedCss.has(filename) &&
    !headerSlice.includes("arch-guard-allow-css-file")
  ) {
    violations.push({
      rule: "no-scattered-css",
      file: relPath,
      line: 1,
      snippet: `New scattered stylesheet ${relPath} (${rawLines.length} lines)`,
      suggestion: `Move reusable component styles into ${config.uiPackageName} or use design tokens instead of local patch CSS files.`,
    });
  }

  if (!config.rules["no-important-css"]) {
    return;
  }

  const strippedLines = stripCssCommentsPreservingLines(fullText);
  for (const [lineno, content] of addedLines) {
    if (content.includes("arch-guard-allow-important")) {
      continue;
    }
    const cleanLine = (strippedLines[lineno - 1] ?? "").replace(/\/\/.*$/, "").trim();
    if (!cleanLine) {
      continue;
    }
    if (IMPORTANT_RE.test(cleanLine)) {
      violations.push({
        rule: "no-important-css",
        file: relPath,
        line: lineno,
        snippet: content.trim().slice(0, 120),
        suggestion: `Avoid !important overrides. Compose ${config.uiPackageName} variants or fix selector specificity cleanly.`,
      });
    }
  }
}

export function mapAstMatchToViolation(
  match: RawAstMatch,
  relPath: string,
  fileLines: string[],
  config: GuardConfig,
  isViewFile: boolean,
): RuleViolation | null {
  const baseRule = match.ruleId.replace(/-(ts|tsx)$/, "");
  const fallback = fileLines[match.startLine - 1] ?? match.text;
  const snippet = formatSnippet(match.text, fallback);

  if (baseRule === "native-form-tag" || baseRule === "native-input-tag") {
    if (
      !config.rules["no-native-form-controls"] ||
      hasAllowDirective(fileLines, match.startLine, match.endLine, "arch-guard-allow-native-form")
    ) {
      return null;
    }
    return {
      rule: "no-native-form-controls",
      file: relPath,
      line: match.startLine,
      snippet,
      suggestion: `Replace native form element with shared primitive from ${config.uiPackageName} (Button / Input / Select / Textarea).`,
    };
  }
  if (baseRule === "inline-style") {
    if (
      !config.rules["no-inline-style"] ||
      hasAllowDirective(fileLines, match.startLine, match.endLine, "arch-guard-allow-inline-style")
    ) {
      return null;
    }
    return {
      rule: "no-inline-style",
      file: relPath,
      line: match.startLine,
      snippet,
      suggestion: `Remove JSX inline style={{...}} and use design tokens or ${config.uiPackageName} styling props.`,
    };
  }
  if (baseRule === "raw-response-json") {
    if (
      !config.rules["no-raw-response-json"] ||
      !isServerEndpointFile(relPath, config) ||
      hasAllowDirective(fileLines, match.startLine, match.endLine, "arch-guard-allow-raw-response")
    ) {
      return null;
    }
    return {
      rule: "no-raw-response-json",
      file: relPath,
      line: match.startLine,
      snippet,
      suggestion: `Avoid raw Response.json / NextResponse.json in endpoints. Wrap responses through ${config.coreHttpPackageName} for consistent error sanitization and Cache-Control headers.`,
    };
  }
  if (baseRule === "scattered-process-env") {
    if (
      !config.rules["no-scattered-process-env"] ||
      isEnvConfigFile(relPath, config) ||
      hasAllowDirective(fileLines, match.startLine, match.endLine, "arch-guard-allow-env")
    ) {
      return null;
    }
    return {
      rule: "no-scattered-process-env",
      file: relPath,
      line: match.startLine,
      snippet,
      suggestion:
        "Centralize process.env access inside dedicated config/env modules instead of reading environment variables inside business code.",
    };
  }
  if (baseRule === "raw-view-fetch") {
    if (
      !config.rules["no-raw-view-fetch"] ||
      !isViewFile ||
      hasAllowDirective(fileLines, match.startLine, match.endLine, "arch-guard-allow-fetch")
    ) {
      return null;
    }
    return {
      rule: "no-raw-view-fetch",
      file: relPath,
      line: match.startLine,
      snippet,
      suggestion: `Avoid raw fetch() inside view components. Route client requests through a typed client module in ${config.corePackageName}.`,
    };
  }
  if (baseRule === "duplicate-helper-wheel") {
    if (
      !config.rules["no-duplicate-helper"] ||
      isSharedFormatterFile(relPath, config) ||
      hasAllowDirective(fileLines, match.startLine, match.endLine, "arch-guard-allow-helper")
    ) {
      return null;
    }
    return {
      rule: "no-duplicate-helper",
      file: relPath,
      line: match.startLine,
      snippet,
      suggestion: `Reuse shared formatting/parsing helpers from ${config.corePackageName} or a designated shared formatter module instead of re-declaring local wheels.`,
    };
  }
  return null;
}
