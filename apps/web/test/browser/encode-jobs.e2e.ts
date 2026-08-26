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

test("queues a mixed worklist after resolving a new shared profile", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const variant = fixtureVariant(testInfo.project.name);
  await page.goto("/encoding");

  const manager = page.getByRole("region", { name: "Queue Encode Jobs" });
  const notEncoded = manager.getByRole("button", { name: /Not encoded \d+/ });
  const reEncode = manager.getByRole("button", { name: /Re-encode \d+/ });
  await expect(notEncoded).toHaveAttribute("aria-pressed", "true");

  const profile = manager.getByRole("combobox", {
    name: "Worklist Encoding Profile",
  });
  await tabTo(page, profile);
  await expectVisibleKeyboardFocus(profile);
  await profile.selectOption({
    label: `Queue browser profile ${variant} · Version 1`,
  });

  const search = manager.getByRole("searchbox", {
    name: "Search reviewed Disc Selections",
  });
  const checkSelection = async (title: string, source: string) => {
    await search.fill(title);
    await search.press("Enter");
    const checkbox = manager.getByRole("checkbox", {
      name: `Select ${title} (2026) · ${source}`,
    });
    await expect(checkbox).toBeVisible();
    await checkbox.check();
    return checkbox;
  };

  await search.fill(`Queue new ${variant}`);
  await search.press("Enter");
  const newSelection = manager.getByRole("checkbox", {
    name: `Select Queue new ${variant} (2026) · DVD main feature`,
  });
  await tabTo(page, newSelection);
  await expectVisibleKeyboardFocus(newSelection);
  await page.keyboard.press("Space");
  await expect(newSelection).toBeChecked();
  await checkSelection(`Queue failed ${variant}`, "DVD main feature");
  await checkSelection(`Queue second ${variant}`, "DVD title 1");
  await checkSelection(`Queue conflict ${variant}`, "DVD title 2");

  await tabTo(page, reEncode);
  await expectVisibleKeyboardFocus(reEncode);
  await page.keyboard.press("Enter");
  await expect(reEncode).toHaveAttribute("aria-pressed", "true");
  await checkSelection(`Queue completed ${variant}`, "DVD main feature");
  await expect(manager.getByText("5 selected", { exact: true }).first())
    .toBeVisible();

  await manager.getByRole("button", { name: /Add selected to worklist/ })
    .click();
  const row = (title: string) => manager.getByRole("textbox", {
    name: `Final output path for ${title}`,
  }).locator("xpath=ancestor::tr");
  const newRow = row(`Queue new ${variant}`);
  const failedRow = row(`Queue failed ${variant}`);
  const secondRow = row(`Queue second ${variant}`);
  const conflictRow = row(`Queue conflict ${variant}`);
  const completedRow = row(`Queue completed ${variant}`);
  await expect(newRow).toContainText("New Encode Job");
  await expect(failedRow).toContainText("Retry");
  await expect(completedRow).toContainText("Re-encode");
  await expect(manager.getByRole("button", { name: "Queue 5 Encode Jobs" }))
    .toBeEnabled();

  const outputPath = (targetRow: Locator, title: string) =>
    targetRow.getByRole("textbox", {
      name: `Final output path for ${title}`,
    });
  const newOutput = outputPath(newRow, `Queue new ${variant}`);
  const failedOutput = outputPath(failedRow, `Queue failed ${variant}`);
  const completedOutput = outputPath(
    completedRow,
    `Queue completed ${variant}`,
  );
  const conflictOutput = outputPath(conflictRow, `Queue conflict ${variant}`);
  await expect(newOutput).toBeEditable();
  await expect(failedOutput).toHaveAttribute("readonly", "");
  await expect(completedOutput).toHaveAttribute("readonly", "");
  await expect(failedRow).toContainText(
    "The existing logical Encode Job retains this output reservation.",
  );
  const completedAuthoritativePath = await completedOutput.inputValue();
  const preservedConflictPath = (await conflictOutput.inputValue()).replace(
    /\.mkv$/,
    ` operator choice ${variant}.mkv`,
  );
  await conflictOutput.fill(preservedConflictPath);

  const resolutionResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/encode-jobs" &&
      url.searchParams.get("encodingProfileId") !== null &&
      url.searchParams.has("resolveDiscSelectionId");
  });
  await profile.selectOption({
    label: `Queue alternate profile ${variant} · Version 1`,
  });
  expect((await resolutionResponse).status()).toBe(200);

  await expect(newRow).toContainText("Retry");
  await expect(newOutput).toHaveAttribute("readonly", "");
  await expect(newOutput).toHaveValue(
    new RegExp(`Queue new ${variant} alternate authoritative\\.mkv$`),
  );
  await expect(failedRow).toContainText("New Encode Job");
  await expect(failedOutput).toBeEditable();
  await expect(completedRow).toContainText("New Encode Job");
  await expect(completedOutput).toBeEditable();
  await expect(completedRow).toContainText(
    "It cannot replace another logical job's final output.",
  );
  await expect(secondRow).toContainText("Already queued");
  await expect(outputPath(secondRow, `Queue second ${variant}`))
    .toHaveAttribute("readonly", "");
  await expect(conflictOutput).toHaveValue(preservedConflictPath);
  await expect(manager.getByRole("button", { name: "Queue 4 Encode Jobs" }))
    .toBeEnabled();

  await conflictOutput.fill(completedAuthoritativePath);
  const mutations: Array<{ method: string; status: number }> = [];
  page.on("response", (response) => {
    const method = response.request().method();
    if (
      response.url().endsWith("/api/encode-jobs") &&
      (method === "POST" || method === "PATCH")
    ) {
      mutations.push({ method, status: response.status() });
    }
  });

  const queueMixed = manager.getByRole("button", {
    name: "Queue 4 Encode Jobs",
  });
  await tabTo(page, queueMixed);
  await expectVisibleKeyboardFocus(queueMixed);
  await page.keyboard.press("Enter");
  await expect(manager.getByRole("status")).toContainText(
    "2 new jobs queued. 1 retry or re-encode queued. 1 row unavailable. 1 failed.",
  );
  expect(mutations).toEqual([
    { method: "PATCH", status: 200 },
    { method: "POST", status: 200 },
    { method: "POST", status: 409 },
    { method: "POST", status: 200 },
  ]);
  await expect(newRow).toContainText("Queued");
  await expect(failedRow).toContainText("Queued");
  await expect(completedRow).toContainText("Queued");
  await expect(conflictRow).toContainText("Failed");
  await expect(conflictRow).toContainText("Encode Job output is already assigned");

  await notEncoded.click();
  await checkSelection(`Queue filler ${variant} 000`, "DVD title 1");
  await manager.getByRole("button", { name: /Add selected to worklist/ })
    .click();
  const laterRow = row(`Queue filler ${variant} 000`);
  await expect(laterRow).toContainText("Ready");

  await conflictOutput.fill(preservedConflictPath);
  await manager.getByRole("button", { name: "Retry 1 failed Encode Job" })
    .click();
  await expect(manager.getByRole("status")).toContainText(
    "1 new job queued. 0 retries or re-encodes queued. 1 row unavailable. 0 failed.",
  );
  expect(mutations.at(-1)).toEqual({ method: "POST", status: 200 });
  await expect(conflictRow).toContainText("Queued");
  await expect(laterRow).toContainText("Ready");

  await manager.getByRole("button", { name: "Queue 1 Encode Job" }).click();
  await expect(manager.getByRole("status")).toContainText(
    "1 new job queued. 0 retries or re-encodes queued. 1 row unavailable. 0 failed.",
  );
  await expect(laterRow).toContainText("Queued");
  expect(mutations).toHaveLength(6);
  await expect(manager.getByRole("button", { name: "Queue 0 Encode Jobs" }))
    .toBeDisabled();
  await expectNoPageOverflow(page);
});
