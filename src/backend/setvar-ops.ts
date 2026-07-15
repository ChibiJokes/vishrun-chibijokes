import type { SpindleAPI } from 'lumiverse-spindle-types';
import { api, varsLog } from './common';
import type { SetvarKind } from './parsers/setvar';

// Shared routing for setvar/setchatvar/setgvar/setglobalvar. Used by
// applyAndStripSetvars (widget `{{setvar::...}}` macros), the user-typed
// `/setvar` message processor, and the iframe pushToSillyTavern dispatch.
//
// setgvar/setglobalvar are DISABLED this iteration: api.variables.global.set
// writes to settings.macro_variables_global but {{getgvar}} reads from
// chat.metadata.macro_variables.global (MacroEnv.ts:105). The set is invisible
// to subsequent resolves. Re-enable when upstream unifies the read/write paths.

export type VarsApi = Pick<SpindleAPI['variables'], 'local' | 'chat' | 'global'>;

export interface SetvarOp {
  kind: SetvarKind;
  name: string;
  value: string;
}

// Returns true if the op was applied (caller should strip the match from the
// template / mark as handled), false if it was intentionally skipped (gvar
// disabled — caller should leave the match in place).
export async function applySetvarOp(
  op: SetvarOp,
  chatId: string,
  userId: string,
  vars: VarsApi = api.variables,
): Promise<boolean> {
  if (op.kind === 'setvar') {
    // 1. Await the change so backend memory stays perfectly synchronized
    await vars.local.set(chatId, op.name, op.value);
    // 2. Fire a redundant update 50ms later to punch through the UI render lock
    setTimeout(() => { void vars.local.set(chatId, op.name, op.value); }, 50);
    return true;
  }
  if (op.kind === 'setchatvar') {
    // 1. Await the change so backend memory stays perfectly synchronized
    await vars.chat.set(chatId, op.name, op.value);
    // 2. Fire a redundant update 50ms later to punch through the UI render lock
    setTimeout(() => { void vars.chat.set(chatId, op.name, op.value); }, 50);
    return true;
  }
  // setgvar / setglobalvar — disabled, see header comment.
  varsLog.debug(`skipping ${op.kind} (upstream get/set path split):`, { name: op.name, userId });
  return false;
}
