import type { MessageParams, Translator } from "./runtime.mjs";
export type MessageDescriptor = {
  code: string;
  params: MessageParams;
  message: string;
};
export type ErrorData = {
  code?: string;
  params: MessageParams;
  message: string;
  issues?: ErrorData[];
};
export type StageDescriptor = { stage: string; params: MessageParams };
export function messageDescriptor(
  code: string,
  params?: MessageParams,
  message?: string,
): MessageDescriptor;
export function stageDescriptor(
  stage: string,
  params?: MessageParams,
): StageDescriptor;
export function serializeError(error: unknown): ErrorData;
export function restoreError(data: ErrorData): Error & ErrorData;
export function formatDescriptor(
  runtime: Translator,
  namespace: "error" | "message" | "stage",
  value:
    MessageDescriptor | ErrorData | StageDescriptor | string | null | undefined,
): string;
