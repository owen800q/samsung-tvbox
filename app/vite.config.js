// Build setup shared with samsung-bilibili.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import legacy from '@vitejs/plugin-legacy';

// Tizen packaged apps load over file:// (no HTTP server), so assets have no
// MIME type, and Chromium enforces strict MIME checking on
// `<script type="module">`. The bundle is therefore emitted by
// @vitejs/plugin-legacy with renderModernChunks:false: a *classic* SystemJS
// bundle (plain <script>, no type="module") for all browsers, which runs over
// file://, with core-js polyfills for the oldest supported engine
// (Tizen 4.0 / 2018 TVs = Chromium 56). SystemJS still handles dynamic
// import(), so hls.js stays lazy-loaded (the TV plays HLS natively).

// Shims applied to the built index.html. Strip `crossorigin` (file:// is a
// null origin; a stray crossorigin attr can fail an internal CORS check) and
// inline a globalThis polyfill before the bundle, in case anything runs ahead
// of the core-js polyfill chunk.
function tvCompat() {
  // Chromium < 61 (Tizen 4.0): scrollIntoView(options) is not supported
  // and an options object is coerced to alignToTop=true, which jumps the focused
  // card to the top edge. Map {block:'nearest'|'center'} onto Chrome's
  // non-standard scrollIntoViewIfNeeded(centerIfNeeded), which 53 has.
  const siv = `if(typeof Element!=='undefined'&&!('scrollBehavior' in document.documentElement.style)&&Element.prototype.scrollIntoViewIfNeeded){var _siv=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(o){if(o&&typeof o==='object'){if(o.block==='start')return _siv.call(this,true);if(o.block==='end')return _siv.call(this,false);return this.scrollIntoViewIfNeeded(o.block==='center');}return _siv.apply(this,arguments);};}`;
  const polyfill = `<script>if(typeof globalThis==='undefined'&&typeof window!=='undefined'){window.globalThis=window;}${siv}</script>`;
  return {
    name: 'tv-compat',
    // order:'post' so this runs AFTER plugin-legacy injects its SystemJS script
    // tags — otherwise the crossorigin it stamps on them survives.
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        html = html.replace(/\s+crossorigin/g, '');
        // Drop modulepreload hints: useless for the classic SystemJS bundle and
        // they trigger a "request mode does not match" warning over file://.
        html = html.replace(/\s*<link rel="modulepreload"[^>]*>/g, '');
        html = html.replace(/<head>/i, `<head>\n    ${polyfill}`);
        return html;
      },
    },
  };
}

export default defineConfig(() => ({
  plugins: [
    react(),
    // Emit a classic SystemJS bundle for EVERY browser (renderModernChunks:false
    // removes the ES-module output entirely) so it runs over file://. core-js
    // polyfills are injected based on usage.
    legacy({
      targets: ['chrome >= 53'],
      modernPolyfills: false,
      renderModernChunks: false,
    }),
    tvCompat(),
  ],
  base: './',
  build: {
    outDir: 'dist',
    // Lower modern syntax (optional chaining etc.) for older TV Chromium
    // (Tizen 4.0 = 56, 5.0 = 63, 5.5 = 69, 6.0 = 76); Chromium < 80 cannot
    // parse it and shows a black screen.
    target: 'chrome53',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 800, // hls.js (lazy, simulator only)
    rollupOptions: {
      output: {
        manualChunks: { 'react-vendor': ['react', 'react-dom'] },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  }
}));
