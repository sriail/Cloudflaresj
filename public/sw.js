/**
 * Service Worker for Scramjet Proxy
 * Handles all proxy routing and integrates with BareMux and Epoxy transit
 */

// Calculate the dynamic base path for the Service Worker.
const swPath = self.location.pathname;
const basePath = swPath.substring(0, swPath.lastIndexOf('/') + 1);

// Store Scramjet configuration
self.basePath = basePath;
self.$scramjet = {
    files: {
        wasm: '/sj-core/scramjet.wasm.wasm',    // Note: Double .wasm extension is intentional (Scramjet naming convention)
        sync: '/sj-core/scramjet.sync.js',
    }
};

// Attempt to import Scramjet core scripts
let ScramjetServiceWorker = null;

try {
    // Import Scramjet core scripts
    importScripts('/sj-core/scramjet.all.js');

    // Check if the Scramjet worker loader is available
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

/**
 * Ensure the "$scramjet" IndexedDB database has all required object stores.
 *
 * ScramjetServiceWorker opens this database in its constructor and in
 * loadConfig() but does NOT provide an onupgradeneeded handler.  On a
 * fresh install that means the database is created empty, causing every
 * subsequent objectStore() call to throw NotFoundError inside an async
 * callback whose Promise is never resolved or rejected — freezing every
 * fetch event indefinitely.
 *
 * We open the database here with an onupgradeneeded handler so the
 * stores exist before Scramjet ever touches the database.  If the
 * database was previously created empty (version 1, no stores) we
 * delete and recreate it because IDB versioning prevents adding stores
 * without a version bump once the database already exists at version 1.
 */
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

            // Database is at version 1 but is missing stores (it was created
            // by an earlier open call that had no onupgradeneeded handler).
            // Delete it so we can recreate it with all required stores.
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

        req.onerror = () => resolve(); // Don't block on unexpected IDB errors
    });
}

// =====================================================================
// LAZY SCRAMJET INITIALIZATION
// =====================================================================

/**
 * ScramjetServiceWorker is constructed lazily, after the IDB schema is
 * guaranteed to exist.  A single Promise is used so construction happens
 * exactly once regardless of how many concurrent fetch events trigger it.
 */
let scramjet = null;
let scramjetInitPromise = null;

function initScramjet() {
    if (scramjetInitPromise) return scramjetInitPromise;

    scramjetInitPromise = ensureIDBSchema().then(() => {
        if (!ScramjetServiceWorker) return;
        try {
            scramjet = new ScramjetServiceWorker();
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
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // Wait for Scramjet (and IDB schema) to be ready before claiming clients
    // so that the first fetch event is never handled with an uninitialised SW.
    event.waitUntil(
        initScramjet().then(() => self.clients.claim())
    );
});

// =====================================================================
// WISP CONFIGURATION
// =====================================================================

let wispConfig = {};

// Ensure SW always has a fallback WISP URL even if postMessage never arrives.
function getDefaultWispUrl() {
    const wsProtocol = self.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${self.location.host}/wisp/`;
}

wispConfig.wispurl = getDefaultWispUrl();

// Prevent race condition: Create a promise that resolves when the config message is received
let resolveConfigReady;
const configReadyPromise = new Promise(resolve => {
    resolveConfigReady = resolve;
});

// Set a timeout for config message (10 seconds)
let configTimeout = setTimeout(() => {
    console.warn('Service Worker: Config message not received within 10 seconds, using default WISP URL');
    if (!wispConfig.wispurl) {
        wispConfig.wispurl = getDefaultWispUrl();
    }
    if (resolveConfigReady) {
        resolveConfigReady();
        resolveConfigReady = null;
    }
}, 10000);

// Resolve immediately if default config exists.
if (resolveConfigReady && wispConfig.wispurl) {
    resolveConfigReady();
    resolveConfigReady = null;
}

// Listen for configuration from the main page
self.addEventListener("message", ({ data }) => {
    if (!data) return;

    if (data.type === "config" && data.wispurl) {
        wispConfig.wispurl = data.wispurl;
        console.log('Service Worker received WISP URL:', data.wispurl);

        // Clear timeout and resolve
        if (configTimeout) {
            clearTimeout(configTimeout);
            configTimeout = null;
        }

        if (resolveConfigReady) {
            resolveConfigReady();
            resolveConfigReady = null;
        }
    }

    // The page sends this after scramjet.init() has written the Scramjet config
    // to IDB.  Scramjet's own postMessage targets navigator.serviceWorker.controller
    // which can be null on the very first install (controller not yet set until
    // clients.claim() fires).  This message lets us load the config from IDB
    // even when that automatic postMessage was dropped.
    if (data.type === "triggerLoadConfig" && scramjet && !scramjet.config) {
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
        await initScramjet();

        if (!scramjet) {
            return fetch(event.request);
        }

        try {
            // Wait for config if not yet loaded
            if (!scramjet.config) {
                try {
                    await scramjet.loadConfig();
                } catch (err) {
                    console.warn('Failed to load Scramjet config:', err);
                    return fetch(event.request);
                }
            }

            if (scramjet.route(event)) {
                return await scramjet.fetch(event);
            }
        } catch (err) {
            console.error('Scramjet processing error:', err);
        }

        return fetch(event.request);
    })());
});

// =====================================================================
// SCRAMJET REQUEST HANDLER
// =====================================================================

// Called once from initScramjet() after the instance is created.
function setupScramjetRequestHandler() {
    scramjet.addEventListener("request", async (e) => {
        e.response = (async () => {
            try {
                // Use a single, persistent BareMux client instance on the scramjet object
                if (!scramjet.client) {
                    // Wait for the WISP URL to be sent from the main page (or default fallback)
                    await configReadyPromise;

                    if (!wispConfig.wispurl) {
                        wispConfig.wispurl = getDefaultWispUrl();
                    }

                    // Check if BareMux is available
                    if (typeof BareMux === 'undefined') {
                        console.error("BareMux is not available.");
                        return new Response("BareMux not available.", {
                            status: 500,
                            statusText: "Internal Server Error"
                        });
                    }

                    // Initialize BareMux connection
                    const connection = new BareMux.BareMuxConnection('/baremux/worker.js');

                    try {
                        // Set Epoxy/libcurl transport with WISP server
                        await connection.setTransport('/epoxy-transit/index.mjs', [{
                            wisp: wispConfig.wispurl
                        }]);

                        // Store the connection for future requests
                        scramjet.client = connection;
                    } catch (err) {
                        console.error('Failed to set BareMux transport:', err);
                        return new Response("BareMux configuration failed.", {
                            status: 500,
                            statusText: "Internal Server Error"
                        });
                    }
                }

                // Fetch through the BareMux client
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
                console.error('Scramjet request handler error:', err);
                return new Response("Proxy error: " + err.message, {
                    status: 502,
                    statusText: "Bad Gateway"
                });
            }
        })();
    });
}
