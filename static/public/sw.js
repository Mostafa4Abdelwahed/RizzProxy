importScripts("/scram/scramjet.all.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

// Poki's game hosts (games.poki.com, *.gdn.poki.com, game-cdn.poki.com, api.poki.com)
// reject any request whose Referer isn't poki.com with a 403. Scramjet forwards a
// Referer derived from the proxied page, so we force a valid Poki referer here.
const POKI_HOST = /(^|\.)poki\.com$/i;
const POKI_CDN_HOST = /(^|\.)poki-cdn\.com$/i;
const bareFetch = scramjet.client.fetch.bind(scramjet.client);

scramjet.client.fetch = function (url, options) {
    try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (POKI_HOST.test(host) || POKI_CDN_HOST.test(host)) {
            options.headers = Object.assign({}, options.headers, {
                referer: "https://poki.com/",
                origin: "https://poki.com",
            });
        }
    } catch (e) {
        // non-URL or missing options, nothing to do
    }
    return bareFetch(url, options);
};

async function handleRequest(event) {
    await scramjet.loadConfig();
    if (scramjet.route(event)) {
        return scramjet.fetch(event);
    }
    return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event));
});
