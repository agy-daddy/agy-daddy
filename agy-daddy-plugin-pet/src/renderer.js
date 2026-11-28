'use strict';

let disposers = [];

async function mount(ctx) {
  dispose();

  let lastSessionKey = '';

  function syncActiveSession() {
    const cascadeId = ctx.hostDom?.getSessionId?.() || null;
    const busy = Boolean(ctx.hostDom?.isAssistantBusy?.());
    const key = `${cascadeId || ''}:${busy ? 1 : 0}`;
    if (key === lastSessionKey) return;
    lastSessionKey = key;
    Promise.resolve(ctx.bridge?.post?.('/active-session', { cascadeId, busy })).catch(() => {});
  }

  const stopActivePoll = ctx.schedule.every(1000, () => {
    syncActiveSession();
  });

  syncActiveSession();

  disposers.push(
    () => { if (typeof stopActivePoll === 'function') stopActivePoll(); }
  );
}

function dispose() {
  for (const fn of disposers.splice(0)) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
}

module.exports = {
  mount,
  dispose
};
