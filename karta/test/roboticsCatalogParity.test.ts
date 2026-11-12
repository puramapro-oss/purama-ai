import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CUSTOM_AGENT_TOOL_NAMES } from "../src/tools/customRegistry.js";

/** Read declarations without importing the browser client or starting Deno. */
function declaredStrings(path: string, name: string, property?: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  let found = false;
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
      found = true;
      const array = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (!ts.isArrayLiteralExpression(array)) throw new Error(`Expected array: ${name}`);
      for (const element of array.elements) {
        if (!property && ts.isStringLiteral(element)) names.push(element.text);
        if (property && ts.isObjectLiteralExpression(element)) {
          const value = element.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText(source) === property);
          if (value && ts.isPropertyAssignment(value) && ts.isStringLiteral(value.initializer)) names.push(value.initializer.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found || !names.length) throw new Error(`Missing declaration: ${name}`);
  return names.sort();
}

describe("agent tool catalog across runtime boundaries", () => {
  it("offers exactly the executable KARTA tools in the frontend editor", () => {
    expect(declaredStrings("../../src/lib/creator-agent.ts", "TOOL_OPTIONS", "value"))
      .toEqual([...CUSTOM_AGENT_TOOL_NAMES].sort());
  });
  it("keeps generated agent tools in parity with KARTA's allowlist", () => {
    expect(declaredStrings("../../supabase/functions/creator-agent-generate/index.ts", "REAL_TOOL_NAMES"))
      .toEqual([...CUSTOM_AGENT_TOOL_NAMES].sort());
  });
});
