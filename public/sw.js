/**
 * Service Worker for Scramjet Proxy - FIXED VERSION
 * Critical: All event listeners must be registered in top-level code
 */

// =====================================================================
// STEP 1: REGISTER ALL EVENT LISTENERS IMMEDIATELY (TOP-LEVEL CODE)
// =====================================================================

// Message handler MUST be registered before anything else
self.addEventListener("message", ({ data }) => {
    if (!data) return;

    if (data.type === "config" && data.wispurl) {
        wispConfig.wispurl = data.wispurl;
        console.log('[SW] Config received - WISP URL:', data.wispurl);
        
        if (configTimeout) clearTimeout(configTimeout);
        if (resolveConfigReady) {
            resolveConfigReady();
            resolveConfigReady = null;
        }
    }

    if (data.type === "triggerLoadConfig" && scramjet && !scramjet.config) {
        console.log('[SW] Triggering loadConfig via message');
        scramjet.loadConfig().catch(err => 
            console.warn('[SW] loadConfig failed:', err)
        );
    }
});

// Install listener (top-level)
self.addEventListener('install', () => {
    console.log('[SW] Installing...');
    self.skipWaiting();
});

// Activate listener (top-level)
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating...');
    event.waitUntil(
        initScramjet().then(() => {
            console.log('[SW] Claiming clients...');
            return self.clients.claim();
        })
    );
});

// Fetch listener (top-level)
self.addEventListener("fetch", (event) => {
    event.respondWith(handleFetch(event));
});

// =====================================================================
// STEP 2: INITIALIZE CONFIGURATION
// =====================================================================

const swPath = self.location.pathname;
const basePath = swPath.substring(0, swPath.lastIndexOf('/') + 1);

self.basePath = basePath;
self.$scramjet = {
    files: {
        wasm: '/sj-core/scramjet.wasm.wasm',
        sync: '/sj-core/scramjet.sync.js',
    }
};

let ScramjetServiceWorker = null;

try {
    importScripts('/sj-core/scramjet.all.js');
    if (typeof $scramjetLoadWorker === 'function') {
        const scramjetWorker = $scramjetLoadWorker();
        ScramjetServiceWorker = scramjetWorker.ScramjetServiceWorker;
    }
} catch (err) {
    console.error('[SW] Failed to load Scramjet:', err);
}

try {
    importScripts('/baremux/index.js');
} catch (err) {
    console.error('[SW] Failed to load BareMux:', err);
}

// =====================================================================
// STEP 3: WISP CONFIGURATION
// =====================================================================

let wispConfig = {};

function getDefaultWispUrl() {
    const wsProtocol = self.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${self.location.host}/wisp/`;
}

wispConfig.wispurl = getDefaultWispUrl();
console.log('[SW] Default WISP URL:', wispConfig.wispurl);

let resolveConfigReady;
const configReadyPromise = new Promise(resolve => {
    resolveConfigReady = resolve;
});

let configTimeout = setTimeout(() => {
    console.warn('[SW] Config timeout - using default WISP URL');
    if (resolveConfigReady) {
        resolveConfigReady();
        resolveConfigReady = null;
    }
}, 10000);

if (resolveConfigReady && wispConfig.wispurl) {
    resolveConfigReady();
    resolveConfigReady = null;
}

// =====================================================================
// STEP 4: INDEXEDDB SCHEMA
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
// STEP 5: SCRAMJET INITIALIZATION
// =====================================================================

let scramjet = null;
let scramjetInitPromise = null;

function initScramjet() {
    if (scramjetInitPromise) return scramjetInitPromise;

    scramjetInitPromise = ensureIDBSchema().then(() => {
        if (!ScramjetServiceWorker) {
            console.warn('[SW] ScramjetServiceWorker class not available');
            return;
        }

        try {
            scramjet = new ScramjetServiceWorker();
            console.log('[SW] ScramjetServiceWorker initialized');
            console.log('[SW] Config:', scramjet.config);
            setupScramjetRequestHandler();
        } catch (err) {
            console.error('[SW] Failed to initialize ScramjetServiceWorker:', err);
        }
    }).catch(err => {
        console.error('[SW] IDB initialization failed:', err);
    });

    return scramjetInitPromise;
}

// =====================================================================
// STEP 6: FETCH HANDLER
// =====================================================================

async function handleFetch(event) {
    const url = event.request.url;
    
    try {
        // Ensure Scramjet is initialized
        await initScramjet();

        if (!scramjet) {
            console.log('[SW:FETCH] Scramjet unavailable, using network');
            return fetch(event.request);
        }

        // Load config if needed
        if (!scramjet.config) {
            console.log('[SW:FETCH] Config missing, loading...');
            try {
                await scramjet.loadConfig();
                console.log('[SW:FETCH] Config loaded');
            } catch (err) {
                console.warn('[SW:FETCH] Config load failed:', err);
                return fetch(event.request);
            }
        }

        // Check if should route through proxy
        const shouldRoute = scramjet.route(event);
        console.log('[SW:FETCH] URL:', url, 'Route:', shouldRoute);

        if (shouldRoute) {
            try {
                return await scramjet.fetch(event);
            } catch (err) {
                console.error('[SW:FETCH] Scramjet proxy error:', err.message);
                // Fall through to network
            }
        }

    } catch (err) {
        console.error('[SW:FETCH] Unexpected error:', err);
    }

    // Default: use network
    return fetch(event.request);
}

// =====================================================================
// STEP 7: SCRAMJET REQUEST HANDLER
// =====================================================================

function setupScramjetRequestHandler() {
    console.log('[SW] Setting up Scramjet request handler');

    scramjet.addEventListener("request", async (e) => {
        e.response = (async () => {
            try {
                // Create BareMux client if needed
                if (!scramjet.client) {
                    console.log('[SW:HANDLER] Initializing BareMux client');
                    
                    // Wait for WISP config to be ready
                    await configReadyPromise;

                    if (!wispConfig.wispurl) {
                        wispConfig.wispurl = getDefaultWispUrl();
                    }

                    console.log('[SW:HANDLER] WISP URL:', wispConfig.wispurl);

                    if (typeof BareMux === 'undefined') {
                        console.error('[SW:HANDLER] BareMux not available');
                        return new Response("BareMux not available", {
                            status: 500,
                            statusText: "Internal Server Error"
                        });
                    }

                    // Initialize BareMux connection
                    const connection = new BareMux.BareMuxConnection('/baremux/worker.js');

                    try {
                        console.log('[SW:HANDLER] Setting BareMux transport');
                        await connection.setTransport('/epoxy-transit/index.mjs', [{
                            wisp: wispConfig.wispurl
                        }]);
                        
                        scramjet.client = connection;
                        console.log('[SW:HANDLER] BareMux transport initialized');
                    } catch (err) {
                        console.error('[SW:HANDLER] Transport setup failed:', err);
                        return new Response("BareMux transport failed: " + err.message, {
                            status: 500,
                            statusText: "Internal Server Error"
                        });
                    }
                }

                // Proxy the request
                console.log('[SW:HANDLER] Proxying through BareMux:', e.url);
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
                console.error('[SW:HANDLER] Request handler error:', err.message);
                console.error('[SW:HANDLER] Full error:', err);
                return new Response("Proxy error: " + err.message, {
                    status: 502,
                    statusText: "Bad Gateway"
                });
            }
        })();
    });
}
