/**
 * Time abstraction for the server.
 *
 * In production `now()` is just `Date.now()`. In tests with TEST_MODE=1,
 * a test endpoint can bump an offset so predicate checks like
 * "is elapsed > 30s?" become fast-forwardable.
 *
 * Crucially, this abstraction only helps with TIMESTAMP COMPARISONS.
 * setTimeout/setInterval still use real wall-clock time. The reliability
 * refactor's reconciliation tick replaces setTimeouts with state-based
 * checks against now(), which IS fast-forwardable.
 */

let offsetMs = 0;

/** Monotonic-ish wall time in ms, with an optional test-mode offset. */
export function now(): number {
	return Date.now() + offsetMs;
}

/** Test-only: advance the clock by `ms`. Throws if not in TEST_MODE. */
export function advanceClock(ms: number): void {
	if (process.env.TEST_MODE !== '1') {
		throw new Error('advanceClock() is only available in TEST_MODE');
	}
	offsetMs += ms;
}

/** Test-only: reset offset to zero. */
export function resetClock(): void {
	if (process.env.TEST_MODE !== '1') {
		throw new Error('resetClock() is only available in TEST_MODE');
	}
	offsetMs = 0;
}

/** For telemetry / debugging. */
export function getClockOffset(): number {
	return offsetMs;
}
