# Prompt DVD skipping and interruptible recovery

Research for [Investigate prompt DVD skipping and interruptible recovery](https://github.com/pmaidens/rip-dvd/issues/312), part of [DVD recovery and title damage review](https://github.com/pmaidens/rip-dvd/issues/311). Investigated 2026-09-09 against repository commit `21f5c8864173d7ae5a11a3b08d6e07c281b0bb02`. This records facts and design implications, not an implementation or a recovery policy decision.

The agreed workflow saves new archives before automatic recovery, allows cataloging during recovery, and waits for recovery to stop before encoding. There is no overall recovery time budget. Those constraints come from the map, not the sources below.

## What the current reader does

The initial copy reads at most 31 DVD sectors per request. After a medium error, `recover_range` makes two attempts at a range, recursively bisects failures, and eventually writes zeros for individual sectors that still fail. It consumes successful partial reads before working on the remainder. This discovers precise failed sectors before moving forward, so a damaged region can cause many commands. A completely failing 31-sector request produces one initial read plus two reads at each of the 61 nodes of the subdivision tree, or 123 application read calls. That count follows directly from the code; it is not a measured drive duration. [Native reader constants and recovery](https://github.com/pmaidens/rip-dvd/blob/21f5c8864173d7ae5a11a3b08d6e07c281b0bb02/docker/dvdcss-reader.c#L1332).

`run_rescue` already supports revisiting only sectors present in an earlier bad-sector bitmap. It tries each twice, writes recovered bytes at their original offsets, and otherwise writes zeros. It syncs the image before emitting a successful final recovery result. Its progress counter advances for every visited sector, including unsuccessful recovery attempts. Thus its byte progress describes completed work, not recovered content. The successful-result path alone does not provide a checkpoint after every recovered sector or a graceful operator-stop result. [Existing recovery loop](https://github.com/pmaidens/rip-dvd/blob/21f5c8864173d7ae5a11a3b08d6e07c281b0bb02/docker/dvdcss-reader.c#L1700).

The worker has a 12-hour copy timeout and 30-minute stall timeout. Cancellation closes result streams and sends `SIGKILL`; the code explicitly protects the output path because a device read may remain blocked afterward. Reusing this behavior unchanged would neither implement graceful stop-and-keep nor satisfy unlimited operator-controlled recovery. Per-command fault handling and loss-of-ownership protection remain separate concerns. [Worker defaults](https://github.com/pmaidens/rip-dvd/blob/21f5c8864173d7ae5a11a3b08d6e07c281b0bb02/apps/archive-worker/src/dvd-archiver.ts#L111), [cancellation](https://github.com/pmaidens/rip-dvd/blob/21f5c8864173d7ae5a11a3b08d6e07c281b0bb02/apps/archive-worker/src/dvd-archiver.ts#L544).

## CSS and the transport boundary

The libdvdcss API provides absolute sector seeking and reading. Its documented public API does not offer a read deadline or cancellation argument. Decryption is requested explicitly with `DVDCSS_READ_DECRYPT`; seeking can request a title-key check. The current archive reader uses `DVDCSS_NOFLAGS` for both operations. Therefore this archive path must not be described as producing decrypted sectors merely because it uses libdvdcss. A replacement recovery engine must preserve the established representation and CSS access behavior. [VideoLAN API](https://videolan.videolan.me/libdvdcss/dvdcss_8h.html), [current transport](https://github.com/pmaidens/rip-dvd/blob/21f5c8864173d7ae5a11a3b08d6e07c281b0bb02/docker/dvdcss-reader.c#L928).

The repo builds libdvdcss 1.6.0 with its own Linux I/O wrapper. Matching scoped reads use `READ(10)` through `SG_IO` with a 15,000 ms timeout. The wrapper falls back to ordinary `read` when it cannot establish the required scope, offset, or generic-device association. The timeout is therefore neither a universal deadline for every library operation nor a total recovery limit. [Build](https://github.com/pmaidens/rip-dvd/blob/21f5c8864173d7ae5a11a3b08d6e07c281b0bb02/docker/runtime.Dockerfile#L24), [wrapper](https://github.com/pmaidens/rip-dvd/blob/21f5c8864173d7ae5a11a3b08d6e07c281b0bb02/docker/libdvdcss-sg-io.c#L715).

Linux SCSI command expiry may invoke a driver timeout handler, reset a timer, schedule aborts and retries, or enter error handling that escalates through device, bus, and host resets. Application retry counts cannot bound that lower-layer work. A timeout is not proof that the hardware has stopped executing a command. [Linux SCSI error handling](https://docs.kernel.org/scsi/scsi_eh.html).

The SG maintainer's explanation also distinguishes returning from a terminated process from command completion: the command may continue and its result be discarded. That document describes Linux 2.6.16, so it supports the conceptual distinction, not a measured latency guarantee for this deployment. Exact stop latency and firmware retry behavior remain hardware/kernel/bridge measurements. [SG_IO documentation](https://sg.danny.cz/sg/sg_io.html).

## Map-based recovery provides a useful algorithm

GNU ddrescue separates broad copying from later trimming, sweeping, scraping, and retrying. Its map distinguishes untried, non-trimmed, non-scraped, bad, and finished blocks. It preserves successful blocks when resuming. Variable skipping gets beyond difficult areas, at the cost of leaving potentially readable data for later. Smaller skips inspect more of that neighborhood during the first pass. Its ETA uses recent throughput and cannot assume all remaining data is recoverable. These are algorithmic precedents, not a recommendation to replace the CSS reader with the ddrescue executable. [GNU manual](https://www.gnu.org/software/ddrescue/manual/ddrescue_manual.html).

A retry pass has a finite traversal even when the number of passes is unlimited. GNU's maintainer explains that every bad sector is tried once per retry pass, and separately documents infinite passes. Thus unlimited overall time does not require an unbounded attempt on one sector. [Retry-pass terminology](https://lists.gnu.org/archive/html/bug-ddrescue/2014-06/msg00011.html), [infinite retry passes](https://mail.gnu.org/archive/html/bug-ddrescue/2020-03/msg00002.html).

## Implications to carry into the decision tickets

These are deductions from the inspected code and sources, not settled product policies.

- Prompt initial copying requires deferring subdivision and repeated reads after a tolerable error. Record the failed request and any additional skipped interval separately. A failed multi-sector request does not establish that every sector in it is individually unreadable.
- Successful sectors need a durable state distinct from placeholders. Retrying only unresolved regions should never overwrite known-good data with zeros after a later failed read. Persist image updates and evidence in an ordered checkpoint protocol before acknowledging stop or opening encoding. The current terminal-result mechanism needs extension for this purpose.
- Stop needs distinct states for requested, waiting on the active operation, and durably stopped. A cooperative reader can avoid issuing another request, but no reviewed source supports a universal instant hardware abort. Retain exclusive ownership until writes can no longer occur.
- Measure examined sectors, skipped/unresolved sectors, recovered sectors, request duration, active phase, pass ordinal and direction, elapsed time, and time since last successful recovery separately. Current progress bytes alone cannot answer how much recovery succeeded.
- Estimate time to traverse the current pass using observed attempt costs and remaining work of comparable size. A range must account for changing read sizes and stalls. Return unknown when observations are inadequate. An unlimited sequence of future passes has no finite completion ETA, and recovery yield is not pass throughput.
- Zero recovery in one pass is an observation, not proof of permanent unreadability. Whether to repeat automatically, pause for an operator, or declare the planned recovery complete remains a decision. None of those options should silently introduce an overall elapsed-time cutoff.

## Questions now precise enough to decide

1. What initial request/skip sizes and escalation rules balance forward progress against deferring readable neighbors? How does this interact with the existing boundary-proof classifier?
2. What constitutes a completed recovery sequence when damage remains, particularly after a pass with no recovered sectors, while preserving the operator's choice to continue?
3. Which cooperative checkpoint and output-ownership contract makes stop-and-keep durable, including a reader still blocked in the kernel?
4. What minimum observations and uncertainty display justify a pass ETA, and when should it revert to unknown?

No physical-drive benchmark or production change was performed. Hardware measurements are still needed before promising stop responsiveness or choosing command-timeout/skip-size tuning. Existing worker fault-injection tests can verify request ordering and persistence semantics; they cannot establish firmware timing.
