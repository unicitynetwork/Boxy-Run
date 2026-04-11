/**
 * Small deterministic math utilities shared by the sim and the renderer.
 * Pure functions — no state, no side effects.
 */

/**
 * Returns the value of a sinusoid at the given time. Matches the
 * `sinusoid()` helper in the original game.js exactly.
 *
 * @param frequency cycles per second
 * @param minimum   minimum output value
 * @param maximum   maximum output value
 * @param phase     phase offset in degrees
 * @param time      time in seconds
 */
export function sinusoid(
	frequency: number,
	minimum: number,
	maximum: number,
	phase: number,
	time: number,
): number {
	const amplitude = 0.5 * (maximum - minimum);
	const angularFrequency = 2 * Math.PI * frequency;
	const phaseRadians = (phase * Math.PI) / 180;
	const offset = amplitude * Math.sin(angularFrequency * time + phaseRadians);
	const average = (minimum + maximum) / 2;
	return average + offset;
}
