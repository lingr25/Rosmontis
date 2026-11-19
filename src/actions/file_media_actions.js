"use strict";

/**
 * File, Media, Profile & Web Credential Action Router Facade (`src/actions/file_media_actions.js`)
 *
 * Composes `src/actions/file_actions.js` (group/private file operations) and
 * `src/actions/media_profile_actions.js` (media resolution, OCR/voice, profile/status,
 * Ark share, and opt-in Web credential/QZone actions) while preserving the exact
 * `HANDLED_ACTIONS` and `dispatch` public surface for `src/bridge_main.js`.
 */

const fileActions = require("./file_actions");
const mediaProfileActions = require("./media_profile_actions");

const SUB_MODULES = [fileActions, mediaProfileActions];
const ACTION_DISPATCH_MAP = new Map();
const HANDLED_ACTIONS = new Set();

for (const mod of SUB_MODULES) {
  for (const act of mod.HANDLED_ACTIONS) {
    if (ACTION_DISPATCH_MAP.has(act)) {
      throw new Error(`Duplicate OneBot action registration in file_media_actions: ${act}`);
    }
    ACTION_DISPATCH_MAP.set(act, mod.dispatch);
    HANDLED_ACTIONS.add(act);
  }
}

async function dispatch(action, p, context = {}) {
  const handler = ACTION_DISPATCH_MAP.get(action);
  if (!handler) {
    throw new Error(`Unsupported file/media/profile OneBot action: ${action}`);
  }
  return await handler.call(this, action, p, context);
}

module.exports = {
  HANDLED_ACTIONS,
  dispatch,
  fileActions,
  mediaProfileActions,
};
