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

test("queues a first-encode worklist with partial failure recovery", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const variant = fixtureVariant(testInfo.project.name);
  await page.goto("/encoding");

  const manager = page.getByRole("region", { name: "Queue Encode Jobs" });
  const notEncoded = manager.getByRole("button", { name: /Not encoded \d+/ });
  const reEncode = manager.getByRole("button", { name: /Re-encode \d+/ });
  await expect(notEncoded).toHaveAttribute("aria-pressed", "true");
  await expect(reEncode).toHaveAttribute("aria-pressed", "false");

  const profile = manager.getByRole("combobox", {
    name: "Worklist Encoding Profile",
  });
  const nextSelections = manager.getByRole("button", {
    name: "Next reviewed selections",
  });
  await tabTo(page, nextSelections);
  await expectVisibleKeyboardFocus(nextSelections);
  const search = manager.getByRole("searchbox", {
    name: "Search reviewed Disc Selections",
  });
  await tabTo(page, search);
  await expectVisibleKeyboardFocus(search);
  const targetQuery = `Queue new ${variant}`;
  await expect(manager.getByRole("option", {
    name: new RegExp(`^${targetQuery} \\(2026\\)`),
  })).toHaveCount(0);
  const searchResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/encode-jobs" &&
      url.searchParams.get("query") === targetQuery &&
      url.searchParams.get("selectionOffset") === "0";
  });
  await search.fill(targetQuery);
  await search.press("Enter");
  expect((await searchResponse).status()).toBe(200);
  await expect(manager).toContainText("Showing 1 of 1 matches");

  const newSelection = manager.getByRole("checkbox", {
    name: `Select Queue new ${variant} (2026) · DVD main feature`,
  });
  await tabTo(page, newSelection);
  await expectVisibleKeyboardFocus(newSelection);
  await page.keyboard.press("Space");
  await expect(newSelection).toBeChecked();

  await manager.getByRole("button", { name: "Clear search" }).click();
  await nextSelections.click();
  await expect(manager.getByText("1 selected", { exact: true }).first())
    .toBeVisible();

  const secondSelection = manager.getByRole("checkbox", {
    name: `Select Queue second ${variant} (2026) · DVD title 1`,
  });
  const conflictSelection = manager.getByRole("checkbox", {
    name: `Select Queue conflict ${variant} (2026) · DVD title 2`,
  });

  await search.fill(`Queue second ${variant}`);
  await search.press("Enter");
  await secondSelection.check();

  await search.fill(`Queue conflict ${variant}`);
  await search.press("Enter");
  await conflictSelection.check();
  await expect(manager.getByText("3 selected", { exact: true }).first())
    .toBeVisible();

  await tabTo(page, reEncode);
  await expectVisibleKeyboardFocus(reEncode);
  await page.keyboard.press("Enter");
  await expect(reEncode).toHaveAttribute("aria-pressed", "true");
  await expect(manager.getByText("3 selected", { exact: true }).first())
    .toBeVisible();
  await expect(manager).toContainText(
    `Queue completed ${variant} (2026) · DVD main feature`,
  );

  await notEncoded.click();
  await expect(manager.getByText("3 selected", { exact: true }).first())
    .toBeVisible();
  await expect(conflictSelection).toBeChecked();

  const addSelected = manager.getByRole("button", {
    name: /Add selected to batch/,
  });
  await addSelected.click();
  await expect(manager.getByRole("row", { name: new RegExp(`Queue new ${variant}`) }))
    .toBeVisible();
  await expect(manager.getByRole("row", { name: new RegExp(`Queue second ${variant}`) }))
    .toBeVisible();
  await expect(manager.getByRole("row", { name: new RegExp(`Queue conflict ${variant}`) }))
    .toBeVisible();

  await tabTo(page, profile);
  await expectVisibleKeyboardFocus(profile);
  await profile.selectOption({ label: `Queue browser profile ${variant} · Version 1` });

  const newRow = manager.getByRole("row", {
    name: new RegExp(`Queue new ${variant}`),
  });
  const conflictRow = manager.getByRole("row", {
    name: new RegExp(`Queue conflict ${variant}`),
  });
  const newOutputPath = newRow.getByRole("textbox", {
    name: `Final output path for Queue new ${variant}`,
  });
  await expect(newOutputPath).toBeEditable();
  await newOutputPath.fill(
    (await newOutputPath.inputValue()).replace(
      /\.mkv$/,
      ` operator choice ${variant}.mkv`,
    ),
  );
  const conflictOutputPath = conflictRow.getByRole("textbox", {
    name: `Final output path for Queue conflict ${variant}`,
  });
  const correctedConflictPath = await conflictOutputPath.inputValue();
  await conflictOutputPath.fill(
    correctedConflictPath.replace(
      /Queue conflict.*\.mkv$/,
      `Queue completed ${variant} authoritative.mkv`,
    ),
  );

  const postStatuses: number[] = [];
  page.on("response", (response) => {
    if (
      response.url().endsWith("/api/encode-jobs") &&
      response.request().method() === "POST"
    ) {
      postStatuses.push(response.status());
    }
  });

  const queueBatch = manager.getByRole("button", {
    name: "Queue 3 Encode Jobs",
  });
  await tabTo(page, queueBatch);
  await expectVisibleKeyboardFocus(queueBatch);
  await page.keyboard.press("Enter");
  await expect(manager.getByRole("status")).toContainText(
    "2 Encode Jobs queued. 1 failed.",
  );
  expect(postStatuses).toEqual([200, 200, 409]);
  await expect(newRow).toContainText("Queued");
  await expect(conflictRow).toContainText("Failed");
  await expect(conflictRow).toContainText("Encode Job output is already assigned");

  await conflictOutputPath.fill(correctedConflictPath);
  const retryFailed = manager.getByRole("button", {
    name: "Retry 1 failed Encode Job",
  });
  await retryFailed.click();
  await expect(manager.getByRole("status")).toContainText(
    "1 Encode Job queued. 0 failed.",
  );
  expect(postStatuses).toEqual([200, 200, 409, 200]);
  await expect(conflictRow).toContainText("Queued");
  await expect(manager.getByRole("button", { name: "Queue 0 Encode Jobs" }))
    .toBeDisabled();

  await reEncode.click();
  const reEncodeSelection = manager.getByRole("combobox", {
    name: "Reviewed Disc Selection",
  });
  await reEncodeSelection.selectOption({
    label: `Queue completed ${variant} (2026) · DVD main feature · Encoded before · Queue browser profile ${variant} version 1 · Completed`,
  });
  const reEncodePath = manager.getByRole("textbox", {
    name: "Re-encode final output path",
  });
  await expect(reEncodePath).toHaveAttribute("readonly", "");
  const requeueResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/encode-jobs") &&
    response.request().method() === "PATCH"
  );
  await manager.getByRole("button", { name: "Re-encode", exact: true }).click();
  expect((await requeueResponse).status()).toBe(200);
  expect(postStatuses).toEqual([200, 200, 409, 200]);
  await expectNoPageOverflow(page);
});
