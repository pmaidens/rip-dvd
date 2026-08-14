import { expect, type Locator, type Page, test } from "@playwright/test";

function fixtureVariant(projectName: string): "desktop" | "mobile" {
  return projectName === "desktop" ? "desktop" : "mobile";
}

const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";

async function tabTo(page: Page, target: Locator, limit = 300): Promise<void> {
  await expect(target).toBeVisible();
  for (let index = 0; index < limit; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`Keyboard focus did not reach ${await target.getAttribute("name") ?? await target.textContent()}`);
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
    const viewportWidth = root.clientWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .map((element) => ({
        element,
        rectangle: element.getBoundingClientRect(),
      }))
      .filter(({ rectangle }) =>
        rectangle.right > viewportWidth + 1 || rectangle.left < -1
      )
      .slice(0, 8)
      .map(({ element, rectangle }) => ({
        tag: element.tagName.toLowerCase(),
        className: element.className,
        text: element.textContent?.trim().slice(0, 80),
        left: rectangle.left,
        right: rectangle.right,
      }));
    return {
      clientWidth: viewportWidth,
      scrollWidth: root.scrollWidth,
      offenders,
    };
  });
  expect(
    result.scrollWidth,
    `Horizontal overflow: ${JSON.stringify(result.offenders)}`,
  ).toBeLessThanOrEqual(result.clientWidth);
}

async function openCatalogReview(page: Page, discLabel: string): Promise<void> {
  await page.goto("/catalog");
  const archive = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: discLabel, exact: true }),
  });
  const open = archive.getByRole("button", { name: "Review catalog" });
  await tabTo(page, open);
  await expectVisibleKeyboardFocus(open);
  await page.keyboard.press("Enter");
  await expect(page.locator("#catalog-editor-title")).toBeVisible();
}

function titleEvidence(page: Page, titleNumber: number): Locator {
  return page.locator("li").filter({
    has: page.getByRole("heading", { name: `Title ${titleNumber}`, exact: true }),
  }).filter({ hasText: "Title Suggestion" }).first();
}

test("keyboard-only mapping and job-free correction announce their results", async ({ page }, testInfo) => {
  const variant = fixtureVariant(testInfo.project.name);
  await openCatalogReview(
    page,
    `CATALOG_BROWSER_KEYBOARD_${variant.toUpperCase()}`,
  );

  await expect(page.getByRole("heading", { name: "Archived Scan Evidence", level: 3 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review Coverage", level: 3 })).toBeVisible();
  const mapMovie = titleEvidence(page, 1).getByRole("button", { name: "Map as movie" });
  const mapBonus = titleEvidence(page, 1).getByRole("button", { name: "Map as bonus feature" });
  await tabTo(page, mapMovie);
  await expectVisibleKeyboardFocus(mapMovie);
  await page.keyboard.press("Tab");
  await expect(mapBonus).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Mapping Proposal", level: 4 })).toBeVisible();
  const title = page.getByLabel("Title", { exact: true });
  await tabTo(page, title);
  await expectVisibleKeyboardFocus(title);
  await page.keyboard.press(selectAllShortcut);
  await page.keyboard.type(`Keyboard mapped movie ${variant}`);
  const create = page.getByRole("button", { name: "Create Media Item and Disc Selection" });
  await tabTo(page, create);
  const mappingResponse = page.waitForResponse((response) =>
    response.url().includes("/api/catalog-reviews/") &&
    response.request().method() === "POST"
  );
  await page.keyboard.press("Enter");
  expect((await mappingResponse).status()).toBe(201);
  await expect(page.getByRole("status").filter({
    hasText: "Mapping changed; review required",
  })).toBeVisible();
  await expect(titleEvidence(page, 1).getByText("Mapped", { exact: true })).toBeVisible();

  const catalogAction = page.getByLabel("Catalog action");
  await tabTo(page, catalogAction);
  await expectVisibleKeyboardFocus(catalogAction);
  await page.keyboard.type("Edit Disc Selection");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("heading", { name: "Edit Disc Selection", level: 3 })).toBeVisible();
  const dvdTitle = page.getByRole("combobox", {
    name: "DVD title",
    exact: true,
  });
  await tabTo(page, dvdTitle);
  await page.keyboard.type("Title 2");
  await page.keyboard.press("Tab");
  const save = page.getByRole("button", { name: "Save Disc Selection" });
  await tabTo(page, save);
  const correctionResponse = page.waitForResponse((response) =>
    response.url().includes("/api/catalog-reviews/") &&
    response.request().method() === "POST"
  );
  await page.keyboard.press("Enter");
  expect((await correctionResponse).status()).toBe(200);
  await expect(page.getByRole("status").filter({
    hasText: "Mapping changed; review required",
  })).toBeVisible();
  await expect(titleEvidence(page, 1).getByText("Unmapped", { exact: true })).toBeVisible();
  await expect(titleEvidence(page, 2).getByText("Mapped", { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
});

test("complex Catalog Review remains responsive and exposes accessible state", async ({ page }, testInfo) => {
  const variant = fixtureVariant(testInfo.project.name);
  await openCatalogReview(
    page,
    pageLabel(variant),
  );

  const coverageFilters = page.getByRole("group", { name: "Title coverage filter" });
  await expect(coverageFilters.getByRole("button", {
    name: "All",
    exact: true,
  })).toHaveAttribute("aria-pressed", "true");
  await expect(titleEvidence(page, 1).getByText("Mapped", { exact: true })).toBeVisible();
  await expect(titleEvidence(page, 3).getByText("Partially mapped", { exact: true })).toBeVisible();
  await expect(titleEvidence(page, 4).getByText("Unmapped", { exact: true })).toBeVisible();

  const technicalDetails = titleEvidence(page, 1).getByText("Technical stream details", { exact: true });
  const details = technicalDetails.locator("..");
  await expect(details).not.toHaveAttribute("open", "");
  await tabTo(page, technicalDetails);
  await expectVisibleKeyboardFocus(technicalDetails);
  await page.keyboard.press("Enter");
  await expect(details).toHaveAttribute("open", "");
  await expect(titleEvidence(page, 1).getByRole("region", { name: "Title 1 audio streams" })).toBeVisible();

  const partialFilter = coverageFilters.getByRole("button", { name: "Partially mapped" });
  await tabTo(page, partialFilter);
  await page.keyboard.press("Enter");
  await expect(partialFilter).toHaveAttribute("aria-pressed", "true");
  await expect(titleEvidence(page, 3)).toBeVisible();
  await expect(titleEvidence(page, 4)).toBeHidden();
  const allFilter = coverageFilters.getByRole("button", {
    name: "All",
    exact: true,
  });
  await tabTo(page, allFilter);
  await page.keyboard.press("Enter");

  for (const titleNumber of [4, 5]) {
    const choice = page.getByLabel(`Select Title ${titleNumber} for episodic mapping`);
    await tabTo(page, choice);
    await page.keyboard.press("Space");
  }
  await expect(page.getByText("2 selected titles", { exact: true })).toBeVisible();
  const startingEpisode = page.getByLabel("Starting episode number");
  await tabTo(page, startingEpisode);
  await page.keyboard.press(selectAllShortcut);
  await page.keyboard.type("7");
  const createProposal = page.getByRole("button", { name: "Create episodic proposal" });
  await tabTo(page, createProposal);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Episodic Mapping Proposal", level: 4 })).toBeVisible();
  await expect(page.getByLabel("Episode number", { exact: true }).first()).toHaveValue("7");
  await expect(page.getByLabel("Episode number", { exact: true }).nth(1)).toHaveValue("8");

  const createNewShow = page.getByLabel("Create new TV Show");
  await tabTo(page, createNewShow);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByLabel("Use existing TV Show")).toBeChecked();
  const episodicForm = page.getByRole("heading", { name: "Episodic Mapping Proposal" })
    .locator("xpath=ancestor::section[1]//form");
  const submitProposal = page.getByRole("button", {
    name: "Create episodic hierarchy and Disc Selections",
  });
  await tabTo(page, submitProposal);
  await page.keyboard.press("Enter");
  const proposalError = page.getByRole("alert").filter({
    hasText: "Select an existing TV Show before saving.",
  });
  await expect(proposalError).toBeVisible();
  await expect(episodicForm).toHaveAttribute("aria-describedby", await proposalError.getAttribute("id") ?? "");

  const replacementGroup = page.getByRole("group", { name: "Corrected replacement encodes" });
  await expect(replacementGroup.getByLabel("Queue corrected replacement")).toBeVisible();
  await expect(replacementGroup.getByLabel("Encoding Profile")).toHaveAccessibleName("Encoding Profile");
  await expect(replacementGroup.getByLabel("Final output path")).toHaveAccessibleName("Final output path");
  await expect(replacementGroup.getByRole("status").filter({
    hasText: "Predecessor ready",
  })).toBeVisible();

  const lockedSelection = page.getByText("Locked provenance", { exact: true }).locator("xpath=ancestor::li[1]");
  await expect(lockedSelection).toContainText("correct this Disc Selection by supersession");
  await expect(lockedSelection.getByRole("button", { name: "Remove Disc Selection" })).toHaveCount(0);
  const archiveOnly = page.getByLabel(/Archive only —/);
  await expect(archiveOnly).toBeDisabled();
  const explanationId = await archiveOnly.getAttribute("aria-describedby");
  expect(explanationId).toBeTruthy();
  await expect(page.locator(`#${explanationId}`)).toContainText("unavailable while Disc Selections are active");
  await expectNoPageOverflow(page);
});

function pageLabel(variant: "desktop" | "mobile"): string {
  return `CATALOG_BROWSER_LAYOUT_${variant.toUpperCase()}_${"UNBROKEN-CATALOG-LABEL-".repeat(8)}`.slice(0, 256);
}
