import type { AppError } from "./bindings";

export type Failure = AppError | { kind: "transport" | "catalog" | "desktop"; message: string };

export class AppFailure extends Error {
  constructor(public readonly detail: Failure) {
    super(detail.message);
    this.name = "AppFailure";
  }
}

export function failure(error: unknown): AppFailure {
  return error instanceof AppFailure
    ? error
    : new AppFailure({
        kind: "transport",
        message:
          error instanceof Error
            ? error.message
            : "The operation could not be completed. Try again.",
      });
}

export async function native<T>(
  request: Promise<{ status: "ok"; data: T } | { status: "error"; error: AppError }>,
): Promise<T> {
  try {
    const result = await request;
    if (result.status === "error") throw new AppFailure(result.error);
    return result.data;
  } catch (error) {
    throw failure(error);
  }
}
