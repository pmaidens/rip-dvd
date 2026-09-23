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
