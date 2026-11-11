const { run } = require('./runningroot');

const STEP_MS = 60;
const CATCH_DISTANCE = 24;

async function play(root) {
    let searchAngle = 0;
    let searchRadiusMs = 300;
    while (root.isActive()) {
        const state = root.perceive();
        const player = state.entities.player;
        const chickens = ['chicken1', 'chicken2'].map(name => state.entities[name]);
        if (chickens.every(chicken => chicken?.caught)) {
            console.log('Chicken1 and Chicken2 caught.');
            return;
        }

        let targets = state.targets;
        if (targets === null) {
            targets = Number.isFinite(player?.x) && Number.isFinite(player?.y)
                ? chickens.filter(chicken => chicken && !chicken.caught
                    && Number.isFinite(chicken.x) && Number.isFinite(chicken.y))
                    .map(chicken => ({
                        distance: Math.hypot(chicken.x - player.x, chicken.y - player.y),
                        direction: Math.atan2(chicken.y - player.y, chicken.x - player.x)
                            * 180 / Math.PI
                    }))
                : [];
        } else {
            targets = targets.filter(target => target
                && (target.type === 'chicken' || /^chicken/i.test(target.name || ''))
                && !target.caught && !target.isCaught && !target.captured
                && Number.isFinite(target.direction)
                && Number.isFinite(target.distance) && target.distance >= 0);
        }

        const target = targets.reduce((nearest, candidate) =>
            !nearest || candidate.distance < nearest.distance ? candidate : nearest, null);
        const angle = target ? target.direction * Math.PI / 180 : searchAngle;
        // Godot bearings use positive Y down; eight headings approximate a circle.
        const heading = Math.round(angle / (Math.PI / 4));
        const dx = Math.round(Math.cos(heading * Math.PI / 4));
        const dy = Math.round(Math.sin(heading * Math.PI / 4));
        const actions = [];
        if (dx) actions.push(dx < 0 ? 'left' : 'right');
        if (dy) actions.push(dy < 0 ? 'up' : 'down');
        // Catch during the approach so a separate movement pulse cannot overshoot.
        if (target && target.distance <= CATCH_DISTANCE) actions.push('catch');
        await root.action(actions, STEP_MS);

        if (!target) {
            const angleStep = STEP_MS / searchRadiusMs;
            searchAngle = (searchAngle + angleStep) % (2 * Math.PI);
            searchRadiusMs += 180 * angleStep / (2 * Math.PI);
        }
        if (!root.perceive().completed) await root.wait(STEP_MS);
    }
}

async function main() {
    await run(play);
}

module.exports = { play, main };

if (require.main === module) {
    main().catch(error => {
        console.error('[player]', error);
        process.exitCode = 1;
    });
}
