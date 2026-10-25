// Test resource only. Packaging copies locales/, never tests/.
export function pseudoCatalog(source) {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      `⟦ ${value.replace(/\{\w+\}|[^{}]+/g, (part) => (part.startsWith("{") ? part : part.repeat(2)))} ⟧`,
    ]),
  );
}
