# Static analysis: EP-133 2.5.1 `.tfw` trailer

**Target:** `fw/extracted/ep133_trailer.bin`  
**SHA-256:** `31cee90c7686fb06df8903a2fb66d4a18315186d66557ad2f028bb56e4eaf081`  
**Tools:** radare2 6.1.8 + r2ghidra; Ghidra 12.1 headless (import OK)  
**Skill:** static-analysis (Stage 1 + Stage 2). No device execution.

## Load address

Inferred VA base **`0x100df490`** (PSoC6 XIP):

- Only base where **both** `../../src/../ext/littlefs-2.10.1/lfs.c` and `littlefs\0` appear as 32-bit literals.
- 136/146 Thumb code pointers in `0x100e…` land inside the mapped image.
- Path string VA: `0x100ec124` · name string VA: `0x100efa08`.

```bash
r2 -a arm -b 16 -m 0x100df490 fw/extracted/ep133_trailer.bin
```

## Stage 1 facts

| Fact | Evidence | Confidence |
|---|---|---|
| Trailer is mostly Thumb, not a second encrypted blob | Entropy pockets; successful `aa`/`aac`; ~210 functions | High |
| Embeds **LittleFS 2.10.1** | Exact path string; assert immediates = `lfs.c` line numbers | **Proven** |
| Head `+0x0…~0x1500` is not valid code at this base | Garbage disassembly / bkpts — likely unrelated packed data or wrong slice | Medium |
| No aligned `0x04000000` / `0x08000000` (64/128 MiB) constants | Exhaustive 4-byte-aligned scan | High |
| No `movs rd, #0x9F` (JEDEC READ ID) / `#0x5A` (SFDP) | Thumb immediate search | High |
| Out-of-trailer calls into encrypted app | `0x1005b754` (assert), `0x10064810`/`820` (malloc/free), `0x10024cf8` (memset) | High |

Earlier “64/128 MiB constant” hits were **unaligned false positives** (`00 00 00 04` matching mid-instruction). Retracted.

## Stage 2: `lfs_init` identified

**`fcn.100ec35c` @ `0x100ec35c`** decompiles to LittleFS **`lfs_init`**.

Assert immediates match upstream [littlefs v2.10.1 `lfs.c`](https://github.com/littlefs-project/littlefs/blob/v2.10.1/lfs.c) **line numbers**:

| Imm | Decimal | Upstream line |
|---|---|---|
| `0x1081` | 4225 | `LFS_ASSERT(lfs->cfg->read_size != 0);` |
| `0x1083` | 4227 | `LFS_ASSERT(lfs->cfg->cache_size != 0);` |
| … | … | further `lfs_init` asserts through ~4341 |

`lfs_config` fields exercised (32-bit, matches public `lfs.h`):

| Offset | Field | Role |
|---|---|---|
| `+0x04…+0x10` | `read` / `prog` / `erase` / `sync` | NOR driver hooks |
| `+0x1c` | `block_size` | erase block (validated ≥ 128) |
| `+0x20` | `block_count` | **density** (blocks on device) |
| `+0x24` | `block_cycles` | wear-leveling |

Callers of `lfs_init` in-trailer: `fcn.100efa14` (format/mount path; references `"littlefs"` superblock name) and a nearby site @ `0x100efb40`.

`fcn.100ef72c` matches **`lfs_file_open`** (error codes `0xfffffffe` = `LFS_ERR_NOENT`, `0xffffffe4` = `LFS_ERR_NOSPC`, etc.).

### EP-133 vs EP-40 tag beside `"littlefs"`

| Model | Word before name |
|---|---|
| EP-133 | `0x20000100` |
| EP-40 | `0x20000200` |

These are LittleFS **name-type tags** (REG vs DIR family), not flash sizes. Model build difference; not NOR density.

## What this means for NOR safety

**The trailer is the filesystem library. It does not probe NOR.**

Density enters only when the **encrypted application** fills `lfs_config.block_count` (and the `read`/`prog`/`erase` function pointers) and calls `lfs_mount` / `lfs_format`. Those pointers and the JEDEC/SFDP logic live at VAs like `0x10024xxxx` / `0x1005xxxx` — inside the encrypted blob.

TE’s “different NOR types and densities in the field” is therefore almost certainly handled in **app code we cannot see yet**, possibly via:

1. JEDEC ID → lookup → `block_count`, or  
2. Mount with `block_count == 0` (read from superblock) / `lfs_fs_grow` when a larger chip is detected.

Upstream 2.10.1 even documents: *“Defaults to block_count stored on disk when zero”* and exports `lfs_fs_grow()`.

**Implication for the 64 MB legacy unit:** a firmware image that assumes 128 MB `block_count` (or grows into it) can walk off the end of the physical chip → corruption / brick. Patching the *trailer* LittleFS code cannot fix that; you must change or gate the **app’s config builder**.

## Artifacts

| Path | Contents |
|---|---|
| `fw/extracted/ep133_trailer.bin` | Analysis subject |
| `docs/research/r2-stage1/decompile.txt` | `lfs_file_open` decomp |
| `docs/research/r2-stage1/lfs_api.txt` | `lfs_init` decomp + xrefs |
| `docs/research/r2-stage1/lfs_mount.txt` | mount/format path |
| `docs/research/ghidra_proj/` | Ghidra project (re-import if deleted) |

## Journal

```
[BINARY-RE:static] ep133_trailer.bin (sha256: 31cee90c7686fb06…)

Functions analyzed: ~210 (r2 aa/aac)
Decompilation performed: yes (r2ghidra) on lfs_init, lfs_file_open, mountish

Key functions:
  FACT: VA base 0x100df490 — both littlefs string literals present (source: literal scan)
  FACT: fcn.100ec35c is lfs_init — assert imms match lfs.c 2.10.1 line numbers (source: pdg + upstream)
  FACT: lfs_config.block_count at cfg+0x20 validated/consumed here (source: pdg vs lfs.h)
  FACT: NOR hooks are cfg->read/prog/erase function pointers supplied by caller (source: pdg)
  FACT: Caller assert/malloc/memset are OUTSIDE trailer at 0x1005b754 / 0x10064810 / 0x10024cf8 (source: pdg)
  FACT: No JEDEC 0x9F / SFDP 0x5A immediates; no aligned 64/128MiB constants in trailer (source: scans)
  FACT: EP-133 vs EP-40 0x20000100 vs 0x20000200 beside "littlefs" is tag, not density (source: diff)

HYPOTHESIS UPDATE: NOR density selection lives in encrypted app that builds lfs_config (confidence: 0.9)
  Supporting: lfs_init only validates; no probe code in trailer; external calls into enc VA range
  Contradicting: none found in trailer

New questions:
  QUESTION: Where in encrypted app is JEDEC read / block_count assigned?
  QUESTION: Does TE use block_count=0 + superblock, or lfs_fs_grow on larger chips?
  QUESTION: Can SWD dump decrypted XIP at 0x10000000 after boot without bricking?

Answered:
  RESOLVED: "Is trailer the flash driver?" → No, it is LittleFS 2.10.1
  RESOLVED: "Can we patch density in trailer?" → Not useful; config comes from app
```

## Next steps (still no flash required)

1. **SWD dump** of mapped XIP after boot → plaintext app → xref `lfs_mount` / `lfs_init` callers → JEDEC path.  
2. Or **offline cryptanalysis** of the `0x400` blob (key likely device-side only).  
3. Soft live probe: backup `.pak`; do **not** fill sample pool to infer size.
