import { forwardRef, type ImgHTMLAttributes } from "react";
type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { src: string | { src: string }; fill?: boolean; unoptimized?: boolean; priority?: boolean; quality?: number };
const Image = forwardRef<HTMLImageElement, Props>(function Image({ src, fill, unoptimized: _unoptimized, priority, quality: _quality, style, ...props }, ref) {
  return <img {...props} src={typeof src === "string" ? src : src.src} ref={ref} loading={priority ? "eager" : props.loading} style={fill ? { position: "absolute", width: "100%", height: "100%", inset: 0, ...style } : style} />;
});
export default Image;
