// Test resource only. Packaging copies locales/, never tests/.
export function pseudoCatalog(source) {
  const expand = (value) =>
    `⟦ ${value.replace(/\{\w+\}|[^{}]+/g, (part) => (part.startsWith("{") ? part : part.repeat(2)))} ⟧`;
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      typeof value === "string"
        ? expand(value)
        : Object.fromEntries(
            Object.entries(value).map(([form, text]) => [form, expand(text)]),
          ),
    ]),
  );
}
