importScripts('../epoxy/index.js');
importScripts('uv.bundle.js');
importScripts('uv.config.js');
importScripts(__uv$config.sw || 'uv.sw.js');

const uv = new UVServiceWorker();

// Poki's game hosts (games.poki.com, *.gdn.poki.com, game-cdn.poki.com, api.poki.com)
// reject any request whose Referer isn't poki.com with a 403. Ultraviolet forwards a
// Referer built from the proxied page's origin, so we force a valid Poki referer here.
const POKI_HOST = /(^|\.)poki\.com$/i;
const POKI_CDN_HOST = /(^|\.)poki-cdn\.com$/i;
const bareFetch = uv.bareClient.fetch.bind(uv.bareClient);

uv.bareClient.fetch = function (url, options) {
    try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (POKI_HOST.test(host) || POKI_CDN_HOST.test(host)) {
            options.headers = Object.assign({}, options.headers, {
                referer: "https://poki.com/",
                origin: "https://poki.com",
            });
        }
    } catch (e) {
        // non-URL (e.g. blob:) or missing options, nothing to do
    }
    return bareFetch(url, options);
};

self.addEventListener('fetch', event => {
    event.respondWith(
        (async ()=>{
            if(uv.route(event)) {
                return await uv.fetch(event);
            }
            return await fetch(event.request);
        })()
    );
});
