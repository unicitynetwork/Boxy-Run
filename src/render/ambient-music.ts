/**
 * Background music player using real mp3 tracks.
 *
 * Music by PPEAK (Preston Peak) — CC-BY 4.0
 * https://opengameart.org/content/free-action-chiptune-music-pack
 *
 * Robust design:
 * - Retries loading until successful (handles suspended context, network errors)
 * - Shared AudioContext with SFX
 * - Mute persisted to localStorage
 * - Volume controlled by setMusicIntensity() every frame
 * - Idempotent — safe to call repeatedly
 */

import { getSharedAudioContext } from './audio-context';

const GAME_TRACK = '/music/surpass.mp3';

let gainNode: GainNode | null = null;
let sourceNode: AudioBufferSourceNode | null = null;
let audioBuffer: AudioBuffer | null = null;
let playing = false;
let loadAttempts = 0;
let musicMuted = false;
let currentIntensity = 0;

// Restore mute preference
try { musicMuted = localStorage.getItem('boxyrun-music-muted') === '1'; } catch {}

// Preload the mp3 as raw bytes on module load — decoding happens later
// when AudioContext is available. This eliminates the network delay.
let preloadedBytes: ArrayBuffer | null = null;
fetch(GAME_TRACK).then(r => r.ok ? r.arrayBuffer() : null).then(buf => {
	if (buf) preloadedBytes = buf;
}).catch(() => {});

/**
 * Start background music. Idempotent — safe to call every frame.
 * Retries loading if previous attempts failed.
 * Music starts silent; call setMusicIntensity() to bring it up.
 */
export function startAmbientMusic(): void {
	// Already playing — just ensure mute is respected
	if (playing) {
		if (gainNode && musicMuted) gainNode.gain.value = 0;
		return;
	}

	// Already loaded but not playing — start playback
	if (audioBuffer && !playing) {
		startPlayback();
		return;
	}

	// Need to decode — but don't spam attempts
	if (loadAttempts > 0) return;
	loadAttempts++;

	const ctx = getSharedAudioContext();
	if (!ctx || ctx.state === 'suspended') {
		loadAttempts = 0; // retry next frame when context is ready
		return;
	}

	// Use preloaded bytes if available, otherwise fetch
	const bytesPromise = preloadedBytes
		? Promise.resolve(preloadedBytes)
		: fetch(GAME_TRACK).then(r => {
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			return r.arrayBuffer();
		});

	bytesPromise
		.then(buf => ctx.decodeAudioData(buf.slice(0))) // slice: decodeAudioData detaches the buffer
		.then(decoded => {
			audioBuffer = decoded;
			startPlayback();
		})
		.catch(err => {
			console.warn('[music] decode failed, will retry:', err.message);
			setTimeout(() => { loadAttempts = 0; }, 2000);
		});
}

function startPlayback(): void {
	if (!audioBuffer || playing) return;
	const ctx = getSharedAudioContext();
	if (!ctx || ctx.state === 'suspended') return;

	if (!gainNode) {
		gainNode = ctx.createGain();
		gainNode.gain.value = 0;
		gainNode.connect(ctx.destination);
	}

	// Stop any existing source
	if (sourceNode) {
		try { sourceNode.stop(); } catch {}
	}

	sourceNode = ctx.createBufferSource();
	sourceNode.buffer = audioBuffer;
	sourceNode.loop = true;
	sourceNode.connect(gainNode);
	sourceNode.start();
	playing = true;

	// Ensure mute is respected
	if (musicMuted) gainNode.gain.value = 0;
}

/**
 * Set music volume. 0 = silent, 1 = full volume.
 * Call every frame from the game loop.
 */
export function setMusicIntensity(intensity: number): void {
	currentIntensity = intensity;
	if (!gainNode || musicMuted) return;

	const target = intensity <= 0 ? 0 : 0.3 + intensity * 0.4;
	const current = gainNode.gain.value;
	const diff = target - current;
	const rate = diff < 0 ? 0.08 : 0.02;
	gainNode.gain.value = current + diff * rate;
	if (gainNode.gain.value < 0.005) gainNode.gain.value = 0;
}

/** No-op — music persists across games. */
export function stopAmbientMusic(): void {}

export function pauseAmbientMusic(): void {
	if (gainNode) gainNode.gain.value = 0;
}

export function resumeAmbientMusic(): void {
	if (gainNode && !musicMuted) {
		gainNode.gain.value = 0.3 + currentIntensity * 0.4;
	}
}

export function toggleMusicMute(): boolean {
	musicMuted = !musicMuted;
	if (gainNode) {
		gainNode.gain.value = musicMuted ? 0 : (currentIntensity <= 0 ? 0 : 0.3 + currentIntensity * 0.4);
	}
	try { localStorage.setItem('boxyrun-music-muted', musicMuted ? '1' : '0'); } catch {}
	updateMusicToggleUI();
	return musicMuted;
}

export function isMusicMuted(): boolean { return musicMuted; }

export function createMusicToggle(): void {
	let btn = document.getElementById('music-toggle');
	if (!btn) {
		btn = document.createElement('button');
		btn.id = 'music-toggle';
		btn.style.cssText = 'padding:8px 16px;font-size:0.65em;font-weight:500;letter-spacing:0.15em;text-transform:uppercase;background:transparent;border-radius:4px;cursor:pointer;border:1px solid rgba(95,234,255,0.25);color:#8aa0b8;font-family:inherit;';
		btn.addEventListener('click', () => toggleMusicMute());
		const panel = document.querySelector('.panel');
		const btnRow = panel?.querySelector('div[style*="flex"]');
		if (btnRow) btnRow.appendChild(btn);
		else panel?.appendChild(btn);
	}
	updateMusicToggleUI();
}

function updateMusicToggleUI(): void {
	const btn = document.getElementById('music-toggle');
	if (btn) btn.textContent = musicMuted ? '♪ Music Off' : '♪ Music On';
}
