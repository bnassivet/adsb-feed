// deck.gl-leaflet 1.3.1 declares "type": "module" but its "main" is a CommonJS
// file named .js, so a bundler that resolves "main" reads it as ESM and every
// export is undefined. DeckGlLeaflet.tsx imports the real ESM build instead.
declare module "deck.gl-leaflet/dist/deck.gl-leaflet.esm.js" {
  export * from "deck.gl-leaflet";
}
