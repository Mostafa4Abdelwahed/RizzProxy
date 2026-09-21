"use strict";

let sjframe = null;

function showProxy() {
  let div = document.getElementById("proxy-div");
  div.classList = ["show-proxy-div"];
}

async function openGame(url) {
  try {
    await registerSW();
  } catch (err) {
    alert("Error. Please contact a server administrator. Error Message: " + err.message);
  }

  await window.scramjetReady;

  showProxy();

  if (!sjframe) {
    sjframe = scramjet.createFrame(document.getElementById("uv-frame"));
  }
  sjframe.go(url);
}
