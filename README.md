# Running Root

`runningroot.js` is a module that allows you to easily create a strategy to play the Running Root game.

The strategy can be created by an agentic coding tool such as GitHub Copilot.

The strategy can also consist of having AI agents playing the game.

The module launches a visible Microsoft Edge (default), Firefox, or Google Chrome window, reads game state and player line of sight from JSON console messages, exposes keyboard actions to your strategy, and saves a video and Playwright trace for each run.

## Setting it up

Clone this repository.

You need Microsoft Edge (or Chrome or Firefox) installed in its standard location, internet access to load the game, and a graphical desktop to display the browser.

From the repository directory:

```powershell
npm ci
npx playwright install ffmpeg
```

The FFmpeg binary is required for video recording. Playwright launches installed Edge using its stable `msedge` channel. 

To use Firefox instead, install Playwright's Firefox binary and select `browser: 'firefox'`:

```powershell
npx playwright install firefox
```

## Run the existing strategy

```powershell
node .\play.js
```

The strategy in [play.js](./play.js) runs in Edge by default, searches for chickens, moves toward them, and attempts to catch them. Running `node .\runningroot.js` alone does not start a session: the module only exports helpers.

## Write a strategy

Create `my-strategy.js` next to `runningroot.js`:

```javascript
const { run } = require('./runningroot');

async function strategy(root) {
    const unsubscribe = root.perceive(state => {
        console.log('Facing:', state.facing, 'Targets:', state.targets);
    });

    try {
        while (root.isActive()) {
            // Replace this simple movement loop with your targeting logic.
            await root.action(['right', 'catch'], 100);
            if (root.isActive()) await root.wait(60);
        }
    } finally {
        unsubscribe();
    }
}

run(strategy).catch(error => {
    console.error('[strategy]', error);
    process.exitCode = 1;
});
```

Run it with:

```powershell
node .\my-strategy.js
```

Always await actions and waits. A strategy that returns immediately ends the session; returning does not leave the browser open.

## API

### `run(strategy, options = {})`

Returns a promise. Creates a recording directory, launches the selected browser in headed mode, attaches the root helper, and navigates to the game using `waitUntil: 'networkidle'`. It then calls your async `strategy(root)`.

Choose a browser with `options.browser`:

```javascript
await run(strategy);                        // Microsoft Edge (default).
await run(strategy, { browser: 'firefox' });
await run(strategy, { browser: 'edge' });    // Installed Microsoft Edge.
await run(strategy, { browser: 'chrome' });  // Installed Google Chrome.
```

Browser names are case-sensitive. Unsupported values reject with `RangeError` before creating recordings or launching a browser. Missing browsers and launch failures reject without falling back to another browser. To use a different browser with the existing strategy:

```powershell
node -e "require('./runningroot').run(require('./play').play, { browser: 'chrome' }).catch(error => { console.error(error); process.exitCode = 1; })"
```

The session ends when:

- The strategy returns or throws.
- The game emits a JSON object with both `level: 1` and `status: 'completed'`.

Completion can end the session even during navigation or while the strategy is still running. This does not cancel the strategy's JavaScript execution, so use `root.isActive()` to guard loops and avoid scheduling more work after completion.

The helper removes its listeners, saves the trace, closes the context to flush videos, and closes the browser. Startup or strategy errors normally reject the promise; errors observed after the browser disconnects or the page closes are suppressed by the run handler. Cleanup errors can still reject the promise.

### `root.perceive()`

Returns an isolated deep-cloned snapshot:

```javascript
{
    facing: null,
    line_of_sight: null,
    targets: null,
    level: null,
    status: null,
    completed: false,
    entities: {}
}
```

These are the initial values before game messages populate the state.

| Field | Meaning |
| --- | --- |
| `facing` | Latest reported facing value. |
| `line_of_sight` | Latest reported line-of-sight value, for example `{ x: -1, y: 0 }`. |
| `targets` | Latest reported target array, including non-chicken targets such as buildings. `null` means no array has been reported; `[]` is a reported empty array. |
| `level`, `status` | Latest reported level and status. |
| `completed` | Becomes `true` when an object reports numeric level `1` and status `'completed'` together. Remains true afterward. |
| `entities` | Accumulated recognized entities, keyed by `player`, `chicken1`, and `chicken2`. Entries may contain `x`, `y`, and `caught`. |

For example, a target from the game can look like:

```json
{ "direction": 298, "distance": 230, "name": "Chicken2", "type": "chicken" }
```

The helper preserves target data as supplied; it does not select a target or compute bearings. The existing strategy interprets `direction` as degrees, with positive Y pointing down.

State comes from browser console messages whose entire text parses as a JSON object or array, not from DOM inspection or screenshots. Nested objects are scanned recursively. Entity names are matched case-insensitively using `name`, then `id`, then `type`, then the enclosing property name:

- `player`, `catcher`, `self`, or the configured `PLAYER_NAME` map to `player`.
- `chicken1` / `chicken2` also accept one space, underscore, or hyphen before the number.
- Positions come from `position`, `pos`, `location`, or the entity object itself, as `{ x, y }` or `[x, y]`. Both coordinates must be finite numbers.
- Catch state accepts boolean `caught`, `isCaught`, or `captured`.

Updates merge into existing entity entries; omitted fields retain their previous values. Treat a snapshot as the latest accumulated observations, not a guaranteed complete or fresh world state.

### `root.perceive(callback)`

Subscribes to subsequent JSON console updates and returns an unsubscribe function:

```javascript
const unsubscribe = root.perceive(state => {
    console.log(state.entities);
});

// Later:
unsubscribe();
```

There is no immediate callback on subscription; call `root.perceive()` for the current snapshot. Each subscriber receives its own clone, including for JSON messages that do not change recognized state. Non-JSON console messages are logged but do not notify subscribers. Use a synchronous callback; callbacks are invoked directly and are not awaited.

### `root.action(nameOrNames, durationMs = 60)`

Returns a promise that presses the requested controls, holds them for the duration in milliseconds, and releases them in reverse order.

| Action | Default key |
| --- | --- |
| `up` | `ArrowUp` |
| `left` | `ArrowLeft` |
| `down` | `ArrowDown` |
| `right` | `ArrowRight` |
| `catch` | `x` |
| `slide` | `z` |

```javascript
await root.action('up');                       // Hold for 60 ms.
await root.action(['up', 'right'], 150);        // Diagonal movement.
await root.action(['left', 'catch'], 100);      // Move and catch together.
await root.action('slide', 80);
```

Keys are pressed sequentially, then held together; duplicate keys within a call are pressed once. An empty array holds no keys but still waits while active. Unknown actions and non-finite or negative durations reject with `RangeError`. Calls made after the session becomes inactive do not press keys or wait.

Await each call before starting another to avoid overlapping key ownership. The duration is a keyboard hold, not a guarantee of movement distance or a successful catch.

### Other root methods

| Method | Behavior |
| --- | --- |
| `isActive()` | Returns true while completion has not been detected, the browser is connected, and the page is open. |
| `wait(durationMs)` | Delegates to Playwright's `page.waitForTimeout`; it does not check whether the session is active. |
| `dispose()` | Removes console/page-error listeners and clears subscribers. Does not close the page or browser. Called automatically by `run`. |

### `createRunningRoot(page, browser)`

Attaches the same root API to an existing Playwright page and browser:

```javascript
const { createRunningRoot } = require('./runningroot');

// page and browser belong to your existing Playwright session.
const root = createRunningRoot(page, browser);
try {
    await page.goto('https://chinvito.github.io/misairu/', {
        waitUntil: 'networkidle'
    });
    await root.action('right', 100);
} finally {
    root.dispose();
}
```

Attach before navigation to capture startup console messages. With this lower-level API, you own navigation, browser/context cleanup, recordings, and reacting to completion. The helper itself does not close the browser.

## Configuration

Set environment variables **before** starting Node.js; their values are read when the module loads:

```powershell
$env:PLAYER_NAME = 'MyPlayer'
$env:CATCH_KEY = 'x'
$env:SLIDE_KEY = 'z'
node .\play.js
```

`PLAYER_NAME` changes the additional name recognized as the player in JSON logs; it does not rename the in-game character. `CATCH_KEY` and `SLIDE_KEY` accept Playwright keyboard key names and must match the game's bindings. Browser selection uses the `run` options above, not an environment variable. The game URL and headed mode are fixed in `run`.

## Recordings and troubleshooting

Each `run` creates `recordings\session-*` beside `runningroot.js` and prints its absolute path with a `[recording]` prefix. A completed cleanup saves video files and `trace.zip` there.

Open a saved trace, substituting your actual session directory:

```powershell
npx playwright show-trace .\recordings\session-ABC123\trace.zip
```

- **Firefox executable missing:** run `npx playwright install firefox`.
- **Edge or Chrome executable missing:** install the selected browser in its standard location. The helper uses Playwright's `msedge` or `chrome` channel and does not fall back to Firefox.
- **FFmpeg executable missing:** run `npx playwright install ffmpeg` to enable video recording.
- **Empty perception:** confirm the game loads and emits JSON console messages. The helper prefixes browser output with `[browser:<type>]` and uncaught page errors with `[browser:uncaught]`. State fields stay unset until reported.
- **Unexpected targets:** filter `targets` by type/name and validate fields before using them; visible buildings are included too. See [play.js](./play.js) for an example.
- **Browser closes immediately:** ensure the strategy awaits its work and keeps running until it intends to exit.
- **No completion detected:** automatic completion requires numeric `level: 1` and `status: 'completed'` on the same JSON object. Other statuses do not end the run automatically; your strategy can return explicitly.