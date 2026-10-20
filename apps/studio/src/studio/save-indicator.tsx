import { useSyncExternalStore } from "react";
import { useEditor } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function SaveIndicator() {
  const editor = useEditor();
  const status = useSyncExternalStore(
    (listener) => editor.save.subscribe(listener),
    () => editor.save.getLastError() ? "Save failed — retry" : editor.save.getIsSaving() ? "Saving…" : editor.save.getIsDirty() ? "Save changes" : "Saved locally",
  );
  return <Button variant="ghost" size="sm" aria-label="Save project" title={status} onClick={async () => {
    try { await editor.save.flush(); toast.success("Project saved locally"); }
    catch (error) { toast.error("Could not save project", { description: error instanceof Error ? error.message : "Retry when storage is available." }); }
  }}><span role="status" aria-live="polite">{status}</span></Button>;
}
