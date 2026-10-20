import { useState, useMemo, useCallback } from "react";
import {
	getCachedFontAtlas,
	getLocalFontNames,
	clearFontAtlasCache,
} from "@/fonts/google-fonts";
import type { FontAtlas } from "@/fonts/types";

type Status = "idle" | "loading" | "error";

export function useFontAtlas(_options: { open: boolean }) {
	const [atlas, setAtlas] = useState<FontAtlas | null>(getCachedFontAtlas);
	const [status, setStatus] = useState<Status>("idle");
	const fontNames = useMemo(getLocalFontNames, []);

	const retry = useCallback(() => {
		clearFontAtlasCache();
		setAtlas(getCachedFontAtlas());
		setStatus("idle");
	}, []);

	return { atlas, status, fontNames, retry };
}
