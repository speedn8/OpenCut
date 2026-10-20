import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import Editor from "@/app/editor/[project_id]/page";
import Projects from "@/app/projects/page";
import { usePathname } from "@/studio/navigation";
import { DesktopLifecycle } from "@/studio/desktop-lifecycle";
import "@/app/globals.css";

function Studio() {
  const path = usePathname();
  return <ThemeProvider attribute="class" defaultTheme="dark" disableTransitionOnChange><TooltipProvider><DesktopLifecycle /><Toaster />{path.startsWith("/editor/") ? <Editor /> : <Projects />}</TooltipProvider></ThemeProvider>;
}
createRoot(document.getElementById("root")!).render(<Studio />);
