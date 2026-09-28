<div align="center">
  <img src="assets/hermes-atoll-thumbnail.png" width="800" alt="Roman-style engraving of Hermes with a subtle laptop notch motif" />
  <h1>Hermes Atoll</h1>
  <p>A local macOS extension for Hermes session and turn status in Atoll.</p>
</div>

Hermes Atoll connects the Hermes state database to Atoll's notch interface. It runs locally, reads `~/.hermes/state.db` without modifying it, and never sends transcript contents to a remote service.

## Features

- Shows active turns, sessions that need attention, and recent session details.
- Keeps the completion notice compact (`Complete`) and does not auto-expand the notch.
- Uses one persistent dashboard and one transient live activity with stable IDs. Refreshes update those resources instead of adding duplicates; the transient activity is retracted when there is nothing active to show.
- Watches SQLite/WAL changes with `fswatch` and falls back to periodic refreshes if it is unavailable.
- Leaves Atoll's native tabs untouched and does not expose transcript bodies or tool arguments.

## Requirements

- macOS with [Atoll](https://atoll.app/) installed and its local extension API enabled.
- Node.js 22.5 or newer (`node:sqlite` is used by the monitor).
- Hermes with its state database at `~/.hermes/state.db`. Set `HERMES_HOME` in the LaunchAgent if the database is stored elsewhere.
- Homebrew `fswatch` is recommended for fast updates. The monitor still works with its periodic refresh if `fswatch` is missing.

Atoll must be running and the extension bundle identifier `dev.hima.notch-plugins` must be authorized when prompted.

## Install

Install Node.js if needed, then run:

```sh
brew install fswatch
git clone https://github.com/himanusia/hermes-atoll-extension.git "$HOME/.hermes/notch"
cd "$HOME/.hermes/notch"
npm ci
```

Install the LaunchAgent. This creates a user-specific plist from the checked-in template so it works with your Node and home-directory paths:

```sh
NODE_BINARY="$(command -v node)"
NOTCH_HOME="$HOME/.hermes/notch"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.hermes/logs/notch"
sed \
  -e "s|__NODE_BINARY__|$NODE_BINARY|g" \
  -e "s|__NOTCH_HOME__|$NOTCH_HOME|g" \
  launchd/com.hima.hermes-notch.plist \
  > "$HOME/Library/LaunchAgents/com.hima.hermes-notch.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.hima.hermes-notch.plist"
```

Open Atoll and approve the extension if asked. The host retries its connection while Atoll is closed. To inspect its log:

```sh
tail -f "$HOME/.hermes/logs/notch/launchd.log"
```

To update an existing installation after pulling changes:

```sh
cd "$HOME/.hermes/notch"
git pull --ff-only
npm ci
launchctl kickstart -k "gui/$(id -u)/com.hima.hermes-notch"
```

To uninstall the LaunchAgent:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.hima.hermes-notch.plist"
rm "$HOME/Library/LaunchAgents/com.hima.hermes-notch.plist"
```

## Development

```sh
npm ci
npm test
```

The tests cover rendering, state transitions, host lifecycle, and SQLite/WAL watching. The LaunchAgent template is `launchd/com.hima.hermes-notch.plist`; replace its `__NODE_BINARY__` and `__NOTCH_HOME__` placeholders before loading it.

## Repository thumbnail

The original monochrome Hermes engraving is in `assets/hermes-atoll-thumbnail.png` and is shown above. To use it as GitHub's social-preview image, open the repository's **Settings → General → Social preview** and upload that file.

## License

ISC. See [LICENSE](LICENSE).
