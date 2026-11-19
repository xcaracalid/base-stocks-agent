# Demo video v1 — production notes

- File: `video/demo-v1.mp4` (kept local, gitignored — 25.6 MB binary).
- Spec: 1920×1080 H.264 + AAC audio, duration 126.8s (2:07).
- Produced 2026-11-19 evening from the live dashboard (`npm run web`)
  and the stored decision records. All footage is the real product —
  no mockups, no invented numbers.
- Narration: English TTS via ElevenLabs (`work/narration.wav`);
  captions burned in from `script.md` (`work/captions.srt`).
- Verification (parent, by eye, per the visual-verification rule):
  ffprobe confirms both streams; frames at ~35s and ~95s inspected —
  real watchlist and decision-log pages, captions readable, no black
  frames, no placeholder text. Agent-extracted frames at 6/58/124s
  also present in `work/`.
- Production incident: the producing session stalled ~2.5h on an
  interactive ffmpeg overwrite prompt during an attempted clip-2
  re-render, after `demo-v1.mp4` was already fully rendered (21:24).
  The session was closed by the parent; the re-render was abandoned
  and v1 stands as the verified cut. Script + these notes were
  completed by the parent from the produced captions track.

## Known v2 polish items (non-blocking; fix buffer until Dec 4)
- Around 0:35 the caption describes the 12-token NAV table while the
  pan is showing the "no NAV published" section — a timing offset
  between the pan and the narration.
- Caption type is large; readable everywhere, but a smaller,
  lower-third style would look more polished.
