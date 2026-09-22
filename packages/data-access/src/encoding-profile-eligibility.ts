import { isHandBrakePreset } from "@rip-dvd/config";

import type { EncodingProfile } from "./types.js";

export type EncodingProfileQueueBlockingReason =
  | "inactive"
  | "wrong_media_domain"
  | "unsupported_preset"
  | "unsupported_container";

export function encodingProfileQueueBlockingReasons(
  profile: Pick<EncodingProfile, "isActive" | "mediaDomain" | "settings">,
): EncodingProfileQueueBlockingReason[] {
  const reasons: EncodingProfileQueueBlockingReason[] = [];
  if (!profile.isActive) reasons.push("inactive");
  if (profile.mediaDomain !== "dvd_video") reasons.push("wrong_media_domain");
  if (typeof profile.settings.preset !== "string" ||
    !isHandBrakePreset(profile.settings.preset)) {
    reasons.push("unsupported_preset");
  }
  if (profile.settings.container !== undefined && profile.settings.container !== "mkv") {
    reasons.push("unsupported_container");
  }
  return reasons;
}
