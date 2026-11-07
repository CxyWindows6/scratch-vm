const {test} = require('node:test');
const assert = require('node:assert');
const path = require('path');
const readFileToBuffer = require('../fixtures/readProjectFile').readFileToBuffer;
const VirtualMachine = require('../../src/virtual-machine');
const Runtime = require('../../src/engine/runtime');
const MonitorRecord = require('../../src/engine/monitor-record');

test('spec', () => {
    const r = new Runtime();

    assert.strictEqual(typeof Runtime, 'function');
    assert.strictEqual(typeof r, 'object');

    // Test types of cloud data managing functions
    assert.strictEqual(typeof r.hasCloudData, 'function');
    assert.strictEqual(typeof r.canAddCloudVariable, 'function');
    assert.strictEqual(typeof r.addCloudVariable, 'function');
    assert.strictEqual(typeof r.removeCloudVariable, 'function');

    assert.ok(r instanceof Runtime);
});

test('monitorStateEquals', () => {
    const r = new Runtime();
    const id = 'xklj4#!';
    const prevMonitorState = new MonitorRecord({
        id,
        opcode: 'turtle whereabouts',
        value: '25'
    });
    const newMonitorDelta = {
        id,
        value: String(25)
    };
    r.requestAddMonitor(prevMonitorState);
    r.requestUpdateMonitor(newMonitorDelta);

    assert.strictEqual(true, prevMonitorState === r._monitorState.get(id));
    assert.strictEqual(String(25), r._monitorState.get(id).get('value'));
});

test('monitorStateDoesNotEqual', () => {
    const r = new Runtime();
    const id = 'xklj4#!';
    const params = {seven: 7};
    const prevMonitorState = new MonitorRecord({
        id,
        opcode: 'turtle whereabouts',
        value: '25'
    });

    // Value change
    let newMonitorDelta = {
        id,
        value: String(24)
    };
    r.requestAddMonitor(prevMonitorState);
    r.requestUpdateMonitor(newMonitorDelta);

    assert.strictEqual(true, r._monitorState.dirty);
    assert.strictEqual(String(24), r._monitorState.get(id).get('value'));

    // Prop change
    r._monitorState.dirty = false;
    newMonitorDelta = {
        id: 'xklj4#!',
        params: params
    };
    r.requestUpdateMonitor(newMonitorDelta);

    assert.strictEqual(true, r._monitorState.dirty);
    assert.strictEqual(String(24), r._monitorState.get(id).value);
    assert.strictEqual(params, r._monitorState.get(id).params);
});

test('getLabelForOpcode', () => {
    const r = new Runtime();

    const fakeExtension = {
        id: 'fakeExtension',
        name: 'Fake Extension',
        blocks: [
            {
                info: {
                    opcode: 'foo',
                    json: {},
                    text: 'Foo',
                    xml: ''
                }
            },
            {
                info: {
                    opcode: 'foo_2',
                    json: {},
                    text: 'Foo 2',
                    xml: ''
                }
            }
        ]
    };

    r._blockInfo.push(fakeExtension);

    const result1 = r.getLabelForOpcode('fakeExtension_foo');
    assert.strictEqual(typeof result1.category, 'string');
    assert.strictEqual(typeof result1.label, 'string');
    assert.strictEqual(result1.label, 'Fake Extension: Foo');

    const result2 = r.getLabelForOpcode('fakeExtension_foo_2');
    assert.strictEqual(typeof result2.category, 'string');
    assert.strictEqual(typeof result2.label, 'string');
    assert.strictEqual(result2.label, 'Fake Extension: Foo 2');
});

test('Project loaded emits runtime event', async () => {
    const vm = new VirtualMachine();
    const projectUri = path.resolve(__dirname, '../fixtures/default.sb2');
    const project = readFileToBuffer(projectUri);
    let projectLoaded = false;

    vm.runtime.addListener('PROJECT_LOADED', () => {
        projectLoaded = true;
    });

    await vm.loadProject(project);
    assert.strictEqual(projectLoaded, true, 'Project load event emitted');
});

test('Cloud variable limit allows only 10 cloud variables', () => {
    // This is a test of just the cloud variable limit mechanism
    // The functions being tested below need to be used when
    // creating and deleting cloud variables in the runtime.

    const rt = new Runtime();

    assert.strictEqual(rt.hasCloudData(), false);

    for (let i = 0; i < 10; i++) {
        assert.strictEqual(rt.canAddCloudVariable(), true);
        rt.addCloudVariable();
        // Adding a cloud variable should change the
        // result of the hasCloudData check
        assert.strictEqual(rt.hasCloudData(), true);
    }


    // We should be at the cloud variable limit now
    assert.strictEqual(rt.canAddCloudVariable(), false);

    // Removing a cloud variable should allow the addition of exactly one more
    // when we are at the cloud variable limit
    rt.removeCloudVariable();

    assert.strictEqual(rt.canAddCloudVariable(), true);
    rt.addCloudVariable();
    assert.strictEqual(rt.canAddCloudVariable(), false);

    // Disposing of the runtime should reset the cloud variable limitations
    rt.dispose();
    assert.strictEqual(rt.hasCloudData(), false);

    for (let i = 0; i < 10; i++) {
        assert.strictEqual(rt.canAddCloudVariable(), true);
        rt.addCloudVariable();
        assert.strictEqual(rt.hasCloudData(), true);
    }

    // We should be at the cloud variable limit now
    assert.strictEqual(rt.canAddCloudVariable(), false);

});

test('Starting the runtime emits an event', () => {
    let started = false;
    const rt = new Runtime();
    rt.addListener('RUNTIME_STARTED', () => {
        started = true;
    });
    rt.start();
    assert.strictEqual(started, true);
    rt.quit();
});

test('Runtime cannot be started while already running', () => {
    const rt = new Runtime();
    rt.start(); // Start the first time

    // Set up a flag/listener to check if it can be started again
    let started = false;
    rt.addListener('RUNTIME_STARTED', () => {
        started = true;
    });

    // Starting again should not emit another event
    rt.start();
    assert.strictEqual(started, false);
    rt.quit();
});

test('setCompatibilityMode restarts if it was already running', () => {
    const rt = new Runtime();
    rt.start(); // Start the first time

    // Set up a flag/listener to check if it gets started again
    let started = false;
    rt.addListener('RUNTIME_STARTED', () => {
        started = true;
    });

    rt.setCompatibilityMode(true);
    // TW: We make an intentional API change here. Changing compatibility mode won't emit a RUNTIME_STARTED
    // if the runtime is already running.
    assert.strictEqual(started, false);
    rt.quit();
});

test('setCompatibilityMode does not restart if it was not running', () => {
    const rt = new Runtime();

    let started = false;
    rt.addListener('RUNTIME_STARTED', () => {
        started = true;
    });

    rt.setCompatibilityMode(true);
    assert.strictEqual(started, false);
});

test('Disposing the runtime emits an event', () => {
    let disposed = false;
    const rt = new Runtime();
    rt.addListener('RUNTIME_DISPOSED', () => {
        disposed = true;
    });
    rt.dispose();
    assert.strictEqual(disposed, true);
});

test('Clock is reset on runtime dispose', () => {
    const rt = new Runtime();
    const c = rt.ioDevices.clock;
    let simulatedTime = 0;

    c._projectTimer = {
        timeElapsed: () => simulatedTime,
        start: () => {
            simulatedTime = 0;
        }
    };

    assert.ok(c.projectTimer() === 0);
    simulatedTime += 1000;
    assert.ok(c.projectTimer() === 1);
    rt.dispose();
    // When the runtime is disposed, the clock should be reset
    assert.ok(c.projectTimer() === 0);
});

/**
 * Build a mock target that is just complete enough to survive Runtime.dispose().
 * dispose() calls stopAll() first, which emits PROJECT_STOP_ALL; the looks,
 * sound and sensing block packages handle that event and read target custom
 * state plus target.sprite.soundBank, so a bare {dispose()} stub would throw
 * before the target list was ever touched.
 * @param {object} options Options for the mock.
 * @param {string} options.id Id of the mock target.
 * @param {boolean} [options.isStage] Whether the mock is the stage.
 * @param {boolean} [options.isOriginal] Whether the mock is an original target.
 * @returns {object} The mock target, with a disposeCalls counter.
 */
const makeMockTarget = ({id, isStage = false, isOriginal = true}) => {
    const customState = Object.create(null);
    const target = {
        id,
        isStage,
        isOriginal,
        disposeCalls: 0,
        onTargetVisualChange: null,
        sprite: {
            name: id,
            soundBank: null,
            sounds: [],
            costumes: []
        },
        getCustomState: key => customState[key],
        setCustomState: (key, value) => {
            customState[key] = value;
        },
        onStopAll: () => {},
        deleteMonitors: () => {},
        dispose: () => {
            target.disposeCalls++;
        }
    };
    return target;
};

test('Disposing the runtime disposes every target exactly once', () => {
    // Regression test: Runtime.dispose() used to iterate this.targets with
    // map() while disposeTarget() spliced the same array in place, so every
    // other target was skipped (N=5 left [1, 3] behind).
    const counts = [1, 2, 5, 6, 10];
    for (let c = 0; c < counts.length; c++) {
        const n = counts[c];
        const rt = new Runtime();
        const targets = [];
        for (let i = 0; i < n; i++) {
            targets.push(makeMockTarget({id: `target${i}`}));
        }
        rt.targets = targets.slice();
        rt.executableTargets = targets.slice();

        assert.doesNotThrow(() => rt.dispose());
        assert.strictEqual(rt.targets.length, 0, `all ${n} targets removed from runtime.targets`);
        for (let i = 0; i < n; i++) {
            assert.strictEqual(targets[i].disposeCalls, 1, `target ${i} of ${n} disposed exactly once`);
        }
    }
});

test('Disposing the runtime clears the cached stage target', () => {
    const rt = new Runtime();
    const stage = makeMockTarget({id: 'stage', isStage: true});
    const sprite = makeMockTarget({id: 'sprite'});
    rt.targets = [sprite, stage];
    rt.executableTargets = [sprite, stage];
    assert.strictEqual(rt.getTargetForStage(), stage, 'stage target is cached');

    assert.doesNotThrow(() => rt.dispose());
    assert.strictEqual(rt.targets.length, 0, 'all targets removed');
    assert.strictEqual(rt._stageTarget, null, 'cached stage target was cleared');
    assert.strictEqual(stage.disposeCalls, 1, 'stage target disposed exactly once');
    assert.strictEqual(sprite.disposeCalls, 1, 'sprite target disposed exactly once');
});

test('disposeTarget clears the cached stage target even when it is not in runtime.targets', () => {
    const rt = new Runtime();
    const stage = makeMockTarget({id: 'stage', isStage: true});
    rt._stageTarget = stage;

    rt.disposeTarget(stage);

    assert.strictEqual(rt._stageTarget, null, 'cached stage target was cleared');
    assert.strictEqual(stage.disposeCalls, 0, 'a target that is not tracked is not disposed');
});
