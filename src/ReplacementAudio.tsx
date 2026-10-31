const NAME = "\u0001";

// One line of queue-row details; the full text shows on hover when it is cut.
export function OneLine({
  className,
  children,
}: {
  className: string;
  children: string;
}) {
  return (
    <span className={className + " one-line"} title={children}>
      {children}
    </span>
  );
}

// Replacement audio on its own queue-row line: only the file name shrinks
// (ellipsis, full path on hover), so the label and offset stay readable.
export function ReplacementAudio({
  path,
  name,
  label,
  shift,
}: {
  path: string;
  name: string;
  label: (name: string) => string;
  shift?: string;
}) {
  const [before, after = ""] = label(NAME).split(NAME);
  return (
    <span className="job-audio" title={path}>
      <span>{before}</span>
      <span className="job-audio-name">{name}</span>
      <span>
        {after}
        {shift}
      </span>
    </span>
  );
}
