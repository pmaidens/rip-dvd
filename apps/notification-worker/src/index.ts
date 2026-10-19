import { setTimeout } from "node:timers/promises";
import { createDataAccess } from "@rip-dvd/data-access";
import { createWebPushSender, dispatchNotifications, readNotificationConfiguration } from "@rip-dvd/application";
import { runConfiguredAsyncWorker } from "@rip-dvd/worker-runtime";

await runConfiguredAsyncWorker({ workerName: "Notification", readyMessage: () => "Notification dispatcher started" }, async ({ config, signal, log }) => {
  const access = createDataAccess({ databasePath: config.databasePath });
  try {
    const notificationConfig = readNotificationConfiguration();
    const sender = notificationConfig.ready ? createWebPushSender(notificationConfig.configuration) : null;
    if (!sender) log("Notification dispatcher is unavailable: check secure origin and persistent VAPID configuration");
    while (!signal.aborted) {
      if (sender) {
        try { await dispatchNotifications(access, sender, { signal }); }
        catch { log("Notification dispatch pass failed; queued work remains durable"); }
      }
      await setTimeout(Math.min(config.workerPollIntervalMs, 5_000), undefined, { signal }).catch(() => undefined);
    }
  } finally { access.close(); }
});
