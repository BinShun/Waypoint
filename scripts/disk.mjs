/**
 * How a test suite reads the workspace off the disk.
 *
 * `JSON.parse(readFileSync(file))` looks harmless and is a lie the moment
 * `WB_DATA_KEY` is set: the file is sealed, the parse throws, and the suite
 * reports a harness error instead of a result. Worse, it would have reported
 * green forever in the one configuration that does not ship.
 *
 * Every suite imports `disk()` from here, so they all read the file exactly the
 * way the server does — plain or sealed, same module, no second copy of the
 * format to drift out of step.
 */
import { readWorkspaceFile } from '../server/seal.mjs';

export const disk = (file) => readWorkspaceFile(file);
export { readWorkspaceFile };
export { ENC_PREFIX, isSealed } from '../server/seal.mjs';
