#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkArchitecture } from "./check-arch.mts";
import { DEFAULT_CONFIG } from "./config.mts";
import { scanCodeNoise } from "./scan-noise.mts";

function printHelp(): void {
  console.log(`agent-arch-guard — Deterministic AST guardrails & code-noise auditor for AI-assisted repos

Usage:
  agent-arch-guard check [options]   Run incremental git-diff or full-repo architecture guardrails
  agent-arch-guard noise [options]   Scan for duplicate helpers, function clones, oversized & orphan modules
  agent-arch-guard init [--cwd dir]  Generate a starter .arch-guard.json config file

Check options:
  --base <ref>            Base branch/commit for incremental diff mode (default: main)
  --all                   Scan all scoped files without requiring a git diff
  --config <file>         Path to custom .arch-guard.json config
  --cwd <dir>             Target repository directory (default: .)
  --json                  Output structured JSON report
  --require-ast-grep      Fail instead of falling back to regex if ast-grep CLI is absent
  -h, --help              Show this help message
`);
}

function main(): number {
  const rawArgs = process.argv.slice(2);
  const subcommand = rawArgs[0] && !rawArgs[0].startsWith("-") ? rawArgs[0] : "help";
  const restArgs = subcommand === "help" ? rawArgs : rawArgs.slice(1);

  if (subcommand === "help" || rawArgs.includes("--help") || rawArgs.includes("-h")) {
    printHelp();
    return 0;
  }

  const parsed = parseArgs({
    args: restArgs,
    options: {
      base: { type: "string" },
      all: { type: "boolean", default: false },
      config: { type: "string" },
      cwd: { type: "string", default: "." },
      json: { type: "boolean", default: false },
      "require-ast-grep": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const targetCwd = path.resolve(parsed.values.cwd ?? ".");
  const resolvedConfig = parsed.values.config
    ? path.resolve(process.cwd(), parsed.values.config)
    : undefined;

  if (subcommand === "init") {
    const outPath = path.join(targetCwd, ".arch-guard.json");
    if (existsSync(outPath)) {
      console.error(`.arch-guard.json already exists at ${outPath}`);
      return 1;
    }
    writeFileSync(outPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
    console.log(`Created ${outPath}`);
    return 0;
  }

  if (subcommand === "check") {
    const report = checkArchitecture({
      cwd: targetCwd,
      base: parsed.values.base,
      all: parsed.values.all,
      configPath: resolvedConfig,
      requireAstGrep: parsed.values["require-ast-grep"],
    });

    if (parsed.values.json) {
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }

    console.log(
      `[agent-arch-guard] mode=${report.mode} engine=${report.engine} branch=${report.branch} checked=${report.filesChecked.length} files`,
    );
    if (report.ratchetImprovements.length > 0) {
      console.log("Ratchet improvements (line count reduced):");
      for (const note of report.ratchetImprovements) {
        console.log(`  - ${note}`);
      }
    }
    if (report.ok) {
      console.log("PASS: 0 architecture guardrail violations detected.");
      return 0;
    }

    console.error(`FAIL: ${report.violationCount} violation(s) detected:\n`);
    for (const v of report.violations) {
      console.error(`  [${v.rule}] ${v.file}:${v.line}`);
      console.error(`    Code: ${v.snippet}`);
      console.error(`    Fix : ${v.suggestion}\n`);
    }
    return 1;
  }

  if (subcommand === "noise") {
    const report = scanCodeNoise({
      cwd: targetCwd,
      configPath: resolvedConfig,
    });

    if (parsed.values.json) {
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }

    console.log(
      `[agent-arch-guard noise] scanner=${report.scanner} files=${report.totalFilesScanned}`,
    );
    console.log(`  A. Duplicate helpers : ${report.duplicateHelpers.length}`);
    for (const dup of report.duplicateHelpers) {
      const locs = dup.locations.map((l) => `${l.file}:${l.line}`).join(", ");
      console.log(`     - ${dup.symbol} -> ${locs}`);
    }
    console.log(`  B. Clone functions   : ${report.cloneGroups.length}`);
    for (const group of report.cloneGroups) {
      const occ = group.occurrences.map((o) => `${o.name}@${o.file}:${o.line}`).join(", ");
      console.log(`     - [${group.hash}] (${group.lineCount} lines): ${occ}`);
    }
    console.log(`  C1. Oversized files  : ${report.oversizedFiles.length}`);
    for (const ov of report.oversizedFiles) {
      console.log(`     - ${ov.file} (${ov.lines}/${ov.limit} lines)`);
    }
    console.log(`  C2. Orphan modules   : ${report.orphanModules.length}`);
    for (const orph of report.orphanModules) {
      console.log(`     - ${orph.file} (${orph.lines} lines)`);
    }
    return 0;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  printHelp();
  return 1;
}

process.exitCode = main();
