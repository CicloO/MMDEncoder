export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type MessageParams = Record<string, JsonValue>;
export type Message = string | { one?: string; other: string };
export type Catalog = Record<string, Message>;
export type Translator = {
  getLocale(): string;
  getLocales(): string[];
  subscribe(listener: () => void): () => void;
  registerCatalog(id: string, catalog: Catalog): void;
  setLocale(locale: unknown): string;
  has(key: string): boolean;
  t(key: string, params?: MessageParams): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
  dateTime(
    value: string | number | Date,
    options?: Intl.DateTimeFormatOptions,
  ): string;
  unit(value: number, unit: string, options?: Intl.NumberFormatOptions): string;
  bytes(value: number): string;
};
export function createTranslator(options: {
  sourceLocale: string;
  catalogs: Record<string, Catalog>;
  initialLocale?: string;
}): Translator;
