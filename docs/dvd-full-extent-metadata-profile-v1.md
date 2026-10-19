# DVD full-extent metadata profile v1

This is the accepted implementation contract for issue #405. Its policy identifier
is `dvd-full-extent-metadata-v1`. Admission of `dvd-recovery-evidence-v1` remains
closed. The rules below apply to marked new-format Archive Jobs once implemented;
they do not describe an already admitted publication path.

## Publication decision

The profile applies only to an image whose exact sector-aligned size equals the
Disc Inspection extent and whose normal endpoint proof has passed all current
Optical Drive, source, claim, and cancellation fences. Sector size is 2,048 bytes.
A smaller corrected extent uses the existing strict filesystem/DVD completeness
proof, title-map comparison, and sector-precise endpoint evidence. It receives no
waiver from this profile.

For a full extent, inspect the fields listed below and every independently
discoverable instance of their records. Publication is permitted when the image
is stable, at least one supported filesystem bootstrap and a positive readable
volume or partition extent survive, and no listed check is contradictory,
unsupported, or unexplained. Missing dependencies explained by Unrecovered Source
produce unknown observations. Complete loss of all supported bootstrap/geometry
declarations blocks v1 as unsupported, even when source-explained.

This decision asserts agreement of the listed readable claims. It does not prove
complete DVD navigation semantics or that unavailable records have a possible
joint completion. Structural and title impact remain unknown when Unrecovered
Source is present or discovery/check dependencies are unavailable. The profile
does not establish watchability or encode eligibility.

## Availability and exact attribution

- Inputs are the accepted extent, the immutable image, and the normalized
  `DvdUnrecoveredSourceRange` list bound to that image/copy. Preserve
  `skipped_untested` and `individually_failed`; both represent unavailable source.
- Each scalar or comparison has explicit byte dependencies mapped through known
  file extents to physical LBAs. A field is known only when every sector supplying
  it lies outside Unrecovered Source. Treat substituted bytes inside those ranges
  as unavailable even if their local read succeeds.
- A source-unavailable observation names the exact intersecting source ranges and
  field. A dependent observation names that field as its missing prerequisite.
  Unreadable bytes outside the map, short local reads, size/identity changes,
  malformed readable values, and map/image mismatches block publication.
- Evaluate every check whose operands are known. Losing a checksum dependency
  makes that checksum unknown; it does not hide readable address/length fields.
  A whole-view exception or generic navigation-subprocess failure is not source
  attribution. A zero-filled readable sector outside the map is not source damage.
- Continue fixed-position descriptors, known table slots, separately located
  files, and peer filesystem views after a source gap. Follow variable records
  only at positions established by readable lengths or supported block rules.
  Never scan for plausible signatures to guess an unknown record boundary.
- A missing discovery prerequisite makes only that branch unknown. Independently
  established locations remain inspectable. A directory with a source gap cannot
  prove absence. A fully read directory can establish absence of a required file.
- Source ranges remain immutable sorted intervals. Overlap, invalid bounds, and
  adjacent equal classifications are noncanonical; adjacent different
  classifications are valid. No full-extent path expands them into sector sets.
  Excluded suffix sectors never enter this map.

## Supported layouts and discovery

V1 supports single-volume ISO 9660 with a primary descriptor and optional Joliet
supplementary descriptors, and physical UDF 1.02 with `NSR02`, type-1 partition
maps, file entries tagged 261, and recorded short/long allocation descriptors.
Visited UDF records use ordinary directory/file types 4/5, zero extended-attribute
length, and no embedded, sparse, continuation, virtual, sparable, or metadata
partition allocation. A readable feature needed for discovery outside this list
blocks as unsupported. Unlisted payload fields are outside this profile.

Read ISO descriptors at LBA 16 onward through a readable terminator, within the
descriptor bound. Inspect UDF recognition sectors 16 through 47 and distinct
in-image anchor candidates 256, `N - 257`, and `N - 1`, where `N` is image sectors.
Use every readable anchor's declared main/reserve sequences. A source gap cannot
hide a later descriptor at its independently known sector. ISO sequence framing
requires a readable terminator; an unidentifiable sequence end blocks v1.

ISO discovery starts at sector 16. A readable `CD001` header establishes a view;
if that sector is source-unavailable, inspect subsequent fixed descriptor slots
through the first readable ISO terminator or the bound. With no readable ISO
header, report unknown presence if discovery sectors are source-unavailable,
otherwise absent. A readable non-ISO sector 16 with no established ISO view
does not create an ISO parsing requirement. For UDF, any readable recognition
identifier or anchor candidate with tag ID 2 establishes a candidate that must
undergo the listed checks; arbitrary non-anchor contents at alternate positions
are ignored. No readable candidates plus source gaps yields unknown presence;
fully readable discovery with no candidate establishes absence. A recognized
candidate's contradiction cannot be hidden by another view's success.

Traverse only the root directory and its `VIDEO_TS` directory in every supported
view. Check address/length fields of every readable record in those directories;
visit file entries for the recognized DVD paths below. Other directory contents,
path-table contents, filesystem extensions, and unrelated file payloads are not
traversed. Declared path-table ranges are still geometry claims.

ISO records must fit within one logical block. A source-unavailable block can be
skipped at the next known block boundary. V1 likewise supports UDF directory FIDs
contained within a logical block; a readable cross-block FID is unsupported.
Inspect known subsequent blocks independently. A readable malformed record is a
blocker, not an opportunity to resynchronize.

Recognized paths are `VIDEO_TS/VIDEO_TS.IFO`, `.BUP`, optional `.VOB`, and
`VIDEO_TS/VTS_nn_0.IFO`, `.BUP`, optional `_0.VOB`, and `_1.VOB` through `_9.VOB`,
with `nn` from 01 through 99. Normalize ISO version suffix `;1` and supported
filename case before comparison. Other version suffixes on recognized DVD paths
are unsupported. Ambiguous duplicate canonical paths block.
Known relevant file lengths must be positive and sector-aligned, and known
recorded extents contiguous; adjoining allocation records may coalesce. A missing
length or allocation field remains source-dependent unknown. Known fragmented or
multi-extent ISO files are unsupported. Concatenate title VOB chunks in numeric
order, requiring consecutive suffixes and physical adjacency when the complete
domain inventory is known. A known prefix can locate NAV packs even when a later
chunk's discovery is unavailable; only comparisons needing total length become
unknown. Menu VOBs each form their own domain.

## Exact field groups and checks

All offset ranges below are byte offsets from the start of the named record.
Unsigned arithmetic must be safe and nonnegative; computed image extents must
stay within the accepted image and any independently known containing extent;
zero means absent only where explicitly allowed. An inclusive last-address field
becomes an exclusive end by adding one. All comparisons require known operands.

### ISO geometry and file locations

| Record/fields | Required checks |
| --- | --- |
| Descriptor `type`, `CD001`, version | Version 1; types 0, 1, 2, 255; type 2 uses Joliet `%/@`, `%/C`, or `%/E`. Type 0 body is outside the profile. At most one known primary per sequence; a complete sequence must contain one primary and its terminator. Known duplicates block even if other slots are unavailable. |
| Volume-space size 80/84, volume-set size 120/122, volume sequence 124/126, logical-block size 128/130 | Paired endian values agree; positive volume size no greater than `N`; single volume and sequence 1; block size 2,048. All readable primary/Joliet views agree on these claims. A declared filesystem may end before the physical image. |
| Path-table length 132/136; L/M table locations 140, 144, 148, 152 | Positive paired endian lengths agree. Required L/M locations are nonzero; optional copy locations may be zero. Every nonzero location and rounded declared length fit the known volume and image. Contents are outside v1. |
| Root record at 156 and root/`VIDEO_TS` directory records: record length, extended-attribute count, extent LBA, data length, flags, file-unit size, interleave gap, volume sequence, identifier length/name | Record/name fit the block; paired endian values agree; volume sequence 1. Flags permit only hidden bit `0x01` and directory bit `0x02`; file-unit size/interleave gap are zero. Include extended-attribute sectors before the data LBA and in address bounds. Zero record length means padding to the next block. Root/`VIDEO_TS` ranges are positive and fit the volume/image. Every readable record's declared range fits; unrelated files may have zero length. Decode primary names as ASCII and Joliet as even-length UCS-2BE. Special identifiers 0/1 mean self/parent and must match known locations/types. |

### UDF geometry and file locations

All UDF integers are little endian. Extent lengths use bytes and locations use
logical blocks. For short/long allocation descriptors, the low 30 length bits
are the byte count and the high two bits must designate recorded allocation.
Long descriptors additionally carry a 16-bit partition reference at byte 8.
Partition-map references index the ordered LVD map list.

| Record/fields | Required checks |
| --- | --- |
| Recognition type 0, identifier bytes 1 through 5, version 6, reserved bytes 7 through 2047 | A readable supported recognition sequence is ordered `BEA01`, `NSR02`, `TEA01`, with structure type 0/version 1 and reserved bytes zero. Missing fields are unknown only with exact source dependencies; readable conflicting order/duplicates block. `NSR03` is unsupported in v1. |
| Descriptor tag: identifier/version at 0/2, checksum/reserved at 4/5, CRC/CRC length at 8/10, location at 12 | Identifier/version/CRC/CRC length are 16-bit; location is 32-bit. Version 2, reserved zero. Tag checksum covers the 16-byte tag except byte 4. CRC-16 uses polynomial `0x1021`, initial zero, over the declared body. Checksum/CRC agree whenever their dependencies are available; exact CRC lengths are defined below. Location matches the known physical address for volume/anchor tags and partition-relative block for FSD/FE/FID tags. Supported volume-sequence tags are 1, 4, 5, 6, 7, 8; tag 3 continuation is unsupported. Tag 4 payload is outside v1. |
| Anchor tag 2: main/reserve length and location at 16/20 and 24/28 | Positive sector-aligned sequences fit the image and descriptor bound, do not overlap, and all readable anchors agree. Inspect main/reserve independently. |
| PVD tag 1: abstract/copyright extents at 328 and 336 | Each nonzero extent fits the image; zero length has zero location. One primary per complete sequence; known duplicates block. Volume identifiers and timestamps are outside v1. |
| Partition tag 5: flags at 20, number at 22, contents entity at 24, access type at 184, start at 188, length at 192, partition-header short extents at 56, 64, 72, 80, 88 | Flags/access type 1, contents `+NSR02`; positive partition fits the image; numbers are unique within each sequence. Every nonzero header extent is recorded and fits its partition; zero length has zero location. |
| LVD tag 6: block size 212, domain entity 216, file-set long AD 248, map byte/count fields 264/268 and maps 440 onward, integrity extent 432/436 | Block size 2,048; domain identifier bytes 217 through 239 are `*OSTA UDF Compliant` with zero padding and revision at 240 is `0x0102`. Map lengths exactly cover the positive count, at most 16 type-1 maps of six bytes, volume sequence 1. References resolve to known partition numbers or become source-dependent unknowns. Recorded file-set and integrity extents fit their known partition/image. One logical volume per complete sequence; known duplicates block. |
| Unallocated-space tag 7: count at 20 and extent list at 24 | At most 61 entries fitting the descriptor. Each declared extent fits the image. A complete sequence needs a readable terminator, PVD, LVD, and referenced partition descriptors; a missing required record in an incomplete source-damaged sequence remains unknown. |
| FSD tag 256: root long AD at 400, domain entity 416, next/system-stream ICB bytes 448 through 479 | Domain identifier at 417 and revision at 440 match the LVD rules. Root ICB is recorded and inside its known partition; next/system-stream fields are zero. Other FSD payload is outside v1. |
| FE tag 261: ICB type/flags at 27/34, information length 56, recorded blocks 64, external-attribute ICB 112, extended-attribute/allocation lengths 168/172, allocation list 176 onward | Type is an 8-bit 4/5 and flags are 16-bit with allocation form 0/1 in low three bits and top three reserved bits zero. Information length/recorded blocks are 64-bit values within safe integer bounds; external/inline attributes are zero. Descriptors fit the entry, cover information length, and only the final allocation may include less than one sector of padding. Recorded blocks equal the sum of rounded allocated sector counts. Each known extent fits its partition/image. Reject visited ICB cycles and conflicting types. |
| FID tag 257: version 16, characteristics/name length 18/19, long AD 20, implementation-use length 36, identifier 38 onward | Version 1; characteristics are 0 for a file, 2 for a directory, or `0x0a` for its parent. Parent identifier length is zero. Zero implementation-use length; name and four-byte-rounded record length fit its block. Zero tag ID denotes all-zero padding to the next block. Decode OSTA compressed Unicode IDs 8/16. Parent references agree where known. Required file ICBs fit known partitions; duplicate canonical paths block. |

Required body CRC lengths are 496 for tags 1, 2, 4, 5, 8, and 256;
`424 + mapTableLength` for tag 6; `8 + allocationCount * 8` for tag 7;
`160 + extendedAttributeLength + allocationDescriptorLength` for tag 261;
and `FID padded record length - 16` for tag 257. Every known length must fit
its declared record. An unavailable length makes the checksum dependent-unknown.

Volume-sequence presence is evaluated per sequence. Compare readable mirror claims
by descriptor kind and partition number, never by assuming descriptor order.
Unavailable slots do not supply invented replacement descriptors or partition
identities. If resolving an extent needs an unavailable partition record, retain
that dependency as unknown and continue other known extents.

### DVD-Video control headers and VOBU maps

Offsets here are big endian. Evaluate BUP address fields relative to the matching
primary IFO's known physical base, rather than the BUP's own location.

| Fields | Required checks |
| --- | --- |
| Identifier bytes 0 through 11 | `DVDVIDEO-VMG` for manager IFO/BUP and `DVDVIDEO-VTS` for title-set IFO/BUP. A readable wrong identifier blocks. |
| Domain last sector `0x0c`, information last sector `0x1c`, MAT last byte `0x80` | Information length agrees with known IFO/BUP file length. MAT end covers the fields listed here and fits information length. Domain end fits the image and contains every known related file; if domain inventory is complete, it equals the maximum related-file end. |
| VMG title-set count `0x3e` | From 1 through 99. Every known title-set number fits; equality with the set 01 through count is required only for complete inventory. |
| Menu VOB start `0xc0` in VMG/VTS; title VOB start `0xc4` in VTS | Nonzero starts fit the image and match independently known domain starts. A zero start contradicts a known corresponding VOB. Require zero for a proven absent optional menu VOB. |
| Menu VOBU map pointer `0xdc` in VMG/VTS; title map pointer `0xe4` in VTS | A nonzero pointer is a sector offset within the information file, leaving room for its four-byte table header. With a known present VOB, a readable zero pointer blocks; an unavailable pointer makes that map unknown. |
| VOBU map `last_byte` and four-byte sector entries | `last_byte + 1` is at least 8, divisible by 4, inside the control file; count is at most 100,000 and no greater than known VOB-domain sectors. Entries are relative to the concatenated VOB domain, start at zero, strictly increase, and fit it. For readable slots `i < j`, require `value[j] - value[i] >= j - i`; known entries also leave room for missing earlier/later slots within the known count/domain. Missing slots remain positional unknowns. |

Compare only these known IFO/BUP fields and known map entries at the same index.
Known map lengths/counts must agree. The profile does not compare whole IFO/BUP
contents or parse PTT, PGC, cell tables, time maps, VM commands, stream attributes,
button commands, angle/interleave semantics, or title durations.

A complete directory inventory must contain the manager IFO/BUP pair and a
matching IFO/BUP pair for each present title set. A source-incomplete inventory
cannot prove a required path missing. Read available IFO and BUP independently.

### Independently discoverable NAV packs

Inspect the first sector of each independently located nonempty VOB domain and
every pack addressed by a readable entry in either matching IFO/BUP VOBU map.
Deduplicate physical reads. This includes a title VOB's first sector when its IFO
is unavailable. File-split boundaries after `_1.VOB` are not additional NAV seeds.
V1 does not scan media sectors, follow search/angle links, or guess further NAV
locations when maps are unavailable.

| NAV-pack fields, byte offsets within its sector | Required checks |
| --- | --- |
| MPEG pack start 0; PCI packet start/length/substream 38/42/44; DSI packet start/length/substream 1024/1028/1030 | Start codes `0x000001ba`, `0x000001bf`, `0x000001bf`; PCI length `0x03d4`, substream 0; DSI length `0x03fa`, substream 1. |
| PCI `nv_pck_lbn` 45 and DSI `nv_pck_lbn` 1035 | Both equal the known sector offset within their VOB domain. |
| DSI `vobu_ea` 1039; reference-image end addresses 1043, 1047, 1051 | VOBU inclusive end fits the known VOB domain and image. Each nonzero reference-image end is no greater than `vobu_ea`. If the next map slot is known and consecutive by index, this VOBU ends exactly before it; the known final map slot ends at the known domain end. Unknown gaps create no adjacency claim. |
| DSI 16-bit VOB ID 1055, 8-bit reserved byte 1057, 8-bit cell ID 1058 | Nonzero IDs and reserved byte zero. No comparison with unparsed PGC/cell semantics. |

All other NAV payload, including timestamps, search/sync arrays, seamless-angle
addresses, interleaving, buttons, and commands, is outside v1. A malformed listed
field blocks even when unrelated IFO, directory, or peer-view bytes are missing.

## Reconciliation, bounds, and result

Keep observations by view and canonical path. Compare ISO volume declarations
for equality; every known UDF declared extent must fit each known ISO volume
declaration. Compare known UDF mirror fields by descriptor kind/partition number,
including ordered partition maps. The known physical byte mapping at the same
file offset for the same canonical path must agree across ISO, Joliet, and UDF.
IFO/BUP comparisons concern only the listed header/map values; their physical
locations differ. A complete inventory's proven
absence contradicts a readable peer's presence. A partial inventory cannot
demote a complete inventory or erase any known claim. No rule requires arbitrary
DVD fields to agree merely because their records share a name.

Use the following hard work limits. Reaching one blocks as unsupported; a source
gap never raises a limit. Counts apply to all visited views in one invocation
unless the row names a per-record bound.

| Work | Limit |
| --- | --- |
| ISO descriptors / each UDF descriptor sequence | 256 sectors each |
| UDF recognition / anchor candidates | 32 sectors / 3 distinct candidates |
| Visited directory data | 16 MiB per directory, 128 MiB aggregate |
| Directory records / decoded path bytes | 100,000 / 16 MiB aggregate |
| Visited UDF file entry / allocation records | 1 MiB per entry / 50,000 aggregate records |
| Known extents / normalized source intervals | 250,000 / 250,000 |
| IFO/BUP declared file bytes | 16 MiB per file, 128 MiB aggregate |
| VOBU map entries / distinct NAV sectors | 100,000 per table / 250,000 aggregate NAV sectors |

Read only the metadata needed for these checks. Preserve cancellation checks and
the existing regular-file, no-symlink, exact-size, and before/after identity guards.
This profile reads the saved image, not the Optical Drive, and adds no whole-image
snapshot, hash pass, media scan, or playback/decode pass to full-extent validation.

Return a decision of `publishable` or `blocked`, policy version
`dvd-full-extent-metadata-v1`, and field observations with physical dependencies,
including source-unavailable/dependent-unknown observations and a concrete
blocking reason for contradiction, unexplained local failure, unsupported layout,
or exhausted work bound. Keep this report separate from Archive Boundary Evidence,
Archive Integrity, and the source map. It must not manufacture successful title
assessment or a maximum-referenced-LBA completeness proof. Checkpoint binding of
policy versions remains the publication/checkpoint work in #406.

## Required behavioral cases

Use small synthetic fixtures at the profile interface and focused initial-copy /
publication integration tests. A named field in the tables is a required check;
unlisted DVD semantics require a later profile version rather than expanding v1.

1. Clean supported ISO, UDF, and bridge images; normal endpoint proved/unproved,
   readable excluded block, contradictory or malformed endpoint evidence, and
   current fencing/cancellation behavior.
2. Source-unavailable IFO with a separately readable valid first title NAV pack
   permits full-extent publication with unknown impact. The same source gap plus
   malformed framing, wrong LBN, or out-of-range `vobu_ea` blocks it.
3. A source-unavailable early ISO/UDF descriptor followed by a readable conflicting
   descriptor in that same sequence blocks. A healthy peer view cannot suppress
   a readable partial-view contradiction; a partial view cannot weaken a complete
   view's known claim or proven absence.
4. Source gaps in directory data, a VOBU map entry, and one UDF mirror retain exact
   dependencies and still inspect independent records. Missing IFO/BUP fields
   cannot turn into invented values, absent files, or success of a generic
   navigation command. Test both view/record inspection orders.
5. A required-field gap absent from the source map, a local read/identity failure,
   readable invalid checksum, unsupported allocation, and exhausted work bound
   block. Complete loss of bootstrap/geometry support blocks v1. Data in unlisted
   DVD payload fields does not acquire new semantic checks.
6. Both source classifications remain distinct. Mixed adjacent ranges are valid;
   same-class adjacent/overlapping/out-of-image ranges are rejected as
   noncanonical. A compact range longer than the legacy salvage sector cap is
   accepted as an interval, without sector expansion or legacy-policy changes.
7. Corrected extents require strict completeness and title-map proof. Metadata
   gaps cannot waive it; unsafe truncation blocks and the excluded suffix is
   never source damage. Preserve legacy behavior and closed new-format admission.

Run the affected focused suites and `pnpm check`. Review against this closed list
of fields, outcomes, bounds, and integration cases. Further format coverage or
navigation semantics belong in a subsequent profile decision.
