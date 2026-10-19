"use client";
import { useEffect } from "react";
import { reconcileBrowserPush } from "../lib/browser-notifications";

export function BrowserNotificationLifecycle() {
  useEffect(() => { void reconcileBrowserPush().catch(() => undefined); }, []);
  return null;
}
