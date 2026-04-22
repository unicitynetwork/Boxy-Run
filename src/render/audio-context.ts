/**
 * Shared AudioContext singleton. Both SFX (audio.ts) and music
 * (ambient-music.ts) use the same context to avoid browser limits.
 */

let ctx: AudioContext | null = null;

export function getSharedAudioContext(): AudioContext | null {
	if (!ctx) {
		try {
			ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
		} catch { return null; }
	}
	if (ctx.state === 'suspended') ctx.resume();
	return ctx;
}
