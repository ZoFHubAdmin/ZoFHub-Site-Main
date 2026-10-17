self.__uv$config = {
  prefix: "/interstellar/uv/",
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: "/interstellar/assets/ultraviolet/uv.handler.js",
  client: "/interstellar/assets/ultraviolet/uv.client.js",
  bundle: "/interstellar/assets/ultraviolet/uv.bundle.js",
  config: "/interstellar/assets/ultraviolet/uv.config.js",
  sw: "/interstellar/assets/ultraviolet/uv.sw.js",
};
