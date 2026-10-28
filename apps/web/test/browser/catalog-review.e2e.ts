import {
  expect,
  type Locator,
  type Page,
  type Response,
  test,
} from "@playwright/test";

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

function waitForCatalogReviewReloads(page: Page, count: number): Promise<void> {
  return new Promise((resolve) => {
    let observed = 0;
    const observe = (response: Response) => {
      if (
        !response.url().includes("/api/catalog-reviews/") ||
        response.request().method() !== "GET"
      ) {
        return;
      }
      observed += 1;
      if (observed === count) {
        page.off("response", observe);
        resolve();
      }
    };
    page.on("response", observe);
  });
}

function damageAcceptanceBrowserPreview(
  state: "available" | "pending" | "outdated",
) {
  const sourceIdentity = {
    displayTitleNumber: 1,
    navigation: {
      videoTitleSetNumber: 1,
      titleSetTitleNumber: 1,
      programChainNumber: 1,
    },
    selectedPath: [{
      programNumber: 1,
      cellNumber: 1,
      vobId: 1,
      cellId: 1,
    }],
    angleNumber: 1,
    angleCount: 1,
    chapterStart: 1,
    chapterEnd: 4,
    chapterCount: 4,
    sourceExtents: [{ startLba: 0, sectorCount: 100 }],
  };
  const assessmentSnapshot = {
    unrecoveredUniqueSourceSectorCount: 4,
    uniqueSourceSectorCount: 100,
    sourceContinuityRiskSectorCount: 1,
    titleMissingSourcePercentage: 4,
    mappingCoverage: { state: "complete", unknownReasons: [] },
    estimatedAffectedPlayback: {
      intervals: [{
        playbackOccurrence: 1,
        startMilliseconds: 1_000,
        endMilliseconds: 5_000,
        timingMethods: ["synthetic-vobu-timing-v1"],
        coverage: "source_span",
      }],
      unknownCoverage: [{
        playbackOccurrence: 3,
        unrecoveredSourceSectorCount: 4,
        reasons: [{
          code: "SYNTHETIC_TIMING_UNKNOWN",
          message: "Timing is unavailable for this playback occurrence.",
        }],
      }],
    },
  };
  const episode = {
    id: "synthetic-browser-episode",
    kind: "episode",
    title: "A Distinct Episode",
    year: 2026,
    seasonNumber: null,
    episodeNumber: 2,
    episodicContext: {
      tvShow: {
        id: "synthetic-browser-show",
        title: "Synthetic Show",
        year: 2024,
      },
      season: {
        id: "synthetic-browser-season",
        title: "Season One",
        year: 2025,
        seasonNumber: 1,
      },
    },
  };
  const mapped = {
    titleIdentityId: "synthetic-browser-title-identity-1",
    titleIdentityObservationId: "synthetic-browser-observation-1",
    included: true,
    mappingState: "mapped",
    preflightMappingState: "mapped",
    reviewContinuity: { result: "proved" },
    sourceIdentity,
    catalogMappings: [{
      discSelectionId: "synthetic-browser-selection",
      discSelectionIdentity: "a".repeat(64),
      mappingState: "mapped",
      sourceIdentity: { kind: "dvd_title", titleNumber: 1 },
      resolvedSourceIdentity: {
        resolution: "title_identity_binding",
        ...sourceIdentity,
      },
      label: null,
      mediaItem: episode,
    }],
    assessmentSnapshot: state === "available" ? assessmentSnapshot : null,
    acknowledgementRequired: state === "available",
  };
  const unmapped = {
    ...mapped,
    titleIdentityId: "synthetic-browser-title-identity-2",
    titleIdentityObservationId: "synthetic-browser-observation-2",
    included: false,
    mappingState: "unmapped",
    preflightMappingState: "unmapped",
    sourceIdentity: {
      ...sourceIdentity,
      displayTitleNumber: 2,
      navigation: {
        videoTitleSetNumber: 2,
        titleSetTitleNumber: 1,
        programChainNumber: 3,
      },
      selectedPath: [{
        programNumber: 2,
        cellNumber: 4,
        vobId: 7,
        cellId: 9,
      }],
    },
    catalogMappings: [],
    assessmentSnapshot: null,
    acknowledgementRequired: false,
  };
  const available = state === "available";
  const reasonCode = state === "pending"
    ? "ASSESSMENT_PENDING"
    : "ASSESSMENT_OUTDATED";
  return {
    schemaVersion: 1,
    evidenceFormat: "dvd-recovery-evidence-v1",
    available,
    previewToken: available
      ? "dvd-title-damage-acceptance-preview:synthetic-browser-token"
      : null,
    action: {
      available,
      reasons: available
        ? []
        : [{
          code: reasonCode,
          message: state === "pending"
            ? "Title Damage Assessment is pending."
            : "Title Damage Assessment is outdated.",
          details: {},
        }],
      expectedInputs: available
        ? ["previewToken", "damageAcknowledgement"]
        : ["excludedTitleIdentityIds", "mainFeatureResolutions"],
    },
    current: null,
    reviewSetIdentity: "b".repeat(64),
    catalogMappingProjectionId: "c".repeat(64),
    assessmentIdentity: available ? `dvd-title-damage-assessment:${"d".repeat(64)}` : null,
    reviewedContentIdentity: "e".repeat(64),
    allContent: [mapped, unmapped],
    reviewedContent: [mapped],
    exclusions: [{
      titleIdentityId: unmapped.titleIdentityId,
      titleIdentityObservationId: unmapped.titleIdentityObservationId,
      displayTitleNumber: 2,
      angleNumber: 1,
    }],
    mainFeatureChoices: [],
    unresolvedSelections: [],
    assessmentSnapshot: available
      ? {
        unknownTitleImpact: {
          unrecoveredSourceSectorCount: 0,
          unrecoveredSourceRanges: [],
          reasons: [],
        },
        unattributedSourceContinuityRisk: {
          sourceSectorCount: 0,
          sourceRanges: [],
        },
      }
      : null,
    acknowledgementRequired: available,
    affectedWork: available
      ? [{
        id: "synthetic-browser-encode-job",
        discSelectionId: "synthetic-browser-selection",
        status: "queued",
      }]
      : [],
    damagePreview: {
      required: false,
      available: false,
      reasons: [{
        code: "DAMAGE_PREVIEW_UNAVAILABLE",
        message: "Damage Preview is optional.",
      }],
    },
  };
}

test("keyboard mapping and job-free correction announce their results", async ({ page }, testInfo) => {
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
  // The mutation reloads the editor, then its dashboard activity event reloads it again.
  const reviewReloads = waitForCatalogReviewReloads(page, 2);
  const mappingResponse = page.waitForResponse((response) =>
    response.url().includes("/api/catalog-reviews/") &&
    response.request().method() === "POST"
  );
  await page.keyboard.press("Enter");
  expect((await mappingResponse).status()).toBe(201);
  await reviewReloads;
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
  await dvdTitle.selectOption("2");
  await expect(dvdTitle.locator("option:checked")).toContainText("Title 2");
  await page.keyboard.press("Tab");
  const save = page.getByRole("button", { name: "Save Disc Selection" });
  await tabTo(page, save);
  const correctionPreviewResponse = page.waitForResponse((response) => {
    if (
      !response.url().includes("/api/catalog-reviews/") ||
      response.request().method() !== "POST"
    ) {
      return false;
    }
    const body = response.request().postDataJSON() as {
      action?: unknown;
      preview?: unknown;
    };
    return body.action === "update_disc_selection" && body.preview === true;
  });
  const correctionResponse = page.waitForResponse((response) => {
    if (
      !response.url().includes("/api/catalog-reviews/") ||
      response.request().method() !== "POST"
    ) {
      return false;
    }
    const body = response.request().postDataJSON() as {
      acknowledge?: unknown;
      action?: unknown;
    };
    return body.action === "update_disc_selection" &&
      body.acknowledge === true;
  });
  const confirmation = new Promise<string>((resolve, reject) => {
    page.once("dialog", (dialog) => {
      const message = dialog.message();
      dialog.accept().then(() => resolve(message), reject);
    });
  });
  await page.keyboard.press("Enter");
  expect((await correctionPreviewResponse).status()).toBe(200);
  expect(await confirmation).toContain(
    "Review this Disc Selection change before applying it.",
  );
  expect((await correctionResponse).status()).toBe(200);
  await expect(page.getByRole("status").filter({
    hasText: "Mapping changed; review required",
  })).toBeVisible();
  await expect(titleEvidence(page, 1).getByText("Unmapped", { exact: true })).toBeVisible();
  await expect(titleEvidence(page, 2).getByText("Mapped", { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
});

test("Review Steps preserve mapping drafts and explain an unavailable damage decision", async ({ page }, testInfo) => {
  const variant = fixtureVariant(testInfo.project.name);
  const discLabel = `CATALOG_BROWSER_DAMAGE_${variant.toUpperCase()}`;
  await page.goto("/catalog");
  const archive = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: discLabel, exact: true }),
  });
  await expect(archive.getByText("Initial Archive Job", { exact: true }))
    .toBeVisible();
  await expect(archive.getByText("Saved", { exact: true })).toBeVisible();
  await expect(archive.getByText("Archive Recovery", { exact: true }))
    .toBeVisible();
  await expect(archive.getByText("Recovering", { exact: true })).toBeVisible();
  await expect(archive.getByText("Unmapped content remains", { exact: true }))
    .toBeVisible();
  const damageReadiness = archive.getByText("Damage decision", {
    exact: true,
  }).locator("..");
  await expect(damageReadiness.getByText("Not ready", { exact: true }))
    .toBeVisible();
  const encodingReadiness = archive.getByText("Encoding readiness", {
    exact: true,
  }).locator("..");
  await expect(encodingReadiness.getByText("Not ready", { exact: true }))
    .toBeVisible();

  await openCatalogReview(page, discLabel);
  const steps = page.getByRole("tablist", { name: "Review Steps" });
  const mapping = steps.getByRole("tab", { name: "Catalog mapping" });
  const recovery = steps.getByRole("tab", { name: "Recovery" });
  const damage = steps.getByRole("tab", { name: "Damage decision" });
  await expect(mapping).toHaveAttribute("aria-selected", "true");

  await titleEvidence(page, 1).getByRole("button", {
    name: "Map as movie",
  }).click();
  const title = page.getByLabel("Title", { exact: true });
  const draftTitle = `Draft recovery mapping ${variant}`;
  await title.fill(draftTitle);

  await recovery.click();
  await expect(recovery).toHaveAttribute("aria-selected", "true");
  const recoveryPanel = page.getByRole("tabpanel", { name: "Recovery" });
  await expect(recoveryPanel.getByText("Saved", { exact: true }))
    .toBeVisible();
  await expect(recoveryPanel.getByText("Recovering", { exact: true }))
    .toBeVisible();
  await expect(recoveryPanel.getByText("Unmapped content remains", {
    exact: true,
  })).toBeVisible();

  await recovery.focus();
  await page.keyboard.press("ArrowRight");
  await expect(mapping).toHaveAttribute("aria-selected", "true");
  await expect(title).toHaveValue(draftTitle);
  await page.keyboard.press("ArrowRight");
  await expect(damage).toHaveAttribute("aria-selected", "true");
  const damagePanel = page.getByRole("tabpanel", { name: "Damage decision" });
  await expect(damagePanel.getByRole("heading", {
    name: "Damage decision readiness",
  })).toBeVisible();
  await expect(damagePanel.getByText(
    "Archive Recovery must stop or complete before a damage decision.",
    { exact: true },
  )).toBeVisible();
  await expect(damagePanel.getByText("SELECTION_UNIDENTIFIED", {
    exact: true,
  })).toBeVisible();
  const acceptancePreflight = damagePanel.getByRole("heading", {
    name: "Title Damage Acceptance preflight",
  }).locator("xpath=ancestor::section[1]");
  const exclusions = acceptancePreflight.getByRole("checkbox");
  expect(await exclusions.count()).toBeGreaterThan(0);
  await expect(exclusions.first()).not.toBeChecked();
  await exclusions.first().click();
  await expect(exclusions.first()).toBeChecked();
  const preflightResponse = page.waitForResponse((response) =>
    response.url().includes("/title-damage-acceptance-preview") &&
    response.request().method() === "POST"
  );
  await acceptancePreflight.getByRole("button", {
    name: "Preview exact review set",
  }).click();
  const completedPreflight = await preflightResponse;
  expect(completedPreflight.status()).toBe(200);
  expect(completedPreflight.request().postDataJSON()).toMatchObject({
    excludedTitleIdentityIds: [expect.any(String)],
  });
  await expect(acceptancePreflight.getByText(/Preflight unavailable\./))
    .toBeVisible();
  await expect(acceptancePreflight.getByText(
    "A Damage Preview is optional. Its unavailability does not block this preflight.",
    { exact: true },
  )).toBeVisible();
  await expect(damagePanel.getByRole("button", {
    name: "Keep archive only",
  })).toBeDisabled();
  await expect(damagePanel.getByText(
    "Archive Recovery must stop or complete before choosing archive-only.",
  )).toBeVisible();

  await mapping.click();
  await expect(title).toHaveValue(draftTitle);
  await expectNoPageOverflow(page);
});

test("Title Damage paging retrieves evidence beyond the review summary", async ({ page }, testInfo) => {
  const variant = fixtureVariant(testInfo.project.name);
  await openCatalogReview(
    page,
    `CATALOG_BROWSER_DAMAGE_${variant.toUpperCase()}`,
  );
  await page.getByRole("tab", { name: "Damage decision" }).click();

  const titleDamage = page.getByRole("heading", {
    name: "Title damage assessment",
    level: 3,
  }).locator("xpath=ancestor::section[1]");
  await expect(titleDamage.getByText("DVD title 20", { exact: true }))
    .toBeVisible();
  await expect(titleDamage.getByText(/Source-continuity risk: 4 recovered/))
    .toBeVisible();
  await expect(titleDamage.getByText(/Archive-level source-continuity risk: 2/))
    .toBeVisible();
  await expect(titleDamage.getByText("Estimated affected playback", {
    exact: true,
  })).toBeVisible();
  await expect(titleDamage.getByText(/Occurrence 1: 01:02.000 to 01:05.000/))
    .toBeVisible();
  await expect(titleDamage.getByText(/Occurrence 2: 02:00.000 to 02:10.000/))
    .toBeVisible();
  await expect(titleDamage.getByText(/Coverage: source span/)).toBeVisible();
  await expect(titleDamage.getByText(/Coverage: whole-cell span/)).toBeVisible();
  await expect(titleDamage.getByText("DVD title 21", { exact: true }))
    .toHaveCount(0);
  const loadMore = titleDamage.getByRole("button", {
    name: "Load more Title Damage evidence",
  });
  const pageResponse = page.waitForResponse((response) =>
    response.url().includes("/api/catalog-reviews/") &&
    response.url().includes("/damage?limit=100") &&
    response.request().method() === "GET"
  );
  await loadMore.click();
  expect((await pageResponse).status()).toBe(200);
  await expect(titleDamage.getByText("DVD title 21", { exact: true }))
    .toBeVisible();
  await expect(loadMore).toHaveCount(0);
});

test("Damage Preview reviews selections and keeps active Recovery generation unavailable", async ({ page }, testInfo) => {
  await openCatalogReview(page, `CATALOG_BROWSER_DAMAGE_${fixtureVariant(testInfo.project.name).toUpperCase()}`);
  await page.getByRole("tab", { name: "Damage decision" }).click();
  const preview = page.getByRole("region", { name: "Damage Preview", exact: true });
  await expect(preview.getByRole("button", { name: "Generate Damage Preview" })).toBeDisabled();
  await preview.getByRole("button", { name: "Review preview availability" }).click();
  await expect(preview.getByLabel("Identified title")).toBeVisible();
  await preview.getByLabel("Interval 1:", { exact: false }).check();
  await preview.getByLabel("Playback range end in seconds").fill("180");
  await preview.getByLabel("Audio stream IDs, separated by commas").fill("128");
  await preview.getByRole("button", { name: "Review preview selections" }).click();
  await expect(preview.getByRole("heading", { name: "Reviewed preview" })).toBeVisible();
  await expect(preview.getByText("Estimated duration: 13 s. Estimated storage: unknown.")).toBeVisible();
  await expect(preview.getByText(/DAMAGE_PREVIEW_ACTIVE_RECOVERY_UNAVAILABLE:/)).toBeVisible();
  await expect(preview.getByRole("button", { name: "Generate Damage Preview" })).toBeDisabled();
  await preview.getByLabel("Context before in seconds").fill("1.001");
  await expect(preview.getByRole("heading", { name: "Reviewed preview" })).toHaveCount(0);
  await preview.getByRole("button", { name: "Review preview selections" }).click();
  await expect(preview.getByText("Estimated duration: 9.001 s. Estimated storage: unknown.")).toBeVisible();
  await preview.getByLabel("Interval 2:", { exact: false }).check();
  await preview.getByRole("button", { name: "Review preview selections" }).click();
  await expect(preview.getByText("Estimated duration: unknown. Estimated storage: unknown.")).toBeVisible();
  await expect(preview.getByText(/COARSE_SAMPLING_WINDOW_REQUIRED:/)).toBeVisible();
  await expectNoPageOverflow(page);
});

test("exact damage preflight identifies mapped and excluded content across assessment states", async ({ page }, testInfo) => {
  const variant = fixtureVariant(testInfo.project.name);
  await openCatalogReview(
    page,
    `CATALOG_BROWSER_DAMAGE_${variant.toUpperCase()}`,
  );
  await page.getByRole("tab", { name: "Damage decision" }).click();
  const preflight = page.getByRole("heading", {
    name: "Title Damage Acceptance preflight",
  }).locator("xpath=ancestor::section[1]");
  let responseState: "available" | "pending" | "outdated" = "available";
  await page.route("**/title-damage-acceptance-preview", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(damageAcceptanceBrowserPreview(responseState)),
    });
  });

  const preview = preflight.getByRole("button", {
    name: "Preview exact review set",
  });
  await preview.click();
  await expect(preflight.getByText(/Preflight available\./))
    .toBeVisible();
  await expect(preflight.getByText(/episode: Synthetic Show \(2024\), season 1, episode 2/))
    .toBeVisible();
  await expect(preflight.getByText(
    "Title Identity synthetic-browser-title-identity-2.",
  )).toBeVisible();
  await expect(preflight.getByText(/Selected path: program 2, cell 4, VOB 7, cell ID 9/))
    .toBeVisible();
  await expect(preflight.getByText(/Occurrence 3: playback location unknown for 4 unrecovered source sectors/))
    .toBeVisible();
  await expect(preflight.getByText(/do not claim exact playback lost or bound decoder effects/))
    .toBeVisible();
  await expect(preflight.getByText(/Encode Job synthetic-browser-encode-job/))
    .toBeVisible();
  await expect(preflight.getByText(/Damage acknowledgement is required for this exact set/))
    .toBeVisible();

  responseState = "pending";
  await preview.click();
  await expect(preflight.getByText("ASSESSMENT_PENDING", { exact: true }))
    .toBeVisible();
  await expect(preflight.getByText(/Damage acknowledgement has not been determined/))
    .toBeVisible();

  responseState = "outdated";
  await preview.click();
  await expect(preflight.getByText("ASSESSMENT_OUTDATED", { exact: true }))
    .toBeVisible();
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


test("Damage Preview requests, waits for and cancels reviewed work with visible provenance", async ({ page }, testInfo) => {
  let cancelled = false;
  const requestId = "11111111-2222-4333-8444-555555555555";
  const state = () => ({ schemaVersion: 1, id: requestId, status: cancelled ? "cancelled" : "queued", generationStatus: cancelled ? "cancelled" : "queued", outdated: false, outdatedReasons: [], reason: null, cancellationRequested: cancelled, progress: { completedClips: 0, totalClips: 1, percent: null }, artifacts: [], media: { state: "not_generated", token: "synthetic-media-token", retention: null, removal: null, deletion: { available: false, reasons: [] }, cleanup: { available: false, reasons: [] } }, provenance: { checkpoint: { manifestRevision: 1 } }, warning: "Failed, empty or partial media never means no damage." });
  await page.route("**/api/damage-previews/*/availability", async (route) => {
    const endpoint = new URL(route.request().url());
    const browserHost = endpoint.host;
    endpoint.hostname = "127.0.0.1";
    // Node requests do not inherit Chromium's test-host resolver rule.
    const response = await route.fetch({ url: endpoint.href, headers: { ...route.request().headers(), host: browserHost } });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    if (route.request().method() === "POST") { body.available = true; body.blockingReasons = []; }
    await route.fulfill({ response, json: body });
  });
  await page.route(/\/api\/damage-previews\/[^/]+(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "DELETE") cancelled = true;
    await route.fulfill({ json: state() });
  });
  await openCatalogReview(page, `CATALOG_BROWSER_DAMAGE_${fixtureVariant(testInfo.project.name).toUpperCase()}`);
  await page.getByRole("tab", { name: "Damage decision" }).click();
  const preview = page.getByRole("region", { name: "Damage Preview", exact: true });
  await preview.getByRole("button", { name: "Review preview availability" }).click();
  await preview.getByLabel("Interval 1:", { exact: false }).check();
  await preview.getByLabel("Playback range end in seconds").fill("180");
  await preview.getByRole("button", { name: "Review preview selections" }).click();
  await preview.getByRole("button", { name: "Generate Damage Preview" }).click();
  await expect(preview.getByLabel("Damage Preview request identity")).toHaveValue(requestId);
  await expect(preview.getByText(/Status: queued/)).toBeVisible();
  await preview.getByRole("button", { name: "Wait for preview", exact: true }).click();
  await preview.getByRole("button", { name: "Cancel preview request" }).click();
  await expect(preview.getByText(/Status: cancelled/)).toBeVisible();
  await expect(preview.getByText("Failed, empty or partial media never means no damage.")).toBeVisible();
  await preview.getByText("Preview provenance").click();
  await expect(preview.locator("pre")).toContainText('"manifestRevision": 1');
});


test("Damage Preview media deletion keeps provenance and coverage visible", async ({ page }, testInfo) => {
  const requestId = "11111111-2222-4333-8444-666666666666";
  let deleted = false;
  const state = () => ({
    schemaVersion: 1, id: requestId, status: "partial", generationStatus: "partial", outdated: false, outdatedReasons: [],
    reason: { code: "SYNTHETIC_INTERRUPTION", message: "Generation was interrupted." }, progress: { completedClips: 1, totalClips: 2, percent: null },
    media: { state: deleted ? "removed" : "retained", token: deleted ? "synthetic-removed-token" : "synthetic-retained-token", retention: null,
      removal: deleted ? { cause: "explicit_deletion", state: "complete" } : null, deletion: { available: !deleted, reasons: [] } },
    artifacts: [{ identity: `damage-preview-v1.${requestId}.0`, sizeBytes: 128, coverage: { startMilliseconds: 1000, endMilliseconds: 6000 },
      media: { state: deleted ? "removed" : "retained", reasonCode: deleted ? "DAMAGE_PREVIEW_MEDIA_DELETED" : null } }],
    provenance: { checkpoint: { manifestRevision: 1 }, streams: { audio: [128], subtitles: [] } },
    warning: "Partial media never means no damage.",
  });
  await page.route(/\/api\/damage-previews\/[^/]+(?:\/media)?$/, async (route) => {
    if (route.request().method() === "DELETE") {
      expect(route.request().postDataJSON()).toMatchObject({ mediaToken: "synthetic-retained-token", mutationKey: expect.any(String) });
      deleted = true;
    }
    await route.fulfill({ json: state() });
  });
  await openCatalogReview(page, `CATALOG_BROWSER_DAMAGE_${fixtureVariant(testInfo.project.name).toUpperCase()}`);
  await page.getByRole("tab", { name: "Damage decision" }).click();
  const preview = page.getByRole("region", { name: "Damage Preview", exact: true });
  await preview.getByLabel("Damage Preview request identity").fill(requestId);
  await preview.getByRole("button", { name: "Refresh preview status" }).click();
  await expect(preview.getByRole("link", { name: /Download canonical MKV/ })).toBeVisible();
  await preview.getByRole("button", { name: "Delete preview media" }).click();
  await expect(preview.getByText("Removal: explicit_deletion, complete.")).toBeVisible();
  await expect(preview.getByRole("link", { name: /Download canonical MKV/ })).toHaveCount(0);
  await expect(preview.getByText(/Actual coverage: 1 s to 6 s/)).toBeVisible();
  await expect(preview.getByText(/Generation was interrupted/)).toBeVisible();
  await expect(preview.getByRole("button", { name: "Delete preview media" })).toBeDisabled();
  await preview.getByText("Preview provenance").click();
  await expect(preview.locator("pre")).toContainText('"manifestRevision": 1');
});
