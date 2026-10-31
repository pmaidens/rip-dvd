import { expect, test } from "@playwright/test";

test.use({ launchOptions: {
  ignoreDefaultArgs: ["--disable-back-forward-cache"],
  args: ["--host-resolver-rules=MAP rip-dvd.test 127.0.0.1", "--no-proxy-server"],
} });

test("opens Settings from primary navigation with addressable configuration sections", async ({ page }) => {
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
  await sections.getByRole("link", { name: "Encoding Profiles", exact: true }).click();
  await expect(page).toHaveURL("/settings#encoding-profiles");
  await expect(page.getByRole("region", { name: "Encoding Profiles", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL("/settings#notifications");
  await page.goForward();
  await expect(page).toHaveURL("/settings#encoding-profiles");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Encoding Profiles", level: 2 })).toBeVisible();
});

for (const section of [
  { name: "Notifications", hash: "notifications", control: "Check notification status" },
  { name: "Encoding Profiles", hash: "encoding-profiles", control: "Profile key" },
]) {
test(`opens ${section.name} directly and reaches its controls by keyboard without horizontal overflow`, async ({ page }) => {
  await page.goto(`/settings#${section.hash}`);
  const region = page.getByRole("region", { name: section.name, exact: true });
  await expect(region).toBeVisible();
  const link = page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: section.name });
  await link.focus();
  await expect(link).toBeFocused();
  expect(await link.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/settings#${section.hash}`);
  await page.keyboard.press("Tab");
  const control = region.getByLabel(section.control, { exact: true }).or(
    region.getByRole("button", { name: section.control, exact: true }),
  );
  await expect(control).toBeFocused();
  expect(await control.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
}

test("manages profile versions from Encoding and returns with current queue choices and captured jobs", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const variant = testInfo.project.name === "desktop" ? "desktop" : "mobile";
  const profileName = `Settings browser profile ${variant}`;
  const profileKey = `settings-browser-${variant}`;
  const title = `Queue filler ${variant} 001`;
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/encoding");
  await expect(page.getByRole("tab")).toHaveText(["Current jobs", "Queue new jobs"]);
  await expect(page.getByRole("heading", { name: "Create profile", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "Queue new jobs" }).click();
  const queue = page.getByRole("region", { name: "Queue Encode Jobs", exact: true });
  const choices = queue.getByRole("combobox", { name: "Worklist Encoding Profile" });
  await expect(choices).toBeEnabled();
  await page.getByRole("link", { name: "Manage Encoding Profiles", exact: true }).click();
  await expect(page).toHaveURL("/settings#encoding-profiles");
  const profiles = page.getByRole("region", { name: "Encoding Profiles", exact: true });
  await expect(profiles.getByRole("article").first()).toBeVisible();
  await profiles.getByRole("button", { name: "Create profile", exact: true }).click();
  await expect(profiles.getByLabel("Profile key", { exact: true })).toBeFocused();
  await profiles.getByLabel("Profile key", { exact: true }).fill(profileKey);
  await profiles.getByLabel("Display name", { exact: true }).fill(profileName);
  let failCreate = true;
  await page.route("**/api/encoding-profiles", async (route) => {
    if (route.request().method() === "POST" && failCreate) {
      failCreate = false;
      await route.fulfill({ status: 503, json: { error: "Synthetic request failure" } });
    } else await route.continue();
  });
  await profiles.getByRole("button", { name: "Create profile", exact: true }).click();
  await expect(profiles.getByRole("alert")).toContainText("The latest Encoding Profile request failed.");
  await expect(profiles.getByLabel("Display name", { exact: true })).toHaveValue(profileName);
  await profiles.getByRole("button", { name: "Create profile", exact: true }).click();
  const first = profiles.getByRole("article").filter({ has: page.getByRole("heading", { name: profileName, exact: true }) }).filter({ hasText: "Version 1" });
  await expect(first.getByText("Active", { exact: true })).toBeVisible();
  await first.getByRole("button", { name: /^Create new version/ }).click();
  await profiles.getByRole("combobox", { name: "HandBrake preset", exact: true }).selectOption("HQ 480p30 Surround");
  await profiles.getByRole("button", { name: "Save new version", exact: true }).click();
  const second = profiles.getByRole("article").filter({ has: page.getByRole("heading", { name: profileName, exact: true }) }).filter({ hasText: "Version 2" });
  await expect(second.getByText("Inactive", { exact: true })).toBeVisible();
  await second.getByRole("button", { name: /^Activate/ }).click();
  await expect(second.getByText("Active", { exact: true })).toBeVisible();
  await expect(first.getByText("Inactive", { exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL("/encoding");
  await page.getByRole("tab", { name: "Queue new jobs" }).click();
  await expect(choices.getByRole("option", { name: `${profileName} · Version 2`, exact: true })).toHaveCount(1);
  await expect(choices.getByRole("option", { name: `${profileName} · Version 1`, exact: true })).toHaveCount(0);
  await choices.selectOption({ label: `${profileName} · Version 2` });
  const search = queue.getByRole("searchbox", { name: "Search reviewed Disc Selections" });
  await search.fill(title);
  await search.press("Enter");
  await queue.getByRole("checkbox", { name: `Select ${title} (2026) · DVD title 2`, exact: true }).check();
  await queue.getByRole("button", { name: /Add selected to worklist/ }).click();
  const output = queue.getByRole("textbox", { name: `Final output path for ${title}` });
  await expect(output).toBeEditable();
  const draft = (await output.inputValue()).replace(/\.mkv$/, " settings.mkv");
  await output.fill(draft);
  const queueTab = page.getByRole("tab", { name: "Queue new jobs" });
  await queueTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Current jobs" })).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(queueTab).toBeFocused();
  await expect(output).toHaveValue(draft);
  await expect(choices.locator("option:checked")).toHaveText(`${profileName} · Version 2`);
  await queue.getByRole("button", { name: "Queue 1 Encode Job", exact: true }).click();
  await expect(queue.getByRole("status")).toContainText("1 new job queued.");

  await page.getByRole("link", { name: "Manage Encoding Profiles", exact: true }).click();
  await second.getByRole("button", { name: /^Deactivate/ }).click();
  await expect(second.getByText("Inactive", { exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Encoding", exact: true }).click();
  const current = page.getByRole("tabpanel", { name: "Current jobs", exact: true });
  await expect(current).toContainText(title);
  await expect(current).toContainText(`${profileName} · Version 2`);
  await page.getByRole("tab", { name: "Queue new jobs" }).click();
  await expect(choices).toBeEnabled();
  await expect(choices.getByRole("option", { name: `${profileName} · Version 2`, exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const unavailable of ["profiles", "notifications"] as const) {
test(`keeps the other section usable while ${unavailable} load, fail and retry`, async ({ page }) => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let fail = true;
  const endpoint = unavailable === "profiles" ? "**/api/encoding-profiles" : "**/api/notifications?action=status";
  await page.route(endpoint, async (route) => {
    await ready;
    if (fail) await route.fulfill({ status: 503, json: { error: "Synthetic unavailable service" } });
    else if (unavailable === "profiles") await route.fulfill({ json: { profiles: [] } });
    else await route.continue();
  });
  await page.goto("/settings#encoding-profiles");
  const profiles = page.getByRole("region", { name: "Encoding Profiles", exact: true });
  const notifications = page.getByRole("region", { name: "Notifications", exact: true });
  const sections = page.getByRole("navigation", { name: "Settings sections" });
  if (unavailable === "profiles") {
    await expect(profiles).toContainText("Loading Encoding Profiles…");
    await sections.getByRole("link", { name: "Notifications", exact: true }).click();
    await expect(notifications.getByRole("button", { name: "Check notification status" })).toBeEnabled();
  } else {
    await expect(notifications.getByRole("status")).toHaveText("Checking notification readiness…");
    await expect(profiles.getByRole("article").first()).toBeVisible();
    await expect(profiles.getByLabel("Profile key", { exact: true })).toBeEditable();
  }
  release();
  if (unavailable === "profiles") {
    await sections.getByRole("link", { name: "Encoding Profiles", exact: true }).click();
    await expect(profiles).toContainText("Encoding Profiles are unavailable.");
    fail = false;
    await profiles.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(profiles).toContainText("No DVD video Encoding Profiles exist yet.");
  } else {
    await sections.getByRole("link", { name: "Notifications", exact: true }).click();
    await expect(notifications.getByRole("status")).toContainText("Notification service is unavailable.");
    fail = false;
    await notifications.getByRole("button", { name: "Check notification status" }).click();
    await expect(notifications.getByRole("status")).toHaveText("Notifications cannot be enabled until server setup is complete.");
  }
});
}
