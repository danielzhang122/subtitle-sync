"""Audio sync on a real film in headless Firefox: first lock-on (sync_eval.html) is never wrong and quick
enough; tracking (track_eval.html) follows slips and cuts without wandering or making things worse.

    python tests/firefox/run_sync_eval.py
"""
import sys
import time
from pathlib import Path

from harness import launch

def run_page(name):
    d.get((Path(__file__).resolve().parent / name).as_uri())
    for _ in range(600):
        out = d.execute_script("return window.RESULT || null")
        if out:
            return out
        time.sleep(1)
    return None


d = launch()
try:
    res = run_page("sync_eval.html")
    track = run_page("track_eval.html")
finally:
    d.quit()

if not res or not track:
    print("FAIL: no result within 10 minutes")
    sys.exit(1)
checks = [
    (not res["problems"], f"never more than 0.3 s wrong ({len(res['problems'])} problems: {res['problems'][:5]})"),
    (res["locked"] >= 0.6 * res["runs"], f"locks on in most viewings ({res['locked']} of {res['runs']}; the rest start where too little is said)"),
    (res["medianLock"] is not None and res["medianLock"] <= 200, f"typical time to lock on: {res['medianLock']} s (at most 200)"),
    (res["medianErr"] is not None and res["medianErr"] <= 100, f"typical final error {res['medianErr']} ms (at most 100), worst {res['worstErr']} ms"),
]
on = {x["name"]: x for x in track if x["track"]}
off = {x["name"]: x for x in track if not x["track"]}
steady = on["steady"]
checks.append((steady["medianErr"] <= 100 and steady["worstErr"] <= 300,
               f"tracking on steady timing doesn't wander: typical {steady['medianErr']} ms (at most 100), worst {steady['worstErr']} ms (at most 300)"))
for name in ("steady -30 s", "steady -75 s"):
    checks.append((on[name]["locked"] > 0 and on[name]["medianErr"] <= 100 and on[name]["jumps"] <= 1,
                   f"{name}: holds at a large offset (typical {on[name]['medianErr']} ms, at most 100; {on[name]['jumps']} jumps)"))
for name in ("slip 1.001", "slip 0.997", "slip 1.003"):
    checks.append((on[name]["medianErr"] <= 0.65 * off[name]["medianErr"],
                   f"{name}: tracking cuts the typical error by over a third ({off[name]['medianErr']} to {on[name]['medianErr']} ms)"))
checks.append((on["slip 1.001"]["medianErr"] <= 150, f"slip 1.001: typical error {on['slip 1.001']['medianErr']} ms (at most 150)"))
for name in ("cut +4 s", "cut -1.5 s"):
    checks.append((on[name]["jumps"] >= on[name]["locked"] and on[name]["medianErr"] <= 100,
                   f"{name}: seen in {on[name]['jumps']} of {on[name]['locked']} viewings, typical error after it {on[name]['medianErr']} ms (at most 100)"))
wrong = [f"{x['name']}: {b}" for x in on.values() for b in x["bad"]]
checks.append((not wrong, f"no tracking correction made a line worse and over 0.3 s off ({len(wrong)}: {wrong[:5]})"))
for ok, text in checks:
    print(("PASS " if ok else "FAIL ") + text)
failed = sum(not ok for ok, _ in checks)
print(f"\n{len(checks) - failed} passed, {failed} failed")
sys.exit(1 if failed else 0)
