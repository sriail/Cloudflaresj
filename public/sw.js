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

// Initialize Scramjet service worker instance only if available
let scramjet = null;
if (ScramjetServiceWorker) {
    try {
        scramjet = new ScramjetServiceWorker({
            prefix: '/sj-core/',
        });
    } catch (err) {
        console.error('Failed to initialize ScramjetServiceWorker:', err);
    }
}


// =====================================================================
// SERVICE WORKER LIFECYCLE
// =====================================================================

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// =====================================================================
// WISP CONFIGURATION
// =====================================================================

let wispConfig = {};

// Prevent race condition: Create a promise that resolves when the config message is received
let resolveConfigReady;
const configReadyPromise = new Promise(resolve => {
    resolveConfigReady = resolve;
});

// Listen for configuration from the main page
self.addEventListener("message", ({ data }) => {
    if (data.type === "config" && data.wispurl) {
        wispConfig.wispurl = data.wispurl;
        console.log('Service Worker received WISP URL:', data.wispurl);
        if (resolveConfigReady) {
            resolveConfigReady();
            resolveConfigReady = null; // Ensure it only resolves once
        }
    }
});

// =====================================================================
// PROXY ROUTING
// =====================================================================

// Main fetch handler - routes through Scramjet
self.addEventListener("fetch", (event) => {
    event.respondWith((async () => {
        // If Scramjet is not available, pass through to network
        if (!scramjet) {
            return fetch(event.request);
        }

        try {
            // Wait for the scramjet config to be loaded before routing
            // This can prevent race conditions on initial load
            await scramjet.loadConfig();
            
            // Check if Scramjet should route this request
            if (scramjet.route(event)) {
                return await scramjet.fetch(event);
            }
        } catch (err) {
            console.error('Scramjet fetch error:', err);
        }
        
        // Pass through non-routed requests to network
        return fetch(event.request);
    })());
});

// =====================================================================
// SCRAMJET REQUEST HANDLER
// =====================================================================

// The main Scramjet listener where the proxying logic happens
if (scramjet) {
    scramjet.addEventListener("request", async (e) => {
        e.response = (async () => {
            try {
                // Use a single, persistent BareMux client instance on the scramjet object
                if (!scramjet.client) {
                    // Wait for the WISP URL to be sent from the main page
                    await configReadyPromise;

                    if (!wispConfig.wispurl) {
                        console.error("WISP URL is missing. Cannot configure BareMux.");
                        return new Response("WISP URL configuration failed in SW.", { 
                            status: 500, 
                            statusText: "Internal Server Error" 
                        });
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
