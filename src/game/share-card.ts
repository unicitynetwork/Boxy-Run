/**
 * Generate a shareable score card image using Canvas.
 * Returns a PNG blob suitable for Web Share API or download.
 */

const W = 600;
const H = 400;

export async function generateShareCard(opts: {
	score: number;
	coins: number;
	isDaily: boolean;
	playerName?: string;
}): Promise<Blob> {
	// Wait for fonts
	await document.fonts.ready;

	const canvas = document.createElement('canvas');
	canvas.width = W;
	canvas.height = H;
	const ctx = canvas.getContext('2d')!;

	// Background gradient
	const grad = ctx.createLinearGradient(0, 0, 0, H);
	grad.addColorStop(0, '#060a12');
	grad.addColorStop(1, '#0a1628');
	ctx.fillStyle = grad;
	ctx.fillRect(0, 0, W, H);

	// Subtle grid lines
	ctx.strokeStyle = 'rgba(0, 229, 255, 0.04)';
	ctx.lineWidth = 1;
	for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
	for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

	// Border
	ctx.strokeStyle = 'rgba(95, 234, 255, 0.3)';
	ctx.lineWidth = 2;
	ctx.strokeRect(2, 2, W - 4, H - 4);

	// Game title
	ctx.textAlign = 'center';
	ctx.font = '800 28px Orbitron, monospace';
	ctx.fillStyle = '#5feaff';
	ctx.shadowColor = 'rgba(95, 234, 255, 0.5)';
	ctx.shadowBlur = 20;
	ctx.fillText('BOXY RUN', W / 2, 55);
	ctx.shadowBlur = 0;

	// Daily badge
	let y = 90;
	if (opts.isDaily) {
		ctx.font = '700 11px Orbitron, monospace';
		ctx.fillStyle = '#ff9534';
		ctx.fillText('DAILY CHALLENGE', W / 2, y);
		y += 25;
	}

	// Player name
	if (opts.playerName) {
		ctx.font = '500 14px "IBM Plex Mono", monospace';
		ctx.fillStyle = '#94a3b8';
		ctx.fillText(opts.playerName, W / 2, y);
		y += 30;
	} else {
		y += 15;
	}

	// Score
	ctx.font = '900 56px Orbitron, monospace';
	ctx.fillStyle = '#ffffff';
	ctx.shadowColor = 'rgba(95, 234, 255, 0.3)';
	ctx.shadowBlur = 15;
	ctx.fillText(opts.score.toLocaleString(), W / 2, y + 50);
	ctx.shadowBlur = 0;

	// "SCORE" label
	ctx.font = '600 11px Orbitron, monospace';
	ctx.fillStyle = '#5feaff';
	ctx.fillText('SCORE', W / 2, y + 70);

	// Coins
	if (opts.coins > 0) {
		ctx.font = '500 16px "IBM Plex Mono", monospace';
		ctx.fillStyle = '#ffd700';
		ctx.fillText(`${opts.coins} coins`, W / 2, y + 100);
	}

	// Challenge text
	ctx.font = '400 15px "IBM Plex Mono", monospace';
	ctx.fillStyle = '#cbd5e1';
	ctx.fillText('Can you beat my score?', W / 2, H - 70);

	// URL
	ctx.font = '600 12px Orbitron, monospace';
	ctx.fillStyle = '#5feaff';
	ctx.fillText('boxy-run.fly.dev', W / 2, H - 40);

	// Date
	ctx.font = '400 10px "IBM Plex Mono", monospace';
	ctx.fillStyle = '#475569';
	ctx.fillText(new Date().toLocaleDateString(), W - 60, H - 12);

	return new Promise((resolve) => {
		canvas.toBlob((blob) => resolve(blob!), 'image/png');
	});
}

export async function shareOrDownload(blob: Blob, score: number): Promise<void> {
	if (navigator.share) {
		try {
			const file = new File([blob], 'boxy-run-score.png', { type: 'image/png' });
			const shareData = {
				files: [file],
				title: 'Boxy Run Score',
				text: `I scored ${score.toLocaleString()} in Boxy Run! Can you beat it? https://boxy-run.fly.dev`,
			};
			if (navigator.canShare?.(shareData)) {
				await navigator.share(shareData);
				return;
			}
		} catch {}
	}
	// Desktop fallback: download
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = 'boxy-run-score.png';
	a.click();
	URL.revokeObjectURL(url);
}
