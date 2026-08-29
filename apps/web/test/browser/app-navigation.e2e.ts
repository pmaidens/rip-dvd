import { expect, test } from "@playwright/test";

test("keeps page navigation available after scrolling", async ({ page }) => {
  await page.goto("/catalog");

  const navigation = page.getByRole("navigation", {
    name: "Primary navigation",
  });
  await expect(navigation).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight > window.innerHeight,
    ),
  ).toBe(true);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect
    .poll(() =>
      navigation.evaluate((element) => element.getBoundingClientRect().top),
    )
    .toBe(0);

  await navigation.getByRole("link", { name: "Encoding" }).click();

  await expect(page).toHaveURL("/encoding");
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" }).getByRole(
      "link",
      { name: "Encoding" },
    ),
  ).toHaveAttribute("aria-current", "page");
});
