#!/usr/bin/env python3
"""Throw normal MIDI remote-control traffic at a connected EP (USB).

Scope: everyday host→device MIDI that a DAW / controller might send.
Out of scope: canceling DFU mid-stream, FILE writes that fill the FS,
foreign KEYHASH flashes.

Exit 0 if every scenario completes and identity still answers afterward.
Writes a markdown checklist under docs/research/ by default.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor" / "ep-series-sysex"))

# Pad MIDI notes: groups A–D, 12 pads each (bottom-left chromatic).
PAD_NOTES = list(range(36, 84))  # 36..83 inclusive


@dataclass
class ScenarioResult:
    id: str
    title: str
    status: str  # PASS | FAIL | WARN | SKIP
    detail: str = ""
    elapsed_s: float = 0.0
    notes: list[str] = field(default_factory=list)


@dataclass
class RunReport:
    started: str
    port_hint: str
    midi_in: str
    midi_out: str
    identity_before: str
    identity_after: str
    scenarios: list[ScenarioResult]
    crashed_or_deaf: bool = False

    def to_markdown(self) -> str:
        lines = [
            "# MIDI normal-use stress checklist",
            "",
            f"**Started (UTC):** {self.started}",
            f"**Ports:** in `{self.midi_in}` / out `{self.midi_out}` (hint `{self.port_hint}`)",
            f"**Identity before:** `{self.identity_before}`",
            f"**Identity after:** `{self.identity_after}`",
            f"**Deaf/crash suspected:** {'YES' if self.crashed_or_deaf else 'no'}",
            "",
            "Scope: notes, CCs, bank/PC, identity spam, MIDI clock + transport. "
            "No DFU mid-cancel. No intentional FS fill.",
            "",
            "| ID | Result | Title | Detail |",
            "|---|---|---|---|",
        ]
        for s in self.scenarios:
            detail = s.detail.replace("|", "\\|").replace("\n", " ")
            lines.append(
                f"| `{s.id}` | **{s.status}** | {s.title} | {detail} ({s.elapsed_s:.1f}s) |"
            )
        lines.extend(["", "## Notes", ""])
        for s in self.scenarios:
            if s.notes:
                lines.append(f"### {s.id} — {s.title}")
                for n in s.notes:
                    lines.append(f"- {n}")
                lines.append("")
        lines.extend(
            [
                "## Interpretation",
                "",
                "- **PASS** = scenario finished; device still answered identity afterward "
                "(or mid-run health check).",
                "- **WARN** = finished but something odd (timeouts, unexpected silence, "
                "debug frames).",
                "- **FAIL** = exception, port gone, or identity dead — treat as hang/crash "
                "candidate for that path.",
                "- Intermittent freezes on factory Riddims are reported by owners; a PASS "
                "here does not prove density is irrelevant, only that this run survived.",
                "",
            ]
        )
        return "\n".join(lines)


def _pick_ports(hint: str):
    import mido

    ins = list(mido.get_input_names())
    outs = list(mido.get_output_names())
    hi = hint.lower()

    def pick(names, kind):
        matches = [n for n in names if hi in n.lower()]
        if not matches:
            raise RuntimeError(f"no MIDI {kind} matching {hint!r}; have {names}")
        # Prefer exact-ish EP-40 / EP-133 over virtual buses
        preferred = [n for n in matches if n.lower().strip() in ("ep-40", "ep-133", "ep-1320")]
        return (preferred or matches)[0]

    return pick(ins, "input"), pick(outs, "output")


def identity_probe(mo, mi, timeout=2.0) -> str:
    """Send universal identity request; return hex of reply or 'TIMEOUT'."""
    import mido

    while mi.poll() is not None:
        pass
    mo.send(mido.Message("sysex", data=[0x7E, 0x7F, 0x06, 0x01]))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        msg = mi.poll()
        if msg is None:
            time.sleep(0.005)
            continue
        if msg.type == "sysex" and len(msg.data) >= 5 and list(msg.data[:5]) == [
            0x7E,
            msg.data[1],
            0x06,
            0x02,
            0x00,
        ]:
            return " ".join(f"{b:02x}" for b in msg.data)
        # TE debug frames sometimes appear; ignore for identity match
    return "TIMEOUT"


def drain(mi, seconds=0.05):
    end = time.monotonic() + seconds
    n = 0
    debug = 0
    while time.monotonic() < end:
        msg = mi.poll()
        if msg is None:
            time.sleep(0.001)
            continue
        n += 1
        if msg.type == "sysex" and len(msg.data) > 8:
            # Rough: TE vendor debug often contains printable ASCII
            raw = bytes(msg.data)
            if b"err " in raw or b"main[" in raw:
                debug += 1
    return n, debug


def run_scenario(fn, sid, title) -> ScenarioResult:
    t0 = time.monotonic()
    try:
        status, detail, notes = fn()
        return ScenarioResult(
            sid, title, status, detail, time.monotonic() - t0, notes or []
        )
    except Exception as exc:  # noqa: BLE001 — surface any MIDI/port failure
        return ScenarioResult(
            sid, title, "FAIL", f"{type(exc).__name__}: {exc}", time.monotonic() - t0
        )


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--hint", default="EP-40", help="MIDI port name substring")
    ap.add_argument(
        "--out",
        type=Path,
        default=ROOT / "docs/research/midi-stress-checklist.md",
    )
    ap.add_argument(
        "--json-out",
        type=Path,
        default=ROOT / "docs/research/midi-stress-last.json",
    )
    ap.add_argument("--channel", type=int, default=0, help="0-based MIDI channel")
    ap.add_argument("--skip-clock", action="store_true")
    ap.add_argument("--skip-supertone-blast", action="store_true")
    args = ap.parse_args()

    import mido

    midi_in, midi_out = _pick_ports(args.hint)
    ch = args.channel
    scenarios: list[ScenarioResult] = []

    with mido.open_input(midi_in) as mi, mido.open_output(midi_out) as mo:
        id_before = identity_probe(mo, mi)
        if id_before == "TIMEOUT":
            print("FAIL: device did not answer identity before stress", file=sys.stderr)
            sys.exit(2)

        def health(label: str) -> tuple[str, list[str]]:
            reply = identity_probe(mo, mi, timeout=1.5)
            notes = []
            if reply == "TIMEOUT":
                return "FAIL", [f"{label}: identity TIMEOUT — device may be hung"]
            if reply != id_before:
                notes.append(f"{label}: identity changed ({reply})")
                return "WARN", notes
            return "PASS", notes

        # --- scenarios ---

        def s_identity_burst():
            misses = 0
            for _ in range(40):
                if identity_probe(mo, mi, timeout=0.8) == "TIMEOUT":
                    misses += 1
            st, notes = health("after identity burst")
            detail = f"40 identity requests, {misses} timeouts"
            if misses:
                st = "WARN" if st == "PASS" else st
            return st, detail, notes

        def s_all_pads_once():
            for note in PAD_NOTES:
                mo.send(mido.Message("note_on", note=note, velocity=100, channel=ch))
                time.sleep(0.015)
                mo.send(mido.Message("note_off", note=note, velocity=0, channel=ch))
                time.sleep(0.01)
            drain(mi, 0.2)
            st, notes = health("after all pads")
            return st, f"{len(PAD_NOTES)} pads note on/off", notes

        def s_pad_hammer():
            # Rapid re-triggers on a few pads (poly / choke stress)
            notes_hit = [36, 38, 42, 48, 60, 72]
            for _ in range(80):
                for note in notes_hit:
                    mo.send(
                        mido.Message("note_on", note=note, velocity=110, channel=ch)
                    )
                time.sleep(0.008)
                for note in notes_hit:
                    mo.send(
                        mido.Message("note_off", note=note, velocity=0, channel=ch)
                    )
                time.sleep(0.008)
            drain(mi, 0.3)
            st, notes = health("after pad hammer")
            return st, "80 cycles × 6 pads rapid on/off", notes

        def s_velocity_sweep():
            for vel in list(range(1, 128, 3)) + [127]:
                mo.send(mido.Message("note_on", note=60, velocity=vel, channel=ch))
                time.sleep(0.02)
                mo.send(mido.Message("note_off", note=60, velocity=0, channel=ch))
                time.sleep(0.01)
            st, notes = health("after velocity sweep")
            return st, "note 60 velocity 1..127", notes

        def s_cc_knobs():
            # CC1 mod, CC12/13 FX X/Y, CC64 sustain (documented EP surface)
            for cc in (1, 12, 13):
                for val in range(0, 128, 4):
                    mo.send(
                        mido.Message(
                            "control_change", control=cc, value=val, channel=ch
                        )
                    )
                    time.sleep(0.004)
                mo.send(
                    mido.Message("control_change", control=cc, value=0, channel=ch)
                )
            mo.send(mido.Message("control_change", control=64, value=127, channel=ch))
            mo.send(mido.Message("note_on", note=64, velocity=100, channel=ch))
            time.sleep(0.15)
            mo.send(mido.Message("note_off", note=64, velocity=0, channel=ch))
            mo.send(mido.Message("control_change", control=64, value=0, channel=ch))
            drain(mi, 0.2)
            st, notes = health("after CC knobs")
            return st, "CC1/12/13 sweeps + CC64 sustain", notes

        def s_bank_program():
            # Bank select + PC — may be no-op on some OS builds; still shouldn't crash
            for sound in (1, 50, 100, 200, 400, 500, 999):
                msb = (sound - 1) // 128
                lsb = (sound - 1) % 128
                mo.send(
                    mido.Message("control_change", control=0, value=msb, channel=ch)
                )
                mo.send(
                    mido.Message("control_change", control=32, value=lsb, channel=ch)
                )
                mo.send(mido.Message("program_change", program=lsb, channel=ch))
                time.sleep(0.05)
                mo.send(mido.Message("note_on", note=48, velocity=90, channel=ch))
                time.sleep(0.04)
                mo.send(mido.Message("note_off", note=48, velocity=0, channel=ch))
            st, notes = health("after bank/PC")
            notes.append(
                "Bank/PC→sound selection is unconfirmed on some 2.5.x builds; "
                "PASS means survived, not that PC remapped sounds."
            )
            return st, "bank+PC for several sound indices + trigger", notes

        def s_clock_transport():
            if args.skip_clock:
                return "SKIP", "skipped by flag", []
            # 120 BPM: 24 PPQN → 48 clocks/sec → 20.833 ms
            bpm = 120.0
            interval = 60.0 / (bpm * 24.0)
            bars = 8
            clocks = int(bars * 4 * 24)  # 4/4
            while mi.poll() is not None:
                pass
            mo.send(mido.Message("start"))
            t_next = time.monotonic()
            for i in range(clocks):
                now = time.monotonic()
                delay = t_next - now
                if delay > 0:
                    time.sleep(delay)
                mo.send(mido.Message("clock"))
                t_next += interval
                # sprinkle notes mid-sequence
                if i % 24 == 0:
                    note = 36 + ((i // 24) % 12)
                    mo.send(
                        mido.Message("note_on", note=note, velocity=100, channel=ch)
                    )
                if i % 24 == 12:
                    note = 36 + ((i // 24) % 12)
                    mo.send(
                        mido.Message("note_off", note=note, velocity=0, channel=ch)
                    )
            mo.send(mido.Message("continue"))
            for _ in range(48):
                time.sleep(interval)
                mo.send(mido.Message("clock"))
            mo.send(mido.Message("stop"))
            # all-notes-off / panic-ish
            mo.send(mido.Message("control_change", control=123, value=0, channel=ch))
            drain(mi, 0.4)
            st, notes = health("after clock transport")
            return st, f"clock {bpm} BPM × {bars} bars + continue + stop", notes

        def s_clock_fast():
            if args.skip_clock:
                return "SKIP", "skipped by flag", []
            bpm = 180.0
            interval = 60.0 / (bpm * 24.0)
            clocks = int(4 * 4 * 24)
            mo.send(mido.Message("start"))
            t_next = time.monotonic()
            for _ in range(clocks):
                now = time.monotonic()
                delay = t_next - now
                if delay > 0:
                    time.sleep(delay)
                mo.send(mido.Message("clock"))
                t_next += interval
            mo.send(mido.Message("stop"))
            drain(mi, 0.3)
            st, notes = health("after fast clock")
            return st, "clock 180 BPM × 4 bars", notes

        def s_poly_blast():
            # Hold many notes across groups (stack pressure)
            held = list(range(36, 60))
            for note in held:
                mo.send(mido.Message("note_on", note=note, velocity=90, channel=ch))
                time.sleep(0.01)
            time.sleep(0.5)
            for note in held:
                mo.send(mido.Message("note_off", note=note, velocity=0, channel=ch))
                time.sleep(0.005)
            mo.send(mido.Message("control_change", control=123, value=0, channel=ch))
            drain(mi, 0.3)
            st, notes = health("after poly blast")
            return st, f"held {len(held)} notes then release", notes

        def s_supertone_style():
            """Riddim Supertone pads are still triggered as ordinary notes.
            Without knowing which pad has which engine on THIS unit, blast
            groups A–D with sustained notes + mod wheel — typical 'play synth'."""
            if args.skip_supertone_blast:
                return "SKIP", "skipped by flag", []
            for round_i in range(6):
                for note in (48, 52, 55, 60, 64, 67, 72):
                    mo.send(
                        mido.Message(
                            "note_on",
                            note=note,
                            velocity=100 + (round_i % 20),
                            channel=ch,
                        )
                    )
                    for mod in (0, 40, 80, 120, 64):
                        mo.send(
                            mido.Message(
                                "control_change", control=1, value=mod, channel=ch
                            )
                        )
                        time.sleep(0.02)
                    time.sleep(0.08)
                    mo.send(
                        mido.Message("note_off", note=note, velocity=0, channel=ch)
                    )
                time.sleep(0.05)
            mo.send(mido.Message("control_change", control=1, value=0, channel=ch))
            mo.send(mido.Message("control_change", control=123, value=0, channel=ch))
            drain(mi, 0.4)
            st, notes = health("after supertone-style blast")
            notes.append(
                "Does not assert audio=Supertone; stresses sustained notes+mod "
                "the way a synth pad session would."
            )
            return st, "6 rounds sustained notes + CC1", notes

        def s_idle_health():
            time.sleep(1.0)
            _, dbg = drain(mi, 0.5)
            st, notes = health("idle")
            if dbg:
                st = "WARN" if st == "PASS" else st
                notes.append(f"saw {dbg} likely debug sysex frame(s) while idle")
            return st, "1.5s idle + health", notes

        plan = [
            ("S01", "Identity request burst", s_identity_burst),
            ("S02", "All pads once (A–D)", s_all_pads_once),
            ("S03", "Rapid pad hammer", s_pad_hammer),
            ("S04", "Velocity sweep", s_velocity_sweep),
            ("S05", "CC knobs + sustain", s_cc_knobs),
            ("S06", "Bank select + program change", s_bank_program),
            ("S07", "MIDI clock + start/continue/stop", s_clock_transport),
            ("S08", "Fast MIDI clock (180 BPM)", s_clock_fast),
            ("S09", "Polyphonic hold blast", s_poly_blast),
            ("S10", "Supertone-style sustained + mod", s_supertone_style),
            ("S11", "Idle health check", s_idle_health),
        ]

        for sid, title, fn in plan:
            print(f"… {sid} {title}", flush=True)
            result = run_scenario(fn, sid, title)
            scenarios.append(result)
            print(f"  → {result.status} {result.detail}", flush=True)
            if result.status == "FAIL":
                break

        id_after = identity_probe(mo, mi, timeout=2.0)
        crashed = id_after == "TIMEOUT" or any(s.status == "FAIL" for s in scenarios)

    report = RunReport(
        started=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        port_hint=args.hint,
        midi_in=midi_in,
        midi_out=midi_out,
        identity_before=id_before,
        identity_after=id_after,
        scenarios=scenarios,
        crashed_or_deaf=crashed,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(report.to_markdown(), encoding="utf-8")
    args.json_out.write_text(
        json.dumps(
            {
                **{k: getattr(report, k) for k in report.__dataclass_fields__ if k != "scenarios"},
                "scenarios": [asdict(s) for s in scenarios],
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nWrote {args.out}")
    print(f"Wrote {args.json_out}")
    sys.exit(1 if crashed else 0)


if __name__ == "__main__":
    main()
