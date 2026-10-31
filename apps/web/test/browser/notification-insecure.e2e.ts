import { expect, test } from "@playwright/test";

test("explains insecure notification origins without prompting", async ({ page }) => {
  await page.goto("/settings#notifications");
  await expect(page.getByText("Notifications require a secure HTTPS origin.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable notifications", exact: true })).toBeDisabled();
});
