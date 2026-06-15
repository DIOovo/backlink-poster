# AI Form Filler

A Chrome (MV3) extension that fills web forms automatically using an LLM and Playwright's
locator/selector model. It captures the ARIA snapshot of a page region, asks an AI to detect
the fields and generate fill actions, turns those into editable Playwright code, and executes
them in the page — all without `eval` (so it complies with the MV3 Content Security Policy).

## Features

- **Pick a form region** on the page (hover-to-highlight, click to select; `Esc` to cancel).
- **AI field detection** with live streaming output; review/edit/add/remove fields before saving.
- **Generate fill code**: the AI emits a structured action JSON, which is converted into
  editable, syntax-highlighted Playwright code. JSON ⇄ code stay in sync.
- **Element-type-aware actions**: text → `fill` (backtick-wrapped, multiline-safe), dropdown →
  `click` + `getByRole('option').first().click()`, checkbox/radio → `check`/`uncheck`,
  rich-text editors → `fill` on the contenteditable (with relative-locator disambiguation), etc.
- **Generic execution interpreter**: runs arbitrary Playwright locator chains by reflection
  (`page.locator(...).filter(...).getByRole(...).fill(...)`, `page.keyboard.*`, `page.frameLocator(...)`)
  on a method whitelist — no `eval`. (`page.evaluate(fn)` and other arbitrary-function APIs are
  intentionally unsupported under MV3 CSP.)
- **Form cache**: each form is keyed by a regex **URL pattern + form name**, matched at selection
  time via `RegExp.test(url)` + a DOM hash. On a hit, fields and code load instantly (skips the AI).
- **Cache manager page**: list all cached forms; edit form name / URL / fields JSON / code and save.
- **Page right-click menu**: "Pick DOM mode" (auto-fills on cache hit) plus a one-click entry for
  every cached form whose URL pattern matches the current page.
- Per-action timeout is 3s; AI provider is configurable (Anthropic / OpenAI / any OpenAI- or
  Claude-compatible endpoint via a custom Base URL).

## Dependencies

| Dependency | Role | How it's consumed | License |
|---|---|---|---|
| **Playwright (playwright-core)** | Locator API, `ariaSnapshot`, `generateSelector` | Vendored as static `public/injected.js` (InjectedScript bundle), shipped in `dist/` | Apache-2.0 |
| **playwright-core** (dev) | Source for regenerating `public/injected.js` | devDependency only; run `npm run gen:injected` | Apache-2.0 |
| TypeScript, Vite, rollup-plugin-sourcemaps, @types/* | Build toolchain (not shipped in `dist/`) | devDependencies | Apache-2.0 / MIT |

> Runtime does **not** use `playwright-crx` or `chrome.debugger`. Page-side Playwright capabilities
> come from the vendored InjectedScript bundle injected by the content script; the background service
> worker converts locator chains to Playwright selector strings and dispatches execution steps via
> message passing.

## Project structure

```
AI-form-filler-crx/
├── public/                     # Copied verbatim into dist/ by Vite
│   ├── manifest.json           # MV3 manifest (permissions, side panel, content script, context menu)
│   ├── content.js              # Content script: region pick, InjectedScript bridge, action execution
│   └── injected.js             # Vendored Playwright InjectedScript bundle (regenerate via gen:injected)
├── scripts/
│   └── gen-injected.mjs        # Extracts InjectedScript from playwright-core → public/injected.js
├── src/
│   ├── background.ts           # Service worker: ariaSnapshot, AI calls, locator→selector conversion,
│   │                           #   Playwright-code interpreter, context menus
│   ├── sidepanel.ts            # Side Panel UI: select → analyze → confirm fields → generate
│   │                           #   code → execute; JSON⇄code sync; syntax highlighting; cache
│   ├── cache.ts                # Cache manager page logic (list + editable detail + save/delete)
│   ├── options.ts              # Settings page logic (provider / model / base URL / profiles)
│   └── utils/
│       ├── types.ts            # Shared types (AIConfig, FillAction, FormCacheEntry, messages)
│       ├── ai.ts               # AI API wrapper (Anthropic & OpenAI formats, streaming, prompts)
│       └── storage.ts          # chrome.storage helpers (AI config, profiles, fingerprint)
├── sidepanel.html              # Side Panel markup (entry: /src/sidepanel.ts)
├── options.html                # Settings page markup (entry: /src/options.ts)
├── cache.html                  # Cache manager markup (entry: /src/cache.ts)
├── vite.config.ts              # Build config (entries: background, sidepanel, options, cache)
├── package.json
├── tsconfig.json
├── LICENSE                     # MIT (this project's own code)
├── LICENSE-APACHE.txt          # Apache-2.0 text for bundled dependencies
├── THIRD_PARTY_NOTICES.md      # Attribution for Playwright (playwright-core)
└── dist/                       # Build output (generated; load this folder in Chrome)
```

## Build & load

### 1. Install deps and build

```bash
npm install
npm run build      # output goes to dist/
```

To upgrade the vendored InjectedScript after bumping `playwright-core`:

```bash
npm run gen:injected
npm run build
```

### 2. Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

### 3. Configure the AI

Click the toolbar icon → Side Panel → ⚙ (top-right) → enter your API Key:

| Provider | Suggested model | Base URL |
|---|---|---|
| Anthropic (Claude) | claude-sonnet-4-6 | default (or a Claude-compatible proxy) |
| OpenAI (GPT) | gpt-4o | default (or an OpenAI-compatible proxy) |
| Custom (OpenAI-compatible) | e.g. deepseek-chat | required, e.g. `https://api.deepseek.com` |
| Custom (Claude-compatible) | e.g. claude-sonnet-4-6 | required |

## How it works

1. Select a container → content script runs InjectedScript `ariaSnapshot()` and computes a DOM hash.
2. If the hash matches a cached form for this URL, fields/code load instantly.
3. Otherwise the AI detects fields (streamed); you confirm/edit them and they're saved to the cache.
4. "Generate fill code" asks the AI for a structured action JSON, rendered to editable Playwright code.
5. Background converts locator chains to Playwright selector strings; content script executes each step — no `eval`.
6. On success, the executable code is cached and associated with the form (URL pattern + form name).

## License

This project's own source code is licensed under the **MIT License** — see [`LICENSE`](./LICENSE).

It bundles third-party software licensed under **Apache License 2.0** (Playwright / playwright-core).
See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) and [`LICENSE-APACHE.txt`](./LICENSE-APACHE.txt).
When you redistribute a build (which includes `dist/injected.js`), keep these files so the
Apache-2.0 attribution/notice requirements are satisfied.
