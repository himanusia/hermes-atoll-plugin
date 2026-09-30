<div align="center">
  <img src="assets/hermes-atoll-thumbnail.jpg" width="800" alt="Monochrome Roman engraving of Hermes above a subtle notch-shaped status indicator" />
  <h1>Hermes Atoll</h1>
  <p>A native Hermes Agent plugin that brings session and turn status to Atoll on macOS.</p>
</div>

Hermes Atoll reads Hermes' local state database in a read-only transaction and presents a compact monitor in Atoll's notch UI. It never writes `state.db` or sends state to a remote service. When a turn starts, the notch may show one bounded, sanitized display-side request preview: text parts only, with obvious secret patterns redacted. It never exposes transcript bodies, tool arguments, provider-only content, or credentials.

## What it does

- Shows active turns, sessions that need attention, and recent session details.
- Shows the actual session title with `Complete` in a brief sneak peek when a turn/session finishes. A confirmed lease release or durable `ended_at` boundary triggers it; a closed notch keeps rendering glyphs only.
- Floors dashboard rewrites at one every 5 s so the tab stays well inside Atoll's per-bundle extension rate limit, then delivers the final state on a deferred wake.
- Uses stable Atoll resource IDs and a single monitor process, so refreshes update the existing display instead of creating duplicates.
- Watches SQLite and WAL changes with `fswatch`, then falls back to periodic refreshes if `fswatch` is unavailable.

## Dummy-data media evidence

The media below was captured from the native Atoll surface with synthetic, display-only fixtures. It contains no real Hermes session titles, requests, transcripts, tool arguments, or desktop windows. The GIF is a timed native recording, not a slideshow; the PNGs are state captures.

<p><img src="assets/demo/hermes-notch-demo.gif" width="570" alt="Timed native Atoll recording of the synthetic one-running-turn notch orbit" /></p>

<p><img src="assets/demo/hermes-expanded-demo.png" width="645" alt="Native expanded Hermes panel with synthetic running, needs-action, and idle sessions" /></p>

| Capability | Evidence |
| --- | --- |
| Start request preview | [`notch-start.png`](assets/demo/notch-start.png) |
| One running turn and orbit | [`notch-running-1.png`](assets/demo/notch-running-1.png), timed [`hermes-notch-demo.gif`](assets/demo/hermes-notch-demo.gif) |
| Twelve running turns / two-digit count | [`notch-running-12.png`](assets/demo/notch-running-12.png) |
| Needs-action marker | [`notch-needs-action.png`](assets/demo/notch-needs-action.png) |
| Completion title, `Complete`, zero, and retraction | [`notch-complete.png`](assets/demo/notch-complete.png), [`notch-idle.png`](assets/demo/notch-idle.png), [`notch-hidden.png`](assets/demo/notch-hidden.png) |
| Expanded multi-session list, selection, details, recent steps, and stats | [`hermes-expanded-demo.png`](assets/demo/hermes-expanded-demo.png) |
| Watcher fallback, pacing, lifecycle, transition detection, and read-only data path | `npm test` and `python3 tools/test-plugin-entrypoint.py` (behavioral evidence; screenshots do not prove these nonvisual paths) |

The capture manifests are [`notch-phases.manifest.json`](assets/demo/notch-phases.manifest.json), [`hermes-notch-demo.manifest.json`](assets/demo/hermes-notch-demo.manifest.json), and [`hermes-expanded-demo.manifest.json`](assets/demo/hermes-expanded-demo.manifest.json). Re-run the native captures with the current, already-running CuaDriver socket (discover it from `ps`; never hardcode an old socket):

```sh
node tools/demo-effects.js all --seconds 6 \
  --capture-dir "$HOME/.hermes/cache/scratch/atoll-effect-demo" \
  --socket "$CUDRIVER_SOCKET"
node tools/record-demo-gif.js --socket "$CUDRIVER_SOCKET"
node tools/capture-expanded-demo.js --socket "$CUDRIVER_SOCKET"
```

## Requirements

- macOS with [Atoll](https://atoll.app/) installed and its local extension API enabled.
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) with its state database at `~/.hermes/state.db`. Set `HERMES_HOME` if your Hermes home is elsewhere.
- Node.js 22.5 or newer. The Hermes installer can install this plugin's pinned Node dependencies in its own plugin directory.
- Homebrew `fswatch` is recommended for faster updates; periodic refresh still works without it.

## Install

Install the plugin from GitHub:

```sh
hermes plugins install himanusia/hermes-atoll-plugin
hermes plugins enable hermes-atoll
```

Accept the installer's separate prompt to install the plugin's Node dependencies. Hermes keeps them in the plugin directory. The monitor starts on the next Hermes session. Start it immediately with:

```sh
hermes atoll start
```

When Atoll prompts for authorization, allow the extension bundle `dev.hima.notch-plugins`.

## Manage the monitor

```sh
hermes atoll status
hermes atoll start
hermes atoll stop
hermes atoll restart
```

`stop` keeps the monitor off until the next Hermes session. Logs are written to `~/.hermes/logs/notch/hermes-atoll.log`.

To remove the plugin:

```sh
hermes atoll stop
hermes plugins remove hermes-atoll
```

## Development

```sh
npm ci
npm test
python3 tools/test-plugin-entrypoint.py
hermes plugins doctor --ci .
```

The Node tests cover rendering, state transitions, host lifecycle, and SQLite/WAL watching. The Python smoke test checks Hermes hook and CLI registration without starting Atoll.

## Repository thumbnail

`assets/hermes-atoll-thumbnail.jpg` is a landscape 1733 × 908 monochrome illustration. It uses a subtle top-edge notch shape to suggest Atoll's Dynamic Island function. To set it as GitHub's social-preview image, upload the JPG from **Settings → General → Social preview**.

## License

ISC. See [LICENSE](LICENSE).
