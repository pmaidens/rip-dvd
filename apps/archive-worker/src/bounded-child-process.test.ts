import { expect, it } from "vitest";

import { startNodeAuthorizedBoundedCommandProcess } from
  "./bounded-child-process.js";

it("keeps a helper gated until the caller authorizes it", async () => {
  const active = startNodeAuthorizedBoundedCommandProcess({
    executable: process.execPath,
    arguments_: [
      "-e",
      `const fs = require("node:fs");
       fs.writeSync(3, "synthetic-ready\\n");
       const authorization = Buffer.alloc(1);
       fs.readSync(4, authorization, 0, 1, null);
       process.stdout.write(authorization);`,
    ],
    authorizationPayload: "1",
    authorizationReadyMessage: "synthetic-ready\n",
    maxOutputBytes: 16,
    operationName: "Synthetic authorized helper",
  });

  await active.ready;
  let settled = false;
  void active.result.finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);

  active.authorize();
  await expect(active.result).resolves.toMatchObject({
    exitCode: 0,
    signal: null,
    stdout: Buffer.from("1"),
  });
  await active.closed;
});
