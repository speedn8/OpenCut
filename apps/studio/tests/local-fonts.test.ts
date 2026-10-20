import { describe, expect, test } from "bun:test";
import {
	clearFontAtlasCache,
	getCachedFontAtlas,
	getLocalFontNames,
	loadFontAtlas,
	loadFonts,
	loadFullFont,
} from "../src/fonts/google-fonts";
import { SYSTEM_FONTS } from "../src/fonts/system-fonts";

describe("local font loading", () => {
	test("offers CSS preview families without atlas sprite dependencies", async () => {
		clearFontAtlasCache();
		const names = getLocalFontNames();
		expect(names).toContain("Arial");
		expect(names).toContain("sans-serif");
		expect(names).toContain("serif");
		expect(names).toContain("monospace");
		expect(names.every((name) => SYSTEM_FONTS.has(name))).toBe(true);
		expect(new Set(names).size).toBe(names.length);
		expect(names).toEqual([...names].sort());
		expect(await loadFontAtlas()).toEqual({ fonts: {} });
		expect(getCachedFontAtlas()).not.toBeNull();
	});

	test("opens with unavailable project fonts without any network or DOM font loading", async () => {
		const descriptors = new Map<string, PropertyDescriptor | undefined>();
		let loadingAttempts = 0;
		const failLoading = () => {
			loadingAttempts++;
			throw new Error("Font loading is unavailable offline");
		};
		const blockedDocument = new Proxy({}, { get: failLoading });
		const blockedGlobals = {
			fetch: failLoading,
			document: blockedDocument,
			Image: failLoading,
			FontFace: failLoading,
		};

		try {
			for (const [name, value] of Object.entries(blockedGlobals)) {
				descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
				Object.defineProperty(globalThis, name, {
					configurable: true,
					writable: true,
					value,
				});
			}
			clearFontAtlasCache();
			expect(await loadFontAtlas()).toEqual({ fonts: {} });
			await expect(
				loadFullFont({ family: "Unavailable Project Font", weights: [400, 700] }),
			).resolves.toBeUndefined();
			await expect(
				loadFonts({ families: ["Arial", "Unavailable Project Font"] }),
			).resolves.toBeUndefined();
			expect(loadingAttempts).toBe(0);
		} finally {
			for (const [name, descriptor] of descriptors) {
				if (descriptor) {
					Object.defineProperty(globalThis, name, descriptor);
				} else {
					Reflect.deleteProperty(globalThis, name);
				}
			}
		}
	});
});
