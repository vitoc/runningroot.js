const { firefox, chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');

const PLAYER_NAME = (process.env.PLAYER_NAME || 'player').toLowerCase();
const CATCH_KEY = process.env.CATCH_KEY || 'x';
const SLIDE_KEY = process.env.SLIDE_KEY || 'z';

/**
 * Attach perception and controls to a Playwright page.
 * perceive() returns an isolated snapshot; perceive(callback) streams JSON log
 * updates and returns an unsubscribe function. Targets include all visible types.
 * action(name | names[], durationMs) holds simultaneous controls, then releases
 * them. Controls: up, left, down, right, catch, slide. Catch defaults to x and
 * slide to z; CATCH_KEY, SLIDE_KEY and PLAYER_NAME override game bindings/names.
 * Call dispose() to detach listeners when the session ends.
 */
function createRunningRoot(page, browser) {
    const entities = new Map();
    const subscribers = new Set();
    let targets = null;
    let facing = null;
    let lineOfSight = null;
    let level = null;
    let status = null;
    let completed = false;

    function readState(value, label = '') {
        if (!value || typeof value !== 'object') return;

        if (value.level !== undefined) level = value.level;
        if (value.status !== undefined) status = value.status;
        if (value.level === 1 && value.status === 'completed') {
            completed = true;
            return;
        }
        if (Array.isArray(value.targets)) targets = value.targets;
        if (value.facing !== undefined) facing = value.facing;
        if (value.line_of_sight !== undefined) lineOfSight = value.line_of_sight;

        const name = String(value.name ?? value.id ?? value.type ?? label).toLowerCase();
        const key = /^chicken[ _-]?1$/.test(name) ? 'chicken1'
            : /^chicken[ _-]?2$/.test(name) ? 'chicken2'
            : [PLAYER_NAME, 'player', 'catcher', 'self'].includes(name) ? 'player' : null;

        if (key) {
            const previous = entities.get(key) || {};
            const position = value.position ?? value.pos ?? value.location ?? value;
            const x = position.x ?? position[0];
            const y = position.y ?? position[1];
            const caught = value.caught ?? value.isCaught ?? value.captured;
            entities.set(key, {
                ...previous,
                ...(Number.isFinite(x) && Number.isFinite(y) ? { x, y } : {}),
                ...(typeof caught === 'boolean' ? { caught } : {})
            });
        }

        for (const [childLabel, child] of Object.entries(value)) {
            if (child && typeof child === 'object') readState(child, childLabel);
        }
    }

    function snapshot() {
        return structuredClone({
            facing,
            line_of_sight: lineOfSight,
            targets,
            level,
            status,
            completed,
            entities: Object.fromEntries(entities)
        });
    }

    function perceive(callback) {
        if (callback === undefined) return snapshot();
        if (typeof callback !== 'function') {
            throw new TypeError('Perception subscriber must be a function');
        }
        subscribers.add(callback);
        return () => subscribers.delete(callback);
    }

    function onConsole(message) {
        console.log(`[browser:${message.type()}] ${message.text()}`);
        let state;
        try {
            state = JSON.parse(message.text());
        } catch {
            return; // Ignore non-JSON output.
        }
        if (!state || typeof state !== 'object') return;
        readState(state);
        for (const subscriber of subscribers) subscriber(snapshot());
    }

    function onPageError(error) {
        console.error('[browser:uncaught]', error);
    }

    function isActive() {
        return !completed && browser.isConnected() && !page.isClosed();
    }

    async function action(actions, duration = 60) {
        const bindings = {
            up: 'ArrowUp',
            left: 'ArrowLeft',
            down: 'ArrowDown',
            right: 'ArrowRight',
            catch: CATCH_KEY,
            slide: SLIDE_KEY
        };
        const requested = Array.isArray(actions) ? actions : [actions];
        const keys = requested.map(name => {
            if (!Object.hasOwn(bindings, name)) {
                throw new RangeError(`Unknown action: ${name}`);
            }
            return bindings[name];
        });
        if (!Number.isFinite(duration) || duration < 0) {
            throw new RangeError('Action duration must be a non-negative number');
        }

        const held = [];
        try {
            for (const key of new Set(keys)) {
                if (!isActive()) break;
                await page.keyboard.down(key);
                held.push(key);
            }
            if (isActive()) await page.waitForTimeout(duration);
        } finally {
            for (const key of held.reverse()) {
                if (!page.isClosed()) await page.keyboard.up(key);
            }
        }
    }

    page.on('console', onConsole);
    page.on('pageerror', onPageError);

    return {
        perceive,
        action,
        isActive,
        wait: duration => page.waitForTimeout(duration),
        dispose() {
            page.off('console', onConsole);
            page.off('pageerror', onPageError);
            subscribers.clear();
        }
    };
}

/**
 * Launch the game and call strategy(root) after navigation. Owns the browser,
 * perception listeners and recordings/session-* video and trace.zip lifecycle,
 * including cleanup on completion or failure. options.browser selects edge
 * (default), firefox, or chrome. Edge and Chrome use installed browser channels.
 */
async function run(strategy, { browser: browserName = 'edge' } = {}) {
    if (typeof strategy !== 'function') {
        throw new TypeError('Strategy must be a function');
    }
    if (!['firefox', 'edge', 'chrome'].includes(browserName)) {
        throw new RangeError('Browser must be firefox, edge, or chrome');
    }
    const recordingsRoot = path.join(__dirname, 'recordings');
    await fs.mkdir(recordingsRoot, { recursive: true });
    const recordingDir = await fs.mkdtemp(path.join(recordingsRoot, 'session-'));
    console.log(`[recording] ${recordingDir}`);
    const browser = browserName === 'firefox'
        ? await firefox.launch({ headless: false })
        : await chromium.launch({
            headless: false,
            channel: browserName === 'edge' ? 'msedge' : 'chrome'
        });

    let context;
    let tracingStarted = false;
    let page;
    let root;
    try {
        context = await browser.newContext({ recordVideo: { dir: recordingDir } });
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        tracingStarted = true;
        page = await context.newPage();
        root = createRunningRoot(page, browser);
        const completion = new Promise(resolve => {
            root.perceive(state => {
                if (state.completed) resolve();
            });
        });

        // Race startup and strategy so completion also shuts down during navigation.
        await Promise.race([
            completion,
            (async () => {
                await page.goto('https://chinvito.github.io/misairu/', { waitUntil: 'networkidle' });
                if (root.perceive().completed) return;
                await page.bringToFront();
                await strategy(root);
            })()
        ]);
    } catch (error) {
        if (browser.isConnected() && !page?.isClosed()) throw error;
    } finally {
        if (root) root.dispose();
        try {
            if (tracingStarted) {
                await context.tracing.stop({ path: path.join(recordingDir, 'trace.zip') });
            }
        } finally {
            try {
                // Closing the context flushes the video files to disk.
                if (context) await context.close();
            } finally {
                await browser.close();
            }
        }
    }
}

module.exports = { createRunningRoot, run };
