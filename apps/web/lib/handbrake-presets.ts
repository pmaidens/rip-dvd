export interface HandBrakePresetGroup {
  label: string;
  presets: readonly string[];
}

// Built-in presets reported by HandBrake 1.6.1, the version installed by the
// Bookworm-based encode-worker image.
export const HANDBRAKE_PRESET_GROUPS = [
  {
    label: "General",
    presets: [
      "Very Fast 2160p60 4K AV1",
      "Very Fast 2160p60 4K HEVC",
      "Very Fast 1080p30",
      "Very Fast 720p30",
      "Very Fast 576p25",
      "Very Fast 480p30",
      "Fast 2160p60 4K AV1",
      "Fast 2160p60 4K HEVC",
      "Fast 1080p30",
      "Fast 720p30",
      "Fast 576p25",
      "Fast 480p30",
      "HQ 2160p60 4K AV1 Surround",
      "HQ 2160p60 4K HEVC Surround",
      "HQ 1080p30 Surround",
      "HQ 720p30 Surround",
      "HQ 576p25 Surround",
      "HQ 480p30 Surround",
      "Super HQ 2160p60 4K AV1 Surround",
      "Super HQ 2160p60 4K HEVC Surround",
      "Super HQ 1080p30 Surround",
      "Super HQ 720p30 Surround",
      "Super HQ 576p25 Surround",
      "Super HQ 480p30 Surround",
    ],
  },
  {
    label: "Web",
    presets: [
      "Creator 2160p60 4K",
      "Creator 1440p60 2.5K",
      "Creator 1080p60",
      "Creator 720p60",
      "Email 25 MB 3 Minutes 720p30",
      "Email 25 MB 5 Minutes 480p30",
      "Email 25 MB 10 Minutes 288p30",
      "Social 100 MB 5 Minutes 1080p30",
      "Social 50 MB 5 Minutes 720p30",
      "Social 50 MB 10 Minutes 480p30",
      "Social 8 MB 3 Minutes 360p30",
    ],
  },
  {
    label: "Devices",
    presets: [
      "Amazon Fire 2160p60 4K HEVC Surround",
      "Amazon Fire 1080p30 Surround",
      "Amazon Fire 720p30",
      "Android 1080p30",
      "Android 720p30",
      "Android 576p25",
      "Android 480p30",
      "Apple 2160p60 4K HEVC Surround",
      "Apple 1080p60 Surround",
      "Apple 1080p30 Surround",
      "Apple 720p30 Surround",
      "Apple 540p30 Surround",
      "Chromecast 2160p60 4K HEVC Surround",
      "Chromecast 1080p60 Surround",
      "Chromecast 1080p30 Surround",
      "Playstation 2160p60 4K Surround",
      "Playstation 1080p30 Surround",
      "Playstation 720p30",
      "Playstation 540p30",
      "Roku 2160p60 4K HEVC Surround",
      "Roku 1080p30 Surround",
      "Roku 720p30 Surround",
      "Roku 576p25",
      "Roku 480p30",
      "Xbox 1080p30 Surround",
    ],
  },
  {
    label: "Matroska",
    presets: [
      "AV1 MKV 2160p60 4K",
      "H.265 MKV 2160p60 4K",
      "H.265 MKV 1080p30",
      "H.265 MKV 720p30",
      "H.265 MKV 576p25",
      "H.265 MKV 480p30",
      "H.264 MKV 2160p60 4K",
      "H.264 MKV 1080p30",
      "H.264 MKV 720p30",
      "H.264 MKV 576p25",
      "H.264 MKV 480p30",
      "VP9 MKV 2160p60 4K",
      "VP9 MKV 1080p30",
      "VP9 MKV 720p30",
      "VP9 MKV 576p25",
      "VP9 MKV 480p30",
    ],
  },
  {
    label: "Hardware",
    presets: [
      "AV1 QSV 2160p 4K",
      "H.265 NVENC 2160p 4K",
      "H.265 NVENC 1080p",
      "H.265 QSV 2160p 4K",
      "H.265 QSV 1080p",
      "H.265 VCN 2160p 4K",
      "H.265 VCN 1080p",
      "H.265 MF 2160p 4K",
      "H.265 MF 1080p",
    ],
  },
  {
    label: "Production",
    presets: [
      "Production Max",
      "Production Standard",
      "Production Proxy 1080p",
      "Production Proxy 540p",
    ],
  },
] as const satisfies readonly HandBrakePresetGroup[];

export const HANDBRAKE_PRESETS: readonly string[] =
  HANDBRAKE_PRESET_GROUPS.flatMap((group) => group.presets);

const HANDBRAKE_PRESET_SET = new Set(HANDBRAKE_PRESETS);

export function isHandBrakePreset(value: string): boolean {
  return HANDBRAKE_PRESET_SET.has(value);
}
