// Worker entry point — routes /notify to the FCM handler,
// everything else falls through to static assets (Workers Assets).

import { handleNotify } from './functions/notify.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/notify' && request.method === 'POST') {
      return handleNotify(request, env);
    }
    return env.ASSETS.fetch(request);
  }
};
