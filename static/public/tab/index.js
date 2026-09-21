"use strict";

let sjframe = null;

function getFrame() {
    if (!sjframe) {
        const el = document.getElementById("uv-frame");
        sjframe = scramjet.createFrame(el);
        sjframe.addEventListener("urlchange", function (event) {
            const url = event.url;
            document.getElementById("nav-bar-address").value = url;
            if (url.startsWith("https://")) {
                document.getElementById("https-lock").innerText = "lock";
            } else if (url.startsWith("http://")) {
                document.getElementById("https-lock").innerText = "lock_open_right";
            } else {
                document.getElementById("https-lock").innerText = "error";
            }
        });
    }
    return sjframe;
}

function openEruda() {
    const iframe = document.getElementById("uv-frame");
    const el = document.createElement("script");
    el.src = "eruda.js";
    iframe.contentDocument.body.append(el);
}

function proxyFullscreen() {
    let elem = document.getElementById("uv-frame");
    if (elem.requestFullscreen) {
        elem.requestFullscreen();
    } else if (elem.webkitRequestFullscreen) { /* Safari */
        elem.webkitRequestFullscreen();
    } else if (elem.msRequestFullscreen) { /* IE11 */
        elem.msRequestFullscreen();
    }
}

document.getElementById("nav-bar-form").addEventListener("submit", function (event) {
    const address = document.getElementById("nav-bar-address");
    const searchEngine = document.getElementById("uv-search-engine");

    event.preventDefault();

    const url = search(address.value, searchEngine.value);

    getFrame().go(url);
    document.getElementById("https-lock").innerText = "pending";
});

function windowPopout() {
    var win = window.open();
    var iframe = win.document.createElement('iframe');
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.border = "none";
    iframe.src = document.getElementById("uv-frame").src;
    win.document.body.appendChild(iframe);
}

function goForward() {
    if (sjframe) sjframe.forward();
}

function goBack() {
    if (sjframe) sjframe.back();
}

function reloadPage() {
    if (sjframe) sjframe.reload();
}

async function startProxy() {
    try {
        await registerSW();
    } catch (err) {
        alert("Error. Please contact a server administrator. Error Message: " + err.message);
    }

    await window.scramjetReady;

    let queryString = new URLSearchParams(window.location.search);
    var url = queryString.get("page");
    if (url) {
        url = decodeURIComponent(url);
    } else {
        url = document.getElementById("uv-start-page").value;
    }

    document.getElementById("nav-bar-address").value = "";
    document.getElementById("https-lock").innerText = "pending";
    getFrame().go(url);
}

startProxy();
