// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationSettings } from "./notification-settings";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

it("explains that server setup blocks enabling notifications", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn() });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
    register: async () => ({ pushManager: { getSubscription: async () => null } }),
  } });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("status")
    ? { configured: false, reason: "missing_configuration", publicKey: null, dispatcherAvailable: false }
    : { deliveries: [] })));
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<NotificationSettings />); });
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "Enable notifications")!;
    expect(button.disabled).toBe(true);
    expect(container.querySelector('[role="status"]')!.textContent).toContain("server setup is complete");
  } finally { await act(async () => { root.unmount(); }); delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker; }
});

it("shows feedback immediately when the browser permission request stays pending", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", class {});
  const requestPermission = vi.fn(() => new Promise<NotificationPermission>(() => {}));
  vi.stubGlobal("Notification", { permission: "default", requestPermission });
  const worker = { pushManager: { getSubscription: async () => null } };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: async () => worker } });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("status")
    ? { configured: true, reason: "ready", publicKey: "synthetic-public-key", dispatcherAvailable: true }
    : { deliveries: [] })));
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<NotificationSettings />); });
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "Enable notifications")!;
    expect(button.disabled).toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();
    await act(async () => { button.click(); });
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(true);
    expect(container.querySelector('[role="status"]')!.textContent).toContain("Enabling notifications");
  } finally { await act(async () => { root.unmount(); }); delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker; }
});
