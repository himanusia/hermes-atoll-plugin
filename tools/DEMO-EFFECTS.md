# Manual Atoll effect demos

Run from the plugin repository. Requires Atoll's loopback RPC on port 9020.

```sh
node tools/demo-effects.js all --seconds 6
node tools/demo-effects.js start --seconds 10
node tools/demo-effects.js running-1 --seconds 10
node tools/demo-effects.js running-12 --seconds 10
node tools/demo-effects.js needs-action --seconds 10
node tools/demo-effects.js complete --seconds 10
node tools/demo-effects.js idle --seconds 6
node tools/demo-effects.js hidden --seconds 6
node tools/demo-effects.js all --dry-run
```

The fixtures are synthetic and display-only. They never read or write Hermes session data. The command pauses an existing plugin host, dismisses its own monitor activity, shows a separate `hermes.monitor.debug-demo` activity, removes that demo, then restores the host in `finally`. Normal completion and caught errors restore monitoring. Force-killing the process bypasses cleanup; if necessary, dismiss the demo with the same SDK identity and relaunch `host.js`. Do not run concurrent demos. Each capture is cropped to the native notch only; expanded-panel behavior is captured separately by `tools/capture-expanded-demo.js`.

## Screenshot mode

Supply the current, already-authorized CuaDriver daemon socket. Do not hardcode a historical socket or start another permission session.

```sh
node tools/demo-effects.js all --seconds 6 \
  --capture-dir /Users/mac/.hermes/cache/scratch/atoll-effect-demo \
  --socket /path/to/current-cua-driver.sock
```

Outputs one PNG per state and a `manifest.json` carrying timestamps and an explicit synthetic source label. Only the centered native notch silhouette is retained (570 × 86); menu-bar icons, wallpaper, and unrelated desktop content are discarded. Screenshots are captured about 1.1 seconds after presentation. They demonstrate a state, not animation smoothness. A start request can be clipped by the native inline preview width; the demo deliberately makes that visible.

The scenarios cover start preview, single-digit running, two-digit running, needs-action, completion preview, zero/idle, and retraction. They do not drive the expanded Hermes panel, Spotify playback, or real session event detection.
