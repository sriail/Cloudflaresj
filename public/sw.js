/**
 * Service Worker for Scramjet Proxy
 *
 * Critical ordering rules
 * -----------------------
 * 1. ALL self.addEventListener() calls must be at the top level (not inside
 *    Promises or async functions) — the browser enforces this for 'message'.
 * 2. new ScramjetServiceWorker() registers its own "message" listener in the
 *    constructor, so it must also be called at the top level.
 */

// =====================================================================
// STEP 1: TOP-LEVEL EVENT LISTENERS
// =====================================================================

self.addEventListener("message", ({ data }) => {
    if (!data) return;
    // {scramjet$type: "loadConfig"} is handled by ScramjetServiceWorker's
    // built-in constructor listener. {type: "config"} messages from the page
    // are accepted here for forward-compat but WISP URL is configured by the
    // page-side BareMuxConnection.setTransport() call, so no action needed.
});

self.addEventListener('install', () => {
    console.log('[SW] Installing...');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[SW] Activating...');
    event.waitUntil(
        ensureIDBSchema()
            .then(() => {
                console.log('[SW] Claiming clients...');
                return self.clients.claim();
            })
            .catch(err => {
                console.error('[SW] Activation error:', err);
                return self.clients.claim();
            })
    );
});

self.addEventListener("fetch", (event) => {
    event.respondWith(handleFetch(event));
});

// =====================================================================
// STEP 2: LOAD SCRAMJET + BAREMUX SCRIPTS
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
// STEP 3: CREATE ScramjetServiceWorker AT TOP LEVEL
//
// Must be top-level so the constructor's addEventListener("message", ...)
// is registered at initial script evaluation (browser requirement).
// =====================================================================

let scramjet = null;

if (ScramjetServiceWorker) {
    try {
        scramjet = new ScramjetServiceWorker();
        console.log('[SW] ScramjetServiceWorker created');
        setupScramjetRequestHandler();
    } catch (err) {
        console.error('[SW] Failed to create ScramjetServiceWorker:', err);
    }
}

// =====================================================================
// STEP 4: INDEXEDDB SCHEMA HELPER
// =====================================================================

const IDB_STORES = ['config', 'cookies', 'redirectTrackers', 'referrerPolicies', 'publicSuffixList'];

function ensureIDBSchema() {
    return new Promise((resolve) => {
        const req = indexedDB.open('$scramjet', 1);

        req.onupgradeneeded = () => {
            const db = req.result;
            IDB_STORES.forEach(store => {
                if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
            });
        };

        req.onsuccess = () => {
            const db = req.result;
            const missing = IDB_STORES.filter(s => !db.objectStoreNames.contains(s));
            db.close();

            if (missing.length === 0) { resolve(); return; }

            // Some stores are missing (DB existed at wrong version); recreate.
            const del = indexedDB.deleteDatabase('$scramjet');
            del.onsuccess = del.onerror = () => {
                const newReq = indexedDB.open('$scramjet', 1);
                newReq.onupgradeneeded = () => {
                    const db = newReq.result;
                    IDB_STORES.forEach(s => db.createObjectStore(s));
                };
                newReq.onsuccess = () => { newReq.result.close(); resolve(); };
                newReq.onerror = () => resolve();
            };
        };

        req.onerror = () => resolve();
    });
}

// =====================================================================
// STEP 5: IDB-BASED CONFIG LOADER
//
// Scramjet's built-in message handler sets scramjet.config from the
// {scramjet$type:"loadConfig"} postMessage but does NOT call Nk() to
// set the module-level $W global. URL-rewriting functions access $W
// (not this.config), so a full IDB read via loadConfig() — which calls
// Nk($W) — must happen before any proxied request is served.
// =====================================================================

let scramjetIDBLoaded = false;
let scramjetIDBLoadPromise = null;

function forceScramjetConfigFromIDB() {
    if (scramjetIDBLoaded) return Promise.resolve();
    // Deduplication: all concurrent callers await the same in-flight Promise.
    // This also prevents scramjet.config from being set to null more than once.
    if (scramjetIDBLoadPromise) return scramjetIDBLoadPromise;

    // Peek at IDB to confirm the config key is populated before calling
    // loadConfig(). loadConfig() crashes (hangs forever) when called on a DB
    // without a valid config entry because Nk(undefined) throws inside the
    // IDB onsuccess callback and the Promise never resolves or rejects.
    const peekPromise = new Promise(resolve => {
        const req = indexedDB.open('$scramjet', 1);

        // Create stores if this is a fresh DB (avoids creating an empty DB
        // that would later require ensureIDBSchema to delete and recreate).
        req.onupgradeneeded = () => {
            const db = req.result;
            IDB_STORES.forEach(s => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s); });
        };

        req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('config')) {
                db.close();
                resolve(false);
                return;
            }
            const getReq = db.transaction('config', 'readonly').objectStore('config').get('config');
            getReq.onsuccess = () => {
                db.close();
                const cfg = getReq.result;
                resolve(cfg != null && cfg.prefix != null);
            };
            getReq.onerror = () => { db.close(); resolve(false); };
        };
        req.onerror = () => resolve(false);
    });

    scramjetIDBLoadPromise = peekPromise.then(hasConfig => {
        // IDB not yet populated (page hasn't called scramjet.init() yet).
        // finally() resets scramjetIDBLoadPromise so the next fetch retries.
        if (!hasConfig) return;

        // loadConfig() reads IDB and calls Nk(config) which sets the module-level
        // $W global that URL-rewriting functions use. The built-in SW message
        // handler only does `this.config = t.config` (no Nk call), so without
        // this explicit IDB read, $W stays undefined and fetch() crashes.
        // Clearing this.config first ensures loadConfig() performs the full read.
        // This is safe because all concurrent callers are awaiting scramjetIDBLoadPromise
        // (deduplication above), so no other code path inspects this.config while null.
        scramjet.config = null;

        return scramjet.loadConfig()
            .then(() => {
                scramjetIDBLoaded = !!scramjet.config;
                if (scramjetIDBLoaded) {
                    console.log('[SW] Config ready from IDB, prefix:', scramjet.config.prefix);
                } else {
                    console.warn('[SW] loadConfig() returned without setting config');
                }
            });
    }).catch(err => {
        // Log and swallow so finally() always runs to allow retry on next request.
        console.warn('[SW] forceScramjetConfigFromIDB error:', err);
    }).finally(() => {
        // If loading succeeded, scramjetIDBLoaded=true prevents future calls.
        // If it failed or IDB was empty, reset the promise so the next fetch
        // can retry once the page has written the config to IDB.
        if (!scramjetIDBLoaded) scramjetIDBLoadPromise = null;
    });

    return scramjetIDBLoadPromise;
}

// =====================================================================
// STEP 6: FETCH HANDLER
// =====================================================================

async function handleFetch(event) {
    const url = event.request.url;

    try {
        if (!scramjet) return fetch(event.request);

        // Ensure $W is populated via a full IDB read before routing.
        await forceScramjetConfigFromIDB();

        if (!scramjet.config) return fetch(event.request);

        const shouldRoute = scramjet.route(event);
        console.log('[SW:FETCH] URL:', url, 'Route:', shouldRoute);

        if (shouldRoute) {
            try {
                return await scramjet.fetch(event);
            } catch (err) {
                console.error('[SW:FETCH] Scramjet proxy error:', err.message);
                return new Response("Proxy error: " + err.message, {
                    status: 500,
                    statusText: "Internal Server Error"
                });
            }
        }
    } catch (err) {
        console.error('[SW:FETCH] Unexpected error:', err);
    }

    return fetch(event.request);
}

// =====================================================================
// STEP 7: SCRAMJET REQUEST HANDLER
//
// Called by scramjet.fetch() for each proxied request.
// scramjet.client is the BareClient created by ScramjetServiceWorker's
// constructor; it uses the BareMux SharedWorker channel (port exchanged
// with the page client that called BareMuxConnection.setTransport()).
// =====================================================================

function setupScramjetRequestHandler() {
    // Scramjet awaits e.response (see: `await E.response || await this.client.fetch(...)`)
    // so assigning a Promise here is the correct pattern for this API.
    // scramjet.client is set by ScramjetServiceWorker's constructor and is
    // always non-null by the time setupScramjetRequestHandler() is called.
    scramjet.addEventListener("request", (e) => {
        if (!scramjet.client) {
            e.response = Promise.resolve(new Response("BareMux client not available", {
                status: 502,
                statusText: "Bad Gateway"
            }));
            return;
        }
        e.response = scramjet.client.fetch(e.url, {
            method: e.method,
            body: e.body,
            headers: e.requestHeaders,
            credentials: "omit",
            mode: e.mode === "cors" ? e.mode : "same-origin",
            cache: e.cache,
            redirect: "manual",
            duplex: "half",
        }).catch(err => {
            console.error('[SW:HANDLER] Request error:', err.message);
            return new Response("Proxy error: " + err.message, {
                status: 502,
                statusText: "Bad Gateway"
            });
        });
    });
}
