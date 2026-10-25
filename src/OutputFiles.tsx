// Paths come from the backend's committed-output projection. Keep the full
// filename in the DOM; CSS shortens only its middle and the title keeps the path.
export function OutputFiles({
  output,
  maskOutput,
}: {
  output?: string;
  maskOutput?: string;
}) {
  const files = [output, maskOutput].filter((p): p is string => !!p);
  if (!files.length) return null;
  return (
    <span className="output-files">
      {files.map((file, index) => {
        const name = file.split(/[\\/]/).pop() || file;
        const points = Array.from(name);
        const tailLength = Math.min(12, Math.ceil(points.length / 3));
        return (
          <span className="output-file" key={file}>
            <span className="output-file-separator" aria-hidden="true">
              {index ? " / " : " · "}
            </span>
            <span className="output-file-name" title={file}>
              <span className="output-file-lead">
                {points.slice(0, -tailLength).join("")}
              </span>
              <span className="output-file-tail">
                {points.slice(-tailLength).join("")}
              </span>
            </span>
          </span>
        );
      })}
    </span>
  );
}
