import { createHash } from "node:crypto";

const RAW_DVD_CONTENT_ID_DOMAIN = "rip-dvd-content-v2\0";

export interface RawDvdContentIdHasher {
  update(rawContent: Uint8Array): void;
  digest(): string;
}

export function createRawDvdContentIdHasher(
  declaredSizeBytes: number,
): RawDvdContentIdHasher {
  const hash = createHash("sha256");
  hash.update(RAW_DVD_CONTENT_ID_DOMAIN);
  hash.update(String(declaredSizeBytes));

  return {
    update(rawContent) {
      hash.update(rawContent);
    },
    digest() {
      return `sha256:${hash.digest("hex")}`;
    },
  };
}
