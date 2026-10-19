"use client";
import { useEffect } from "react";
import { checkBrowserPushUpdate, reconcileBrowserPush } from "../lib/browser-notifications";

export function BrowserNotificationLifecycle() {
  useEffect(() => {
    const checkUpdate = () => {
      if (document.visibilityState === "visible") void checkBrowserPushUpdate();
    };
    checkUpdate();
    void reconcileBrowserPush().catch(() => undefined);
    document.addEventListener("visibilitychange", checkUpdate);
    window.addEventListener("pageshow", checkUpdate);
    return () => {
      document.removeEventListener("visibilitychange", checkUpdate);
      window.removeEventListener("pageshow", checkUpdate);
    };
  }, []);
  return null;
}
