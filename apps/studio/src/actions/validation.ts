import { ACTIONS } from "./definitions";
import type { TAction, TActionWithOptionalArgs } from "./types";

// Keep the runtime boundary exhaustive as action argument types evolve.
const ACTIONS_REQUIRING_ARGS = {
	"remove-media-asset": true,
	"remove-media-assets": true,
} satisfies Record<Exclude<TAction, TActionWithOptionalArgs>, true>;

export function isActionWithOptionalArgs(
	value: unknown,
): value is TActionWithOptionalArgs {
	return (
		typeof value === "string" &&
		Object.hasOwn(ACTIONS, value) &&
		!Object.hasOwn(ACTIONS_REQUIRING_ARGS, value)
	);
}
