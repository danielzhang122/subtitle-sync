"""Build the end-to-end test media (Windows only: uses the built-in text-to-speech voices).

    python tests/firefox/make_media.py <output dir>

Writes movie.mp4 (~13 min of spoken sentences at known times, with music-like gaps),
true.srt (correct timing), good.srt (every line 2.3 s late) and long.srt (stretched 3x,
far too long for the video). Needs ffmpeg (winget install Gyan.FFmpeg).
"""
import random
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
import pysubs2

OUT = Path(sys.argv[1]).resolve()
CLIPS = OUT / "clips"
CLIPS.mkdir(parents=True, exist_ok=True)
SR = 16000

rng = random.Random(7)
subjects = ["The captain", "My sister", "Nobody in town", "That old dog", "The new teacher", "Your brother", "The mayor", "Everyone here", "A stranger", "The doctor"]
verbs = ["never trusted", "finally found", "quietly left", "always remembered", "slowly opened", "loudly argued about", "carefully hid", "suddenly noticed", "forgot about", "kept talking about"]
objects = ["the broken clock", "a letter from Paris", "the red door", "the money in the drawer", "our last conversation", "the storm last night", "the key under the mat", "that ridiculous hat", "the train schedule", "the empty house"]
tails = [".", " before sunrise.", " and walked away.", ", which surprised me.", " again and again.", " without saying a word."]
lines = [f"{rng.choice(subjects)} {rng.choice(verbs)} {rng.choice(objects)}{rng.choice(tails)}" for _ in range(120)]

# 1. speak every sentence to its own WAV with Windows' System.Speech
script = CLIPS / "speak.ps1"
script.write_text("""
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)
$i = 0
foreach ($line in Get-Content -Encoding UTF8 "$PSScriptRoot\\lines.txt") {
  $s.SelectVoice($voices[$i % $voices.Count]); $s.Rate = ($i % 5) - 2
  $s.SetOutputToWaveFile("$PSScriptRoot\\$i.wav", $fmt); $s.Speak($line); $i++
}
$s.SetOutputToNull(); $s.Dispose()
""", encoding="utf-8")
(CLIPS / "lines.txt").write_text("\n".join(lines), encoding="utf-8")
subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)], check=True)

# 2. place them on a timeline with gaps and occasional music-like tones; record true times
nrng = np.random.default_rng(3)
audio, truth = [np.zeros(int(3.0 * SR))], []
for i, text in enumerate(lines):
    with wave.open(str(CLIPS / f"{i}.wav")) as w:
        clip = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(float)
    loud = np.nonzero(np.abs(clip) > 500)[0]
    clip = clip[loud[0]:loud[-1] + 1]
    start = sum(len(a) for a in audio) / SR
    audio.append(clip)
    truth.append((start, start + len(clip) / SR, text))
    gap = nrng.uniform(0.4, 5.0)
    if i % 30 == 29:
        tt = np.arange(int(20 * SR)) / SR
        audio.append(np.zeros(int(gap * SR / 2)))
        audio.append(1500 * np.sin(2 * np.pi * 220 * tt) * (np.sin(2 * np.pi * 0.5 * tt) > 0) + 800 * np.sin(2 * np.pi * 330 * tt))
        gap /= 2
    audio.append(np.zeros(int(gap * SR)))
mix = np.concatenate(audio) + nrng.normal(0, 60, sum(len(a) for a in audio))
with wave.open(str(OUT / "speech.wav"), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(np.clip(mix, -32768, 32767).astype(np.int16).tobytes())

# 3. video: a plain background plus the speech track
ffmpeg = shutil.which("ffmpeg") or str(Path.home() / "AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe")
dur = len(mix) / SR
subprocess.run([ffmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c=0x202020:s=640x360:d={dur}:r=25",
                "-i", str(OUT / "speech.wav"), "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage",
                "-c:a", "aac", "-b:a", "96k", "-shortest", str(OUT / "movie.mp4")], check=True)


def write(name, fn):
    subs = pysubs2.SSAFile()
    for s, e, text in truth:
        a, b = fn(s * 1000, (e + 0.3) * 1000)  # lines linger ~0.3 s after the speech, like real subtitles
        subs.append(pysubs2.SSAEvent(start=int(a), end=int(b), text=text))
    subs.save(str(OUT / name))


write("true.srt", lambda a, b: (a, b))
write("good.srt", lambda a, b: (a + 2300, b + 2300))
write("long.srt", lambda a, b: (a * 3, b * 3))
shutil.rmtree(CLIPS)
(OUT / "speech.wav").unlink()
print(f"{len(truth)} lines, {dur:.0f} s of video in {OUT}")
