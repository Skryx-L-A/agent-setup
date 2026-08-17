# Local media generation

Optional. Nothing in the workbench needs it. It exists so an agent that needs an image, a
voice-over, a short clip or a transcript produces it **on your machine** instead of reaching for
a paid cloud API — which also means the input never leaves the machine.

The rule that governs it is in `claude/regeln/medien.md`: media is generated locally by default,
and a cloud service is used only when local quality is demonstrably not enough for the concrete
task — and then the agent says so.

## The four commands

They are in `shell/`, so `install.sh` has already put them on your `PATH`. Each has `--help`; run
it before assuming a flag exists.

| Command | What it does | Rough cost on Apple Silicon |
|---|---|---|
| `bild "a red apple on a wooden table"` | image generation, several backends and a fast/quality/text-in-image switch | ~10 s fast, ~1 min quality, ~3 min for the text-accurate model |
| `video "waves breaking at sunset"` | short video, also image-to-video (`--bild photo.png`) | minutes; the quality mode noticeably longer |
| `tts "some text"` | text to speech, several voices and an expressive mode | seconds |
| `stt recording.wav` | speech to text, with a timestamped fallback engine | seconds to a minute |

`medien-ui` is a small local interface over the same four commands, for when clicking is faster
than typing flags. It runs against the same models; nothing is duplicated.

**The wrappers ship, the models do not.** Each command is a few hundred lines that drive a model
weighing gigabytes, and the download has its own licence. Until you install one, the command tells
you what it is missing instead of failing quietly.

## Two hardware paths, one set of names

`shell/` holds the Apple Silicon versions, built on MLX. `shell/linux/` holds the versions for a
machine with an NVIDIA card, built on CUDA and whisper.cpp. Same four names, same flags, different
engine underneath — so a rule or a skill that says `bild` works on either machine without knowing
which one it is on. On Linux, put `shell/linux/` on your `PATH` ahead of `shell/`, or copy those
four over the others; `shell/linux/README.md` says which is which.

Honestly, about the hardware:

- **Apple Silicon**: roughly 16 GB unified memory gets you images; the large text-accurate image
  model wants ~34 GB; video wants everything you have and is still slow.
- **Linux with an NVIDIA GPU**: a 12 GB card handles images and speech comfortably; video is out
  of reach there.
- **Anything else**: skip this layer. The workbench does not care.

Only one large model at a time. Before starting any of them, run `check-resources` — and stop a
loaded model with `ollama stop <model>` before generating video, or the machine will swap itself
to a standstill. `gpu-slot` is the one-slot lock for that: `gpu-slot nimm <wer>` succeeds only if
nobody holds it, `gpu-slot gib <wer>` hands it back, and `gpu-slot wer` says who has it.

## What has to be installed separately

Large downloads with their own licences, so none of them is bundled:

| Component | For | How |
|---|---|---|
| mflux | images on Apple Silicon | `pip install mflux` |
| mlx-audio | speech on Apple Silicon | `pip install mlx-audio` |
| parakeet-mlx | fast transcription | `pip install parakeet-mlx` |
| whisper.cpp | transcription on Linux/CUDA, timestamped fallback | build from source |
| The model weights themselves | all of the above | downloaded on first run, several GB each |

Draw Things (macOS, free) is a graphical alternative for images and shares the same model files.
