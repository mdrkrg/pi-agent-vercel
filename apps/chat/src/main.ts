import { mount } from "svelte";
import App from "./App.svelte";
import "water.css/out/light.css";
import "./style.css";

mount(App, { target: document.getElementById("app")! });
