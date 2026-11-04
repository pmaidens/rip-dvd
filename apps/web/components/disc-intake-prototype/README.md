# Disc intake design study

Throwaway UI prototypes for choosing the drive status and disc carousel layout.
They render inside the existing application header on the `/discs` route.

Run `pnpm prototype:disc-intake`, then open the printed local origin with
`/discs?variant=A`. Use the floating bar or left/right arrow keys to compare:

- A, Focus: one centered disc and quiet drive status chips.
- B, Carousel: selected disc with clickable neighboring discs, the Focus drive
  status header and an action toolbar for the selected drive.
- C, Console: disc viewport, activity stages and a drive worklist.

`Try a state` changes the selected sample drive. It includes archiving,
completion, inspection, metadata failure, read failure, disconnected drive
and empty drive scenarios. The slider changes archive progress, the artwork
checkbox demonstrates the fallback, and Play advances active sample drives.
Reset restores the initial fixtures. Variant changes preserve sample state;
reloading resets it. Arrow keys leave focused controls alone.

The Carousel toolbar shows actions for the selected drive. Active Archive Jobs
offer activity and cancellation confirmation. Problems offer an investigation
dialog and a matching retry action. Cancelled requests have a neutral status and
can start a new sample archive. Completed and empty drives offer relevant detail
dialogs. Native dialogs support Escape, focus containment and focus return.
Cancellation and retries change sample memory only.

All movie names, artwork and drive details are synthetic. The artwork is drawn
in SVG and the progress ring uses the sample read percentage. No prototype
action calls application operations. The selector and variants render only
in development. Keep these variants on a throwaway branch once a design is
chosen, then implement the selected behavior through the shared operation
boundary with CLI parity.
