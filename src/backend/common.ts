import type { SpindleAPI } from 'lumiverse-spindle-types';

// Host injects the SpindleAPI as `globalThis.spindle` before importing this
// module; bind it once so submodules share one typed accessor.
declare const spindle: SpindleAPI;
export const api: SpindleAPI = spindle;

// Shared prefix for variable/macro logging (setvar interceptor, resolve_macros).
const VARS_PREFIX = '[vishrun:variables]';
export const varsLog = {
  warn: (...args: unknown[]) => console.warn(VARS_PREFIX, ...args),
  debug: (...args: unknown[]) => console.debug(VARS_PREFIX, ...args),
};
