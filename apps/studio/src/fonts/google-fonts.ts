import type { FontAtlas } from "@/fonts/types";
import { SYSTEM_FONTS } from "@/fonts/system-fonts";

// Keep the Classic call contract, but let CSS resolve local font families.
// An empty atlas makes the existing picker use its system-font text previews.
// These are CSS family choices, not an enumeration of installed font files;
// unavailable families use the browser's normal fallback.
let cachedAtlas: FontAtlas = { fonts: {} };

export function getLocalFontNames(): string[] {
	return [...SYSTEM_FONTS].sort();
}

export function getCachedFontAtlas(): FontAtlas | null {
	return cachedAtlas;
}

export function clearFontAtlasCache(): void {
	cachedAtlas = { fonts: {} };
}

export async function loadFontAtlas(): Promise<FontAtlas | null> {
	return cachedAtlas;
}

export async function loadFullFont(_options: {
	family: string;
	weights?: number[];
}): Promise<void> {
	// Do not install font faces or wait for FontFaceSet: opening an imported
	// project must also work when its original font family is unavailable.
}

export async function loadFonts(_options: {
	families: string[];
}): Promise<void> {
	// Rendering selects local CSS fonts or fallback without a loading step.
}
