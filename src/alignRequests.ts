// Requests owned by the alignment dialog rather than its parent page.
export const isCancelled = (e: unknown) => /已取消$/.test((e as Error).message);
export async function ask(action: string, payload: unknown) {
  try {
    return await window.encoder.invoke(action, payload);
  } catch (e) {
    throw Error(
      (e as Error).message.replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        "",
      ),
    );
  }
}
