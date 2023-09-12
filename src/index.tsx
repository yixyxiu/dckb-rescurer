import { createRoot } from "react-dom/client";
import React from "react";
import { App } from "./App";

function startReactApp() {
    const placeholder = document.getElementById("dummy")!;
    const container = document.getElementById("app")!;
    const root = createRoot(container)
    placeholder.remove();
    root.render(<App />);
}

const button = document.getElementById('dummy-btn')!;
button.onclick = startReactApp;
if (button.getAttribute('disabled') === '') {
    startReactApp();
}