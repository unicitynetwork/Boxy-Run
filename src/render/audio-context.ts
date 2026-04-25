/**
 * Shared AudioContext singleton with iOS unlock.
 *
 * iOS Safari rules:
 * 1. AudioContext must be created OR resumed in a non-passive user gesture
 * 2. A buffer must be played in that same gesture call stack
 * 3. touchend works more reliably than touchstart on iOS
 */

let ctx: AudioContext | null = null;
let unlocked = false;
let listenersAttached = false;
const gestureCallbacks: (() => void)[] = [];

/** Register a callback to fire on the next user gesture. */
export function onNextGesture(cb: () => void): void {
	gestureCallbacks.push(cb);
}

function debugAudio(msg: string): void {
	console.log('[audio] ' + msg);
}

export function getSharedAudioContext(): AudioContext | null {
	// Don't create here — only in gesture handler (unlockAudio)
	if (!ctx) return null;
	return ctx;
}

export function isAudioReady(): boolean {
	return ctx !== null && ctx.state === 'running';
}

/**
 * Must be called from a user gesture handler.
 * Creates context, resumes it, plays silent buffer.
 */
export function unlockAudio(): void {
	if (unlocked && ctx && ctx.state === 'running') return;

	if (!ctx) {
		try {
			const Ctor = window.AudioContext || (window as any).webkitAudioContext;
			if (!Ctor) { debugAudio('no AudioContext'); return; }
			ctx = new Ctor();
			debugAudio('ctx created: ' + ctx.state);
		} catch (e) { debugAudio('ctx error: ' + e); return; }
	}

	if (ctx.state === 'suspended') {
		debugAudio('resuming suspended ctx');
		try { ctx.resume(); } catch (e) { debugAudio('resume error: ' + e); }
	}

	try {
		const buf = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
		const src = ctx.createBufferSource();
		src.buffer = buf;
		src.connect(ctx.destination);
		src.start(0);
		debugAudio('silent buf played, state=' + ctx.state);
	} catch (e) { debugAudio('unlock error: ' + e); }

	setTimeout(() => {
		if (ctx) debugAudio('after 200ms: state=' + ctx.state);
	}, 200);

	unlocked = true;
}

/**
 * Attach unlock listeners. Call once at startup.
 * Uses touchend (most reliable on iOS), click, and keydown.
 * Listeners are non-passive and use capture phase.
 */
export function attachUnlockListeners(): void {
	if (listenersAttached) return;
	listenersAttached = true;

	let unlockCount = 0;
	const removeAll = () => {
		document.removeEventListener('touchend', handler, true);
		document.removeEventListener('touchstart', handler, true);
		document.removeEventListener('click', handler, true);
		document.removeEventListener('keydown', handler, true);
	};
	const handler = (e: Event) => {
		debugAudio('gesture: ' + e.type);
		unlockAudio();
		// Trigger deferred music playback if pending (Safari workaround)
		for (const cb of gestureCallbacks) { try { cb(); } catch {} }
		unlockCount++;
		// Remove after context is running, OR after 10 attempts (failsafe)
		if ((ctx && ctx.state === 'running') || unlockCount >= 10) {
			removeAll();
		}
	};

	// touchend is more reliable than touchstart on iOS for audio unlock
	// { capture: true } ensures we fire before game handlers
	// Not using { passive: true } — must be active for gesture recognition
	document.addEventListener('touchend', handler, true);
	document.addEventListener('touchstart', handler, true);
	document.addEventListener('click', handler, true);
	document.addEventListener('keydown', handler, true);
}

// Auto-attach on module load
attachUnlockListeners();
