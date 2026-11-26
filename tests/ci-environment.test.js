import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("Node.js runtime is available", () => {
  const version = process.versions.node;
  assert.match(version, /^22\./, `Expected Node.js 22.x, received ${version}`);
});

test("npm-installed TypeScript compiler is available", () => {
  const version = execFileSync("npx", ["tsc", "--version"], { encoding: "utf8" }).trim();
  assert.match(version, /^Version /);
});
