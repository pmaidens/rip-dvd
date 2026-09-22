import { isHandBrakePreset } from "@rip-dvd/config";

import type { EncodingProfile } from "./types.js";

export type EncodingProfileSettingsBlockingReason =
  | "unsupported_preset"
  | "unsupported_container";

export type EncodingProfileQueueBlockingReason =
  | "inactive"
  | "wrong_media_domain"
  | EncodingProfileSettingsBlockingReason;

export function encodingProfileSettingsBlockingReasons(
  settings: EncodingProfile["settings"],
): EncodingProfileSettingsBlockingReason[] {
  const reasons: EncodingProfileSettingsBlockingReason[] = [];
  if (typeof settings.preset !== "string" || !isHandBrakePreset(settings.preset)) {
    reasons.push("unsupported_preset");
  }
  if (settings.container !== undefined && settings.container !== "mkv") {
    reasons.push("unsupported_container");
  }
  return reasons;
}

export function encodingProfileQueueBlockingReasons(
  profile: Pick<EncodingProfile, "isActive" | "mediaDomain" | "settings">,
): EncodingProfileQueueBlockingReason[] {
  const reasons: EncodingProfileQueueBlockingReason[] = [];
  if (!profile.isActive) reasons.push("inactive");
  if (profile.mediaDomain !== "dvd_video") reasons.push("wrong_media_domain");
  reasons.push(...encodingProfileSettingsBlockingReasons(profile.settings));
  return reasons;
}
