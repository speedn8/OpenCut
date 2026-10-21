export class EditorError extends Error {
  constructor(public readonly code: "VALIDATION" | "NOT_FOUND" | "LOCKED" | "BOUNDS" | "CONFLICT" | "UNSUPPORTED", message: string) {
    super(message);
    this.name = "EditorError";
  }
}

export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new EditorError("VALIDATION", message);
}
