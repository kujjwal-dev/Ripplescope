/** Whether an external program RippleScope relies on can be run, with its version or the reason it can't. */
export type ToolStatus =
  | { ok: true; version: string }
  | { ok: false; error: string };
