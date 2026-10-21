import type { EditorExtension } from "../src/extensions";

/** A real, deliberately narrow tool extension. It uses the same validated
 * command and project history as the editor's built-in controls. */
export function createMakeSocialSquareExtension(): EditorExtension {
  return {
    manifest: {
      id: "opencut.make-social-square",
      version: "1.0.0",
      apiVersion: 1,
      kind: "tool",
      name: "Make social square",
      capabilities: ["project.read", "commands.dispatch"],
    },
    activate(api) {
      const project = api.getSnapshot();
      const side = Math.min(project.settings.width, project.settings.height);
      api.dispatch({
        type: "project.settings",
        patch: { width: side, height: side },
      });
    },
  };
}
