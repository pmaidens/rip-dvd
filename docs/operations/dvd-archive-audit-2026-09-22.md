# DVD archive audit, 2026-09-22

Issue #324 called for a read-only audit of the live deployment and a bounded report. This is the audit result, not a record of physical rearchiving. The operator procedure is in [DVD archive audit and physical rearchiving](dvd-archive-reaudit-and-rearchive.md).

## Execution and scope

The live Compose checkout was at `1be846113b2b95b911ccc876038eba460b45788a`, before the audit service and DVD safeguards reached the deployment. To avoid updating that checkout or its services, I built a one-off image from repository commit `003604dd36d4253122931eb74de6d5fe2658736c` in a temporary directory and ran its `archive-audit-v1` entry point against the deployment. The container had no network, a read-only root filesystem, a read-only mount of the originals library, and a read-only mount of the SQLite volume. The command used a read-only SQLite connection with `query_only`. It created no Archive Requests or Archive Jobs and did not change archives or database rows.

| Measure | Value |
| --- | ---: |
| Start, UTC | 2026-09-22 04:21:32.548 |
| Completion, UTC | 2026-09-22 04:23:01.972 |
| Matching DVD archives examined | 186 |
| Record limit | 1,000 |
| Record set truncated | No |
| Concurrent file helpers | 2 |
| Per-file timeout | 5,000 ms |
| Overall timeout | 600,000 ms |

The command exited successfully. Its JSON report contains stable IDs, byte counts, geometry, and classifications but no archive paths or filesystem error text. This public summary uses only relevant disc labels and eight-character archive ID prefixes. Full IDs remain in the restricted audit output for operator lookup.

| Primary classification | Count |
| --- | ---: |
| Definite truncation | 20 |
| Suspicious capacity reuse | 11 |
| Malformed metadata | 3 |
| Consistent | 152 |
| Unsupported layout | 0 |
| Missing file | 0 |
| Size mismatch | 0 |
| Containment rejection, nonregular file, read error, or timeout | 0 |

The audit found 11 exact-capacity clusters spanning distinct media generations on the same Optical Drive. It attached capacity-reuse signals to 30 findings: 19 definite truncations and 11 otherwise consistent archives. A repeated byte count is a lead only. The definite classification came from an ISO 9660 volume-space declaration beyond the actual file end for every one of the 20 archives. The three malformed-metadata archives need separate inspection; the audit cannot establish their physical boundaries.

## Known incident discs

All three DS9 incident discs appear as definite truncations. Each file and recorded archive size is 8,047,493,120 bytes. Their ISO 9660 declarations extend beyond EOF.

| Disc label | Archive ID prefix | ISO-declared bytes |
| --- | --- | ---: |
| DS9S6D2 | `28fb6607` | 8,413,894,656 |
| DS9S6D3 | `ddb74f4f` | 8,209,993,728 |
| DS9S6D5 | `1e64cd93` | 8,231,698,432 |

These three also carry a capacity-reuse signal at 8,047,493,120 bytes, shared with DS9S5D7. The geometry result, rather than that shared size, establishes their audit classification.

## Other definite candidates

The remaining 17 candidates also have ISO 9660 volume-space declarations beyond EOF. The shortfall is the declared size minus actual file size, rounded to one decimal MiB. The audit does not identify the matching physical DVD or verify a replacement; an operator must check each case before rearchiving.

| Archive ID prefix | Disc label | Shortfall, MiB |
| --- | --- | ---: |
| `185b1247` | CLUELESS | 163.9 |
| `71bfd3e8` | LEGALLYBLONDE | 1,884.9 |
| `a05e36e8` | GILMORE_GIRLS_S6_D1 | 3,190.2 |
| `70ed8245` | SUITS | 181.1 |
| `26a5aef0` | SUITS | 343.0 |
| `bea983a5` | LORD_OF_THE_RINGS_1978 | 3,512.8 |
| `c085498d` | DS9S4D1 | 88.8 |
| `9e006cca` | DS9S4D7 | 198.2 |
| `0a2bae87` | DS9S5D2 | 165.2 |
| `fe11133d` | ICE_AGE_3 | 3,492.7 |
| `78011eb7` | ICE_AGE_2 | 4,885.9 |
| `eda5d7ed` | LIONKING_1_5 | 3,120.8 |
| `454de14e` | MEAN_GIRLS_16X9 | 448.4 |
| `4aa0e55a` | OFFICE_SPACE_SE | 628.3 |
| `46c11e62` | THE_UNIT_SEASON_3_DISC_2 | 252.2 |
| `f2e3f4c1` | THE_UNIT_SEASON_4 | 373.1 |
| `d67f9758` | THE_UNIT_SEASON_4 | 329.9 |

Sixteen of these 17 also have a capacity-reuse signal. CLUELESS does not; its ISO 9660 geometry alone put it in the definite group. The 11 findings classified only as suspicious capacity reuse have supported geometry within their files, so the audit does not call them truncated. The three malformed-metadata findings are `8c9adda4`, `760bc108`, and `e534ac1c`; they are neither geometry confirmations nor clean bills of health.

This audit did not request or run physical rearchiving. No DVD was inserted for this task, no Archive Request was created for it, and no successful replacement Archive Job evidence was collected. Physical rearchiving remains an operator task after the safeguards are deployed.
