// Errors thrown by the data helpers. Messages name the kind of object, never IDs or values, so
// they are safe to log and to map to HTTP responses.

/** The row does not exist in this organization (it may exist in another one: same answer). */
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}

/** The actor's role does not allow this action. */
export class ForbiddenError extends Error {
  override readonly name = "ForbiddenError";
}

/** The action does not apply to the row's current state. */
export class ConflictError extends Error {
  override readonly name = "ConflictError";
}
