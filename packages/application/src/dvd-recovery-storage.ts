import {
  DVD_RECOVERY_STORAGE_PREFLIGHT_VERSION,
  DVD_RECOVERY_STORAGE_REASON_MESSAGES,
  type DvdRecoveryStoragePreflight,
} from "@rip-dvd/data-access";

export function describeDvdRecoveryStorage(
  preflight: DvdRecoveryStoragePreflight | null,
) {
  if (preflight === null) {
    const message =
      "The Originals Library storage has not been examined for DVD Archive Recovery.";
    return {
      available: false,
      blockingReasons: [{ code: "STORAGE_UNSUPPORTED", message }],
      preflight: {
        contractVersion: DVD_RECOVERY_STORAGE_PREFLIGHT_VERSION,
        status: "unsupported" as const,
        reasonCode: "STORAGE_UNSUPPORTED" as const,
        reason: message,
        facts: null,
        checkedAt: null,
      },
    };
  }

  const reason = preflight.reasonCode === null
    ? null
    : DVD_RECOVERY_STORAGE_REASON_MESSAGES[preflight.reasonCode];
  return {
    available: preflight.status === "supported",
    blockingReasons: reason === null || preflight.reasonCode === null
      ? []
      : [{ code: preflight.reasonCode, message: reason }],
    preflight: {
      ...preflight,
      reason,
    },
  };
}
