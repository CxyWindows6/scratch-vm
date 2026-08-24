// Due to the existence of features such as interpolation and "0 FPS" being treated as "screen refresh rate",
// The VM loop logic has become much more complex

// tw: Maximum number of _step() calls per scheduler callback (spiral-of-death guard).
// At a 4ms setInterval (250Hz), MAX_STEPS_PER_FRAME=1000 caps effective rate at 250000 steps/s,
// while preventing runaway accumulation when a single _step() takes longer than stepTime.
const MAX_STEPS_PER_FRAME = 1000;

let rendererDrawProfilerId = -1;

const _requestAnimationFrame = typeof requestAnimationFrame === 'function' ?
    requestAnimationFrame : (f => setTimeout(f, 1000 / 60));
const _cancelAnimationFrame = typeof requestAnimationFrame === 'function' ?
    cancelAnimationFrame : clearTimeout;

const taskWrapper = (callback, requestFn, cancelFn, autoRepeat) => {
    let id;
    let cancelled = false;
    const handle = () => {
        if (autoRepeat) id = requestFn(handle);
        callback();
    };
    const cancel = () => {
        if (!cancelled) {
            cancelFn(id);
            cancelled = true;
        }
    };
    id = requestFn(handle);
    return { cancel };
};

class FrameLoop {
    constructor (runtime) {
        this.runtime = runtime;
        this.running = false;
        this._framerate = 30;
        this.opsPerFrame = 1;
        this.interpolation = false;
        this._lastRenderTime = 0;
        this._lastStepTime = 0;
        this._accumulator = 0;
        this._stepInterval = null;
        this._renderInterval = null;
    }

    get framerate () {
        return this._framerate;
    }

    set framerate (val) {
        this._framerate = val;
    }

    now () {
        return (performance || Date).now();
    }

    setFramerate (fps) {
        this.framerate = fps;
        this._restart();
    }

    setOpsPerFrame (opf) {
        this.opsPerFrame = opf;
        this._restart();
    }

    setInterpolation (interpolation) {
        this.interpolation = interpolation;
        this._restart();
    }

    stepCallback () {
        const now = this.now();
        const stepTime = this.framerate === 0 ? 0 : 1000 / this.framerate;
        let stepsToRun;
        if (stepTime === 0) {
            // 0 FPS: track screen refresh rate, 1 step per callback (multiplied by opsPerFrame)
            stepsToRun = this.opsPerFrame;
        } else {
            // tw: time-driven accumulator. stepTime = 1000/framerate (e.g. 9876 FPS -> 0.101ms).
            // setInterval is clamped by the browser to ~4ms (250 callbacks/s), so each callback
            // runs multiple steps to reach the target rate: 250 * 40 ~= 10000 steps/s ~= 9876 FPS.
            this._accumulator += now - this._lastStepTime;
            const baseSteps = Math.floor(this._accumulator / stepTime);
            const opsPerFrame = this.opsPerFrame;
            stepsToRun = baseSteps * opsPerFrame;
            if (stepsToRun > MAX_STEPS_PER_FRAME) {
                // Spiral-of-death guard: clamp accumulated work to a safe ceiling.
                stepsToRun = MAX_STEPS_PER_FRAME;
                this._accumulator = (stepsToRun / opsPerFrame) * stepTime;
            } else {
                this._accumulator -= baseSteps * stepTime;
            }
        }
        this._lastStepTime = now;
        for (let i = 0; i < stepsToRun; i++) {
            this.runtime._step();
        }
    }

    renderCallback () {
        if (!this.runtime.renderer) return;
        const renderTime = this.now();
        if (this.interpolation && this.framerate !== 0) {
            if (typeof document !== 'undefined' && !document.hidden) {
                this.runtime._renderInterpolatedPositions();
            }
            this.runtime.screenRefreshTime = renderTime - this._lastRenderTime;
            this._lastRenderTime = renderTime;
            this.runtime.flushFrameEvents();
        } else if (
            this.framerate === 0 ||
            renderTime - this._lastRenderTime >= this.runtime.currentStepTime
        ) {
            if (this.runtime.profiler !== null) {
                if (rendererDrawProfilerId === -1) {
                    rendererDrawProfilerId = this.runtime.profiler.idByName('RenderWebGL.draw');
                }
                this.runtime.profiler.start(rendererDrawProfilerId);
            }
            if (typeof document !== 'undefined' && !document.hidden) {
                this.runtime.renderer.draw();
            }
            if (this.runtime.profiler !== null) {
                this.runtime.profiler.stop();
            }
            this.runtime.screenRefreshTime = renderTime - this._lastRenderTime;
            this._lastRenderTime = renderTime;
            if (this.framerate === 0) {
                this.runtime.currentStepTime = this.runtime.screenRefreshTime;
            }
            this.runtime.flushFrameEvents();
        }
    }

    _restart () {
        if (this.running) {
            this.stop();
            this.start();
        }
    }

    start () {
        this.running = true;
        // tw: reset accumulator state so the first scheduled tick doesn't compute a huge
        // elapsed time (since _lastStepTime was last set) and run a burst of catch-up steps.
        const now = this.now();
        this._lastStepTime = now;
        this._lastRenderTime = now;
        this._accumulator = 0;
        if (this.framerate === 0) {
            this._stepInterval = this._renderInterval = taskWrapper(
                (() => {
                    this.stepCallback();
                    this.renderCallback();
                }),
                _requestAnimationFrame,
                _cancelAnimationFrame,
                true
            );
            this.runtime.currentStepTime = 0;
        } else {
            // tw: Renderer always runs on its own RAF loop (independent of step scheduling),
            // so rendering is never throttled by step load and vice versa.
            this._renderInterval = taskWrapper(
                this.renderCallback.bind(this),
                _requestAnimationFrame,
                _cancelAnimationFrame,
                true
            );
            // tw: Step scheduling uses setInterval. Browsers clamp setInterval to ~4ms (250/s)
            // per HTML spec, so for framerate > 250 the accumulator inside stepCallback() runs
            // multiple _step() calls per callback to reach the target rate
            // (e.g. 9876 FPS = 250 callbacks/s * ~40 steps = ~10000 steps/s).
            // This avoids MessageChannel/setImmediate polyfills which Chrome throttles under load.
            // Use Math.max(4, ...) so we never pass a sub-4ms interval; the browser would clamp
            // it anyway, and an explicit 4ms makes the 250Hz ceiling predictable.
            this._stepInterval = taskWrapper(
                this.stepCallback.bind(this),
                fn => setInterval(fn, Math.max(4, 1000 / this.framerate)),
                clearInterval,
                false
            );
            this.runtime.currentStepTime = 1000 / this.framerate;
        }
    }

    stop () {
        this.running = false;
        if (this._stepInterval) {
            this._stepInterval.cancel();
            this._stepInterval = null;
        }
        if (this._renderInterval) {
            this._renderInterval.cancel();
            this._renderInterval = null;
        }
    }
}

module.exports = FrameLoop;
