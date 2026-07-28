//@ts-ignore
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import { scramjetPath } from "@mercuryworkshop/scramjet/path";
import { refluxPath } from "@nightnetwork/reflux";
//@ts-ignore
import { enigmaPath } from "@nightnetwork/enigma/path";
import { baremuxPath as bmworkerPath } from "@nightnetwork/bm-plusworker/path";
import path from "path";
import fs from "fs";

export const routePaths = {
  epoxy: "epoxy",
  scramjet: "assets",
  libcurl: "libcurl",
  baremux: "baremux",
  uv: "data",
  reflux: "reflux",
  enigma: "enigma",
  auth: "",
  bmworker: "bmworker",
  plusClient: "plus",
  eruda: "core/i/eruda",
  chii: "core/i/chii",
  localforage: "core/localforage",
};

const authPath = path.resolve(
  "node_modules/@nightnetwork/night-auth/dist/login",
);
const plusClientPath = path.resolve(
  "node_modules/@nightnetwork/plus-client/dist",
);
const erudaPath = path.resolve("node_modules/eruda");
const chiiPath = path.resolve("node_modules/chii/public");
const localforagePath = path.resolve("node_modules/localforage/dist");
const copyMap = {
  epoxy: {
    path: epoxyPath,
    files: ["*"],
    dest: routePaths.epoxy,
  },
  uv: {
    path: uvPath,
    files: [
      { name: "uv.bundle.js", rename: "bundle.js" },
      { name: "uv.handler.js", rename: "handler.js" },
      { name: "uv.client.js", rename: "client.js" },
      { name: "uv.sw.js", rename: "worker.js" },
    ],
    dest: routePaths.uv,
  },
  scramjet: {
    path: scramjetPath,
    files: [
      { name: "scramjet.all.js", rename: "all.js" },
      { name: "scramjet.sync.js", rename: "sync.js" },
      { name: "scramjet.wasm.wasm", rename: "wasm.wasm" },
    ],
    dest: routePaths.scramjet,
  },
  libcurl: {
    path: libcurlPath,
    files: ["*"],
    dest: routePaths.libcurl,
  },
  baremux: {
    path: baremuxPath,
    files: ["*"],
    dest: routePaths.baremux,
  },
  reflux: {
    path: refluxPath,
    files: ["*"],
    dest: routePaths.reflux,
  },
  enigma: {
    path: enigmaPath,
    files: ["*"],
    dest: routePaths.enigma,
  },
  auth: {
    path: authPath,
    files: [
      "assets/nightloginflow.css",
      "night-login-frame.umd.js",
      "night-login.umd.js",
      "night-login.es.js.map",
      "vite.svg",
      "nightlogo.png",
      "nightloginflow.css",
      "bg_alt.jpeg",
      "nightplus.png",
      "nightplusheader.png",
      "nightplus_icon.png",
      "night-login-frame.es.js",
      "night-login.umd.js.map",
      "night-login-frame.es.js.map",
      "night-login-frame.umd.js.map",
      "night-login.es.js",
      "bg.png",
      "bg_alt_2.png",
    ],
    dest: routePaths.auth,
  },
  plusClient: {
    path: plusClientPath,
    files: ["*"],
    dest: routePaths.plusClient,
  },
  bmworker: {
    path: bmworkerPath,
    files: ["*"],
    dest: routePaths.bmworker,
  },
  eruda: {
    path: erudaPath,
    files: ["eruda.js"],
    dest: routePaths.eruda,
  },
  chii: {
    path: chiiPath,
    files: ["*"],
    dest: routePaths.chii,
  },
  localforage: {
    path: localforagePath,
    files: ["*"],
    dest: routePaths.localforage,
  },
};

function generateStaticCopyTargets(map: typeof copyMap) {
  const targets: any[] = [];

  for (const key in map) {
    const entry = map[key as keyof typeof copyMap];
    // These become GLOB patterns for vite-plugin-static-copy, and its matcher
    // treats "\" as an escape character — so on Windows the native absolute
    // paths these packages export never match anything and the build dies with
    // "No file was found to copy on ...\dist/*". Forward slashes work on every
    // platform, so normalising here is a no-op on POSIX.
    const basePath = String(entry.path).replace(/\\/g, "/");
    const files = entry.files;

    // vite-plugin-static-copy FAILS THE WHOLE BUILD if any target matches zero
    // files. Several of these lists are hard-coded against upstream packages
    // whose published contents have since changed (@nightnetwork/night-auth no
    // longer ships assets/nightloginflow.css or the night-login-frame.* files),
    // so one drifted optional asset killed an otherwise complete build. Skip
    // literal filenames that aren't on disk and log them; glob patterns ("*")
    // are passed through untouched so a genuinely empty package still errors.
    const keep = (src: string) => {
      if (src.includes("*") || fs.existsSync(src)) return true;
      console.log(`[copy] skipping missing optional asset: ${src}`);
      return false;
    };

    for (const file of files) {
      if (typeof file === "string") {
        const src = `${basePath}/${file}`;
        if (keep(src)) targets.push({ src, dest: entry.dest });
      } else {
        const src = `${basePath}/${file.name}`;
        if (keep(src)) targets.push({ src, dest: entry.dest, rename: file.rename });
      }
    }
  }

  targets.push({
    src: `node_modules/eruda/eruda.js`,
    dest: "core",
    rename: "inspect.js",
  });

  return targets;
}

export function copyRoutes() {
  return {
    targets: generateStaticCopyTargets(copyMap),
  };
}
