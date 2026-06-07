// Loaded via bunfig `[test] preload` BEFORE the test files import `src`, so `mock.module('bun', …)`
// is registered before `src` binds `import { fetch, write, spawn } from 'bun'`. `mock.module` does not
// reliably update an ALREADY-imported module's bindings (it must run first — that's what `--preload`
// is for), so the host-effect mocks are created here and the `bun` module's `fetch`/`write`/`spawn`
// resolve to them. The test file imports the same mocks (this is a single cached module) and
// configures them per test. `console.*` and the global `Bun.file`/`Bun.Glob` reads are NOT part of the
// `bun` module, so they are handled in the test file (spied / left real) rather than here.
import { mock } from 'bun:test';

export const fetchMock = mock();
export const writeMock = mock();
export const spawnMock = mock();

void mock.module('bun', () => ({ fetch: fetchMock, spawn: spawnMock, write: writeMock }));
