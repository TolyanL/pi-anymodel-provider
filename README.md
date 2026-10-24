# pi-anymodel-provider

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Pi extension](https://img.shields.io/badge/pi-extension-blueviolet.svg)](https://pi.dev)

An [AnyModel](https://anymodel.org) provider for [Pi](https://pi.dev). AnyModel is an OpenAI-compatible gateway, and the extension adds two things:

1. **Provider `anymodel`** with a dynamically discovered model catalog, so the models appear in `/model`, `Ctrl+P` and `/models` like any built-in provider.
2. **Balance-token usage display**: AnyModel bills in *balance tokens* using a per-model coefficient, so raw token counts are misleading. The extension converts session usage with the catalog coefficient, shows a running total in the footer, and offers a detailed report.

## Features

- **Provider `anymodel`** — chat models come from `GET /v1/models` and are registered like built-ins; reasoning, vision, thinking formats, and context limits are mapped from the gateway's capability fields.
- **Balance-token accounting** — per-request `ceil(prompt × coefficient.input + completion × coefficient.output)`, reported in the footer and in `/anymodel` instead of a fake USD price.
- **Custom footer** — active only while an AnyModel model is selected: raw `↑in`/`↓out`, charged `btok`, remaining balance, and context usage on Pi's model row.
- **Image generation** — a model-callable `anymodel_image` tool plus `/anymodel image <prompt>`, saved under a configurable media directory and previewed in the transcript.
- **Offline catalog** — the raw payload is snapshotted to `~/.pi/agent/anymodel-catalog.json` and reused for `ANYMODEL_CATALOG_TTL_MS` (default 6 h).
- **Live balance** — `GET /v1/balance` is refreshed after every AnyModel message and on `/anymodel`, with requests coalesced into a single follow-up.

## Requirements

- [Pi](https://pi.dev) with extension support; interactive TUI mode for the footer and previews.
- An AnyModel API key: `/login` → *AnyModel API key*, or `ANYMODEL_API_KEY` in the environment.
- Network access on the first launch; afterwards the snapshot works offline.
- A terminal with image support (Kitty, iTerm2, Sixel) for image previews — otherwise Pi renders a placeholder.

No build step and no runtime dependencies: Pi loads the TypeScript entry point directly. `@earendil-works/pi-ai`, `pi-coding-agent`, and `pi-tui` are declared as peer dependencies provided by the host.

## Installation

```sh
pi install git:github.com/TolyanL/pi-anymodel-provider
```

Pin a tag or commit:

```sh
pi install git:github.com/TolyanL/pi-anymodel-provider@v1.0.0
```

Try it for a single invocation without touching your settings:

```sh
pi -e git:github.com/TolyanL/pi-anymodel-provider
```

From a local clone:

```sh
git clone https://github.com/TolyanL/pi-anymodel-provider
pi install ./pi-anymodel-provider
```

Restart Pi, or run `/reload`, after changing the extension. The package is npm-shaped (`keywords: ["pi-package"]`), so `pi install npm:pi-anymodel-provider` works the same way if you publish it.

During development the extension can also be discovered from `~/.pi/agent/extensions/pi-anymodel-provider` (a symlink to a clone) or loaded with `pi --extension ~/.pi/agent/extensions/pi-anymodel-provider`. Load it **once**: Pi rejects duplicate tool names, so combining discovery with an explicit `--extension` for the same path fails.

## Usage

Connect the API key once (stored in `~/.pi/agent/auth.json`, never in git):

```text
/login
# → AnyModel API key
```

Alternatively set `ANYMODEL_API_KEY` in the environment. Then pick a model:

```text
/model
# → anymodel/am/kimi-k3, anymodel/cc/claude-opus-5, …
```

## Commands

| Command | Effect |
| --- | --- |
| `/anymodel` | Session report: model and coefficient, requests, input/output, billed btok, media generations, per-model split, last request, account balance |
| `/anymodel image <prompt>` | Generate an image (flags: `--model=`, `--n=`, `--size=`, `--quality=`, `--format=`) |
| `/anymodel refresh` | Force `GET /v1/models` and rewrite the local snapshot |
| `/anymodel footer on\|off` | Custom footer for AnyModel models, or back to Pi's footer everywhere |

## Configuration

Optional `~/.pi/agent/anymodel.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `output` | `~/.pi/agent/anymodel-media` | Directory for generated images. `~` expands to the home directory; a relative path resolves against Pi's working directory. |

```json
{ "output": "~/Pictures/anymodel" }
```

The file is optional and re-read on every generation, so edits apply without a restart. A malformed file is reported once and ignored. Set `PI_ANYMODEL_CONFIG` to a path to use a different file.

## Media generation

Images are available both as a model-callable tool and as a command. Everything is saved under the configured media directory (`~/.pi/agent/anymodel-media/` by default — see [Configuration](#configuration)).

| | |
| --- | --- |
| Tool `anymodel_image` | Generates images, saves them, and attaches them to the result |
| `/anymodel image <prompt>` | Same for manual use; the result is posted into the transcript |

Images are previewed in the transcript: a tool result carries the image block, and the command posts a custom message with text plus the image. Non-PNG responses (the free FLUX routes return JPEG) are converted to PNG for the preview while the saved file keeps its original format. Previewing needs a terminal with image support (Kitty, iTerm2, Sixel) — otherwise Pi renders a placeholder such as `[Image: [image/png] 1x1]`, and the `images.blockImages` setting turns previews off entirely.

The agent can choose generation options itself: the image tool exposes `model`, `n`, `size`, `quality` and `outputFormat`. Unknown `size`/`quality` values are rejected against the model's `billing.scales` before anything is spent.

Without an explicit `--model`, the cheapest image model is used. Image models come from `GET /v1/models`.

Video generation is intentionally not implemented: the routes are by far the most expensive (`xai/grok-imagine-video-1.5` at 1080p is 625 000 btok per second, so a single 8-second clip costs about 5M btok) and an accidental call from the model would be costly.

Media spend counts toward the session totals in balance tokens — images as `ceil(round(base_tokens × quality × size) × delivered × coefficient.output)`. `/anymodel` lists it on a `Media:` line and the footer's `btok` includes it.

Until an account has topped up once, AnyModel returns generated images as `b64_json` with a small mark in the corner.

## Footer

The extension replaces Pi's built-in footer (`ctx.ui.setFooter`) **only while an AnyModel model is selected**; for every other provider Pi's default footer stays in place. The replacement drops Pi's `↑in ↓out Rcache CHhit%` stats line, which the AM status supersedes. Kept from the built-in footer: working directory, git branch, session name, right-aligned model with thinking level, and extension statuses. The AM statistics occupy the **left side of the model row** — the space Pi's own token stats used to fill — while other statuses (`mcp …`) stay on their own row below. Switching away from an AnyModel model restores the built-in footer and clears the AM status, so nothing is duplicated.

`/anymodel footer on|off` disables the replacement entirely (always Pi's footer) or re-enables it for AnyModel models.

The model row reads:

```text
AM ↑2.77M ↓25.8k · 4.14M btok · 9.84M left · ctx 56.8%/200k   (anymodel) glm/glm-5.3 • high
```

`↑`/`↓` are the raw prompt (cache included) and completion tokens — the sum the cabinet adds up. `btok` is the balance-token charge after coefficients — the cabinet's «списано» column. `ctx` is context usage as `percent/window`, colored by threshold (>70% warning, >90% error). The counters start at zero and the balance appears as soon as `GET /v1/balance` returns, so the row is complete from the first render instead of collapsing to context alone.

## How billing is computed

AnyModel charges, per chat request:

```text
billed = ceil(prompt_tokens × coefficient.input + completion_tokens × coefficient.output)
```

`prompt_tokens` is the full input count; cache reads are a subset rather than a discount. Pi reports `usage.input` with cache tokens already subtracted, so the extension bills `input + cacheRead + cacheWrite`. A non-zero route costs at least one balance token; a `×0` route is free.

Combo routes (`owned_by: "combo"`, e.g. `nano-banana*`) publish no coefficient, so their spend is shown as a lower bound (`≥`). Built-in web search adds a flat 40 000 balance tokens per search, which the response usage does not expose; that surcharge is **not** included in the totals.

### Comparing with the cabinet

- The cabinet's `списано` column is `btok` (coefficient applied). It should match `/anymodel` for the same requests, minus per-request `ceil` rounding.
- The cabinet's token column adds the request's `вход + выход` (raw), which is the status line's `↑` + `↓`.
- `/anymodel` is scoped to **this session**, while the cabinet reports its own period across the whole key, so absolute totals rarely match exactly. For an exact check, compare one request: `/anymodel` shows the last request's `in / out → btok`.

## Catalog and offline startup

`GET /v1/models` is fetched through the provider's `refreshModels` hook and the raw payload is snapshotted to `~/.pi/agent/anymodel-catalog.json`, so models and coefficients are available offline and on restart. A snapshot is reused for `ANYMODEL_CATALOG_TTL_MS` (default 6 h); `refresh` always bypasses it.

### When models refresh

The extension never polls on its own. `GET /v1/models` runs in these cases:

1. **On every Pi start** — `session_start` forces one fetch per process (skipped when no API key is configured or `PI_OFFLINE` is set).
2. **`/anymodel refresh`** — always forces a fetch.
3. **After `/login anymodel`** — Pi refreshes that provider's catalog with network enabled, and the fetch happens only when the snapshot is missing or older than `ANYMODEL_CATALOG_TTL_MS`.

Pi coalesces catalog refreshes per provider and aborts one that is already in flight when a newer refresh starts, so a cache-only refresh during startup can cancel the first attempt. The extension detects an unchanged snapshot and retries (up to 3 attempts, 600 ms apart), so the fetch still lands.

Everything else is local. `session_start` reads the snapshot from disk before refreshing, Pi's own session-services refresh is cache-only (`allowNetwork: false`), and the provider's `fetchModels` then returns the cached list without network access.

`GET /v1/balance` is separate from the catalog: it runs on `session_start`, after every AnyModel assistant message (so the footer's `left` stays current), and whenever you run `/anymodel`. Requests are coalesced — while one is in flight the next ones schedule a single follow-up, so a tool-heavy turn cannot start a burst of parallel calls.

Only chat-capable kinds are registered as chat models (`llm`, `text`, `chat`, `imageToText`). Image entries are parsed separately as media models, available to the image tool and command. Video, TTS, STT, embedding, rerank, and web entries are ignored entirely — they are not callable through `/v1/chat/completions`.

| Catalog field | Pi mapping |
| --- | --- |
| `capabilities.contextWindow` / `context_length` | `contextWindow` |
| `capabilities.maxOutput` / `max_completion_tokens` | `maxTokens` |
| `capabilities.vision` | `input: ["text", "image"]` |
| `capabilities.reasoning` | `reasoning` |
| `capabilities.thinkingFormat` = `deepseek`/`zai`/`qwen` | `compat.thinkingFormat` |
| `capabilities.thinkingCanDisable === false` | `thinkingLevelMap.off = null` |
| `billing.coefficient` | balance-token accounting (not Pi's USD `cost`) |

Pi's `cost` stays at zero on purpose: AnyModel prices are not USD, and the extension reports balance tokens instead of a fake dollar figure.

## Limitations

- Balance tokens are not USD: Pi's session cost stays at zero, and nothing here converts to money.
- Combo routes without a published coefficient are shown as a lower bound (`≥`), and built-in web-search surcharges are not counted.
- `/anymodel` covers this session only; the cabinet aggregates the whole key, so totals differ.
- Video generation is deliberately absent; images only.
- The first start after installation has no catalog until `GET /v1/models` completes; offline without a snapshot, the provider lists no models.

## Development

`tests/anymodel.test.mjs` is a self-contained harness (105 checks) covering the catalog mapping, the billing math, image pricing and generation with a stubbed `fetch`, the tool and command paths, the footer layout, the model-scoped footer, the startup refresh (including the supersede retry), the balance refresh, and the stale-ctx guard. It never talks to AnyModel: the agent directory is sandboxed by pointing `PI_CODING_AGENT_DIR` at `/tmp/anymodel-test-agent`, and all requests are stubbed. It is not loaded by Pi: extension discovery uses the root `index.ts`, and `.mjs` files are not extension candidates.

```sh
npm test                              # node tests/anymodel.test.mjs; needs a catalog snapshot at the agent dir
PI_PACKAGE=/path/to/pi-coding-agent node tests/anymodel.test.mjs
```

## License

[MIT](LICENSE) © TolyanL
