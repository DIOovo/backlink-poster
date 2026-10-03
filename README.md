# Batch Backlink Poster

A Chrome MV3 extension based on **skkhub/AI-form-filler-crx**, using the original TypeScript/Vite toolchain, AI providers and Playwright InjectedScript bridge. It runs inside the current Chromium / ego(lite) browser. It does not launch Playwright, Puppeteer or Selenium browsers.

Import tasks → **Start Batch** → direct-form detection → Reply entry discovery when needed → fresh form detection / AI fallback → fill → verify → submit → observe → screenshot → persist → next task. Concurrency is fixed at **1**.

## Build and reload in ego(lite)

```bash
npm run build
npm run typecheck
npm test
git diff --check
```

The repository has no configured lint script or lint dependency. `typecheck` checks both the main strict TypeScript project and the original content-script project (which retains its existing relaxed settings).

1. Open `chrome://extensions` in ego(lite).
2. Find the existing extension (now named **Batch Backlink Poster**) and click **Reload**.
3. If loading it for the first time: enable Developer mode, choose **Load unpacked**, and select this project's `dist/` directory. Do not select the repository root or the older `dist.crx`.
4. Reopen the extension's side panel. Existing AI settings remain in the same storage keys.

## Start a batch

1. Open **Settings**. Keep the existing AI Provider / Model ID / Base URL / API Key configuration. For a compatible provider, select **Custom (OpenAI-compatible)** and enter your model, such as `qwen3.5-flash`. The batch logic does not hardcode a model or API credentials. The existing OpenAI-compatible client appends `/chat/completions` to the configured Base URL; include `/v1` in that base if your provider requires it.
2. Set **Screenshot Folder** to a relative folder, such as `backlink-results/2026-10-02`. This applies to the next newly imported batch.
3. Enter **Name**, **Email**, and **Website**. **Remember identity** saves them in `chrome.storage.local`. When unchecked, identity is kept only in `chrome.storage.session`, including across panel reopening and service-worker suspension, and is removed from local storage.
4. Choose **Use CSV Content** (the default) to paste one `URL<TAB>Content` task per line or import a UTF-8 CSV with the exact header `url,content`. CSV supports commas, escaped quotes, and multiline content. Blank or malformed tasks are rejected with a row error.
5. To generate one article-specific comment per URL, upload a local `.xlsx` file. The first worksheet's first column contains URLs; the first row may be a `URL` header (case-insensitive after trimming). Blank cells are ignored, whitespace is trimmed, only `http://` and `https://` values are accepted, and exact duplicate strings are removed. The panel shows Total, Valid, Duplicate, Invalid, task count, and invalid row details. Excel import is parsed locally and selects **Generate with AI** automatically.
6. In **Generate with AI**, enter a Comment Generation Prompt describing the required product name, URL, tone, language, length, and other constraints. The prompt is saved locally. Each page is loaded before its title, description, H1, and cleaned article body (up to 10,000 characters) are passed to the currently configured provider and model. Article text is treated as untrusted reference material.
7. **Preview tasks** persists the queue. **Start Batch** also imports the current pasted draft automatically before starting.
8. Inspect progress and per-task details. Completed and failed tasks are not automatically repeated. To deliberately retry a finished task, import it into a new batch.

Example CSV:

```csv
url,content
https://your-test-site.example/post-1,"First supplied comment."
https://your-test-site.example/post-2,"A comment containing a comma, and ""quotes""."
```

**Pause** finishes the current task, including its screenshot, then pauses. **Resume Batch** processes only READY tasks. **Stop** also finishes the current task and exports the partial results; unstarted tasks remain READY. There are no per-task confirmation dialogs or manual form-selection steps.

## Local File Writer installation

Install the Native Messaging host with the unpacked extension ID shown on `chrome://extensions`:

```bash
./native-host/install.sh EXTENSION_ID ego
```

The default output root is `~/Downloads/backlink-results`. To choose another absolute output root while installing, use the compatible three-argument form:

```bash
./native-host/install.sh EXTENSION_ID /absolute/output/root ego
```

For Google Chrome, use `chrome` in the same position. Chrome installation remains compatible:

```bash
./native-host/install.sh EXTENSION_ID chrome
```

On macOS, ego(lite) 0.5.1.13 reads this host from:

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.backlinkposter.native.json
```

This behavior was verified with ego(lite) 0.5.1.13 and may change in a future ego release. Although ego keeps its browser profile under `~/Library/Application Support/Citro Labs/ego lite`, that profile directory is not its Native Messaging lookup path in this version. The `ego` installer mode therefore deliberately reuses the verified Chrome manifest directory.

The generated manifest points to the absolute `native-host/host.py` path and allows only `chrome-extension://EXTENSION_ID/`. After installing, reload the extension and use **Settings → Local File Writer → Test Connection**. A successful check displays `Connected`, the host version and the configured output root.

To remove only the manifest while leaving the host script, config and output files intact:

```bash
./native-host/uninstall.sh ego
```

Because ego(lite) 0.5.1.13 and Chrome use the same manifest location, `uninstall.sh ego` and `uninstall.sh chrome` address the same host manifest.

## Execution and detection

The service worker owns the queue and uses one dedicated worker tab. The same tab is reused for successive tasks and, within the same window/session, successive batches. Page loading waits on `tabs.onUpdated` completion, then allows a short dynamic-rendering interval. Detection retries after 1, 2 and 3 seconds before falling back.

Local detection prioritizes WordPress `form#commentform`, `textarea#comment` / `name=comment`, author, email, URL, and the submit control. Generic candidates need a visible large text editor and a plausible posting button in the same container. Field labels, id/name, placeholder, ARIA labels, nearby headings and form action contribute to identification. Password, search, newsletter, login and registration forms are excluded. Ambiguous mappings do not silently choose the first element.

In AI content mode, comment generation is an independent step before form detection. The generated plain text is persisted on its task before detection and submission, and Resume reuses it without requesting another comment. A generation error becomes `CONTENT_GENERATION_FAILED`, saves a screenshot, skips submission for that URL, and continues with the next task. CSV mode never calls the Comment Generator.

If no fillable form is visible, the entry detector scans only visible enabled links/buttons in comment, review or discussion context. WordPress `a.comment-reply-link` and its comment data attributes have priority; otherwise the first safe Reply / Respond / 回复 control is used. Reply-by-email, Share, Report, navigation/footer/prose links and login/sign-in Reply controls are rejected. An authentication-only entry becomes `FORM_NOT_FOUND` with `Reply requires authentication` and is never clicked.

After activating one Reply control, the worker discards the old page state and runs direct-form detection against fresh DOM immediately and after 500, 1000 and 2000 ms. This supports WordPress moving `#respond` / `#commentform` under an existing comment. If local detection still fails, a fresh AI form analysis may return either a direct form mapping or one `reply_trigger`; an AI trigger is page-validated before one click and followed by the same fresh-DOM detection. Comment generation and form analysis use separate prompts and outputs. CSS and ARIA-reference selectors resolve through the existing InjectedScript. No code from the model is evaluated.

Filling reuses the original native setters and input/change events. It verifies exact Content readback and supplied Name/Email, and revalidates immediately before submission. Missing optional identity fields are allowed. An invalid non-required website value is cleared so it does not block native submission. Additional required fields are not guessed.

Before clicking Submit, the worker persists the submission phase and baseline evidence. It waits up to 15 seconds for **new** comment nodes containing the task text, explicit submission success or moderation evidence. Navigation or a changed URL alone is insufficient. Existing comments and moderation notices are not treated as new success. Unconfirmed outcomes remain SUBMIT_FAILED; this status can also mean a submission was accepted but could not be verified.

Task statuses:

- READY / RUNNING
- SUCCESS / PENDING_MODERATION
- FORM_NOT_FOUND / SUBMIT_FAILED / LOAD_FAILED / AI_FAILED / CONTENT_GENERATION_FAILED

## Screenshots and CSV

After each task reaches a result, the worker scrolls to the result or form, activates its own tab and calls `chrome.tabs.captureVisibleTab`. It checks the tab ID and URL before and after capture and watches activation/navigation changes during capture. A mismatched capture is discarded and reported, never attached to the wrong task.

Screenshots and CSV are sent to the Local File Writer through Native Messaging and written directly to disk. Each batch gets a unique timestamp/ID directory, so separate runs do not overwrite one another. The absolute written path returned by the host is recorded in the result.

```text
<Local File Writer output root>/
  backlink-results/2026-10-02/
    <unique-batch-id>/
      001-example.com-success.png
      002-example.org-pending.png
      003-example.net-failed.png
      results.csv
```

`results.csv` includes index, URL, final Content, `content_source` (`CSV` or `AI`), `generation_status`, `generated_content`, task status, detection method, `entry_strategy` (`DIRECT_FORM`, `REPLY_TRIGGER_LOCAL` or `REPLY_TRIGGER_AI`), form type, start/completion times (ISO 8601 UTC), final URL, actual screenshot path and errors. Every cell is quoted; embedded quotes, commas and newlines round-trip correctly. The **Export results.csv** button supports retrying export.

The extension sends only a batch ID, filename, and file data to the installed host; the host resolves them under its configured output root. Screenshot or file-write failures are recorded explicitly and do not prevent the next site from running.

## Persistence and recovery

`chrome.storage.local` stores `batchTasks`, `batchState`, `currentTaskIndex`, `batchRun`, the remembered `identity`, screenshot-folder settings and the current input draft. Every significant phase is persisted. Closing or reopening the side panel does not stop the queue.

During an active batch, lightweight extension API activity keeps the service worker available. An internal recovery alarm can wake a suspended worker; it is not a scheduled posting feature. A worker that resumes after a possibly dispatched submission observes its result rather than clicking Submit again. Interrupted pre-submission tasks are recorded conservatively as failed, then the next queued task can proceed.

A full browser/extension restart clears session tab ownership. The queue pauses, in-flight tasks are marked unverified without resubmission, and stale tab IDs are discarded. The saved data remains available. An interrupted final CSV export is recoverable. No attempt is made to promise exactly-once remote posting across a browser crash.

## Permissions

Batch permissions:

- `nativeMessaging`: write screenshot PNGs and results CSV through the installed Local File Writer.
- `alarms`: recover an active finite batch after service-worker suspension.

Existing `tabs`, `storage`, `sidePanel`, `activeTab`, `contextMenus`, and `<all_urls>` host access are retained. Dynamic user-supplied URLs require content access across arbitrary sites, and visible-tab capture needs the existing broad host access when there is no per-site activeTab gesture. Content-script matching is narrowed to HTTP and HTTPS. No debugger or scripting permission is added; the original manifest-injected content script is sufficient.

## Project map

```text
public/manifest.json            MV3 permissions and original injection order
public/injected.js              Existing Playwright InjectedScript bundle
src/background.ts               Existing background flow plus batch registration
src/content.ts                  Existing locator/fill bridge plus batch page handlers
src/batch/model.ts              Task types, CSV, paths and AI schema validation
src/batch/reply.ts              Conservative local Reply candidate selection
src/batch/article-context.ts    Local article extraction and cleanup
src/batch/comment-generator.ts  Independent article-comment prompt and provider call
src/batch/excel.ts              Local .xlsx first-column URL import
src/batch/content.ts            Local detection, fill validation and result evidence
src/batch/runner.ts             Serial queue, recovery, screenshots and CSV export
src/sidepanel.ts + sidepanel.html Batch side panel
src/options.ts + options.html   Original AI/profile settings plus Screenshot Folder
src/utils/ai.ts                 Existing providers plus mapping-only batch detection
src/utils/storage.ts            Existing AI/profile/cache storage
src/utils/pwcode.ts             Original locator interpreter (unchanged)
test/batch*.cjs                 Data, provider and scheduler regression tests
test/batch-fixtures.mjs         Local HTTP fixture pages and a mock AI endpoint
```

The old selection/recording/cache execution helpers remain available in the underlying modules. They are no longer part of the side panel's main workflow. The legacy context-menu debugging flow is not a Batch feature.

## First test: 2–3 URLs

Use pages you own or have permission to submit to. Start with one standard WordPress comment page, one moderated comment page and one page without a comment form. Use distinct comments so the screenshots can be matched to the task rows. Verify SUCCESS / PENDING_MODERATION / FORM_NOT_FOUND, confirm the identity values, then inspect all screenshots and the CSV. A failure in the third page must not prevent any later task from running.

For a completely local test:

```bash
node test/batch-fixtures.mjs
```

Import these URLs with your own non-empty test comments:

- `http://127.0.0.1:8765/wp`
- `http://127.0.0.1:8765/pending`
- `http://127.0.0.1:8765/noform`

Additional fixtures: `/article-a` and `/article-b` provide distinct article topics plus WordPress comment forms for Excel/AI generation tests; `/reply-local` initially exposes only an existing comment and Reply, then inserts/moves a WordPress-style form after activation; `/controlled` tests controlled-input event behavior; `/failed` leaves old moderation evidence unchanged without accepting the new comment; `/challenge` displays a challenge; `/ai` requires a fallback mapping. `/state` exposes only synthetic test submissions, Reply activations and the mock AI call count. The fixture server listens only on localhost.

## Limits

- First version supports top-document forms. Cross-origin iframe comments, closed Shadow DOM, login-gated editors and complex multi-step forms are not generally supported.
- No CAPTCHA solving, challenge bypass, automated login, proxy rotation or fingerprint evasion. Detected challenges are failed and skipped.
- Screenshots capture the visible viewport, not a full-page panorama. The worker tab/window is temporarily activated. Avoid navigating or closing it during a batch; if it disappears, the error is recorded.
- Success and moderation are evidence-based heuristics, not proof that a link is publicly indexed or approved. Unusual languages/markup can yield a conservative failure.
- Background suspension, browser shutdown, Native Host availability, filesystem permissions or storage quota can interrupt work; failures remain visible in task/batch details.
- Real Qwen/provider availability depends on the user's configuration. Automated unit and scheduler tests use synthetic provider responses; the documented browser E2E can use the current real provider configuration.

## License

The project remains MIT licensed (see `LICENSE`). The bundled Playwright InjectedScript is Apache-2.0 licensed (see `LICENSE-APACHE.txt`). The original `npm run gen:injected` script remains available for regenerating that bundle when deliberately upgrading Playwright.
