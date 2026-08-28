# SCSI read-failure classification

## Decision

The reader should stop treating a sense buffer as an all-or-nothing structure. The SCSI sense key, ASC, and ASCQ are the classification evidence. Optional fields and descriptors refine that evidence. They do not invalidate it.

That distinction fixes both Brooklyn Nine-Nine failures:

- `03/11/05` is `MEDIUM ERROR / L-EC UNCORRECTABLE ERROR`. The existing fixed-format parser can reject it when the drive also supplies valid command-specific, FRU, or sense-key-specific data.
- `03/02/00` is `MEDIUM ERROR / NO SEEK COMPLETE`. It is not in the reader's ASC whitelist. The MMC working group explicitly permits `3/02/00` during a read and recommends retrying the command. The same guidance names `2/04/07` and `2/04/08` as preferred responses for temporary read resource conflicts ([T10/08-456r0, section 7.1](https://www.t10.org/ftp/t10/document.08/08-456r0.pdf)).

For a current READ(10) failure, sense key `03h` is enough to enter the bounded read-recovery path. The ASC and ASCQ remain useful diagnostics, but they should not be a recovery allowlist. The maintained `sg3_utils` decoder follows this rule: it categorizes every `MEDIUM ERROR` sense key as a medium/hardware error, then treats ASC/ASCQ as detail ([`sg_err_category_sense`](https://github.com/doug-gilbert/sg3_utils/blob/main/lib/sg_lib.c#L2210-L2278)).

## What Linux SG_IO returns

The code uses Linux's version 3 `SG_IO` ABI. `sg_io_hdr_t.status` is the SCSI device status, `host_status` comes from the host adapter, `driver_status` comes from the software driver, and `sb_len_wr` is the number of bytes actually copied to the caller's sense buffer ([Linux `sg.h`](https://github.com/torvalds/linux/blob/master/include/scsi/sg.h#L35-L74)).

On the current kernel path, the SG driver copies `min(8 + additional_length, SCSI_SENSE_BUFFERSIZE, mx_sb_len)` bytes and sets `driver_status` to the obsolete but compatibility-preserved `DRIVER_SENSE` value `08h` when it returns sense data ([Linux `sg.c`](https://github.com/torvalds/linux/blob/master/drivers/scsi/sg.c#L520-L552), [Linux `sg.h`](https://github.com/torvalds/linux/blob/master/include/scsi/sg.h#L107-L117)). The project requests 252 bytes, which is the SPC maximum. A larger declared sense record can still arrive truncated at the kernel's internal sense-buffer size, so `8 + additional_length == sb_len_wr` is not a safe validity requirement.

The SCSI status comparison should use Linux's status mask. Both the maintained kernel and `sg3_utils` mask bit 0 before comparing status ([Linux `scsi.h`](https://github.com/torvalds/linux/blob/master/include/scsi/scsi.h#L61-L75), [`sg_scsi_status_is_good`](https://github.com/doug-gilbert/sg3_utils/blob/main/lib/sg_lib.c#L214-L257)). An exact `status == 02h` comparison can reject a CHECK CONDITION completion that carries that low status bit. Use `(status & 0xfe) == 0x02`.

Current Linux host statuses are `00h` through `0fh` plus `14h`. Values `10h` through `13h` were removed but left unused for userspace compatibility; `14h` is `DID_TRANSPORT_MARGINAL` ([Linux `scsi_status.h`](https://github.com/torvalds/linux/blob/master/include/scsi/scsi_status.h#L38-L67)). Any nonzero host status means the target-sense recovery path is not proven. Classify it as a terminal transport failure. A whitelist is unnecessary and turns future kernel statuses into `unknown`.

Modern SG output uses driver status `00h` or `08h`. The older ABI also defined low-nibble statuses `01h` through `07h` and high-nibble retry, abort, remap, die, and sense suggestions ([SG v3 HOWTO, `driver_status`](https://sg.danny.cz/sg/p/sg_v3_ho/ch06.html)). If compatibility with those values is retained, inspect the low nibble instead of comparing the full field. A base status other than `00h` or `08h` should remain terminal. In particular, do not let a driver suggestion authorize zero substitution without current target sense.

## Sense data is deliberately extensible

SPC defines `70h` and `71h` as fixed-format current and deferred errors, and `72h` and `73h` as descriptor-format current and deferred errors. The response code, sense key, ASC, and ASCQ form a hierarchy. The additional-length byte tells the caller how many bytes follow ([T10/08-321r0](https://www.t10.org/ftp/t10/document.08/08-321r0.pdf)).

The current decoder is much stricter than that contract.

### Fixed format

The reader currently requires exactly 18 bytes and rejects any nonzero value in these fields:

- byte 1, an obsolete field;
- FILEMARK, EOM, ILI, and SDAT_OVFL above the sense-key nibble in byte 2;
- command-specific information in bytes 8 through 11;
- the FRU code in byte 14; and
- sense-key-specific data in bytes 15 through 17.

Those fields are defined data, not padding. For `MEDIUM ERROR`, a set SKSV bit in byte 15 means bytes 16 and 17 contain the drive's actual retry count. T10's sense-data work describes that exact use ([T10/08-321r0, actual retry count](https://www.t10.org/ftp/t10/document.08/08-321r0.pdf#page=5)). The maintained `sg3_utils` decoder reads all of these fields and normalizes a fixed record as soon as the bytes needed for each field are present; it does not require an 18-byte record or zero optional fields ([normalization](https://github.com/doug-gilbert/sg3_utils/blob/main/lib/sg_lib.c#L2165-L2208), [fixed-field decoding](https://github.com/doug-gilbert/sg3_utils/blob/main/lib/sg_lib.c#L1889-L1950)).

The fixed-format VALID bit applies only to the information field. If VALID is clear, the information LBA must not drive boundary proof or bad-sector localization. Nonzero information bytes do not invalidate the sense key or ASC/ASCQ. `sg3_utils` returns the information value separately from the VALID result for this reason ([`sg_get_sense_info_fld`](https://github.com/doug-gilbert/sg3_utils/blob/main/lib/sg_lib.c#L413-L443)).

### Descriptor format

The reader currently accepts only a single information descriptor. T10/08-321r0 lists information (`00h`), command-specific information (`01h`), sense-key-specific (`02h`), FRU (`03h`), stream (`04h`), block (`05h`), OSD (`06h` to `08h`), ATA status (`09h`), and vendor-specific (`80h` to `FFh`) descriptors. Later revisions added more standard types. The maintained `sg3_utils` decoder handles types through `0Fh` and skips unknown or vendor types ([T10/08-321r0, descriptor table](https://www.t10.org/ftp/t10/document.08/08-321r0.pdf#page=2), [`sg_get_sense_descriptors_str`](https://github.com/doug-gilbert/sg3_utils/blob/main/lib/sg_lib.c#L1462-L1774)). T10 forbids duplicate descriptors of the same type, not the presence of different types. A well-bounded descriptor with an unneeded or unknown type should be skipped for core classification.

The information descriptor's VALID bit has the same narrow role as fixed-format VALID. T10/08-321r0 requires it to be set for a standards-defined information descriptor and defines a clear bit as meaning the information field is not defined by a command standard ([T10/08-321r0, information descriptor](https://www.t10.org/ftp/t10/document.08/08-321r0.pdf#page=3)). `sg3_utils` tolerates the clear form as vendor-specific information but does not report a valid information field ([`sg_get_sense_info_fld`](https://github.com/doug-gilbert/sg3_utils/blob/main/lib/sg_lib.c#L413-L443)). A clear VALID bit, malformed information descriptor, or LBA outside the requested range should discard the LBA, not the already decoded sense header.

Current SPC also uses the header's SDAT_OVFL bit to report omitted sense data. `sg3_utils` accepts that bit in fixed and descriptor records and still decodes the available core fields ([sense rendering](https://github.com/doug-gilbert/sg3_utils/blob/main/lib/sg_lib.c#L1835-L1881)). The reader currently rejects it.

### Current versus deferred errors

Deferred responses `71h` and `73h` describe a previous command. They may be decoded for diagnostics, but they must not authorize recovery or zero substitution for the current requested range. Recovery should require current response `70h` or `72h`. This is one place where the existing conservative behavior is right.

### Parser decision matrix

| Evidence | Accept for core classification | Location effect | Core-invalidating condition |
| --- | --- | --- | --- |
| Capture metadata | `captured`, reported length at most the 252-byte destination, and copied length equal to reported length | None | Missing capture, overflow, or a copied/reported mismatch |
| Fixed `70h` or `71h` | Use `usable = min(captured, 8 + additional_length)`; key needs byte 2 and ASC/ASCQ need bytes 12 and 13 | VALID clear or an out-of-request value makes location absent | Unsupported response, or `usable < 14` when classification needs key/ASC/ASCQ |
| Fixed optional fields | Ignore byte 1; FILEMARK/EOM/ILI/SDAT_OVFL in byte 2; command-specific bytes 8 to 11; FRU byte 14; and SKSV/SKS bytes 15 to 17 | None, except VALID and bytes 3 to 6 | Never invalidate core merely because these fields are nonzero |
| Descriptor `72h` or `73h` | Four captured bytes are enough for response, key, ASC, and ASCQ; byte 7 is needed only to walk descriptors | No descriptor scan when the eight-byte header is incomplete | Unsupported response or fewer than four bytes for a classification that needs ASCQ |
| Descriptor list | Bound by `min(captured, 8 + additional_length)`; skip each complete unneeded, unknown, or vendor descriptor | A truncated tail or descriptor overrun makes location parsing incomplete | Never erase core fields already decoded from bytes 0 to 3 |
| Information descriptor | Type `00h`, additional length `0Ah`, reserved bits clear, one instance, VALID set | Any failed check makes location absent | Never erase core classification |
| Deferred response | Decode for evidence | Location cannot refer to the current READ(10) | Always terminal for recovery, split, zero substitution, and boundary proof |

The matrix deliberately distinguishes a malformed optional suffix from an undecodable sense record. A malformed information descriptor cannot safely locate a sector, but it cannot change a current `MEDIUM ERROR` header into something else.

## Classification policy

Apply precedence in this order:

1. No captured completion, an interrupted SG_IO call, or a nonzero host status is a terminal transport failure or `unknown` when no status exists.
2. A driver base status other than `00h` or `08h` is terminal. Preserve its raw value in evidence.
3. A device status other than masked CHECK CONDITION is terminal `unknown` unless a separate status category is added.
4. Decode fixed or descriptor sense incrementally. Require only the bytes needed by the field being read. Preserve whether the response is current, whether the record was truncated, and whether an information LBA is valid.
5. Deferred sense is terminal and must not enter range recovery.
6. Current sense key `03h` from READ(10) is a recoverable medium error, regardless of ASC/ASCQ. This covers standard `11h` read errors, `3/02/00`, and vendor detail while keeping recovery bounded by the existing retry, split, and zero-substitution policy.
7. Current sense key `02h` is `not_ready`. Keep it terminal unless a separate bounded delay-and-retry state is added. `2/04/07` and `2/04/08` are temporary according to MMC, but treating them as medium damage would eventually write zeros for an undamaged disc.
8. Sense keys `04h`, `06h`, and `07h` remain `hardware_error`, `unit_attention`, and `protection_error`.
9. `ILLEGAL REQUEST / 6Fh` is `protection_error`. The current `ASCQ <= 05h` test is stale. T10 now assigns DVD copy-protection values through `6Fh/0Ah`, including binding, permission, and drive-host pairing failures ([T10 ASC/ASCQ assignments](https://www.t10.org/lists/asc-num.htm#ASC_6F)). Match the ASC, not a frozen ASCQ range.
10. `ILLEGAL REQUEST / 21h/00h` is an out-of-range candidate only for current sense with a valid information LBA inside the request. Keep the existing boundary proof before truncating or publishing an image. T10 assigns `21h/00h` as `LOGICAL BLOCK ADDRESS OUT OF RANGE` for C/DVD devices ([T10 ASC/ASCQ assignments](https://www.t10.org/lists/asc-num.htm#ASC_21)).
11. Other sense keys remain terminal `unknown` until the application has a distinct policy for them. In particular, `BLANK CHECK` and `ABORTED COMMAND` should not borrow the medium-damage zero-substitution policy merely because another library groups them nearby.

T10's current assignment table confirms the important DVD read tuples: `11h/00h`, `01h`, `02h`, `05h`, and `06h` are read or ECC failures, while `11h/0Dh` through `11h/11h` are also assigned to C/DVD reads ([T10 `11h` assignments](https://www.t10.org/lists/asc-num.htm#ASC_11)). A hardcoded five-value ASCQ list will keep aging badly. Key-driven recovery avoids that problem.

## Concrete code changes

Refactor [`decode_sense`](../../docker/dvdcss-reader.c#L339) so core decoding and optional-location validation are independent:

- Replace `well_formed` with narrower facts such as `recognized_format`, `is_current`, `is_deferred`, `sense_truncated`, and `has_information_lba`.
- For fixed sense, compute `usable_length = min(captured_length, 8 + sense[7])` when byte 7 exists. Read the key at byte 2, ASC at byte 12, and ASCQ at byte 13 only when each byte is available. Ignore optional fields for classification.
- For descriptor sense, decode the four-byte header first. Bound the descriptor region by both captured and declared length. Walk every complete descriptor, skip unneeded types, and parse the first valid type `00h`, length `0Ah` information descriptor. An incomplete descriptor invalidates location parsing, not the header fields already decoded.
- Set `has_information_lba` only when VALID is set and the value falls within the submitted READ(10) range. Otherwise keep the medium classification unlocated.
- Mask SCSI status before comparing CHECK CONDITION.
- Let every nonzero host status win over target sense. Treat driver status by base nibble if legacy suggestion bits are supported.
- Replace `is_recognized_dvd_medium_read_error` with a current-sense-key check for `03h`.
- Match all `ILLEGAL REQUEST / 6Fh` protection errors.

Keep raw SCSI, host, driver, response, key, ASC, ASCQ, and request fields in the emitted evidence. The changed observable meaning requires `scsi-read-classifier-v2` in both the reader and the worker contract in [`dvd-recovery-contracts.ts`](../../apps/archive-worker/src/dvd-recovery-contracts.ts#L15). The TypeScript mirror in [`archive-read-failure.ts`](../../packages/data-access/src/archive-read-failure.ts#L20) and the database evidence constraint in [`schema.ts`](../../packages/data-access/src/internal/schema.ts#L786) duplicate the old host, driver, medium, and protection rules. They must change in the same commit or a newly valid C result may be rejected while the archive failure is persisted.

## Test matrix

Keep malformed buffers terminal, but move these currently rejected cases into accepted classification tests:

- fixed `03/11/05` with SKSV and a nonzero actual retry count;
- fixed sense with command-specific information, FRU, FILEMARK/EOM/ILI, or SDAT_OVFL set;
- fixed records whose declared and captured length is 14, 18, or greater than 18;
- a declared record longer than the captured prefix, with key and ASC/ASCQ still available;
- fixed VALID clear with nonzero information bytes, classified as an unlocated medium error;
- descriptor medium sense containing command-specific, sense-key-specific, FRU, vendor, or other well-bounded descriptors before and after the information descriptor;
- descriptor VALID clear, missing information descriptor, malformed information descriptor, and out-of-request information LBA, all classified as unlocated medium errors;
- fixed and descriptor `03/02/00`, with transient recovery and persistent single-sector recovery cases;
- every current `03h` sense with an unfamiliar or vendor ASC/ASCQ, proving that detail does not gate recovery;
- deferred `71h` and `73h` medium sense, proving that no retry, split, zero write, or boundary proof occurs;
- CHECK CONDITION with legal vendor status bits set;
- descriptor and fixed SDAT_OVFL;
- `05/6F/06` through `05/6F/0A` as protection failures;
- nonzero unknown host status as terminal transport failure; and
- driver suggestion bits combined with `DRIVER_SENSE`, if legacy compatibility is intentionally supported.

Retain tests that prevent unsafe location use: malformed response codes, too-short headers, descriptor-length overruns, duplicate information descriptors, VALID clear, contradictory LBAs, deferred errors, and out-of-range boundary candidates without full proof.
