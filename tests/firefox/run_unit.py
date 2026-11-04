"""Run the extension's JavaScript unit tests (firefox-extension/tests/unit.js) in headless Firefox."""
import sys
import time

from harness import launch, open_ext

d = launch()
try:
    open_ext(d, "tests/unit.html")
    for _ in range(100):
        text = d.execute_script("return document.getElementById('results').textContent")
        if text != "running":
            break
        time.sleep(0.2)
    errors = d.execute_script("return window.__errors || []")
    print(text)
    failed = text.count("FAIL") + (text == "running")
    print(f"\n{text.count('PASS')} passed, {failed} failed")
    sys.exit(1 if failed else 0)
finally:
    d.quit()
