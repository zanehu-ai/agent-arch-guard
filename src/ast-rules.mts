import { readFileSync } from "node:fs";
import path from "node:path";

export interface RawAstMatch {
  ruleId: string;
  file: string;
  text: string;
  startLine: number;
  endLine: number;
}

export function buildAstGrepInlineRules(): string {
  const sharedRuleDefs = (lang: "TypeScript" | "Tsx", suffix: string): string => `
id: raw-response-json-${suffix}
language: ${lang}
rule:
  kind: call_expression
  has:
    field: function
    kind: member_expression
    all:
      - has:
          field: object
          kind: identifier
          regex: "^(Response|NextResponse)$"
      - has:
          field: property
          kind: property_identifier
          regex: "^json$"
---
id: scattered-process-env-${suffix}
language: ${lang}
rule:
  any:
    - kind: member_expression
      all:
        - has:
            field: object
            pattern: process.env
        - has:
            field: property
            kind: property_identifier
            not:
              regex: "^NODE_ENV$"
    - kind: subscript_expression
      all:
        - has:
            field: object
            pattern: process.env
        - has:
            field: index
            not:
              has:
                kind: string_fragment
                regex: "^NODE_ENV$"
                stopBy: end
---
id: duplicate-helper-wheel-${suffix}
language: ${lang}
rule:
  any:
    - kind: function_declaration
      has:
        field: name
        kind: identifier
        regex: "^(format(Date|Time|DateTime|Money|Amount|Currency|Minor[A-Za-z0-9_]*)|parse(Money|Amount|Date)|readableError)$"
    - kind: variable_declarator
      all:
        - has:
            field: name
            kind: identifier
            regex: "^(format(Date|Time|DateTime|Money|Amount|Currency|Minor[A-Za-z0-9_]*)|parse(Money|Amount|Date)|readableError)$"
        - has:
            field: value
            any:
              - kind: arrow_function
              - kind: function_expression
`;

  const tsxOnlyRules = `
id: native-form-tag
language: Tsx
rule:
  any:
    - kind: jsx_opening_element
      has:
        field: name
        kind: identifier
        regex: "^(button|select|textarea)$"
    - kind: jsx_self_closing_element
      has:
        field: name
        kind: identifier
        regex: "^(button|select|textarea)$"
---
id: native-input-tag
language: Tsx
rule:
  any:
    - kind: jsx_opening_element
      has:
        field: name
        kind: identifier
        regex: "^input$"
      not:
        has:
          kind: jsx_attribute
          all:
            - has:
                kind: property_identifier
                regex: "^type$"
            - has:
                kind: string_fragment
                regex: "^hidden$"
                stopBy: end
    - kind: jsx_self_closing_element
      has:
        field: name
        kind: identifier
        regex: "^input$"
      not:
        has:
          kind: jsx_attribute
          all:
            - has:
                kind: property_identifier
                regex: "^type$"
            - has:
                kind: string_fragment
                regex: "^hidden$"
                stopBy: end
---
id: inline-style
language: Tsx
rule:
  kind: jsx_attribute
  all:
    - has:
        kind: property_identifier
        regex: "^style$"
    - has:
        kind: jsx_expression
        has:
          kind: object
---
id: raw-view-fetch
language: Tsx
rule:
  kind: call_expression
  any:
    - has:
        field: function
        kind: identifier
        regex: "^fetch$"
    - has:
        field: function
        kind: member_expression
        all:
          - has:
              field: object
              kind: identifier
              regex: "^(window|globalThis)$"
          - has:
              field: property
              kind: property_identifier
              regex: "^fetch$"
`;

  return [
    tsxOnlyRules.trim(),
    sharedRuleDefs("Tsx", "tsx").trim(),
    sharedRuleDefs("TypeScript", "ts").trim(),
  ].join("\n---\n");
}

function stripCommentsPreservingLines(source: string): string[] {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\r\n]/g, " "),
  );
  return withoutBlock.split(/\r\n|\r|\n/).map((line) => line.replace(/\/\/.*$/, ""));
}

export function runFallbackRegexOnFiles(
  rootDir: string,
  relPaths: string[],
): Map<string, RawAstMatch[]> {
  const byFile = new Map<string, RawAstMatch[]>();

  const formTagRe = /<(button|select|textarea)\b/i;
  const inputTagRe = /<input\b([^>]*)/i;
  const inlineStyleRe = /\bstyle\s*=\s*\{\{/;
  const rawResponseRe = /\b(?:Response|NextResponse)\.json\s*\(/;
  const rawFetchRe = /\b(?:window\.|globalThis\.)?fetch\s*\(/;
  const processEnvRe = /\bprocess\.env(?:\.([A-Za-z0-9_]+)|\[['"]([A-Za-z0-9_]+)['"]\])/;
  const dupHelperRe =
    /\b(?:export\s+)?(?:async\s+)?function\s+(format(?:Date|Time|DateTime|Money|Amount|Currency|Minor[A-Za-z0-9_]*)|parse(?:Money|Amount|Date)|readableError)\s*\(|\b(?:export\s+)?const\s+(format(?:Date|Time|DateTime|Money|Amount|Currency|Minor[A-Za-z0-9_]*)|parse(?:Money|Amount|Date)|readableError)\s*=\s*(?:async\s*)?(?:\(|[A-Za-z0-9_]+\s*=>)/;

  for (const rel of relPaths) {
    const ext = path.posix.extname(rel).toLowerCase();
    const isJsx = ext === ".tsx" || ext === ".jsx";
    const lines = stripCommentsPreservingLines(readFileSync(path.join(rootDir, rel), "utf8"));
    const fileMatches: RawAstMatch[] = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const lineno = i + 1;
      if (!line.trim()) {
        continue;
      }
      if (isJsx) {
        if (formTagRe.test(line)) {
          fileMatches.push({ ruleId: "native-form-tag", file: rel, text: line.trim(), startLine: lineno, endLine: lineno });
        }
        const inputMatch = inputTagRe.exec(line);
        if (inputMatch && !/type\s*=\s*['"]hidden['"]/i.test(inputMatch[1] ?? "")) {
          fileMatches.push({ ruleId: "native-input-tag", file: rel, text: line.trim(), startLine: lineno, endLine: lineno });
        }
        if (inlineStyleRe.test(line)) {
          fileMatches.push({ ruleId: "inline-style", file: rel, text: line.trim(), startLine: lineno, endLine: lineno });
        }
        if (rawFetchRe.test(line)) {
          fileMatches.push({ ruleId: "raw-view-fetch", file: rel, text: line.trim(), startLine: lineno, endLine: lineno });
        }
      }
      if (rawResponseRe.test(line)) {
        fileMatches.push({ ruleId: "raw-response-json-ts", file: rel, text: line.trim(), startLine: lineno, endLine: lineno });
      }
      const envMatch = processEnvRe.exec(line);
      const envKey = envMatch?.[1] ?? envMatch?.[2];
      if (envKey && envKey !== "NODE_ENV") {
        fileMatches.push({ ruleId: "scattered-process-env-ts", file: rel, text: line.trim(), startLine: lineno, endLine: lineno });
      }
      if (dupHelperRe.test(line)) {
        fileMatches.push({ ruleId: "duplicate-helper-wheel-ts", file: rel, text: line.trim(), startLine: lineno, endLine: lineno });
      }
    }

    if (fileMatches.length > 0) {
      byFile.set(rel, fileMatches);
    }
  }

  return byFile;
}
