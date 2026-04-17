/**
 * In-game chat panel — fixed bottom-right, with quick messages.
 */

export function createChatPanel(opts: {
	onSend: (text: string) => void;
	playerName: string;
}): {
	addMessage: (from: string, text: string, isMe: boolean) => void;
} {
	const panel = document.createElement('div');
	panel.id = 'game-chat';
	panel.style.cssText =
		'position:fixed;bottom:16px;right:16px;z-index:150;width:280px;' +
		'background:rgba(0,0,0,0.75);border:1px solid rgba(255,255,255,0.1);' +
		'border-radius:8px;font-family:monospace;font-size:12px;' +
		'backdrop-filter:blur(8px);display:flex;flex-direction:column;';
	panel.innerHTML =
		'<div id="game-chat-messages" style="height:120px;overflow-y:auto;padding:8px 10px;color:#ccc"></div>' +
		'<div style="display:flex;border-top:1px solid rgba(255,255,255,0.1)">' +
		'<input id="game-chat-input" type="text" maxlength="200" placeholder="Chat..." style="flex:1;padding:8px 10px;background:transparent;border:none;color:#fff;font-family:monospace;font-size:12px;outline:none">' +
		'<button id="game-chat-send" style="padding:8px 12px;background:transparent;border:none;border-left:1px solid rgba(255,255,255,0.1);color:#00e5ff;font-size:10px;font-weight:bold;cursor:pointer">SEND</button>' +
		'</div>';

	const quickBar = document.createElement('div');
	quickBar.style.cssText = 'display:flex;gap:4px;padding:6px 8px;border-top:1px solid rgba(255,255,255,0.1);flex-wrap:wrap;';
	['GG', 'Nice!', 'GL', '😂'].forEach(text => {
		const btn = document.createElement('button');
		btn.textContent = text;
		btn.style.cssText = 'padding:3px 8px;background:rgba(255,255,255,0.1);border:none;border-radius:4px;color:#aaa;font-size:11px;cursor:pointer;font-family:monospace;';
		btn.addEventListener('click', () => opts.onSend(text));
		quickBar.appendChild(btn);
	});
	panel.appendChild(quickBar);
	document.body.appendChild(panel);

	const input = document.getElementById('game-chat-input')!;
	const sendBtn = document.getElementById('game-chat-send')!;
	function doSend() {
		const text = (input as HTMLInputElement).value.trim();
		if (text) { opts.onSend(text); (input as HTMLInputElement).value = ''; }
	}
	sendBtn.addEventListener('click', doSend);
	input.addEventListener('keydown', (e) => {
		e.stopPropagation();
		if (e.key === 'Enter') doSend();
	});
	input.addEventListener('keyup', (e) => e.stopPropagation());

	function addMessage(from: string, text: string, isMe: boolean) {
		const el = document.getElementById('game-chat-messages');
		if (!el) return;
		const div = document.createElement('div');
		div.style.marginBottom = '3px';
		const color = isMe ? '#00e5ff' : '#f97316';
		div.innerHTML = `<span style="color:${color};font-weight:bold">${from.replace(/</g, '&lt;')}</span> ${text.replace(/</g, '&lt;')}`;
		el.appendChild(div);
		el.scrollTop = el.scrollHeight;
	}

	return { addMessage };
}
