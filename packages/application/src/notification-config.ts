import { createECDH } from "node:crypto";
import { normalizeHttpOrigin } from "@rip-dvd/config";
import { base64Key } from "./notification-validation.js";

export interface NotificationConfiguration {
  origin: string;
  vapid: { subject: string; publicKey: string; privateKey: string };
}

export function readNotificationConfiguration(environment: Readonly<Record<string, string | undefined>> = process.env):
  { ready: true; configuration: NotificationConfiguration } |
  { ready: false; reason: "missing_configuration" | "invalid_configuration" | "insecure_origin" } {
  const origin = normalizeHttpOrigin(environment.RIP_DVD_WEB_TRUSTED_ORIGIN || "http://localhost:3000");
  if (!origin) return { ready: false, reason: "invalid_configuration" };
  if (!origin.startsWith("https:") && new URL(origin).hostname !== "localhost" && new URL(origin).hostname !== "127.0.0.1") {
    return { ready: false, reason: "insecure_origin" };
  }
  const publicKey = environment.RIP_DVD_VAPID_PUBLIC_KEY?.trim();
  const privateKey = environment.RIP_DVD_VAPID_PRIVATE_KEY?.trim();
  const subject = environment.RIP_DVD_VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return { ready: false, reason: "missing_configuration" };
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(base64Key(privateKey, 32));
    if (!ecdh.getPublicKey().equals(base64Key(publicKey, 65))) throw new Error("Mismatched keys");
    const subjectUrl = new URL(subject);
    if (!(subjectUrl.protocol === "mailto:" && subjectUrl.pathname.includes("@")) &&
      !(subjectUrl.protocol === "https:" && !subjectUrl.username && !subjectUrl.password)) throw new Error("Invalid subject");
    return { ready: true, configuration: { origin, vapid: { publicKey, privateKey, subject } } };
  } catch { return { ready: false, reason: "invalid_configuration" }; }
}
