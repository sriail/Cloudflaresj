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
    
    // Get response from ASSETS binding
    let response = null;
    if (env.ASSETS) {
      response = await env.ASSETS.fetch(request);
    } else {
      return new Response('Asset serving not configured', { status: 500 });
    }

    // Add security headers for HTML responses
    if (response.headers.get('content-type')?.includes('text/html')) {
      const newHeaders = new Headers(response.headers);
      
      // Add CSP header to allow framing on the same origin
      newHeaders.set('Content-Security-Policy', 
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: https:; " +
        "font-src 'self' data:; " +
        "connect-src 'self' ws: wss: https:; " +
        "frame-ancestors 'self'; " +
        "object-src 'none'; " +
        "base-uri 'self';"
      );
      
      // Add header to allow any site to be framed by this origin
      newHeaders.set('X-Frame-Options', 'ALLOWALL');
      
      response = new Response(response.body, response);
      for (const [key, value] of newHeaders) {
        response.headers.set(key, value);
      }
    }

    return response;
  },
};
