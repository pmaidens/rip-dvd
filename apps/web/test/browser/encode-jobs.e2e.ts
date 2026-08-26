import { expect, type Locator, type Page, test } from "@playwright/test";

function fixtureVariant(projectName: string): "desktop" | "mobile" {
  return projectName === "desktop" ? "desktop" : "mobile";
}

async function tabTo(page: Page, target: Locator, limit = 300): Promise<void> {
  await expect(target).toBeVisible();
  for (let index = 0; index < limit; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error("Keyboard focus did not reach the Queue Encode Jobs control");
}

async function expectVisibleKeyboardFocus(target: Locator): Promise<void> {
  await expect(target).toBeFocused();
  const focusStyle = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(focusStyle.outlineWidth).toBeGreaterThan(0);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const root = document.documentElement;
    return {
      clientWidth: root.clientWidth,
      scrollWidth: root.scrollWidth,
    };
  });
  expect(result.scrollWidth).toBeLessThanOrEqual(result.clientWidth);
}

test("queues one new encode and deliberately requeues completed work", async ({
  page,
}, testInfo) => {
  const variant = fixtureVariant(testInfo.project.name);
  await page.goto("/encoding");

  const manager = page.getByRole("region", { name: "Queue Encode Jobs" });
  const notEncoded = manager.getByRole("button", { name: /Not encoded \d+/ });
  const reEncode = manager.getByRole("button", { name: /Re-encode \d+/ });
  await expect(notEncoded).toHaveAttribute("aria-pressed", "true");
  await expect(reEncode).toHaveAttribute("aria-pressed", "false");

  const profile = manager.getByRole("combobox", {
    name: "Active Encoding Profile",
  });
  await tabTo(page, profile);
  await expectVisibleKeyboardFocus(profile);
  await profile.selectOption({ label: `Queue browser profile ${variant} · Version 1` });

  const selection = manager.getByRole("combobox", {
    name: "Reviewed Disc Selection",
  });
  await selection.selectOption({ label: `Queue new ${variant} (2026) · DVD main feature · Not encoded` });
  const outputPath = manager.getByRole("textbox", { name: "Final output path" });
  await expect(outputPath).toBeEditable();
  await outputPath.fill(
    (await outputPath.inputValue()).replace(
      /\.mkv$/,
      ` operator choice ${variant}.mkv`,
    ),
  );
  const queueNew = manager.getByRole("button", { name: "Queue new Encode Job" });
  const enqueueResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/encode-jobs") &&
    response.request().method() === "POST"
  );
  await queueNew.click();
  expect((await enqueueResponse).status()).toBe(200);

  await tabTo(page, reEncode);
  await expectVisibleKeyboardFocus(reEncode);
  await page.keyboard.press("Enter");
  await expect(reEncode).toHaveAttribute("aria-pressed", "true");
  await expect(manager).toContainText(
    `Queue completed ${variant} (2026) · DVD main feature`,
  );
  await profile.selectOption({ label: `Queue browser profile ${variant} · Version 1` });
  await selection.selectOption({
    label: `Queue completed ${variant} (2026) · DVD main feature · Encoded before · Queue browser profile ${variant} version 1 · Completed`,
  });
  await expect(manager).toContainText(
    `Previously encoded with Queue browser profile ${variant}, version 1 · Completed`,
  );
  await expect(outputPath).toHaveValue(
    new RegExp(`Queue completed ${variant} authoritative\\.mkv$`),
  );
  await expect(outputPath).toHaveAttribute("readonly", "");
  const requeue = manager.getByRole("button", {
    name: "Re-encode",
    exact: true,
  });
  const requeueResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/encode-jobs") &&
    response.request().method() === "PATCH"
  );
  await requeue.click();
  expect((await requeueResponse).status()).toBe(200);

  await notEncoded.click();
  await profile.selectOption({ label: `Queue browser profile ${variant} · Version 1` });
  await selection.selectOption({
    label: `Queue active ${variant} (2026) · DVD main feature · Not encoded`,
  });
  await expect(manager).toContainText("This Encode Job is already queued");
  await expect(manager.getByRole("button", { name: "Already queued" }))
    .toBeDisabled();
  await expectNoPageOverflow(page);
});
