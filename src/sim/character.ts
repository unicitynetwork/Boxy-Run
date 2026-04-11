/**
 * Character physics — jump arc, lane switching, running bob. Pure
 * mutation of CharacterState given the current tick and game config.
 * Limb rotations (head, arms, legs) are NOT computed here — they are
 * cosmetic and derived by the renderer from the same state.
 *
 * The jump and bob formulas are ported verbatim from the Phase-0
 * game.js Character.update() to preserve the feel exactly. Constants
 * (±20 bob amplitude, 2×stepFreq bob frequency) match the original.
 */

import type { GameConfig, GameState } from './state';
import { TICK_HZ, TICK_SECONDS } from './state';
import { sinusoid } from './math';

/**
 * Advance the character by one tick. Consumes at most one queued action
 * per tick (matching the original single-action-per-frame behaviour),
 * then updates either jump physics or running/lane-switch state.
 */
export function updateCharacter(state: GameState, config: GameConfig): void {
	const char = state.character;
	const currentTick = state.tick;
	const currentTime = currentTick / TICK_HZ;

	// Consume one queued action if the character is idle. A character
	// mid-jump or mid-lane-switch ignores queued actions until the
	// current motion completes.
	if (
		!char.isJumping &&
		!char.isSwitchingLeft &&
		!char.isSwitchingRight &&
		char.queuedActions.length > 0
	) {
		const action = char.queuedActions.shift();
		switch (action) {
			case 'up':
				char.isJumping = true;
				char.jumpStartTick = currentTick;
				break;
			case 'left':
				if (char.currentLane !== -1) {
					char.isSwitchingLeft = true;
				}
				break;
			case 'right':
				if (char.currentLane !== 1) {
					char.isSwitchingRight = true;
				}
				break;
		}
	}

	if (char.isJumping) {
		// Jump arc: half-sine peak of height jumpHeight, superimposed on
		// a running bob frozen at the instant the jump began. The bob
		// term is what makes the jump feel like it starts from the
		// character's current running bob position rather than popping
		// to y=0.
		const jumpStartSec = char.jumpStartTick / TICK_HZ;
		const runningStartSec = char.runningStartTick / TICK_HZ;
		const jumpClock = currentTime - jumpStartSec;
		char.y =
			config.jumpHeight *
				Math.sin((1 / config.jumpDuration) * Math.PI * jumpClock) +
			sinusoid(
				2 * config.characterStepFreq,
				0,
				20,
				0,
				jumpStartSec - runningStartSec,
			);
		if (jumpClock > config.jumpDuration) {
			char.isJumping = false;
			// Advance the running clock by the jump duration (rounded to
			// an integer tick) so the running-bob sinusoid picks up
			// where it left off when the jump started.
			char.runningStartTick += Math.round(config.jumpDuration * TICK_HZ);
		}
	} else {
		// Running bob on y.
		const runningClock = currentTime - char.runningStartTick / TICK_HZ;
		char.y = sinusoid(2 * config.characterStepFreq, 0, 20, 0, runningClock);

		// Lane switching. Either direction moves the character at a
		// fixed per-tick step until it reaches the target lane's x,
		// then snaps to exact position and clears the switching flag.
		const laneSwitchPerTick = config.laneSwitchSpeed * TICK_SECONDS;
		if (char.isSwitchingLeft) {
			char.x -= laneSwitchPerTick;
			const targetX = (char.currentLane - 1) * config.laneWidth;
			if (char.x <= targetX) {
				char.currentLane = (char.currentLane - 1) as -1 | 0 | 1;
				char.x = char.currentLane * config.laneWidth;
				char.isSwitchingLeft = false;
			}
		}
		if (char.isSwitchingRight) {
			char.x += laneSwitchPerTick;
			const targetX = (char.currentLane + 1) * config.laneWidth;
			if (char.x >= targetX) {
				char.currentLane = (char.currentLane + 1) as -1 | 0 | 1;
				char.x = char.currentLane * config.laneWidth;
				char.isSwitchingRight = false;
			}
		}
	}
}
