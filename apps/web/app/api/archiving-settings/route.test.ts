import { expect, it } from "vitest";

import { createOperatorWorkflowFixture } from "../../../../operator-cli/src/operator-workflow.test-support.js";
import { createArchivingSettingsRoute } from "./route";

it("shares the setting, strict validation, and replay with the JSON CLI", async () => {
  const fixture = createOperatorWorkflowFixture();
  const origin = "http://operator.example";
  const url = `${origin}/api/archiving-settings`;
  const access = fixture.openAccess();
  const request = (input: Request) =>
    createArchivingSettingsRoute(input, () => access, () => origin);
  const write = (body: unknown, requestOrigin = origin) => request(new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: requestOrigin, Host: "operator.example" },
    body: JSON.stringify(body),
  }));
  const cliRead = ["archiving-settings", "get"];
  const disabled = { schemaVersion: 1, automaticallyArchiveInsertedDvds: false };
  const enabled = { schemaVersion: 1, automaticallyArchiveInsertedDvds: true };

  try {
    const initial = await request(new Request(url));
    expect(initial.headers.get("Cache-Control")).toBe("no-store");
    expect(await initial.json()).toEqual(disabled);
    expect((await write(enabled, "http://another.example")).status).toBe(403);
    const mutationKey = "synthetic-archiving-http";
    const invalid = await write({ mutationKey, automaticallyArchiveInsertedDvds: "true" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
    expect((await write(enabled)).status).toBe(400);
    expect((await fixture.run(cliRead)).result).toEqual(disabled);

    const saved = await write({ mutationKey, automaticallyArchiveInsertedDvds: true });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual(enabled);
    expect((await fixture.run(cliRead)).result).toEqual(enabled);

    const cliWrite = await fixture.run([
      "archiving-settings", "set", "--key", "synthetic-archiving-cli", "--enabled", "false",
    ]);
    expect(cliWrite).toMatchObject({ exitCode: 0, result: disabled });
    const replay = await write({ mutationKey, automaticallyArchiveInsertedDvds: true });
    expect(await replay.json()).toEqual(enabled);
    const conflict = await write({ mutationKey, automaticallyArchiveInsertedDvds: false });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "MUTATION_KEY_CONFLICT" } });
    expect(await (await request(new Request(url))).json()).toEqual(disabled);
  } finally {
    access.close();
    fixture.dispose();
  }
});
