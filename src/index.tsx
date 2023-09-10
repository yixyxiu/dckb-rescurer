import { createRoot } from "react-dom/client";
import React from "react";
import { App } from "./App";

const placeholder = document.getElementById("app-placeholder")!;
const container = document.getElementById("app")!;
const root = createRoot(container)
placeholder.remove();
root.render(<App />);