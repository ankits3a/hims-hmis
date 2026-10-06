import { detectDocument } from "./detect";
import type { Pixels } from "./geometry";

/*
  The page finder off the main thread: ~60–90 ms on the build box, so 200–350 ms on a mid-range
  phone — long enough to freeze the corner handles if it ran beside them.
*/
const scope = self as unknown as { onmessage: ((e: MessageEvent<Pixels>) => void) | null; postMessage: (m: unknown) => void };
scope.onmessage = (e) => { scope.postMessage(detectDocument(e.data)); };
