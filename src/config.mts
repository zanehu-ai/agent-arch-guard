import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { GuardConfig, GuardRuleToggleMap } from "./types.mts";

export const DEFAULT_RULES: GuardRuleToggleMap = {
  "no-scattered-css": true,
  "no-important-css": true,
  "no-native-form-controls": true,
  "no-inline-style": true,
  "file-line-ratchet": true,
  "no-raw-response-json": true,
  "no-scattered-process-env": true,
  "no-raw-view-fetch": true,
  "no-duplicate-helper": true,
};

export const DEFAULT_CONFIG: GuardConfig = {
  uiPackageName: "@acme/ui",
  corePackageName: "@acme/core",
  coreHttpPackageName: "@acme/core/http",
  businessDirs: ["src", "apps"],
  sharedUiDirs: ["packages/ui", "src/ui"],
  coreDirs: ["packages/core", "src/lib", "src/core"],
  excludedPaths: [
    "node_modules",
    "dist",
    "build",
    "out",
    "output",
    ".next",
    "coverage",
    "docs",
    "scripts",
  ],
  serverPathPatterns: ["/api/", "/server/", "/routes/", "route.ts", "endpoint.ts"],
  envConfigPatterns: ["config", "env", "instrumentation.ts"],
  sharedFormatterNames: [
    "formatters.ts",
    "format.ts",
    "presentation.ts",
    "format.mts",
    "formatters.mts",
  ],
  allowedGlobalCssNames: [
    "globals.css",
    "global.css",
    "tokens.css",
    "theme.css",
    "variables.css",
  ],
  maxFileLines: 300,
  rules: { ...DEFAULT_RULES },
};

export interface PartialGuardConfig {
  uiPackageName?: string;
  corePackageName?: string;
  coreHttpPackageName?: string;
  businessDirs?: string[];
  sharedUiDirs?: string[];
  coreDirs?: string[];
  excludedPaths?: string[];
  serverPathPatterns?: string[];
  envConfigPatterns?: string[];
  sharedFormatterNames?: string[];
  allowedGlobalCssNames?: string[];
  maxFileLines?: number;
  rules?: Partial<GuardRuleToggleMap>;
}

function normalizeStringList(values: unknown, fallback: string[]): string[] {
  if (!Array.isArray(values)) {
    return [...fallback];
  }
  return values
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim().replaceAll("\\", "/").replace(/\/+$/, ""));
}

export function loadConfig(cwd: string, configPath?: string): GuardConfig {
  const candidate = configPath
    ? path.resolve(cwd, configPath)
    : path.join(cwd, ".arch-guard.json");

  if (!existsSync(candidate)) {
    if (configPath) {
      throw new Error(`Config file not found: ${candidate}`);
    }
    return {
      ...DEFAULT_CONFIG,
      rules: { ...DEFAULT_RULES },
    };
  }

  const rawText = readFileSync(candidate, "utf8");
  const parsed = JSON.parse(rawText) as PartialGuardConfig;

  const maxLines =
    typeof parsed.maxFileLines === "number" && Number.isInteger(parsed.maxFileLines) && parsed.maxFileLines > 0
      ? parsed.maxFileLines
      : DEFAULT_CONFIG.maxFileLines;

  return {
    uiPackageName:
      typeof parsed.uiPackageName === "string" && parsed.uiPackageName.trim()
        ? parsed.uiPackageName.trim()
        : DEFAULT_CONFIG.uiPackageName,
    corePackageName:
      typeof parsed.corePackageName === "string" && parsed.corePackageName.trim()
        ? parsed.corePackageName.trim()
        : DEFAULT_CONFIG.corePackageName,
    coreHttpPackageName:
      typeof parsed.coreHttpPackageName === "string" && parsed.coreHttpPackageName.trim()
        ? parsed.coreHttpPackageName.trim()
        : DEFAULT_CONFIG.coreHttpPackageName,
    businessDirs: normalizeStringList(parsed.businessDirs, DEFAULT_CONFIG.businessDirs),
    sharedUiDirs: normalizeStringList(parsed.sharedUiDirs, DEFAULT_CONFIG.sharedUiDirs),
    coreDirs: normalizeStringList(parsed.coreDirs, DEFAULT_CONFIG.coreDirs),
    excludedPaths: normalizeStringList(parsed.excludedPaths, DEFAULT_CONFIG.excludedPaths),
    serverPathPatterns: normalizeStringList(
      parsed.serverPathPatterns,
      DEFAULT_CONFIG.serverPathPatterns,
    ),
    envConfigPatterns: normalizeStringList(
      parsed.envConfigPatterns,
      DEFAULT_CONFIG.envConfigPatterns,
    ),
    sharedFormatterNames: normalizeStringList(
      parsed.sharedFormatterNames,
      DEFAULT_CONFIG.sharedFormatterNames,
    ),
    allowedGlobalCssNames: normalizeStringList(
      parsed.allowedGlobalCssNames,
      DEFAULT_CONFIG.allowedGlobalCssNames,
    ),
    maxFileLines: maxLines,
    rules: {
      ...DEFAULT_RULES,
      ...(parsed.rules ?? {}),
    },
  };
}
