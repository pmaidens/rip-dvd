import { expect, it } from "vitest";

import { createOperatorWorkflowFixture } from "./operator-workflow.test-support.js";

it("persists explicit automatic archiving settings and replays a write without applying it again", async () => {
  const fixture = createOperatorWorkflowFixture();
  const read = ["archiving-settings", "get"];
  const set = (key: string, enabled: string) =>
    fixture.run(["archiving-settings", "set", "--key", key, "--enabled", enabled]);
  const disabled = { schemaVersion: 1, automaticallyArchiveInsertedDvds: false };
  const enabled = { schemaVersion: 1, automaticallyArchiveInsertedDvds: true };

  try {
    expect(await fixture.run(read)).toMatchObject({ exitCode: 0, result: disabled });
    expect(await set("synthetic-archiving-on", "true")).toMatchObject({ exitCode: 0, result: enabled });
    expect(await fixture.run(read)).toMatchObject({ exitCode: 0, result: enabled });
    expect(await set("synthetic-archiving-on", "false")).toMatchObject({
      exitCode: 2, result: { error: { code: "MUTATION_KEY_CONFLICT" } },
    });
    expect(await set("synthetic-archiving-invalid", "yes")).toMatchObject({
      exitCode: 2, result: { error: { code: "INVALID_ARGUMENTS" } },
    });
    expect(await fixture.run(["archiving-settings", "set", "--enabled", "false"])).toMatchObject({
      exitCode: 2, result: { error: { code: "INVALID_MUTATION_KEY" } },
    });
    expect(await fixture.run(read)).toMatchObject({ exitCode: 0, result: enabled });
    expect(await set("synthetic-archiving-off", "false")).toMatchObject({ exitCode: 0, result: disabled });
    expect(await set("synthetic-archiving-on", "true")).toMatchObject({ exitCode: 0, result: enabled });
    expect(await fixture.run(read)).toMatchObject({ exitCode: 0, result: disabled });
  } finally {
    fixture.dispose();
  }
});
