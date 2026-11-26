'use strict';

/**
 * Renderer entry stub for @agy-daddy/plugin-viewer (isolated world).
 * Stage 4 implements the Omni Viewer & Git Inline Diff Shadow DOM UI here.
 */

let mounted = false;

async function mount(_ctx) {
  mounted = true;
}

function dispose() {
  mounted = false;
}

function isMounted() {
  return mounted;
}

module.exports = { mount, dispose, isMounted };
