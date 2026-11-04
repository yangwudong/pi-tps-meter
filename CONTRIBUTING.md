# Contributing to pi-tps-meter

This guide is for anyone changing pi-tps-meter, people and coding agents alike. It covers how the code is organised, the rules every change must keep, the pi-specific traps, how to test, and how to ship a release.

The user documentation is the Chinese [README](./README.md). This file is the source of truth for development.

## Contents

1. [What this project is](#1-what-this-project-is)
2. [Getting started](#2-getting-started)
3. [Repository layout](#3-repository-layout)
4. [How it works](#4-how-it-works)
5. [Rules](#5-rules)
6. [Code style](#6-code-style)
7. [Gotchas](#7-gotchas)
8. [Testing](#8-testing)
9. [When pi releases a new version](#9-when-pi-releases-a-new-version)
10. [Releasing](#10-releasing)
11. [Documentation](#11-documentation)

## 1. What this project is

pi-tps-meter is an extension for the [pi coding agent](https://pi.dev). It shows three readings:

- **TPS**: live generation speed.
- **AVG**: the session average.
- **TTFT**: time to first token.

It is a port of [opencode-tps-meter](https://github.com/yangwudong/opencode-tps-meter). The port treats the original as its source of truth: the measurement core, the speed tiers and their colours, and the thinking particle stream come from it. The event wiring and the rendering were rewritten for pi.

Design principles, in priority order:

1. **Accurate numbers.** Estimates are calibrated against the provider's authoritative token counts. Every deviation from the original's arithmetic has an argument in a code comment and an entry in the README.
2. **Small and self-contained.** pi loads the TypeScript directly, so there is no build step. There are no runtime dependencies and no network requests.
3. **Never break the host.** The meter must not throw into pi, slow down a stream, or leave the user without pi's footer.

## 2. Getting started

**Prerequisites**

- Node.js ≥ 22.19. The tests run `.ts` files through Node's built-in type stripping.
- pi ≥ 1.5.0, for trying changes.
- Optional:
  - `gh` (GitHub CLI), for releases.
  - [`uv`](https://docs.astral.sh/uv/), for the TUI snapshot script.

**Setup**

```bash
git clone git@github.com:yangwudong/pi-tps-meter.git
cd pi-tps-meter
npm test            # node --test; needs no install
npm install         # once: typescript, @types/node and the pi peers (for types only)
npm run typecheck   # tsc --noEmit, strict, against pi's real types
```

`npm install` downloads `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as peers, only so the type check has pi's real types. `node_modules/` is git-ignored and never affects your pi installation. `package-lock.json` is git-ignored too, so each install resolves the latest pi, as CI does.

### Trying the working copy in pi

```bash
pi -ne -e .         # this extension only, loaded from the working copy
```

Always pass `-ne` if the published package is also installed. pi treats an npm install and a local path as two different packages, so both would load. You would get two meters and the commands `/tps:1` and `/tps:2`. `-ne` also keeps your other extensions out of test sessions, such as ones that send phone notifications.

After editing code, run `/reload` in pi to re-import the extension, or restart pi.

To use an unreleased build day to day, swap the installed package for the working copy:

```bash
pi remove npm:@jack-yang/pi-tps-meter
pi install "$PWD"        # loads straight from this directory; /reload picks up edits
# later, back to the release:
pi remove "$PWD" && pi install npm:@jack-yang/pi-tps-meter
```

Never use `pi install npm:./pi-tps-meter` (see [Gotchas](#packaging-and-npm)).

## 3. Repository layout

| Path | Contents |
|---|---|
| `extensions/index.ts` | The pi host layer: event wiring, display modes, `/tps`, the 100 ms ticker, footer wrapping |
| `src/core.ts` | Measurement state machine: window, calibration, AVG, TTFT |
| `src/format.ts` | Number formats, tiers, ANSI colours, line layout, right alignment |
| `src/spinner.ts` | Thinking particle stream: colour presets, gradient, FIFO flow |
| `src/footer.ts` | Merges the meter into the directory line of pi's footer |
| `src/config.ts` | `config.json`: path, load, save, validation. The only module that does IO |
| `test/*.test.ts` | One `node:test` suite per module, plus `extension.test.ts` for the host layer |
| `scripts/tui-snapshot.py` | Development aid: runs pi in a pseudo-terminal and prints the screen |
| `docs/*.png` | README screenshots |
| `.github/workflows/` | `ci.yml` (tests and type check), `publish.yml` (npm release) |

The npm package contains only what the `files` field in `package.json` lists: `extensions/`, `src/`, `README.md`, `CHANGELOG.md`, `LICENSE` and `package.json`. Tests, docs, scripts and this guide stay in the repository.

**Dependency direction**

```
extensions/index.ts ──► src/config.ts ──► src/spinner.ts
        │                    └──(types)──► src/format.ts ──(types)──► src/core.ts, src/spinner.ts
        └──► src/core.ts, src/format.ts, src/spinner.ts, src/footer.ts
```

Nothing under `src/` imports pi. `extensions/index.ts` imports pi's types statically. It reaches pi's runtime modules only through one dynamic import in `loadPiFooterKit`, which the tests replace. As a result, every test runs on plain Node.

## 4. How it works

### Event flow

| pi event | What the extension does |
|---|---|
| `session_start` | Fresh state, reads `config.json`, renders the idle line |
| `turn_start` | Records when the LLM request began, the TTFT origin |
| `message_start` (assistant) | Starts a message: clears TTFT and samples, starts the ticker |
| `message_update` (text, thinking or toolcall delta) | Records a sample. If this is the first token, renders at once so TTFT appears immediately |
| `message_end` (assistant) | Folds `usage.output` into AVG and calibration, skipping `error` and `aborted` messages. Stops the ticker and renders |
| `turn_end` | Re-renders only. The summary is never cleared |
| `session_shutdown` | Stops the ticker and drops the UI reference |

pi also emits message events for user, tool-result and custom messages. Every handler filters on `role === "assistant"`.

### Measurement (`src/core.ts`)

**Samples.** Each delta is estimated at UTF-8 bytes ÷ 4 tokens (`estimateTokens`) and pushed into a 5 s sliding window.

**Live TPS** is window tokens × calibration factor ÷ (now − oldest sample in the window):

- The span is never shorter than 1 s.
- The reading blanks once the newest sample is more than 1.5 s old.

**Calibration** happens when a message completes:

1. The ratio `usage.output ÷ estimate` is clamped to [0.3, 3.0].
2. The factor is the median of the last 10 ratios.
3. The new factor applies from the next message on.

**AVG** is the sum of authoritative output tokens ÷ the sum of generation times, over completed messages. A message's generation time is last delta − first delta, at least 1 s.

**TTFT** is the time from `turn_start` to the first text or thinking delta.

Samples are cleared at every message boundary, so a tool run between two messages never dilutes the next message's rate.

### Display modes (`extensions/index.ts`)

| Mode | Where the meter appears | How |
|---|---|---|
| `footer` (default) | Right end of the directory line of pi's footer | Wraps pi's own `FooterComponent` |
| `right` | Its own line below the editor, right-aligned | A component that re-aligns at every width |
| `status` | pi's footer status line | `ctx.ui.setStatus()`, sorted by key among other extensions' statuses |
| `widget` | A line above the editor | `ctx.ui.setWidget()` with a string line |
| `off` | Nowhere | Measurement continues |

Display rules:

- Exactly one surface shows the meter at a time. When the mode changes, `render()` clears the surface being left.
- RPC mode has no custom footers or component widgets, so there `footer` and `right` fall back to plain lines below the editor.
- The ticker runs at 10 Hz, and only while a message streams. A line that has not changed is not pushed again.

### Footer wrapping

pi has no API for placing text in its footer, and replacing the footer would mean re-implementing it. Instead, footer mode wraps pi's own footer:

1. `setFooter` mounts a wrapper that runs pi's exported `FooterComponent`, so pi still renders its own footer.
2. `mergeFooterLine` (`src/footer.ts`) adds the meter to the first line.
   - On a narrow terminal the directory is truncated first and the meter stays whole.
   - Widths come from pi-tui, so CJK characters count as two columns.
3. `FooterComponent` expects pi's whole `AgentSession`, which extensions never get. `SessionView` rebuilds the members it reads from the extension context. The `SAFETY` comment in `loadPiFooterKit` lists those members.
4. If loading or rendering fails, `fallBack()` restores pi's footer, switches to `right` and notifies the user once. `mountEpoch` makes a late result from an old mode or session harmless.

### Thinking particle stream (`src/spinner.ts`)

- The stream shows only in the TUI, while the latest delta is reasoning.
- Frames advance with wall time, every `intervalMs`.
- Colours are RGB values painted through `ctx.ui.theme.style()`, so pi picks truecolor or 256 colours to suit the terminal.
- Next to a right-aligned reading (`footer`, `right`), the stream sits on the left and is mirrored, so the numbers never move.

## 5. Rules

A change must keep every rule below. If a change has to break one, discuss it first and update this section in the same change.

1. **The measurement modules are pure.**
   - `src/core.ts`, `src/format.ts`, `src/spinner.ts` and `src/footer.ts` never read the clock, start a timer, do IO or import pi.
   - Time, randomness and text-width functions are parameters. `extensions/index.ts` passes `Date.now()`, `Math.random` and pi-tui's width functions.
   - This is what keeps the tests deterministic.
2. **The measurement math matches the original.**
   - This covers the constants (`WINDOW_MS` 5000, `STALE_MS` 1500, `MIN_DURATION_MS` 1000, `MAX_CALIBRATION_RATIOS` 10) and `estimateTokens`.
   - It covers the `now − oldest` span, the median of ratios clamped to [0.3, 3.0], and the AVG formula.
   - It covers `formatTps`, `formatTtft` and the tier boundaries.
   - A deliberate deviation needs an argument in a code comment and an entry in the README section "与 opencode-tps-meter 的差异".
3. **No runtime dependencies, no network.**
   - `dependencies` stays empty.
   - Packages pi supplies to extensions (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `typebox`) go in `peerDependencies` with range `"*"` as soon as the code imports them at runtime. They never go in `dependencies` and are never bundled.
   - pi is imported with `import type`. The only runtime pi imports are the dynamic ones in `loadPiFooterKit`.
4. **Erasable TypeScript only.**
   - No `enum`, `namespace`, parameter properties or `import =`.
   - Relative imports end in `.ts`, and type-only imports use `import type`.
   - Node's type stripping (the tests) and pi's loader both depend on this. `tsconfig.json` enforces it with `erasableSyntaxOnly` and `verbatimModuleSyntax`.
5. **Never break the host.**
   - No exception may escape into pi. Config IO returns a result instead of throwing, and the footer wrapper catches render errors and falls back.
   - Event handlers stay synchronous and cheap, because they run on pi's streaming path.
   - Nothing may leave the user without pi's footer.
6. **Respect pi's lifecycle.**
   - The factory function does no IO and starts no timers: pi can load extensions without starting a session.
   - State is built in `session_start`.
   - `session_shutdown` stops the ticker and drops the UI reference.
   - Async work checks `mountEpoch` before it touches the UI.
7. **One surface at a time.** Leaving a mode clears its surface:
   - `setStatus(KEY, undefined)`, never `""`.
   - `setWidget(KEY, undefined)`.
   - `setFooter(undefined)`, only when leaving footer mode.
8. **Type assertions explain themselves.**
   - Prefer pi's real types to casts. They are richer than they look: check `pi-ai`'s types before writing one.
   - An unavoidable `as unknown as T` goes in its own statement, with a `// SAFETY:` comment directly above it stating the invariant the compiler cannot check.
9. **`config.json` belongs to the user.** `/tps` rewrites only `mode` and keeps every other key. A file that does not parse is reported and left untouched.
10. **Behaviour changes ship complete.** Every behaviour change ships with tests and a CHANGELOG entry. A change users can see also updates the README.

## 6. Code style

- **Formatting:** no semicolons, double quotes, 2-space indentation, as in the original.
- **Code shape:** exported functions have explicit types. Prefer small pure functions and plain objects to classes.
- **Comments:**
  - A comment explains why: what pi does there, or what would break. It doesn't restate what the line does.
  - Comment the trap where the code meets it.
  - Code, comments and this guide are in English. The user README is in Chinese.
- **Tests:** a test sits next to the behaviour it pins down, and its name says what must hold.
- **Commit messages** use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `chore:`. Release commits are `chore: release vX.Y.Z`.
- **Staging:** stage files by name. `TASK.md`, `AGENTS.md` and other local notes are never committed. Avoid `git add -A`.

## 7. Gotchas

These traps have each caused a real bug or a wrong reading during development.

### pi's events and data

- **`message_start` is not the start of the request.**
  - pi emits it only when the provider stream opens, after the HTTP response headers arrive. Most backends send those headers only after queueing and prefill.
  - Measured from `message_start`, TTFT reads about 0 ms when the real wait is seconds. TTFT is therefore timed from `turn_start`.
- **`usage.output` already includes reasoning tokens.** `usage.reasoning` is a subset of it. Don't add the two.
- **Tool-call arguments are output.**
  - They count toward TPS and calibration. Leaving them out pushed calibration to its 3.0 clamp.
  - They never end the TTFT wait.
  - Providers that send a whole function call in one delta, such as Gemini, cause a brief spike at the end of a message. This is accepted.
- **Non-assistant messages emit message events too**: user, tool-result and custom messages. Filter on `role`.
- **`pi.getSettings()` deep-copies all settings on every call.** Never call it per frame. Footer mode reads the auto-compaction flag at most once a second.
- **`ctx.sessionManager` has more methods at runtime than its read-only type.** For example, `getEntryCount`, which pi's footer uses.
- **`ctx.modelRegistry.isUsingOAuth` takes a `Model`, not a provider id.** pi's internal `ModelRuntime` takes the id. The strict type check caught this mix-up, so keep running it.

### pi's UI

- **pi sanitises the footer status line.** Runs of spaces collapse, and both ends are trimmed, including no-break spaces. The particle stream's gaps therefore use U+2800, the empty braille cell.
- **Footer statuses cannot be positioned.** pi joins them left-aligned, sorted by key.
- **`setStatus(key, "")` keeps an empty entry.** Clear it with `undefined`.
- **Enter applies an open argument completion instead of submitting.** `getArgumentCompletions` therefore returns only strict prefixes. With an exact match in the list, `/tps off` would need two Enters.
- **Only one footer exists at a time.** The last extension to call `setFooter` wins. Footer mode conflicts with other footer-replacing extensions, such as awesome-pi-themes' look-pack. `right` mode does not.
- **Replacing the session shuts down the extension instance.** `/new`, `/resume`, `/fork` and `/reload` end this instance and start a new one, and pi resets extension UI itself.

### Packaging and npm

- **`pi install npm:./path` installs but never loads.** pi derives the install directory from the text after `npm:`. Use `pi install ./path` instead.
- **An npm install and a local or `-e` copy are different packages to pi.** Both load. Use `pi -ne -e .` when testing.
- **A just-published version is not installable right away.** For a few minutes, sometimes more than five, installs fail with `ETARGET` even with an empty cache.
- **Your own npm cache can hide the new version.** `~/.npm` can keep answering "not found" for a while after the version is live. Run `npm view @jack-yang/pi-tps-meter version --prefer-online` before `pi update`, or pi installs the previous version.
- **`gh release create --target` needs a branch name or a full 40-character SHA.** A short SHA fails with HTTP 422, "tag_name is not a valid tag".
- **Don't remove the `0.0.0-stage` version on npm.** It is a stub that `npm trust` created before 0.1.0. It is a prerelease that no install range matches.

### Tests

- **Test fakes must emit real SGR sequences.** A fake `theme.style()` must return `\x1b[38;2;r;g;bm…\x1b[39m`, as pi's does. An earlier fake emitted other markup, which broke width measurement and caused a flaky test that depended on random values.
- **Particle-stream assertions must hold for every random stream.** The stream draws from `Math.random`. After touching it, run the suite several times.

## 8. Testing

### Unit tests

```bash
npm test                          # every suite
node --test test/core.test.ts     # one suite
```

| Suite | Covers |
|---|---|
| `core.test.ts` | All of the original's measurement tests, the sliding window, STALE, the TTFT origin and its reset, AVG, calibration including convergence on CJK text, the thinking flag |
| `format.test.ts` | Number formats, tier boundaries, colours, particle layout, right alignment |
| `spinner.test.ts` | Colour parsing, gradient, FIFO flow, time-based frame advance |
| `footer.test.ts` | Merging into the directory line: widths, truncation, CJK |
| `config.test.ts` | Defaults, overrides, validation, the mode cycle, file IO (a broken file is never overwritten) |
| `extension.test.ts` | The host layer end to end: every display mode, refresh cadence, summary persistence, toolcall vs TTFT, footer wrapping and fallback, `/tps`, RPC |

**Test doubles in `extension.test.ts`**

- `mock.timers` (`setInterval` and `Date`) drives the clock.
- A fake `ExtensionAPI` and `ctx.ui` record every `setStatus`, `setWidget` and `setFooter` call.
- `fakeKit()` stands in for pi's `FooterComponent`. It can be made to fail on load or to throw on render.
- `PI_CODING_AGENT_DIR` points at a temporary directory, so config IO is real but isolated.

When a change touches timing, rendering or the particle stream, run the suite several times:

```bash
for i in 1 2 3 4 5; do npm test 2>&1 | grep -E '^ℹ (pass|fail)' | tr '\n' ' '; echo; done
```

### Type check

`npm run typecheck` (after `npm install`) checks strictly against pi's real types. CI runs it against the latest pi on npm, so it is the first warning when pi changes its API.

### Manual verification in pi

The unit tests use fakes. Layout, colours and pi's real event timing need the real TUI. `scripts/tui-snapshot.py` runs pi in a pseudo-terminal, emulates the screen with [pyte](https://github.com/selectel/pyte) and prints the bottom lines:

```bash
uv run scripts/tui-snapshot.py                                    # idle screen
uv run scripts/tui-snapshot.py --cols 70                          # a narrow terminal
uv run scripts/tui-snapshot.py --with ~/.pi/agent/npm/node_modules/pi-lens   # next to another extension
uv run scripts/tui-snapshot.py --command "/tps right"             # after a command
uv run scripts/tui-snapshot.py --prompt "用中文写两句话介绍西湖。不要使用工具。"   # a real request
uv run scripts/tui-snapshot.py --help                             # all options
```

How the script runs pi:

- It runs `pi --no-session -ne -e <repo>`. No session file is written, and no other extension loads unless you add one with `--with`.
- It uses your models and settings.
- It restores your `config.json` on exit, even after `--command "/tps …"`.
- `--prompt` sends a real request to your default model, so it costs tokens. It prints the screen while thinking, while streaming and after the message.

What to check:

- The meter is where the mode says it is.
- In `footer` and `right` mode the meter ends in the last column, and pi's other footer lines are unchanged. Compare with `/tps off`.
- TPS updates while the model streams.
- The particle stream appears while the model thinks and disappears when the answer starts.
- AVG and TTFT remain after the message.
- Narrow widths (`--cols 70`) work, as do long or CJK working directories (`--cwd`).

**Scripted checks in RPC mode.** RPC mode reports every UI call as a JSON line on stdout:

```bash
(sleep 6) | pi --mode rpc --no-session -ne -e .
# {"type":"extension_ui_request",...,"method":"setWidget","widgetKey":"tps-meter","widgetLines":["TPS -- | AVG -- | TTFT --"],"widgetPlacement":"belowEditor"}
```

Send commands on stdin, for example `{"type":"prompt","message":"..."}`. See pi's `docs/rpc.md`. In RPC mode, `footer` and `right` show up as `setWidget` with `"widgetPlacement":"belowEditor"`.

### CI

`.github/workflows/ci.yml` runs on every push and pull request to `main`:

- `npm test` on Node 22 (the `engines` floor) and Node 24.
- The type check, against the latest pi.

## 9. When pi releases a new version

Footer mode relies on pi internals that are not a public contract. Check these after a pi update:

1. **CI's type check.** It installs the latest pi, so a red type check is the first warning.
2. **What `FooterComponent` reads from its session.**
   - It must still be exported from `@earendil-works/pi-coding-agent`.
   - It must read only members that `SessionView` provides.
   - pi assigns `this.session.sessionManager` and `this.session.state` to local variables before using them, so grep for all three:

   ```bash
   npm install
   F=node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js
   grep -nE 'this\.session\.[A-Za-z_.]+|sessionManager\.[A-Za-z_]+\(|state\.[A-Za-z_]+' "$F"
   ```

   Update `SessionView`, its construction in `extensions/index.ts`, and the `SAFETY` comment, which names the pi version it was checked against.
3. **The real TUI.**
   - Run `scripts/tui-snapshot.py` with the new pi.
   - Footer mode must not show the `footer mode unavailable` notice.
   - Every footer line except the directory line must match pi's own footer. Compare with `/tps off`.
4. **If wrapping can no longer work.** The fallback keeps users safe for now. Release a fix, or make `right` the default until there is one.

Requiring a newer pi is a breaking change for users on older versions, so it needs a major version. Update the README requirements line and the `pi ≥` badge in the same change.

## 10. Releasing

A GitHub Release triggers the publish. GitHub Actions then publishes to npm through [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so no npm token is stored anywhere and every version carries signed provenance.

### Versioning

The project follows [Semantic Versioning](https://semver.org/):

| Bump | For |
|---|---|
| Patch (1.0.x) | Bug fixes, performance, documentation that ships in the package |
| Minor (1.x.0) | New modes, options or features. A changed default, as long as the old behaviour stays available |
| Major (x.0.0) | Removed or renamed modes, commands or config keys. A higher minimum pi or Node version |

### Steps

1. **Start clean.** Be on `main` with a clean working tree, everything pushed, and CI green.
2. **Bump `version`** in `package.json`.
3. **Add the CHANGELOG entry** at the top of `CHANGELOG.md`:
   - The heading format is exactly `## [X.Y.Z] - YYYY-MM-DD`.
   - Write the bullets for users. pi shows these entries to users after `pi update`.
4. **Update the README** if users can see the change: commands, config, defaults or screenshots.
5. **Verify locally.**

   ```bash
   npm test && npm run typecheck
   npm pack --dry-run
   ```

   The package must contain exactly 10 files: `CHANGELOG.md`, `LICENSE`, `README.md`, `extensions/index.ts`, `package.json` and the five files in `src/`. For changes to rendering or event handling, also run `scripts/tui-snapshot.py`.
6. **Commit and push, then wait for CI.**

   ```bash
   git add package.json CHANGELOG.md   # plus the other changed files, by name
   git commit -m "chore: release vX.Y.Z"
   git push origin main
   gh run watch "$(gh run list --workflow ci.yml --commit "$(git rev-parse HEAD)" --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
   ```

7. **Create the GitHub Release.** This step publishes.

   ```bash
   awk -v v="X.Y.Z" 'index($0, "## [" v "]") == 1 {p = 1; next} /^## \[/ {p = 0} p' CHANGELOG.md > /tmp/notes.md
   gh release create vX.Y.Z --target main --title "vX.Y.Z" --notes-file /tmp/notes.md
   ```

   The tag must be exactly `v` followed by the `package.json` version. The workflow refuses a mismatch. `--target` takes `main` or a full SHA, never a short one.
8. **Watch the Publish workflow.**

   ```bash
   gh run watch "$(gh run list --workflow publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
   ```

   The log ends with `+ @jack-yang/pi-tps-meter@X.Y.Z` and `Signed provenance statement`.
9. **Wait until npm serves the version.** This takes a few minutes. Repeat until the version prints:

   ```bash
   npm view @jack-yang/pi-tps-meter@X.Y.Z version --cache "$(mktemp -d)"
   ```

10. **Check the registry entry.** It should be published by GitHub Actions, built from the expected commit, with provenance:

    ```bash
    curl -s https://registry.npmjs.org/@jack-yang%2fpi-tps-meter/X.Y.Z \
      | jq '{version, by: ._npmUser.name, commit: .gitHead, provenance: .dist.attestations.provenance.predicateType}'
    ```

11. **Update your own pi.** Refresh the npm cache first, then update, then run `/reload` in any running session:

    ```bash
    npm view @jack-yang/pi-tps-meter version --prefer-online
    pi update npm:@jack-yang/pi-tps-meter
    ```

### How publishing is wired

**The workflow.** `.github/workflows/publish.yml` runs when a release is published. In order, it:

1. Runs the tests.
2. Prints the npm version. OIDC needs npm ≥ 11.5.1, which Node 24 ships.
3. Checks that the tag matches the package version.
4. Skips a version that is already on npm, so re-running a failed release is safe.
5. Runs `npm publish`.

**The trust binding.** npm binds the package to the repository `yangwudong/pi-tps-meter` and the workflow file `publish.yml`.

- Renaming the workflow file breaks publishing until the binding is replaced, and so does moving or renaming the repository.
- To replace the binding, run the commands below in a terminal. They need npm ≥ 11.15, an account with 2FA, and your one-time password. The registry allows one binding per package, so the old one goes first:

  ```bash
  npm trust list @jack-yang/pi-tps-meter
  npm trust revoke @jack-yang/pi-tps-meter --id <id>
  npm trust github @jack-yang/pi-tps-meter --repo <owner>/<repo> --file publish.yml --allow-publish
  ```

**`package.json` fields that must stay.**

- `repository.url` must keep matching the GitHub repository, or provenance verification fails.
- `publishConfig.access` must stay `public`, because the package is scoped.

**Never publish by hand.** The account requires 2FA for writes, so a manual `npm publish` needs an interactive terminal and skips provenance. If it is ever unavoidable, publish from a clean checkout of the tagged commit. The workflow then skips that version.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Publish fails with `release tag … does not match package.json version` | The version was not bumped, or the tag is wrong. Delete the release and its tag, fix the version, and release again |
| Publish fails with `ENEEDAUTH`, or a 404 on the upload | The trust binding is missing or no longer matches (workflow file or repository renamed). Replace the binding as described above |
| `gh release create` fails with HTTP 422 "tag_name is not a valid tag" | `--target` was a short SHA. Use `main` or the full SHA |
| `ETARGET` / "No matching version found" right after publishing | npm is still propagating the version. Wait a few minutes |
| `pi update` installs the previous version | Your local npm cache is stale. Run `npm view … --prefer-online`, then update again |
| The CI type check fails without a code change | A new pi changed its types. See [When pi releases a new version](#9-when-pi-releases-a-new-version) |

## 11. Documentation

- **`README.md`** (Chinese) is the user documentation and ships in the npm package, where it becomes the npmjs.com page.
  - Images use absolute `https://raw.githubusercontent.com/yangwudong/pi-tps-meter/main/docs/…` URLs, so they render on npm too.
  - A README change reaches npm only with the next release.
- **`docs/*.png`**: never delete or rename a screenshot, because the READMEs of already-published versions link to these files. Add new files instead.
  - A plain screenshot of a real terminal is fine.
  - `pi.image` in `package.json` is the preview image in the [pi package gallery](https://pi.dev/packages).
- **`CHANGELOG.md`** gets one entry per release. See [Releasing](#steps).
- **`CONTRIBUTING.md`** (this file) is updated in the same change as any rule, trap or step it describes.
