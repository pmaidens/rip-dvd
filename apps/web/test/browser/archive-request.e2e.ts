import { expect, test } from "@playwright/test";

test("requests an archive on an ordinary HTTP origin", async ({ page }, testInfo) => {
  const variant = testInfo.project.name === "desktop" ? "desktop" : "mobile";
  await page.goto("/discs");
  // Assert the actual browser capability, not a mocked version of crypto.
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");

  const disc = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: `HTTP archive fixture ${variant}`, exact: true }),
  });
  const response = page.waitForResponse((response) =>
    response.url().endsWith("/api/archive-requests") && response.request().method() === "POST",
  );
  await disc.getByRole("button", { name: "Request archive", exact: true }).click();
  expect((await response).status()).toBe(201);
  await expect(disc.getByRole("region", { name: "Archive Request" })).toBeVisible();
  await expect(disc.getByRole("button", { name: "Cancel request", exact: true })).toBeVisible();
  await page.reload();
  await expect(disc.getByRole("button", { name: "Cancel request", exact: true })).toBeVisible();
});

test("shows the saved archive and active recovery as one truthful artifact", async ({
  page,
}, testInfo) => {
  const variant = testInfo.project.name === "desktop" ? "desktop" : "mobile";
  const discLabel = `ARCHIVE_ARTIFACT_BROWSER_${variant.toUpperCase()}`;
  await page.goto("/discs");

  const artifact = page.getByRole("article", {
    name: `${discLabel} archive artifact`,
  });
  await expect(artifact).toBeVisible();
  const initial = artifact.getByRole("region", { name: "Initial preservation" });
  await expect(initial.getByText("Archive Request", { exact: true })).toBeVisible();
  await expect(initial.getByText("fulfilled", { exact: true })).toBeVisible();
  await expect(initial.getByText("Initial Archive Job", { exact: true })).toBeVisible();
  await expect(initial.getByText("completed", { exact: true })).toBeVisible();

  const recovery = artifact.getByRole("region", { name: "Archive Recovery" });
  await expect(recovery.getByText("Revision 1", { exact: true })).toBeVisible();
  await expect(recovery.getByText("1 sector", { exact: true })).toHaveCount(2);
  await expect(recovery.getByText("0 sectors", { exact: true })).toHaveCount(2);

  const readiness = artifact.getByRole("region", { name: "Archive readiness" });
  await expect(readiness.getByText("Not stable", { exact: true })).toBeVisible();
  await expect(readiness.getByText("Current", { exact: true })).toBeVisible();
  await expect(readiness.getByText("Not ready", { exact: true })).toBeVisible();

  const actions = artifact.locator(".archive-artifact-actions");
  await actions.getByText("Recovery actions", { exact: true }).click();
  const stop = actions.locator(".archive-artifact-action").filter({
    has: page.getByText("Stop", { exact: true }),
  });
  await expect(stop.getByText("Available", { exact: true })).toBeVisible();
  const resume = actions.locator(".archive-artifact-action").filter({
    has: page.getByText("Resume", { exact: true }),
  });
  await expect(resume.getByText("Unavailable", { exact: true })).toBeVisible();

  await actions.getByRole("button", {
    name: "Stop and keep archive",
    exact: true,
  }).click();
  await expect(artifact.locator(".status-stopping")).toHaveCount(2);
  await expect(initial.getByText("completed", { exact: true })).toBeVisible();
});
