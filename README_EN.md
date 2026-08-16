# imemory — Self-Evolving Long-Term Memory Plugin for DSH

> **中文文档**:[README.md](./README.md)
>
> ⚠️ **Release status**: Built on Aug 14, 2026 and put into daily use the very next day, this project has already gone through 4 iterations. Because it is highly personalized, the published version is still a **beta** — APIs and behavior may change as it evolves. Thanks for your understanding.

`imemory` is a self-evolving long-term memory plugin for DeepSeek Harness (DSH). It keeps your long-term memory in two **plain-text files** (`MEMORY.md` — your notes, and `USER.md` — the user profile; entries separated by a lone `§` line). After each turn, an LLM extracts durable facts worth remembering and writes them back; before each step, relevant memories are recalled and injected into the context. Reusable workflows are distilled into `learned-*` skills. A web panel is included.

## Features

- **Auto-extraction after each turn** — the LLM mines the conversation for durable facts (importance 1–10; <3 is dropped; better few than many)
- **Per-step recall injection** — keyword pre-filter + LLM semantic re-rank (temperature 0), injected without announcing the memory use
- **Session opener** — new sessions start with the user profile + high-importance notes
- **Conflict merge / dedup / decay** — consolidated every 6 h (auto-merges plugin-owned entries; user-edited entries only get suggestions)
- **Skill learning loop** — reusable procedures become `learned-*` skills (skills.json → DSH skill registry, loadable via the `skill` tool)
- **6 tools** — `memory_search` / `memory_add` / `memory_update` / `memory_forget` / `memory_sessions` / `memory_consolidate`
- **Web panel** — `/imemory/` (browse entries / hit counts / importance up-down / delete / consolidate)
- **Zero dependency** — imports no `@deepseek-ai` package; loads from any install path (manual copy, `link:`, npm/git)
- **Profile-agnostic** — `webServer` is optional: web profiles get the panel automatically; headless/tui profiles run fine without it

## Quick start (60 s)

```bash
# 1. copy the plugin into your profile dir (web profile example)
cp imemory.mjs ~/.dsh/profiles/web/imemory.mjs

# 2. append to ~/.dsh/profiles/web/cordis.patch.yml:
#    - insert:
#        - id: imemory
#          name: ./imemory.mjs

# 3. restart dsh. You should see: [imemory] 就绪 ... 记忆目录 ...
```

## Installation

Target DSH: `0.1.0-rc.6` (Node ≥ 20). Two ways:

### Method A — Manual mount (recommended, no build/npm)

1. Copy `imemory.mjs` into your profile dir, e.g. `~/.dsh/profiles/web/imemory.mjs`
2. Append to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: imemory
      name: ./imemory.mjs
      # optional: config:
      #   memDir: ~/.dsh/my-memories
```

3. Restart dsh.

### Method B — Bundle install (npm / git)

```bash
dsh plugin --profile web add imemory                    # after npm publish
dsh plugin --profile web add https://github.com/bass1125/imemory.git
```

The package's `dsh.bundle.patch` declaration mounts the plugin automatically. Remove any manual mount line from Method A first to avoid double-mounting.

### Hot reload

- **Config changes** (e.g. `memDir`): the profile's `cordis.patch.yml` is watched (`watchUserPatches`), saving takes effect immediately.
- **Plugin code changes**: restart dsh; or force a re-import by bumping the module URL query in the insert line, e.g. `name: ./imemory.mjs?v=2`.

## Configuration

Only one option: `memDir` (memory/notes directory).

| Option | Default | Notes |
| --- | --- | --- |
| `memDir` | `$DSH_HOME/imemory/` (or `~/.dsh/imemory/`) | `~` prefix supported; relative paths resolve against the harness home |

The directory is created automatically on startup.

## Memory layout

The harness home is `$DSH_HOME`, defaulting to `~/.dsh` (Windows: `C:\Users\<you>\.dsh`). **No hardcoded paths** — works out of the box on any machine:

| File | Purpose |
| --- | --- |
| `<memDir>/MEMORY.md` | your notes (environment, projects, lessons, skills) |
| `<memDir>/USER.md` | user profile (identity, preferences, rules) |
| `<memDir>/memories.index.json` | sidecar index (importance / hits / timestamps) |
| `<memDir>/skills.json` | learned `learned-*` skills |

> The memory files are plain text — edit them anytime. `§` on its own line separates entries; don't use lone `§` lines inside an entry.

## Verification

- A new session's first step carries an `<imemory>` opener block
- 6 `memory_*` tools appear in the model's tool list
- Panel: `http://<dsh-host>:<dsh-port>/imemory/` (web profiles)

## Behavior notes

- **Extraction**: root sessions only; 20 s cooldown; ≤6 memory ops / 2 skills per round
- **Recall**: keyword scoring, ≤15 candidates go through LLM re-rank; plain keyword fallback without a model
- **Consolidation**: every 6 h — conflict merge + dedup + decay (entries >14 days with effective score ≤1.5 are retired) + index orphan cleanup
- **Importance**: 1–10; <3 dropped; hits raise the effective score
- **Hermes-compatible**: same `§`-separated format as Hermes memory files — point `memDir` at an existing Hermes memory dir to adopt old memories seamlessly

## Development

```
imemory/
├─ imemory.mjs       plugin body (single file, zero build, zero deps)
├─ package.json      bundle declaration (dsh.bundle.patch)
├─ cordis.patch.yml  bundle mount patch
├─ README.md / README_EN.md
└─ LICENSE
```

## License

MIT
