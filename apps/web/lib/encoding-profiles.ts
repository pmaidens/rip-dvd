import { toEncodingProfileDto } from "@rip-dvd/application";
import type { MediaDomain } from "@rip-dvd/data-access";

export { toEncodingProfileDto };
export interface EncodingProfileDto {
  id: string;
  key: string;
  displayName: string;
  mediaDomain: MediaDomain;
  version: number;
  isActive: boolean;
  settings: { preset: string | null; container: "mkv" | null };
  createdAt?: string;
  updatedAt?: string;
  eligibility?: ReturnType<typeof toEncodingProfileDto>["eligibility"];
}

export interface DvdVideoEncodingSettings extends Record<string, unknown> {
  preset: string;
  container: "mkv";
}
