# MIDI normal-use stress checklist

**Started (UTC):** 2026-07-21 19:09:19
**Ports:** in `EP-40` / out `EP-40` (hint `EP-40`)
**Identity before:** `7e 3c 06 02 00 20 76 20 00 06 00 00 00 00 00`
**Identity after:** `7e 3c 06 02 00 20 76 20 00 06 00 00 00 00 00`
**Deaf/crash suspected:** no

Scope: notes, CCs, bank/PC, identity spam, MIDI clock + transport. No DFU mid-cancel. No intentional FS fill.

| ID | Result | Title | Detail |
|---|---|---|---|
| `S01` | **PASS** | Identity request burst | 40 identity requests, 0 timeouts (0.3s) |
| `S02` | **PASS** | All pads once (A–D) | 48 pads note on/off (1.6s) |
| `S03` | **PASS** | Rapid pad hammer | 80 cycles × 6 pads rapid on/off (1.9s) |
| `S04` | **PASS** | Velocity sweep | note 60 velocity 1..127 (1.6s) |
| `S05` | **PASS** | CC knobs + sustain | CC1/12/13 sweeps + CC64 sustain (0.9s) |
| `S06` | **PASS** | Bank select + program change | bank+PC for several sound indices + trigger (0.7s) |
| `S07` | **PASS** | MIDI clock + start/continue/stop | clock 120.0 BPM × 8 bars + continue + stop (17.6s) |
| `S08` | **PASS** | Fast MIDI clock (180 BPM) | clock 180 BPM × 4 bars (5.6s) |
| `S09` | **PASS** | Polyphonic hold blast | held 24 notes then release (1.3s) |
| `S10` | **PASS** | Supertone-style sustained + mod | 6 rounds sustained notes + CC1 (9.3s) |
| `S11` | **PASS** | Idle health check | 1.5s idle + health (1.5s) |

## Notes

### S06 — Bank select + program change
- Bank/PC→sound selection is unconfirmed on some 2.5.x builds; PASS means survived, not that PC remapped sounds.

### S10 — Supertone-style sustained + mod
- Does not assert audio=Supertone; stresses sustained notes+mod the way a synth pad session would.

## Interpretation

- **PASS** = scenario finished; device still answered identity afterward (or mid-run health check).
- **WARN** = finished but something odd (timeouts, unexpected silence, debug frames).
- **FAIL** = exception, port gone, or identity dead — treat as hang/crash candidate for that path.
- Intermittent freezes on factory Riddims are reported by owners; a PASS here does not prove density is irrelevant, only that this run survived.
