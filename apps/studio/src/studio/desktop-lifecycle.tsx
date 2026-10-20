import { useEffect } from "react";
import { EditorCore } from "@/core";
import { setNavigationGuard } from "./navigation";
import { toast } from "sonner";

declare global {
  interface Window {
    studioDesktop?: {
      onCloseRequested(callback: () => void): () => void;
      respondToClose(result: { saved: boolean; error?: string }): void;
    };
  }
}
export function DesktopLifecycle() {
  useEffect(() => setNavigationGuard(async () => {
    try {
      const editor = EditorCore.getInstance();
      if (editor.project.getActiveOrNull()) await editor.project.prepareExit();
    } catch (error) {
      toast.error("Project could not be saved. Your editor is still open.");
      throw error;
    }
  }), []);
  useEffect(() => window.studioDesktop?.onCloseRequested(async () => {
    try {
      const editor = EditorCore.getInstance();
      if (editor.project.getActiveOrNull()) await editor.project.prepareExit();
      window.studioDesktop?.respondToClose({ saved: true });
    } catch (error) {
      window.studioDesktop?.respondToClose({ saved: false, error: error instanceof Error ? error.message : "Project could not be saved." });
    }
  }), []);
  return null;
}
