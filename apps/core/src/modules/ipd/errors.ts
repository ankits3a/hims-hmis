/**
 * The ipd module's error vocabulary. Same shape as the other modules' errors: a stable `code` a caller
 * maps, a sentence a person reads, and `detail` carrying the data the sentence names.
 */
export type IpdErrorCode =
  /** A bed-layout file failed validation or disagrees with the registry; nothing was written. */
  | "bed_layout_invalid";

export class IpdError extends Error {
  constructor(
    readonly code: IpdErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "IpdError";
  }
}
