import { AudioLines } from "lucide-react";

export function AlignmentIcon({
  active = false,
  size = 16,
}: {
  active?: boolean;
  size?: number;
}) {
  return (
    <AudioLines
      size={size}
      className={active ? "alignment-wave active" : "alignment-wave"}
    />
  );
}
