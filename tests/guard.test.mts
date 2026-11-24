import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkArchitecture } from "../src/check-arch.mts";
import { resolveAstGrepBinary } from "../src/ast-engine.mts";
import { scanCodeNoise } from "../src/scan-noise.mts";

function writeRepoFile(root: string, relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function initGitRepo(baseFiles: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "arch-guard-test-"));
  const run = (args: string[]) => {
    const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    }
  };
  run(["init", "-b", "main"]);
  run(["config", "user.name", "Arch Guard Test"]);
  run(["config", "user.email", "test@example.invalid"]);
  for (const [rel, content] of Object.entries(baseFiles)) {
    writeRepoFile(dir, rel, content);
  }
  run(["add", "."]);
  run(["commit", "-m", "chore: initial baseline"]);
  return dir;
}

function switchFeatureBranch(dir: string, branchName = "feat/ai-change"): void {
  const res = spawnSync("git", ["-C", dir, "checkout", "-b", branchName], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(res.stderr);
  }
}

test("catches all expected violations on dirty fixture app with ast-grep", (t) => {
  const astBin = resolveAstGrepBinary();
  if (!astBin) {
    t.skip("ast-grep CLI not installed in PATH");
    return;
  }
  const fixtureDir = path.resolve("examples/fixture-app");
  const report = checkArchitecture({
    cwd: fixtureDir,
    all: true,
    configPath: path.resolve("examples/arch-guard.json"),
    requireAstGrep: true,
  });

  assert.equal(report.engine, "ast-grep");
  assert.equal(report.ok, false);
  const rulesHit = new Set(report.violations.map((v) => v.rule));
  assert.ok(rulesHit.has("no-scattered-css"));
  assert.ok(rulesHit.has("no-important-css"));
  assert.ok(rulesHit.has("no-native-form-controls"));
  assert.ok(rulesHit.has("no-inline-style"));
  assert.ok(rulesHit.has("no-raw-response-json"));
  assert.ok(rulesHit.has("no-scattered-process-env"));
  assert.ok(rulesHit.has("no-raw-view-fetch"));
  assert.ok(rulesHit.has("no-duplicate-helper"));

  // GoodCheckout uses <input type="hidden"> and shared primitives -> zero violations on that file
  const goodViolations = report.violations.filter((v) => v.file.endsWith("GoodCheckout.tsx"));
  assert.equal(goodViolations.length, 0);
});

test("ignores comments and string literals containing forbidden patterns under ast-grep", (t) => {
  if (!resolveAstGrepBinary()) {
    t.skip("ast-grep CLI not installed in PATH");
    return;
  }
  const dir = initGitRepo({ "README.md": "baseline\n" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  switchFeatureBranch(dir);

  writeRepoFile(
    dir,
    "apps/web/SafeView.tsx",
    `import React from "react";
// Never write <button> or style={{ color: "red" }} or fetch("/api") in business views
export function SafeView() {
  const doc = "<input type='text' /> Response.json({ ok: true }) process.env.SECRET";
  return <div><input type="hidden" name="token" value={doc} /></div>;
}
`,
  );

  const report = checkArchitecture({ cwd: dir, base: "main", requireAstGrep: true });
  assert.equal(report.ok, true);
  assert.equal(report.violationCount, 0);
});

test("permits shared UI, core library, and env config modules without false positives", () => {
  const dir = initGitRepo({ "README.md": "baseline\n" });
  try {
    switchFeatureBranch(dir);
    writeRepoFile(
      dir,
      "packages/ui/Button.tsx",
      `export function Button({ label }: { label: string }) {
  return <button style={{ fontWeight: 600 }}>{label}</button>;
}
`,
    );
    writeRepoFile(
      dir,
      "packages/core/http.ts",
      `export function ok(data: unknown) {
  return Response.json(data);
}
`,
    );
    writeRepoFile(
      dir,
      "src/config/env.ts",
      `export const API_SECRET = process.env.API_SECRET ?? "";
`,
    );
    writeRepoFile(
      dir,
      "src/formatters.ts",
      `export function formatMoney(minor: number) { return String(minor); }
`,
    );

    const report = checkArchitecture({ cwd: dir, base: "main" });
    assert.equal(report.ok, true);
    assert.equal(report.violationCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("freezes legacy violations on untouched lines in diff mode", () => {
  const dir = initGitRepo({
    "apps/web/LegacyPanel.tsx": `export function LegacyPanel() {
  return <button>Legacy Untouched</button>;
}
`,
  });
  try {
    switchFeatureBranch(dir);
    writeRepoFile(
      dir,
      "apps/web/LegacyPanel.tsx",
      `// Updated header comment only
export function LegacyPanel() {
  return <button>Legacy Untouched</button>;
}
`,
    );

    const report = checkArchitecture({ cwd: dir, base: "main" });
    assert.equal(report.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catches newly added !important in existing CSS but allows annotated escape hatch", () => {
  const dir = initGitRepo({
    "apps/web/tokens.css": `:root { --fg: #111; }\n`,
  });
  try {
    switchFeatureBranch(dir);
    writeRepoFile(
      dir,
      "apps/web/tokens.css",
      `:root { --fg: #111; }
.bad { color: #000 !important; }
.ok { color: #222 !important; /* arch-guard-allow-important */ }
`,
    );

    const report = checkArchitecture({ cwd: dir, base: "main" });
    assert.equal(report.ok, false);
    assert.equal(report.violationCount, 1);
    assert.equal(report.violations[0]?.rule, "no-important-css");
    assert.equal(report.violations[0]?.line, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allows explicit global CSS names like globals.css while blocking arbitrary CSS files", () => {
  const dir = initGitRepo({ "README.md": "baseline\n" });
  try {
    switchFeatureBranch(dir);
    writeRepoFile(dir, "apps/web/globals.css", `body { margin: 0; }\n`);
    writeRepoFile(dir, "apps/web/card-patch.css", `.card { margin: 4px; }\n`);

    const report = checkArchitecture({ cwd: dir, base: "main" });
    assert.equal(report.ok, false);
    assert.equal(report.violationCount, 1);
    assert.equal(report.violations[0]?.rule, "no-scattered-css");
    assert.equal(report.violations[0]?.file, "apps/web/card-patch.css");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforces 300-line ratchet: blocks growth of oversized file and rewards shrinking", () => {
  const makeLines = (n: number) =>
    Array.from({ length: n }, (_, i) => `export const item_${i} = ${i};`).join("\n") + "\n";

  const dirGrow = initGitRepo({ "src/legacyBig.ts": makeLines(305) });
  try {
    switchFeatureBranch(dirGrow);
    writeRepoFile(dirGrow, "src/legacyBig.ts", makeLines(308));
    const growReport = checkArchitecture({ cwd: dirGrow, base: "main" });
    assert.equal(growReport.ok, false);
    assert.equal(growReport.violations[0]?.rule, "file-line-ratchet");
  } finally {
    rmSync(dirGrow, { recursive: true, force: true });
  }

  const dirShrink = initGitRepo({ "src/legacyBig.ts": makeLines(310) });
  try {
    switchFeatureBranch(dirShrink);
    writeRepoFile(dirShrink, "src/legacyBig.ts", makeLines(302));
    const shrinkReport = checkArchitecture({ cwd: dirShrink, base: "main" });
    assert.equal(shrinkReport.ok, true);
    assert.equal(shrinkReport.ratchetImprovements.length, 1);
    assert.match(shrinkReport.ratchetImprovements[0] ?? "", /310 -> 302/);
  } finally {
    rmSync(dirShrink, { recursive: true, force: true });
  }
});

test("allows NODE_ENV in business logic while blocking arbitrary process.env keys", () => {
  const dir = initGitRepo({ "README.md": "baseline\n" });
  try {
    switchFeatureBranch(dir);
    writeRepoFile(
      dir,
      "src/service/billing.ts",
      `export function mode() {
  if (process.env.NODE_ENV === "production") {
    return process.env.STRIPE_SECRET_KEY;
  }
  return "dev";
}
`,
    );

    const report = checkArchitecture({ cwd: dir, base: "main" });
    assert.equal(report.ok, false);
    assert.equal(report.violationCount, 1);
    assert.equal(report.violations[0]?.rule, "no-scattered-process-env");
    assert.equal(report.violations[0]?.line, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supports fallback-regex engine cleanly when ast-grep binary is absent", () => {
  const dir = initGitRepo({ "README.md": "baseline\n" });
  try {
    switchFeatureBranch(dir);
    writeRepoFile(
      dir,
      "apps/web/Form.tsx",
      `export function Form() {
  return <button type="button">Submit</button>;
}
`,
    );

    const fallbackReport = checkArchitecture({
      cwd: dir,
      base: "main",
      astGrepBinOverride: "__missing__",
    });
    assert.equal(fallbackReport.engine, "fallback-regex");
    assert.equal(fallbackReport.ok, false);
    assert.equal(fallbackReport.violations[0]?.rule, "no-native-form-controls");

    assert.throws(
      () =>
        checkArchitecture({
          cwd: dir,
          base: "main",
          requireAstGrep: true,
          astGrepBinOverride: "__missing__",
        }),
      /ast-grep CLI not found/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanCodeNoise detects duplicate helpers, clone bodies, oversized and orphan modules", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "arch-noise-test-"));
  try {
    writeRepoFile(
      dir,
      "src/index.ts",
      `import { usedWorker } from "./used";
console.log(usedWorker());
`,
    );
    writeRepoFile(
      dir,
      "src/used.ts",
      `export function formatMoney(minor: number) { return String(minor); }
export function usedWorker() {
  const items = [1, 2, 3, 4];
  const doubled = items.map((n) => n * 2);
  const sum = doubled.reduce((a, b) => a + b, 0);
  return sum + formatMoney(100).length;
}
`,
    );
    writeRepoFile(
      dir,
      "src/orphanClone.ts",
      `export function formatMoney(minor: number) { return String(minor); }
export function copiedWorker() {
  const items = [1, 2, 3, 4];
  const doubled = items.map((n) => n * 2);
  const sum = doubled.reduce((a, b) => a + b, 0);
  return sum + formatMoney(100).length;
}
`,
    );

    const noise = scanCodeNoise({ cwd: dir });
    assert.equal(noise.ok, false);
    assert.ok(noise.duplicateHelpers.some((d) => d.symbol === "formatMoney"));
    assert.equal(noise.cloneGroups.length, 1);
    assert.ok(noise.orphanModules.some((o) => o.file === "src/orphanClone.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("respects custom .arch-guard.json rule toggles and maxFileLines", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "arch-config-test-"));
  try {
    writeRepoFile(
      dir,
      ".arch-guard.json",
      JSON.stringify({
        maxFileLines: 3,
        rules: { "no-inline-style": false },
      }),
    );
    writeRepoFile(
      dir,
      "apps/Card.tsx",
      `export function Card() {
  const a = 1;
  const b = 2;
  return <div style={{ margin: 4 }}>{a + b}</div>;
}
`,
    );
    const report = checkArchitecture({ cwd: dir, all: true });
    assert.equal(report.ok, false);
    assert.equal(report.violationCount, 1);
    assert.equal(report.violations[0]?.rule, "file-line-ratchet");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI supports init, check --json (exit 1 on failure), and noise --json (exit 0)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "arch-cli-test-"));
  const cliPath = path.resolve("src/cli.mts");
  try {
    const initRes = spawnSync(process.execPath, [cliPath, "init", "--cwd", dir], {
      encoding: "utf8",
    });
    assert.equal(initRes.status, 0);
    const created = JSON.parse(readFileSync(path.join(dir, ".arch-guard.json"), "utf8"));
    assert.equal(created.maxFileLines, 300);

    const fixtureDir = path.resolve("examples/fixture-app");
    const checkRes = spawnSync(
      process.execPath,
      [
        cliPath,
        "check",
        "--all",
        "--config",
        path.resolve("examples/arch-guard.json"),
        "--cwd",
        fixtureDir,
        "--json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(checkRes.status, 1);
    const parsedCheck = JSON.parse(checkRes.stdout);
    assert.equal(parsedCheck.ok, false);
    assert.ok(parsedCheck.violationCount >= 5);

    const noiseRes = spawnSync(
      process.execPath,
      [
        cliPath,
        "noise",
        "--config",
        path.resolve("examples/arch-guard.json"),
        "--cwd",
        fixtureDir,
        "--json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(noiseRes.status, 0);
    const parsedNoise = JSON.parse(noiseRes.stdout);
    assert.ok(parsedNoise.duplicateHelpers.some((d: { symbol: string }) => d.symbol === "formatMoney"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("can ignore non-endpoint files for raw Response.json rule", () => {
  const dir = initGitRepo({ "README.md": "baseline\n" });
  try {
    switchFeatureBranch(dir);
    writeRepoFile(
      dir,
      "src/lib/test-double.ts",
      `export function fakeRes() { return Response.json({ mock: true }); }\n`,
    );
    writeRepoFile(
      dir,
      "apps/api/orders/route.ts",
      `export function GET() { return Response.json({ orders: [] }); }\n`,
    );
    const report = checkArchitecture({ cwd: dir, base: "main" });
    assert.equal(report.ok, false);
    assert.equal(report.violationCount, 1);
    assert.equal(report.violations[0]?.file, "apps/api/orders/route.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supports arch-guard-allow directives for auditable opt-outs", () => {
  const dir = initGitRepo({ "README.md": "baseline\n" });
  try {
    switchFeatureBranch(dir);
    writeRepoFile(
      dir,
      "apps/web/CanvasWidget.tsx",
      `export function CanvasWidget() {
  // arch-guard-allow-inline-style
  return <div style={{ width: "100%" }} />;
}
`,
    );
    const report = checkArchitecture({ cwd: dir, base: "main" });
    assert.equal(report.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
