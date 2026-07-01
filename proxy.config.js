/**
 * Scramjet Proxy Configuration
 * 
 * This file contains configuration for the Scramjet proxy running on Cloudflare Workers.
 * It defines path mappings for asset serving, module resolution, and framework integration.
 */

// =====================================================================
// PATH CONFIGURATION
// Maps framework components to their served locations
// =====================================================================

const PathConfig = {
  // Scramjet core paths - served from /sj-core/
  scramjet: {
    all: '/sj-core/scramjet.all.js',          // Full Scramjet bundle
    bundle: '/sj-core/scramjet.bundle.js',    // Bundled version
    sync: '/sj-core/scramjet.sync.js',        // Sync version
    sw: '/sj-core/scramjet.sw.js',            // Service Worker version
    wasm: '/sj-core/scramjet.wasm.wasm',      // WASM binary (double .wasm extension is intentional)
  },

  // BareMux paths - served from /baremux/
  baremux: {
    main: '/baremux/index.mjs',               // Main ESM entry point
    compat: '/baremux/index.js',              // CommonJS/compat entry point
    worker: '/baremux/worker.js',             // SharedWorker implementation
  },

  // Epoxy Transit paths - served from /epoxy-transit/
  epoxy: {
    main: '/epoxy-transit/index.mjs',         // Main ESM entry point
    compat: '/epoxy-transit/index.js',        // CommonJS/compat entry point
  },

  // Wisp server endpoint
  wisp: {
    endpoint: '/wisp/',                       // WebSocket endpoint for Wisp protocol
    wsProtocol: () => {                       // Determine correct WebSocket protocol
      if (typeof window === 'undefined') return 'wss://'; // Server-side
      return window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    },
    // Full URL is constructed as: wsProtocol + window.location.host + endpoint
  },

  // Service Worker path
  serviceWorker: {
    path: '/sw.js',                           // Service worker registration path
    scope: '/',                               // Scope for all routes
  },

  // Static asset paths
  assets: {
    html: '/index.html',                      // Main HTML file
    script: '/script.js',                     // Main script file
  },
};

// =====================================================================
// WISP SERVER CONFIGURATION
// Default server and fallback options
// =====================================================================

const WispServerConfig = {
  // Default local Wisp server on the same host
  default: {
    host: 'localhost',
    getUrl: () => {
      const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = typeof window !== 'undefined' ? window.location.host : 'localhost';
      return `${protocol}//${host}/wisp/`;
    },
  },

  // Optional: Remote Wisp server (for testing)
  // Uncomment and configure to use an external Wisp server
  // remote: {
  //   url: 'wss://wisp.rhw.one/wisp/',
  // },

  // Validate Wisp URL format
  validate: (url) => {
    try {
      if (!url || typeof url !== 'string') return false;
      const urlObj = new URL(url);
      // Must be secure or localhost
      return urlObj.protocol === 'wss:' || 
             (urlObj.protocol === 'ws:' && (urlObj.hostname === 'localhost' || urlObj.hostname === '127.0.0.1'));
    } catch (e) {
      return false;
    }
  },
};

// =====================================================================
// SCRAMJET FRAMEWORK CONFIGURATION
// Integration settings for the Scramjet proxy
// =====================================================================

const ScramjetConfig = {
  // Core configuration
  core: {
    prefix: '/sj-core/',                     // Prefix for core files
    entrypoint: PathConfig.scramjet.all,     // Entry point bundle
  },

  // Service Worker configuration
  serviceWorker: {
    enabled: true,
    path: PathConfig.serviceWorker.path,
    scope: PathConfig.serviceWorker.scope,
  },

  // BareMux configuration
  baremux: {
    workerPath: PathConfig.baremux.worker,
    transport: PathConfig.epoxy.main,       // Default transport: Epoxy
  },

  // URL encoding configuration
  urlEncoding: 'scramjet',                  // Use Scramjet's native encoding
};

// =====================================================================
// INTEGRATION CHECKLIST
// Ensures all components are properly wired
// NOTE: These functions are for Node.js/build-time verification only
// =====================================================================

const IntegrationChecklist = {
  // Build-time checks can be performed by scripts
  // Runtime checks should be done in the browser via console
  
  notes: [
    'Verify worker entry point exists at ./src/worker.js',
    'Verify Wisp server module exists at ./src/wisp/wisp.js',
    'Verify all asset directories exist: ./src/sj-core/, ./src/baremux/, ./src/epoxy-transit/',
    'Run build: wrangler build',
    'Test locally: wrangler dev',
  ],
};

// =====================================================================
// BUILD & DEPLOYMENT NOTES
// =====================================================================

const DeploymentNotes = {
  cloudflareWorkers: {
    assetBinding: {
      description: 'Assets are served via Cloudflare ASSETS binding',
      configuration: 'Defined in wrangler.toml: [assets] directory = "./public"',
      note: 'All static files in ./public are served at / with appropriate caching'
    },
    
    srcFiles: {
      description: 'Source files in ./src are bundled with the worker',
      note: 'Ensure all imports are ES modules or properly transpiled',
    },

    buildProcess: {
      description: 'Wrangler automatically handles bundling',
      steps: [
        '1. Run: wrangler deploy',
        '2. Source files (src/) are bundled into the worker',
        '3. Public files (public/) are uploaded as static assets',
        '4. Routes are configured via wrangler.toml',
      ],
    },

    testing: {
      description: 'Test locally before deployment',
      steps: [
        '1. Run: wrangler dev',
        '2. Open http://localhost:8787',
        '3. Navigate to test URLs',
        '4. Check browser console for errors',
        '5. Verify service worker registration',
        '6. Test proxy functionality',
      ],
    },
  },
};

// =====================================================================
// EXPORTS
// =====================================================================

// CommonJS export for Node.js
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = {
    PathConfig,
    WispServerConfig,
    ScramjetConfig,
    IntegrationChecklist,
    DeploymentNotes,
  };
}
