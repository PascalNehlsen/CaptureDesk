# CaptureDesk — AI Feature Ideas

A collection of AI feature concepts ranging from practical quick wins to genuinely novel ideas that don't exist in any screen recording tool today.

---

## Practical — Build These First

### Auto-Summary After Recording
When recording stops, send the transcript to Claude and get a 3–5 sentence summary of what was covered. Low effort, immediate value.

### Auto-Title Generation
Replace "Recording 2026-04-16" with "How to configure nginx reverse proxy" or "Bug walkthrough: auth token expiry". One API call after recording ends. Claude reads the transcript, returns a descriptive title.

### Action Item Extraction
For walkthroughs and demos with narration — Claude pulls a bullet list of TODOs, decisions, or next steps mentioned. Appears in the UI after the recording finishes.

---

## Novel — No Other Tool Has These

### Silent Record → AI Narrates You

**The idea:** You record with zero talking. AI watches what you do — mouse movements, clicks, screen content, keystrokes — and generates professional narration automatically. Synthesizes audio in your cloned voice via TTS.

**Why it matters:** The #1 barrier to screen recording is having to talk while doing something. Developers especially hate it. This removes that barrier entirely. You focus on doing, AI explains it.

**How to build it:**
- Capture frame snapshots + mouse/keyboard events during recording
- Post-recording: send event stream + OCR'd screen content to Claude
- Prompt: "You are narrating a screen recording. Here is what happened step by step. Write natural, clear narration."
- Synthesize with a TTS API (ElevenLabs, OpenAI TTS, or local Coqui)
- Overlay audio onto the recording

**Complexity:** Medium. The hardest part is syncing narration timing to video events.

---

### "The Ghost" — Describe It, AI Records It

**The idea:** You type a prompt: *"Show how to set up nginx with SSL on Ubuntu."* An AI agent operates the computer, performs the steps, records itself doing it, and narrates the result. You get a finished recording without touching the keyboard.

**Why it matters:** Eliminates recording effort entirely for known workflows. Scales content creation to zero marginal cost per video.

**How to build it:**
- Integrate a computer-use agent (Claude's computer use API or similar)
- Agent executes steps on a sandboxed desktop session
- CaptureDesk records the agent's screen activity
- Narration generated from the action log
- Output: complete recording, ready to share

**Complexity:** High. Requires sandboxed environment and computer-use agent integration. Long-term play.

---

### Living Documentation — Auto-Update on UI Change

**The idea:** AI tracks every step you performed as structured data (not just video). Stores: element selectors, URLs, action types, screenshots. When the product UI changes, it detects "step 3 looks different now" and flags it — or auto-regenerates that section.

**Why it matters:** Loom recordings go stale in weeks. Documentation becomes a liability. This makes recordings durable.

**How to build it:**
- During recording: extract DOM state or screenshot + OCR each step
- Store step graph alongside the video file
- Periodic job: re-screenshot the same steps, compare via vision model
- On diff detected: notify user, offer to re-record just that section

**Complexity:** High. Requires persistent step tracking and a comparison pipeline.

---

### Adaptive Replay — Viewer Controls Depth

**The idea:** The recording becomes interactive. Viewer clicks **"explain this more"** at any timestamp and AI generates a deeper explanation on demand. Clicks **"skip setup"** and it jumps intelligently. Clicks **"what if I chose X instead?"** and AI generates the alternative path.

**Why it matters:** Video is a one-size-fits-all medium. A senior engineer and a junior engineer watching the same recording need different things. This personalises the experience at playback time.

**How to build it:**
- Store transcript + step metadata alongside video
- Build an interactive player UI with AI chat sidebar
- On user question: send timestamp context + transcript slice to Claude
- Render response inline in the player
- "Alternative path" requires branching step graph (advanced)

**Complexity:** Medium to high. The chat sidebar is doable fast; true branching is a bigger project.

---

### Fix My Recording

**The idea:** You fumbled some clicks, had awkward pauses, went down the wrong path and backtracked. AI analyzes the recording, identifies the mistakes and dead ends, reconstructs the correct logical flow, and regenerates the video showing only what should have happened. Automatic director's cut.

**Why it matters:** Most people re-record 2–3 times to get a clean take. This makes the first take good enough.

**How to build it:**
- Analyze recording events for backtracking patterns (undo, back button, repeated attempts)
- Send event log to Claude: "Identify the clean path through these actions"
- Claude returns the optimal step sequence
- Re-render video by cutting/reordering segments
- Optional: re-generate narration for the cleaned version

**Complexity:** Medium. Video editing is the hard part; the AI analysis is straightforward.

---

## Recommended Build Order

| Priority | Feature | Why |
|---|---|---|
| 1 | Auto-title + auto-summary | One API call, immediate UX win |
| 2 | Action item extraction | Same pipeline, adds real utility |
| 3 | Silent Record → AI Narrates | Genuinely novel, buildable in days, biggest differentiator |
| 4 | Fix My Recording | High value, medium complexity |
| 5 | Adaptive Replay | Changes the medium itself, larger build |
| 6 | The Ghost | Most ambitious, most impactful long-term |
| 7 | Living Documentation | Requires persistent infrastructure |

---

## Tech Stack Notes

- **Claude API** (Anthropic SDK) for all text generation — use prompt caching for repeated system prompts
- **Whisper** (local via `whisper.cpp`) or Loom's own transcript for input
- **ElevenLabs / OpenAI TTS / Coqui** for voice synthesis
- **Express backend** already in place — add `src/server/ai.js` as the AI layer
- **Computer use API** for The Ghost feature (Claude or an open alternative)
