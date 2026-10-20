import { forwardRef, type AnchorHTMLAttributes } from "react";
import { studioRouter } from "./navigation";
type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: string | { pathname?: string }; prefetch?: boolean; replace?: boolean };
const Link = forwardRef<HTMLAnchorElement, Props>(function Link({ href, prefetch: _prefetch, replace, onClick, ...props }, ref) {
  const url = typeof href === "string" ? href : href.pathname || "/projects";
  return <a {...props} href={url} ref={ref} onClick={(event) => {
    onClick?.(event);
    if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && url.startsWith("/") && !props.target) {
      event.preventDefault();
      if (replace) studioRouter.replace(url); else studioRouter.push(url);
    }
  }} />;
});
export default Link;
