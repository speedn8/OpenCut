"use client";
import { useLocalStorage } from "@/services/storage/use-local-storage";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogTitle } from "../ui/dialog";

export function Onboarding() {
  const [seen, setSeen] = useLocalStorage({ key: "studio-intro-v1", defaultValue: false });
  const close = () => setSeen({ value: true });
  return <Dialog open={!seen} onOpenChange={close}>
    <DialogContent className="sm:max-w-[460px]">
      <DialogTitle>Make something. Keep it local.</DialogTitle>
      <DialogBody>
        <p className="mb-4 text-sm text-muted-foreground">Import your video, audio, or images. Use the + on an asset to add it at the playhead, then trim, split, and arrange your timeline.</p>
        <p className="mb-4 text-sm text-muted-foreground">Projects save on this computer. Check the save status before leaving, and use Export to create a video.</p>
        <p className="mb-5 text-xs text-muted-foreground">OpenCut Studio 0.1 · Local preview. Cloud tools and CapCut project import are unavailable.</p>
        <Button className="w-full" onClick={close}>Start editing</Button>
      </DialogBody>
    </DialogContent>
  </Dialog>;
}
