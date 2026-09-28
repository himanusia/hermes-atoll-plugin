<div align="center">
  <img src="assets/hermes-atoll-thumbnail.jpg" width="800" alt="Monochrome Roman engraving of Hermes above a subtle notch-shaped status indicator" />
  <h1>Hermes Atoll</h1>
  <p>A native Hermes Agent plugin that brings session and turn status to Atoll on macOS.</p>
</div>

Hermes Atoll reads Hermes' local state database and presents a compact monitor in Atoll's notch UI. It does not modify the database or send transcript contents to a remote service.

## What it does

- Shows active turns, sessions that need attention, and recent session details.
- Keeps the completion status compact and does not request a completion sneak peek.
- Uses stable Atoll resource IDs and a single monitor process, so refreshes update the existing display instead of creating duplicates.
- Watches SQLite and WAL changes with `fswatch`, then falls back to periodic refreshes if `fswatch` is unavailable.
- Does not expose transcript bodies or tool arguments.

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
