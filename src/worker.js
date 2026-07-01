import WispServer from './wisp/wisp.js';

/**
 * Cloudflare Worker Entry Point
 * Routes Wisp WebSocket traffic and serves static assets
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Route Wisp WebSocket traffic
    if (url.pathname === '/wisp/' || url.pathname === '/wisp') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader === 'websocket') {
        return WispServer.fetch(request, env, ctx);
      }
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }
    
    // Serve static assets from public directory
    // Use Cloudflare ASSETS binding for static files
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    
    // Fallback if ASSETS binding is not available
    return new Response('Asset serving not configured', { status: 500 });
  },
};
