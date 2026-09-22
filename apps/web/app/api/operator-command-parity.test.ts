import { expect, it } from "vitest";

import { createOperatorWorkflowFixture } from "../../../operator-cli/src/operator-workflow.test-support.js";
import { createDeploymentReadinessResponse } from "./deployment-readiness/route";
import { createHealthResponse } from "./health/route";

it("returns the same health and readiness results through web and CLI adapters", async () => {
  const fixture = createOperatorWorkflowFixture();
  const access = fixture.openAccess();
  try {
    const healthResponse = createHealthResponse(access);
    const readinessResponse = createDeploymentReadinessResponse(access);

    expect(healthResponse.status).toBe(200);
    expect(readinessResponse.status).toBe(200);
    expect(healthResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(readinessResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(fixture.run(["health"]).result).toEqual(await healthResponse.json());
    expect(fixture.run(["readiness"]).result).toEqual(await readinessResponse.json());
  } finally {
    access.close();
    fixture.dispose();
  }
});
