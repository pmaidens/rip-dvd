import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const inventoryPath = join(
  repositoryRoot,
  "docs/agents/operator-capability-parity.md",
);
const commandPath = join(
  repositoryRoot,
  "apps/operator-cli/src/command.ts",
);

function filesNamed(directory, name) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesNamed(path, name);
    return entry.isFile() && entry.name === name ? [path] : [];
  });
}

function inventoryRows(markdown) {
  const start = markdown.indexOf("<!-- capability-inventory:start -->");
  const end = markdown.indexOf("<!-- capability-inventory:end -->");
  assert.ok(start >= 0 && end > start, "Capability inventory markers are missing");
  return markdown.slice(start, end).split("\n")
    .filter((line) => line.startsWith("|") && !line.includes("| ---"))
    .slice(1)
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

test("every operator route and CLI command stays in the capability inventory", () => {
  const inventory = readFileSync(inventoryPath, "utf8");
  const rows = inventoryRows(inventory);
  assert.ok(rows.length >= 30, "The capability inventory lost expected workflows");
  assert.equal(
    new Set(rows.map(([capability]) => capability)).size,
    rows.length,
    "Capability names must be unique",
  );
  for (const row of rows) {
    assert.equal(row.length, 4, `Inventory row must have four columns: ${row[0]}`);
    assert.match(row[2], /rip-dvd/, `Inventory row has no CLI boundary: ${row[0]}`);
    assert.match(
      row[3],
      /(?:\.test\.[cm]?[jt]sx?|\.e2e\.[cm]?[jt]s|scripts\/smoke-[^`]+\.sh)/,
      `Inventory row has no behavior coverage: ${row[0]}`,
    );
  }

  const routeRoot = join(repositoryRoot, "apps/web/app/api");
  for (const routePath of filesNamed(routeRoot, "route.ts")) {
    const repositoryPath = relative(repositoryRoot, routePath);
    const source = readFileSync(routePath, "utf8");
    const methods = [
      ...source.matchAll(
        /^export (?:async )?function (GET|POST|PATCH|DELETE|PUT)\b/gm,
      ),
    ].map((match) => match[1]);
    assert.ok(methods.length > 0, `Operator route exports no HTTP methods: ${repositoryPath}`);
    for (const method of methods) {
      const boundary = `${method} ${repositoryPath}`;
      assert.ok(
        inventory.includes(boundary),
        `Operator route method is missing from the capability inventory: ${method} ${repositoryPath}`,
      );
    }
  }

  const commandSource = readFileSync(commandPath, "utf8");
  const recoveryStart = commandSource.indexOf("const recoveryCommands = {");
  const recoveryEnd = commandSource.indexOf(
    "} satisfies Record<string, RecoveryCommandSpec>;",
    recoveryStart,
  );
  const definitionsStart = commandSource.indexOf("const commandDefinitions = [");
  const definitionsEnd = commandSource.indexOf("] as const;", definitionsStart);
  assert.ok(
    recoveryStart >= 0 && recoveryEnd > recoveryStart &&
      definitionsStart >= 0 && definitionsEnd > definitionsStart,
    "CLI command definitions could not be read",
  );
  const commandNames = new Set([
    ...commandSource.slice(recoveryStart, recoveryEnd)
      .matchAll(/^\s*"([^"]+)": \{/gm)
      .map((match) => match[1]),
    ...commandSource.slice(definitionsStart, definitionsEnd)
      .matchAll(/^\s*name: "([^"]+)",/gm)
      .map((match) => match[1]),
  ]);
  for (const commandName of commandNames) {
    assert.match(
      inventory,
      new RegExp(`rip-dvd ${commandName}(?:[\\s\x60,]|$)`),
      `CLI command is missing from the capability inventory: ${commandName}`,
    );
  }

  const coveragePaths = new Set(
    [...inventory.matchAll(/`((?:apps|scripts)\/[^`]+(?:\.test\.[cm]?[jt]sx?|\.e2e\.[cm]?[jt]s|\.sh))`/g)]
      .map((match) => match[1]),
  );
  assert.ok(coveragePaths.size > 0, "No behavior coverage paths were found");
  for (const coveragePath of coveragePaths) {
    assert.ok(
      existsSync(join(repositoryRoot, coveragePath)),
      `Inventory coverage path does not exist: ${coveragePath}`,
    );
  }
});
