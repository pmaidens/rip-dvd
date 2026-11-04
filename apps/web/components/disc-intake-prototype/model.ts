// Synthetic, in-memory fixtures for the throwaway Disc intake design study.
export type PrototypeDrive = {
  id: string;
  name: string;
  model: string;
  state: "complete" | "active" | "error" | "idle" | "cancelled";
  phase: string;
  progress: number | null;
  title: string | null;
  subtitle: string;
  artwork: "orbit" | "tide" | "grove" | null;
  error: string | null;
  speed: string;
  eta: string;
  elapsed: string;
  read: string;
  capacity: string;
};

export type PrototypeVariantProps = {
  drives: PrototypeDrive[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  onPrevious: () => void;
  onNext: () => void;
  onRetry: () => void;
  onCancel: (driveId: string) => void;
};

export const stateLabels = {
  complete: "Archive complete",
  active: "In progress",
  error: "Needs attention",
  idle: "Ready for a disc",
  cancelled: "Archive cancelled",
};

export function createDemoDrives(): PrototypeDrive[] {
  return [
    { id: "demo-a", name: "Drive A", model: "Optical Drive 01", state: "active", phase: "Archiving disc", progress: 64, title: "The Last Orbit", subtitle: "Science fiction · Sample DVD", artwork: "orbit", error: null, speed: "6.2×", eta: "About 8 min", elapsed: "14:32", read: "4.54 GB", capacity: "7.10 GB" },
    { id: "demo-b", name: "Drive B", model: "Optical Drive 02", state: "complete", phase: "Archive complete", progress: 100, title: "A Quiet Tide", subtitle: "Drama · Sample DVD", artwork: "tide", error: null, speed: "Finished", eta: "Complete", elapsed: "21:08", read: "6.40 GB", capacity: "6.40 GB" },
    { id: "demo-c", name: "Drive C", model: "Optical Drive 03", state: "error", phase: "Disc Inspection failed", progress: null, title: null, subtitle: "Disc identity unavailable", artwork: null, error: "The disc metadata could not be read. Check the disc, then retry Disc Inspection.", speed: "Stopped", eta: "Unavailable", elapsed: "00:18", read: "Unknown", capacity: "Unknown" },
    { id: "demo-d", name: "Drive D", model: "Optical Drive 04", state: "idle", phase: "Waiting for a disc", progress: null, title: null, subtitle: "Insert a DVD to begin", artwork: null, error: null, speed: "Idle", eta: "Unavailable", elapsed: "00:00", read: "0 GB", capacity: "Unknown" },
  ];
}
