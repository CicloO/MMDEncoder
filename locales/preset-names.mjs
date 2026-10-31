// Pure display projection shared by the renderer and standalone plugin config.
// Saved names, comparisons, fingerprints and command settings never use it.
export function presetDisplayName(runtime, preset, peers = []) {
  const name = baseName(runtime, preset);
  if (
    isDefault(preset) &&
    peers.some((p) => p.id !== preset.id && baseName(runtime, p) === name)
  )
    return runtime.t("preset.displayCollision", { name, id: preset.id });
  return name;
}
function isDefault(p) {
  return (
    p.builtin && p.nameSource === "builtin" && typeof p.nameKey === "string"
  );
}
function baseName(runtime, p) {
  if (!isDefault(p) || !runtime.has(p.nameKey)) return p.name;
  const name = runtime.t(p.nameKey);
  return p.nameDisambiguation
    ? runtime.t("preset.builtinSuffix", { name })
    : name;
}
