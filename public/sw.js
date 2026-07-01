/**
 * Service Worker for Scramjet Proxy - DEBUG VERSION
 * Handles all proxy routing and integrates with BareMux and Epoxy transit
 */

// Calculate the dynamic base path for the Service Worker.
const swPath = self.location.pathname;
const basePath = swPath.substring(0, swPath.lastIndexOf('/') + 1);

// Store Scramjet configuration
self.basePath = basePath;
self.$scramjet = {
    files: {
        wasm: '/sj-core/scramjet.wasm.wasm',
        sync: '/sj-core/scramjet.sync.js',
    }
};

// Attempt to import Scramjet core scripts
let ScramjetServiceWorker = null;

try {
    importScripts('/sj-core/scramjet.all.js');
    if (typeof $scramjetLoadWorker === 'function') {
        const scramjetWorker = $scramjetLoadWorker();
        ScramjetServiceWorker = scramjetWorker.ScramjetServiceWorker;
    }
} catch (err) {
    console.error('Failed to load Scramjet core scripts:', err);
}

// Attempt to import BareMux
try {
    importScripts('/baremux/index.js');
} catch (err) {
    console.error('Failed to load BareMux scripts:', err);
}

// =====================================================================
// INDEXEDDB SCHEMA SETUP
// =====================================================================

function ensureIDBSchema() {
    const REQUIRED_STORES = [
        'config', 'cookies', 'redirectTrackers',
        'referrerPolicies', 'publicSuffixList',
    ];

    return new Promise((resolve) => {
        const req = indexedDB.open('$scramjet', 1);

        req.onupgradeneeded = () => {
            const db = req.result;
            REQUIRED_STORES.forEach(store => {
                if (!db.objectStoreNames.contains(store)) {
                    db.createObjectStore(store);
                }
            });
        };

        req.onsuccess = () => {
            const db = req.result;
            const missing = REQUIRED_STORES.filter(
                s => !db.objectStoreNames.contains(s)
            );
            db.close();

            if (missing.length === 0) {
                resolve();
                return;
            }

            const delReq = indexedDB.deleteDatabase('$scramjet');
            delReq.onsuccess = delReq.onerror = () => {
                const newReq = indexedDB.open('$scramjet', 1);
                newReq.onupgradeneeded = () => {
                    const newDb = newReq.result;
                    REQUIRED_STORES.forEach(s => newDb.createObjectStore(s));
                };
                newReq.onsuccess = () => { newReq.result.close(); resolve(); };
                newReq.onerror = () => resolve();
            };
        };

        req.onerror = () => resolve();
    });
}

// =====================================================================
// LAZY SCRAMJET INITIALIZATION
// =====================================================================

let scramjet = null;
let scramjetInitPromise = null;

function initScramjet() {
    if (scramjetInitPromise) return scramjetInitPromise;

    scramjetInitPromise = ensureIDBSchema().then(() => {
        if (!ScramjetServiceWorker) return;
        try {
            scramjet = new ScramjetServiceWorker();
            console.log('[SW:INIT] ScramjetServiceWorker instance created');
            console.log('[SW:INIT] scramjet.config:', scramjet.config);
            setupScramjetRequestHandler();
        } catch (err) {
            console.error('Failed to initialize ScramjetServiceWorker:', err);
        }
    }).catch(err => {
        console.error('Scramjet init failed:', err);
    });

    return scramjetInitPromise;
}

// =====================================================================
// SERVICE WORKER LIFECYCLE
// =====================================================================

self.addEventListener('install', () => {
    console.log('[SW:INSTALL] Service Worker installing');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[SW:ACTIVATE] Service Worker activating');
    event.waitUntil(
        initScramjet().then(() => {
            console.log('[SW:ACTIVATE] Scramjet initialized, claiming clients');
            return self.clients.claim();
        })
    );
});

// =====================================================================
// WISP CONFIGURATION
// =====================================================================

let wispConfig = {};

function getDefaultWispUrl() {
    const wsProtocol = self.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${self.location.host}/wisp/`;
}

wispConfig.wispurl = getDefaultWispUrl();

let resolveConfigReady;
const configReadyPromise = new Promise(resolve => {
    resolveConfigReady = resolve;
});

let configTimeout = setTimeout(() => {
    console.warn('[SW:CONFIG] Config message not received within 10 seconds, using default');
    if (!wispConfig.wispurl) {
        wispConfig.wispurl = getDefaultWispUrl();
    }
    if (resolveConfigReady) {
        resolveConfigReady();
        resolveConfigReady = null;
    }
}, 10000);

if (resolveConfigReady && wispConfig.wispurl) {
    resolveConfigReady();
    resolveConfigReady = null;
}

self.addEventListener("message", ({ data }) => {
    if (!data) return;

    if (data.type === "config" && data.wispurl) {
        wispConfig.wispurl = data.wispurl;
        console.log('[SW:CONFIG] Received WISP URL:', data.wispurl);

        if (configTimeout) {
            clearTimeout(configTimeout);
            configTimeout = null;
        }

        if (resolveConfigReady) {
            resolveConfigReady();
            resolveConfigReady = null;
        }
    }

    if (data.type === "triggerLoadConfig" && scramjet && !scramjet.config) {
        console.log('[SW:MESSAGE] Triggering loadConfig via message');
        scramjet.loadConfig().catch(err =>
            console.warn('SW: loadConfig via trigger failed:', err)
        );
    }
});

// =====================================================================
// PROXY ROUTING
// =====================================================================

self.addEventListener("fetch", (event) => {
    event.respondWith((async () => {
        console.log('[SW:FETCH] Request:', event.request.url, 'Method:', event.request.method);

        await initScramjet();

        if (!scramjet) {
            console.log('[SW:FETCH] Scramjet not available, network fallback');
            return fetch(event.request);
        }

        try {
            // Load config if missing
            if (!scramjet.config) {
                console.log('[SW:FETCH] Config missing, attempting loadConfig()');
                try {
                    await scramjet.loadConfig();
                    console.log('[SW:FETCH] Config loaded successfully');
                    console.log('[SW:FETCH] Config object:', scramjet.config);
                } catch (err) {
                    console.warn('[SW:FETCH] loadConfig failed:', err);
                    return fetch(event.request);
                }
            } else {
                console.log('[SW:FETCH] Config already available');
                console.log('[SW:FETCH] Config prefix:', scramjet.config?.prefix);
            }

            // Check if request should be routed
            console.log('[SW:FETCH] Checking if request should be routed...');
            const shouldRoute = scramjet.route(event);
            console.log('[SW:FETCH] shouldRoute:', shouldRoute);

            if (shouldRoute) {
                console.log('[SW:FETCH] Routing through Scramjet proxy');
                try {
                    return await scramjet.fetch(event);
                } catch (fetchErr) {
                    console.error('[SW:FETCH] Scramjet fetch error:', fetchErr);
                    // Fall through to network
                }
            } else {
                console.log('[SW:FETCH] Request does not match routing pattern, network fallback');
            }
        } catch (err) {
            console.error('[SW:FETCH] Error in routing logic:', err);
        }

        console.log('[SW:FETCH] Final fallback to network for:', event.request.url);
        return fetch(event.request);
    })());
});

// =====================================================================
// SCRAMJET REQUEST HANDLER
// =====================================================================

function setupScramjetRequestHandler() {
    console.log('[SW:HANDLER] Setting up Scramjet request handler');
    
    scramjet.addEventListener("request", async (e) => {
        console.log('[SW:HANDLER:REQUEST] Internal request:', e.url);
        
        e.response = (async () => {
            try {
                // Use a single, persistent BareMux client instance
                if (!scramjet.client) {
                    console.log('[SW:HANDLER] Creating new BareMux client');
                    await configReadyPromise;

                    if (!wispConfig.wispurl) {
                        wispConfig.wispurl = getDefaultWispUrl();
                    }

                    console.log('[SW:HANDLER] WISP URL:', wispConfig.wispurl);

                    if (typeof BareMux === 'undefined') {
                        console.error("[SW:HANDLER] BareMux is not available.");
                        return new Response("BareMux not available.", {
                            status: 500,
                            statusText: "Internal Server Error"
                        });
                    }

                    const connection = new BareMux.BareMuxConnection('/baremux/worker.js');

                    try {
                        await connection.setTransport('/epoxy-transit/index.mjs', [{
                            wisp: wispConfig.wispurl
                        }]);
                        scramjet.client = connection;
                        console.log('[SW:HANDLER] BareMux client initialized successfully');
                    } catch (err) {
                        console.error('[SW:HANDLER] Failed to set BareMux transport:', err);
                        return new Response("BareMux configuration failed.", {
                            status: 500,
                            statusText: "Internal Server Error"
                        });
                    }
                } else {
                    console.log('[SW:HANDLER] Reusing existing BareMux client');
                }

                console.log('[SW:HANDLER] Fetching through BareMux:', e.url);
                return await scramjet.client.fetch(e.url, {
                    method: e.method,
                    body: e.body,
                    headers: e.requestHeaders,
                    credentials: "omit",
                    mode: e.mode === "cors" ? e.mode : "same-origin",
                    cache: e.cache,
                    redirect: "manual",
                    duplex: "half",
                });
            } catch (err) {
                console.error('[SW:HANDLER] Request handler error:', err);
                return new Response("Proxy error: " + err.message, {
                    status: 502,
                    statusText: "Bad Gateway"
                });
            }
        })();
    });
}
