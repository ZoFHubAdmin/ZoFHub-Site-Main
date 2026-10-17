self.__scramjet$config = {
  prefix: "/interstellar/uv/scramjet/",
  codec: {
    encode: url => url && encodeURIComponent(url),
    decode: url => url && decodeURIComponent(url),
  },
  files: {
    wasm: "/interstellar/assets/scramjet/scramjet.wasm.wasm",
    all: "/interstellar/assets/scramjet/scramjet.all.js",
    sync: "/interstellar/assets/scramjet/scramjet.sync.js",
  },
  flags: {
    rewriterLogs: false,
    scramitize: false,
    cleanErrors: true,
    sourcemaps: true,
  },
};
