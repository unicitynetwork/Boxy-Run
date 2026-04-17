/**
 * Full-screen character selector overlay. Shows a grid of skin
 * options; clicking one invokes the callback and removes the overlay.
 */

import { SKINS, type CharacterSkin } from '../render/skins';

export function showSkinSelector(onSelect: (skin: CharacterSkin) => void): void {
	const overlay = document.createElement('div');
	overlay.id = 'skin-selector';
	overlay.style.cssText =
		'position:fixed;inset:0;z-index:200;' +
		'background:rgba(0,0,0,0.85);' +
		'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
		'font-family:monospace;color:#e2e8f0;';

	const title = document.createElement('div');
	title.style.cssText =
		'font-size:24px;font-weight:bold;margin-bottom:8px;letter-spacing:0.1em;';
	title.textContent = 'CHOOSE YOUR RUNNER';
	overlay.appendChild(title);

	const sub = document.createElement('div');
	sub.style.cssText = 'font-size:13px;color:#64748b;margin-bottom:32px;';
	sub.textContent = 'Each coin collected adds 250 to your score';
	overlay.appendChild(sub);

	const grid = document.createElement('div');
	grid.style.cssText =
		'display:grid;grid-template-columns:repeat(4,1fr);gap:16px;' +
		'max-width:560px;width:90%;';

	for (const skin of SKINS) {
		grid.appendChild(buildSkinCard(skin, () => {
			overlay.remove();
			onSelect(skin);
		}));
	}

	overlay.appendChild(grid);
	document.body.appendChild(overlay);
}

function buildSkinCard(skin: CharacterSkin, onClick: () => void): HTMLButtonElement {
	const card = document.createElement('button');
	const hex = '#' + skin.preview.toString(16).padStart(6, '0');
	const skinHex = '#' + skin.colors.skin.toString(16).padStart(6, '0');
	const hairHex = '#' + skin.colors.hair.toString(16).padStart(6, '0');
	const shortsHex = '#' + skin.colors.shorts.toString(16).padStart(6, '0');

	card.style.cssText =
		'background:rgba(255,255,255,0.05);border:2px solid rgba(255,255,255,0.1);' +
		'border-radius:8px;padding:16px 8px;cursor:pointer;' +
		'display:flex;flex-direction:column;align-items:center;gap:10px;' +
		'transition:all 0.2s;color:#e2e8f0;font-family:monospace;';

	// Character preview — a simple figure: head, torso (shirt), shorts, legs
	const figure = document.createElement('div');
	figure.style.cssText = 'width:40px;height:60px;position:relative;';

	const head = document.createElement('div');
	head.style.cssText =
		`width:20px;height:20px;background:${skinHex};` +
		`border-radius:4px;margin:0 auto;position:relative;` +
		`border-top:4px solid ${hairHex};`;
	figure.appendChild(head);

	const torso = document.createElement('div');
	torso.style.cssText =
		`width:28px;height:22px;background:${hex};` +
		'border-radius:3px;margin:2px auto 0;';
	figure.appendChild(torso);

	const shorts = document.createElement('div');
	shorts.style.cssText =
		`width:28px;height:10px;background:${shortsHex};` +
		'border-radius:0 0 3px 3px;margin:1px auto 0;';
	figure.appendChild(shorts);

	const legs = document.createElement('div');
	legs.style.cssText =
		`width:20px;height:12px;margin:1px auto 0;` +
		`display:flex;gap:4px;justify-content:center;`;
	const legL = document.createElement('div');
	legL.style.cssText = `width:6px;height:12px;background:${skinHex};border-radius:2px;`;
	const legR = legL.cloneNode(true) as HTMLElement;
	legs.appendChild(legL);
	legs.appendChild(legR);
	figure.appendChild(legs);

	card.appendChild(figure);

	const label = document.createElement('div');
	label.style.cssText = 'font-size:11px;font-weight:600;letter-spacing:0.1em;';
	label.textContent = skin.name.toUpperCase();
	card.appendChild(label);

	card.addEventListener('mouseenter', () => {
		card.style.borderColor = hex;
		card.style.background = 'rgba(255,255,255,0.1)';
		card.style.transform = 'translateY(-2px)';
	});
	card.addEventListener('mouseleave', () => {
		card.style.borderColor = 'rgba(255,255,255,0.1)';
		card.style.background = 'rgba(255,255,255,0.05)';
		card.style.transform = 'translateY(0)';
	});
	card.addEventListener('click', onClick);

	return card;
}
