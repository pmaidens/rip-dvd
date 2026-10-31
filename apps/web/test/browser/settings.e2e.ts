import { expect, test } from "@playwright/test";

test("opens Settings from primary navigation with an addressable Notifications section", async ({ page }) => {
  await page.goto("/encoding");
  const primary = page.getByRole("navigation", { name: "Primary navigation" });
  await primary.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL("/settings");
  await expect(primary.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(primary.getByRole("link", { name: "Notifications", exact: true })).toHaveCount(0);
  await expect(page.getByRole("main")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  await sections.getByRole("link", { name: "Notifications", exact: true }).click();
  await expect(page).toHaveURL("/settings#notifications");
  await expect(page.getByRole("region", { name: "Notifications", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent deliveries", level: 3 })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL("/settings");
  await page.goForward();
  await expect(page).toHaveURL("/settings#notifications");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Notifications", level: 2 })).toBeVisible();
});

test("opens a section directly and reaches its controls by keyboard without horizontal overflow", async ({ page }) => {
  await page.goto("/settings#notifications");
  await expect(page.getByRole("region", { name: "Notifications", exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Notifications cannot be enabled until server setup is complete.");
  const link = page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Notifications" });
  await link.focus();
  await expect(link).toBeFocused();
  expect(await link.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/settings#notifications");
  await page.keyboard.press("Tab");
  const refresh = page.getByRole("button", { name: "Check notification status" });
  await expect(refresh).toBeFocused();
  expect(await refresh.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toHaveText("Notifications cannot be enabled until server setup is complete.");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
