import { useEffect, useRef, useState } from "react";
// Owns the original JPEG request debounce and newest-response check only.
export function useTrimPreview(
  id: string | undefined,
  frame: number,
  readFrame: (id: string, frame: number) => Promise<string>,
) {
  const [image, setImage] = useState("");
  const request = useRef(0);
  useEffect(() => {
    if (!id) return setImage("");
    const n = ++request.current;
    const timer = setTimeout(() => {
      readFrame(id, frame)
        .then((src) => n === request.current && src && setImage(src))
        .catch(() => {});
    }, 120);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, frame]);
  return image;
}
