import type { EncodingProfile, MediaDomain } from "@rip-dvd/data-access";

export interface DvdVideoEncodingSettings extends Record<string, unknown> {
  preset: string;
  container: "mkv";
}

export interface EncodingProfileDto {
  id: string;
  key: string;
  displayName: string;
  mediaDomain: MediaDomain;
  version: number;
  isActive: boolean;
  settings: {
    preset: string | null;
    container: "mkv" | null;
  };
}

export function toEncodingProfileDto(
  profile: EncodingProfile,
): EncodingProfileDto {
  return {
    id: profile.id,
    key: profile.key,
    displayName: profile.displayName,
    mediaDomain: profile.mediaDomain,
    version: profile.version,
    isActive: profile.isActive,
    settings: {
      preset:
        typeof profile.settings.preset === "string"
          ? profile.settings.preset
          : null,
      container: profile.settings.container === "mkv" ? "mkv" : null,
    },
  };
}

export function dvdVideoSettings(
  profile: EncodingProfileDto,
): DvdVideoEncodingSettings | null {
  const { preset, container } = profile.settings;
  return preset !== null && container === "mkv"
    ? { preset, container }
    : null;
}
