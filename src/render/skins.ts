/**
 * Named character skin presets. Each defines the four material colors
 * (skin, hair, shirt, shorts) used by createCharacterMesh. Players
 * pick a skin before playing; the opponent is rendered in whichever
 * skin contrasts best (or a fixed "Crimson" fallback).
 */

import { Colors } from './colors';
import type { CharacterColors } from './character-mesh';

export interface CharacterSkin {
	/** Display name in the selector. */
	name: string;
	/** The color values passed to createCharacterMesh. */
	colors: Required<CharacterColors>;
	/** Preview color for the selector card (shirt color). */
	preview: number;
}

export const SKINS: CharacterSkin[] = [
	{
		name: 'Classic',
		colors: { skin: Colors.brown, hair: Colors.black, shirt: Colors.yellow, shorts: Colors.olive },
		preview: Colors.yellow,
	},
	{
		name: 'Crimson',
		colors: { skin: Colors.peach, hair: Colors.black, shirt: Colors.cherry, shorts: 0x1a1a2e },
		preview: Colors.cherry,
	},
	{
		name: 'Ocean',
		colors: { skin: Colors.brown, hair: Colors.black, shirt: Colors.blue, shorts: Colors.white },
		preview: Colors.blue,
	},
	{
		name: 'Shadow',
		colors: { skin: Colors.grey, hair: Colors.black, shirt: 0x1a1a2e, shorts: 0x333333 },
		preview: 0x1a1a2e,
	},
	{
		name: 'Solar',
		colors: { skin: Colors.peach, hair: Colors.brownDark, shirt: 0xf97316, shorts: Colors.yellow },
		preview: 0xf97316,
	},
	{
		name: 'Forest',
		colors: { skin: Colors.brown, hair: Colors.black, shirt: Colors.green, shorts: Colors.brownDark },
		preview: Colors.green,
	},
	{
		name: 'Royal',
		colors: { skin: Colors.peach, hair: Colors.brownDark, shirt: 0x6c3baa, shorts: Colors.olive },
		preview: 0x6c3baa,
	},
	{
		name: 'Ghost',
		colors: { skin: Colors.white, hair: Colors.white, shirt: 0xf0f0f0, shorts: 0xcccccc },
		preview: 0xf0f0f0,
	},
];

/** Find a skin by name (case-insensitive), defaults to Classic. */
export function getSkin(name: string | null): CharacterSkin {
	if (!name) return SKINS[0];
	const lower = name.toLowerCase();
	return SKINS.find((s) => s.name.toLowerCase() === lower) ?? SKINS[0];
}

/**
 * Pick an opponent skin that contrasts with the player's choice.
 * Simple rule: if the player picked Crimson, opponent gets Classic;
 * otherwise opponent gets Crimson.
 */
export function getOpponentSkin(playerSkin: CharacterSkin): CharacterSkin {
	return playerSkin.name === 'Crimson' ? SKINS[0] : SKINS[1];
}
