/**
 * Procedural sound effects using Web Audio API. No external files needed.
 * All sounds are synthesized on the fly. Muted by default until first
 * user interaction (browser autoplay policy).
 */

import { getSharedAudioContext } from './audio-context';

let muted = false;
let initialized = false;
let resumed = false;

function getCtx(): AudioContext | null {
	return getSharedAudioContext();
}

/** Call from any user gesture to ensure audio works */
export function resumeAudio(): void {
	if (resumed) return;
	const c = getCtx();
	if (c && c.state !== 'suspended') resumed = true;
}

export function initAudio(): void {
	if (initialized) return;
	initialized = true;

	// Try to create AudioContext immediately (may be suspended)
	getCtx();

	// Resume on any user interaction
	function onGesture() {
		resumeAudio();
		if (resumed) {
			document.removeEventListener('keydown', onGesture, true);
			document.removeEventListener('click', onGesture, true);
			document.removeEventListener('touchstart', onGesture, true);
		}
	}
	// Use capture phase so we fire before game handlers
	document.addEventListener('keydown', onGesture, true);
	document.addEventListener('click', onGesture, true);
	document.addEventListener('touchstart', onGesture, true);

	// Create the toggle button
	let btn = document.getElementById('sound-toggle');
	if (!btn) {
		btn = document.createElement('button');
		btn.id = 'sound-toggle';
		document.body.appendChild(btn);
	}
	updateToggle(btn);
	btn.addEventListener('click', () => {
		muted = !muted;
		updateToggle(btn!);
	});
}

function updateToggle(btn: HTMLElement) {
	btn.innerHTML = muted
		? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
		: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
}

function play(fn: (ctx: AudioContext, t: number) => void) {
	if (muted) return;
	const c = getCtx();
	if (!c) return;
	fn(c, c.currentTime);
}

/** Coin collect — bright ping, pitch varies by tier */
export function playCoinCollect(tier: 'gold' | 'blue' | 'red' = 'gold') {
	const freq = tier === 'red' ? 1200 : tier === 'blue' ? 900 : 660;
	const dur = tier === 'red' ? 0.3 : tier === 'blue' ? 0.25 : 0.15;
	play((c, t) => {
		const osc = c.createOscillator();
		const gain = c.createGain();
		osc.type = 'sine';
		osc.frequency.setValueAtTime(freq, t);
		osc.frequency.exponentialRampToValueAtTime(freq * 1.5, t + dur * 0.3);
		gain.gain.setValueAtTime(0.15, t);
		gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
		osc.connect(gain).connect(c.destination);
		osc.start(t);
		osc.stop(t + dur);
		// Second harmonic for richer sound
		if (tier !== 'gold') {
			const osc2 = c.createOscillator();
			const gain2 = c.createGain();
			osc2.type = 'triangle';
			osc2.frequency.setValueAtTime(freq * 2, t);
			gain2.gain.setValueAtTime(0.06, t);
			gain2.gain.exponentialRampToValueAtTime(0.001, t + dur);
			osc2.connect(gain2).connect(c.destination);
			osc2.start(t);
			osc2.stop(t + dur);
		}
	});
}

/** Jump — short whoosh */
export function playJump() {
	play((c, t) => {
		const osc = c.createOscillator();
		const gain = c.createGain();
		osc.type = 'sine';
		osc.frequency.setValueAtTime(200, t);
		osc.frequency.exponentialRampToValueAtTime(600, t + 0.15);
		gain.gain.setValueAtTime(0.08, t);
		gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
		osc.connect(gain).connect(c.destination);
		osc.start(t);
		osc.stop(t + 0.2);
	});
}

/** Lane switch — quick swipe */
export function playLaneSwitch() {
	play((c, t) => {
		const osc = c.createOscillator();
		const gain = c.createGain();
		osc.type = 'square';
		osc.frequency.setValueAtTime(300, t);
		osc.frequency.exponentialRampToValueAtTime(150, t + 0.08);
		gain.gain.setValueAtTime(0.04, t);
		gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
		osc.connect(gain).connect(c.destination);
		osc.start(t);
		osc.stop(t + 0.1);
	});
}

/** Crash — low thud + noise burst */
export function playCrash() {
	play((c, t) => {
		// Thud
		const osc = c.createOscillator();
		const gain = c.createGain();
		osc.type = 'sine';
		osc.frequency.setValueAtTime(120, t);
		osc.frequency.exponentialRampToValueAtTime(40, t + 0.3);
		gain.gain.setValueAtTime(0.3, t);
		gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
		osc.connect(gain).connect(c.destination);
		osc.start(t);
		osc.stop(t + 0.4);

		// Noise burst
		const bufSize = c.sampleRate * 0.2;
		const buf = c.createBuffer(1, bufSize, c.sampleRate);
		const data = buf.getChannelData(0);
		for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
		const noise = c.createBufferSource();
		noise.buffer = buf;
		const noiseGain = c.createGain();
		noiseGain.gain.setValueAtTime(0.15, t);
		noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
		noise.connect(noiseGain).connect(c.destination);
		noise.start(t);
	});
}

/** Flamethrower pickup — ascending chime */
export function playPowerupCollect() {
	play((c, t) => {
		const notes = [440, 554, 659, 880];
		notes.forEach((freq, i) => {
			const osc = c.createOscillator();
			const gain = c.createGain();
			osc.type = 'triangle';
			osc.frequency.setValueAtTime(freq, t + i * 0.08);
			gain.gain.setValueAtTime(0.12, t + i * 0.08);
			gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.08 + 0.2);
			osc.connect(gain).connect(c.destination);
			osc.start(t + i * 0.08);
			osc.stop(t + i * 0.08 + 0.2);
		});
	});
}

/** Flamethrower activate — roaring fire */
export function playFlameActivate() {
	play((c, t) => {
		// Filtered noise for fire roar
		const bufSize = c.sampleRate * 0.6;
		const buf = c.createBuffer(1, bufSize, c.sampleRate);
		const data = buf.getChannelData(0);
		for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
		const noise = c.createBufferSource();
		noise.buffer = buf;
		const filter = c.createBiquadFilter();
		filter.type = 'bandpass';
		filter.frequency.setValueAtTime(800, t);
		filter.frequency.exponentialRampToValueAtTime(200, t + 0.5);
		filter.Q.setValueAtTime(2, t);
		const gain = c.createGain();
		gain.gain.setValueAtTime(0.2, t);
		gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
		noise.connect(filter).connect(gain).connect(c.destination);
		noise.start(t);

		// Low rumble
		const osc = c.createOscillator();
		const oGain = c.createGain();
		osc.type = 'sawtooth';
		osc.frequency.setValueAtTime(80, t);
		oGain.gain.setValueAtTime(0.1, t);
		oGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
		osc.connect(oGain).connect(c.destination);
		osc.start(t);
		osc.stop(t + 0.5);
	});
}

/** Countdown tick beep */
export function playBeep(pitch = 1) {
	play((c, t) => {
		const osc = c.createOscillator();
		const gain = c.createGain();
		osc.type = 'sine';
		osc.frequency.setValueAtTime(600 * pitch, t);
		gain.gain.setValueAtTime(0.15, t);
		gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
		osc.connect(gain).connect(c.destination);
		osc.start(t);
		osc.stop(t + 0.12);
	});
}

/** Game start — short fanfare */
export function playGameStart() {
	play((c, t) => {
		const notes = [523, 659, 784];
		notes.forEach((freq, i) => {
			const osc = c.createOscillator();
			const gain = c.createGain();
			osc.type = 'square';
			osc.frequency.setValueAtTime(freq, t + i * 0.12);
			gain.gain.setValueAtTime(0.08, t + i * 0.12);
			gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.25);
			osc.connect(gain).connect(c.destination);
			osc.start(t + i * 0.12);
			osc.stop(t + i * 0.12 + 0.25);
		});
	});
}

/** Near-miss whoosh — fast wind past */
export function playNearMiss() {
	play((c, t) => {
		const bufSize = c.sampleRate * 0.15;
		const buf = c.createBuffer(1, bufSize, c.sampleRate);
		const data = buf.getChannelData(0);
		for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1);
		const noise = c.createBufferSource();
		noise.buffer = buf;
		const filter = c.createBiquadFilter();
		filter.type = 'bandpass';
		filter.frequency.setValueAtTime(2000, t);
		filter.frequency.exponentialRampToValueAtTime(400, t + 0.12);
		filter.Q.setValueAtTime(5, t);
		const gain = c.createGain();
		gain.gain.setValueAtTime(0.08, t);
		gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
		noise.connect(filter).connect(gain).connect(c.destination);
		noise.start(t);
	});
}

/** Level complete — triumphant arpeggio */
export function playLevelComplete() {
	play((c, t) => {
		const notes = [523, 659, 784, 1047, 1319, 1568];
		notes.forEach((freq, i) => {
			const osc = c.createOscillator();
			const gain = c.createGain();
			osc.type = i < 3 ? 'square' : 'sine';
			osc.frequency.setValueAtTime(freq, t + i * 0.1);
			gain.gain.setValueAtTime(0.1, t + i * 0.1);
			gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.1 + 0.4);
			osc.connect(gain).connect(c.destination);
			osc.start(t + i * 0.1);
			osc.stop(t + i * 0.1 + 0.4);
		});
	});
}
