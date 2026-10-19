"use client";

import { useEffect, useState } from "react";
import { browserNotificationProblem, disableBrowserPush, enableBrowserPush, readBrowserTestDelivery, readPushReadiness,
  reconcileBrowserPush, submitBrowserTest, type PushReadiness } from "../lib/browser-notifications";

export function NotificationSettings() {
  const [readiness, setReadiness] = useState<PushReadiness | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Checking notification readiness…");
  const [eventId, setEventId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setProblem(browserNotificationProblem());
    void Promise.all([readPushReadiness(), reconcileBrowserPush()]).then(([status, enabled]) => {
      if (!cancelled) { setReadiness(status); setActive(enabled); setMessage(enabled ? "Notifications enabled on this browser." : "Notifications disabled on this browser."); }
    }).catch(() => { if (!cancelled) setMessage("Notification service is unavailable. Try checking status again."); });
    return () => { cancelled = true; };
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : "Notification operation failed."); }
    finally { setBusy(false); setProblem(browserNotificationProblem()); }
  }
  return <main className="notification-settings">
    <h1>Notifications</h1>
    <p>On iPhone, open this app in Safari, choose Share, then Add to Home Screen. Open that Home Screen app and tap Enable notifications.</p>
    <p>No permission prompt appears until you tap Enable notifications. Each active browser receives installation events, including work started through the CLI.</p>
    {problem && <p role="note">{problem}</p>}
    {readiness && !readiness.configured && <p role="note">{readiness.reason === "insecure_origin"
      ? "The server needs a trusted HTTPS application origin."
      : readiness.reason === "missing_configuration" ? "Push configuration is missing. Configure persistent VAPID keys and a contact subject on the server."
        : "Push configuration is invalid. Check the server VAPID keys and application origin."}</p>}
    {readiness?.configured && !readiness.dispatcherAvailable && <p role="note">Delivery is unavailable. The notification dispatcher has not reported readiness recently. Tests remain queued until it returns.</p>}
    <p role="status" aria-live="polite">{message}</p>
    <div className="notification-controls">
      <button disabled={busy || active || !!problem || !readiness?.publicKey} onClick={() => void run(async () => {
        setActive(await enableBrowserPush(readiness!.publicKey!)); setMessage("Notifications enabled on this browser.");
      })}>Enable notifications</button>
      <button disabled={busy || !active} onClick={() => void run(async () => { await disableBrowserPush(); setActive(false); setMessage("Notifications disabled on this browser."); })}>Disable notifications</button>
      <button disabled={busy || !active || !readiness?.configured} onClick={() => void run(async () => { setEventId(await submitBrowserTest()); setMessage("Queued for delivery. Provider acceptance does not prove device display."); })}>Send test notification</button>
      <button disabled={busy} onClick={() => void run(async () => {
        setReadiness(await readPushReadiness()); setActive(await reconcileBrowserPush());
        setMessage(eventId ? await readBrowserTestDelivery(eventId) : "Notification status refreshed.");
      })}>Check notification status</button>
    </div>
    <p>Disabling prevents later dispatch. An already accepted push cannot be recalled. Push is best effort; provider acceptance does not guarantee device display.</p>
  </main>;
}
