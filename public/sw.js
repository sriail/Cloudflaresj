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
        wasm: '/sj-core/scramjet.wasm.wasm',
        sync: '/sj-core/scramjet.sync.js',
    }
};

// Import Scramjet core scripts
importScripts('/sj-core/scramjet.all.js');

// Import BareMux for the service worker
importScripts('/baremux/index.js');

// Load the Scramjet service worker worker
const { ScramjetServiceWorker } = $scramjetLoadWorker();

// Initialize Scramjet service worker instance
const scramjet = new ScramjetServiceWorker({
    prefix: '/sj-core/',
});

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
        // Wait for the scramjet config to be loaded before routing
        // This can prevent race conditions on initial load
        await scramjet.loadConfig();
        
        // Check if Scramjet should route this request
        if (scramjet.route(event)) {
            return scramjet.fetch(event);
        }
        
        // Pass through non-routed requests to network
        return fetch(event.request);
    })());
});

// =====================================================================
// SCRAMJET REQUEST HANDLER
// =====================================================================

// The main Scramjet listener where the proxying logic happens
scramjet.addEventListener("request", async (e) => {
    e.response = (async () => {
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

            // Initialize BareMux connection
            const connection = new BareMux.BareMuxConnection('/baremux/worker.js');
            
            // Set Epoxy/libcurl transport with WISP server
            await connection.setTransport('/epoxy-transit/index.mjs', [{ 
                websocket: wispConfig.wispurl 
            }]);
            
            // Store the connection for future requests
            scramjet.client = connection;
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
    })();
});
