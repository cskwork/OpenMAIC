# OpenMAIC with Codex sign-in

For a fresh checkout, install dependencies with `pnpm install`. Copy
`openmaic.codex.env.example` to `.env.local` and `openmaic.codex.example.yml` to
`openmaic.yml`. Generate three separate random tokens as directed in the environment
example, and set the paths to your existing Qwen model and original voice profile.
Install the isolated Python runtime using the commands below. This checkout is
already configured; its local secrets and voice assets are excluded from Git.

Run `pnpm local:start` in this folder, then open http://localhost:3000.
Keep the terminal running. Ctrl+C stops the application, text adapter and speech service; the database
and saved lessons remain. Docker Desktop and a ChatGPT-authenticated Codex CLI
are required. If the sign-in expires, run `codex login` and restart.

The local adapter uses the documented Codex app-server over stdio. Codex manages
OAuth credentials and token refresh; the adapter never reads or copies them.
The random token in `.env.local` only authenticates local app-to-adapter requests.
No OpenAI API key or other paid provider key is needed.

| Use | Model | Reasoning |
| --- | --- | --- |
| Lesson writing, slides, quizzes, activities, lecture actions | GPT-6.1 Sol | Medium |
| Curriculum outline and Pro course agent | GPT-6 Astra | Low |
| Classroom replies, agent profiles, conversation titles | GPT-6 Luna | High |

These models were listed by the signed-in Codex account during setup.
The model assignments live in `openmaic.yml`; `openmaic.codex.example.yml` is the
reusable copy. The adapter confirms model availability and ChatGPT sign-in at
startup. It fails explicitly on unavailable models or exhausted usage rather
than switching to another account or paid API. Calls consume the signed-in
account's Codex allowance and remain subject to its limits.

Image/video generation, speech transcription, external web
search, and cloud document parsing are disabled. Text/Markdown and local PDF
parsing remain available. Courses can contain generated slide layouts, diagrams,
quizzes, interactive HTML and classroom conversations.

Voice uses the local Qwen3-TTS-12Hz-1.7B-Base model on the Mac's GPU, with the
original calm Korean female announcer profile. It does not use Codex credits,
OpenAI speech, or any paid speech API. The **Local Qwen3-TTS** provider uses an
OpenAI-compatible request format at `127.0.0.1:57441`. Its voice picker exposes
only the original Korean announcer. The legacy `alloy` id remains an alias for
that one local voice; other OpenAI voice names are refused.

`pnpm local:start` also starts this service. Its isolated runtime is `.venv-tts`.
To rebuild it, run `uv venv --python 3.12 .venv-tts`, then
`uv pip install --python .venv-tts/bin/python -r scripts/requirements-tts.txt`.
The existing model path and original voice profile are set by
`QWEN_TTS_MODEL_PATH` and `QWEN_TTS_VOICE_PROFILE` in `.env.local`.
The clean reference WAV is checked against its approved hash before loading.
The profile is JSON with `id`, `reference_audio` (filename), `reference_sha256`,
`reference_text` (the transcript), and `clone_mode` (`speaker_embedding_only` or
`transcript`). Put the reference WAV in a `voices/` folder beside the profile.
The voice id is `announcer-female-calm-ko`; supply your own original reference.
Speech inference uses these local files offline; it downloads no model weights.
The separate runtime leaves the video project's Python environment untouched.

New narration and discussion replies use this service. Existing lessons that
were generated while speech was disabled have no saved audio. In Pro mode,
the page's **전체 음성 다시 생성** button fills its narration, or ask the Pro agent
to generate narration for the desired pages. The sample two-page lesson has
its narration generated as part of voice setup. Audio is cached in
`data/qwen-tts-cache`; new clips take time to generate, and repeated clips
return immediately. The configured request timeout is three minutes to allow
local synthesis. Generated lesson audio is saved with the course.

The application listens on `127.0.0.1:3000`, the adapter on `127.0.0.1:57440`,
and its separate PostgreSQL on `127.0.0.1:57439`. This is a personal local
installation with one fixed course owner. Do not expose it to a network.
The Docker project is `learn-anything-openmaic` and its data volume is separate
from other projects. Stop its database without deleting data using
`docker compose -p learn-anything-openmaic -f docker-compose.db.yml stop postgres`.

Text responses stream from Codex. Function requests use constrained JSON and
are translated to OpenAI-compatible tool-call events; OpenMAIC executes its own
tools and supplies results on subsequent calls. The adapter does not execute
Codex shell, file, browser, connector, or delegated-agent tools. Function calls
are emitted once their JSON response is complete. Native Codex features are
disabled for this process; your normal Codex settings are unchanged.

Checks: `pnpm local:test` tests adapter behavior. `GET /api/health` checks the app.
The Codex app-server interface is experimental; a future CLI update may require
an adapter update. This setup was prepared with Codex CLI 0.160.0.

The Pro workbench and course editor are enabled. Setup verification generated
the saved two-slide Korean lesson "피자로 배우는 분수 기초" and received a live
teacher reply through classroom chat. The lesson is available at
http://localhost:3000/classroom/stage-5KpDBquAO1Ex.

The production build, TypeScript check, 72 existing model-configuration tests,
and 6 adapter tests passed. Evidence is in `logs/` (ignored by Git), including
`classroom-proof.png`, `lesson-status.json`, `config-tests.log`, and `build.log`.

Voice setup also passed 114 focused configuration/audio tests and four local
speech-server tests. All 10 sample narration clips were saved and retrieved,
the slides and speech text were preserved, and browser lecture playback and a
spoken teacher reply were checked. See `logs/voice-setup-receipt.json`,
`tts-final-tests.log`, `tts-build.log` and `local-voice-settings.png`.

The language menu supports all 12 UI locales, including English and Korean,
and remembers the selection. Workspace, skill, playback and local voice labels
are translated. Built-in skills have translated UI summaries; their original
agent instructions and user-authored descriptions remain intact. All locale
keys and interpolation tokens were checked. The full app suite passed 9,921 tests
with 157 existing skips; six adapter tests and four speech-server tests
also passed. English and Korean
home, workspace, settings and voice-picker screens were checked in the browser.
English local speech generation also returned playable audio. The other ten
locales have automated resource validation, not a full native-language review.

Sources: [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC),
[Codex app-server](https://developers.openai.com/codex/app-server/),
[model guidance](https://learn.chatgpt.com/docs/models).

Pre-release review fixed reduced-motion hydration of the Pro switch, stale keyboard
callbacks and the local-provider fallback ordering. The hydration regression was
reproduced before the fix and checked on fresh browser loads afterward. The
incumbent purple palette is preserved; two gray-on-color detector findings were
false positives from combined hover text/background styles and have a scoped
exception in `.impeccable/config.json`.

Existing saved courses were also backfilled with the selected female voice:
79 missing narration clips were generated, and 10 previously saved clips were
preserved. All 89 serving URLs returned audio, narration played in the app, and
course content/layout was unchanged. The private receipt is
`logs/course-voice-audit.json`; course data and audio remain outside Git.
