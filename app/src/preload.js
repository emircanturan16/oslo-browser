const { contextBridge, ipcRenderer, webFrame } = require('electron');

// ─── COSMETIC FILTER CSS ────────────────────────────────────────────────────────
const cosmeticFilterCSS = `
  [id*="google_ads"],
  [id*="GoogleAds"],
  [class*="GoogleAds"],
  #ad-container, .ad-container,
  [id*="-ad-container"], [class*="-ad-container"],
  [id*="_ad-container"], [class*="_ad-container"],
  [id^="ad-container-"], [class^="ad-container-"],
  [id^="ad_container_"], [class^="ad_container_"],
  #ad_container, .ad_container,
  [id*="-ad_container"], [class*="-ad_container"],
  [id*="_ad_container"], [class*="_ad_container"],
  #adBanner, .adBanner,
  [id*="-adBanner"], [class*="-adBanner"],
  [id*="_adBanner"], [class*="_adBanner"],
  [id^="adBanner-"], [class^="adBanner-"],
  #ad-banner, .ad-banner,
  [id*="-ad-banner"], [class*="-ad-banner"],
  [id*="_ad-banner"], [class*="_ad-banner"],
  [id^="ad-banner-"], [class^="ad-banner-"],
  #ad_banner, .ad_banner,
  [id*="-ad_banner"], [class*="-ad_banner"],
  [id*="_ad_banner"], [class*="_ad_banner"],
  [data-ad],
  [data-ad-slot],
  [data-ad-client],
  [data-google-query-id],
  [data-ad-manager-id],
  ins.adsbygoogle,
  div[id^="div-gpt-ad"],
  iframe[src*="doubleclick.net"],
  iframe[src*="googlesyndication"],
  iframe[id*="google_ads"],
  iframe[name*="google_ads"],
  .adsbygoogle,
  .ad-slot,
  .sponsored-content,
  .native-ad,
  .promoted-content,
  a[href*="doubleclick.net"],

  /* YouTube */
  .ad-showing .video-ads,
  .ytp-ad-module,
  .ytp-ad-overlay-container,
  .ytp-ad-text-overlay,
  .ytp-ad-overlay-close-button,
  .ytp-ad-overlay-ad-info-button-container,
  .ytp-ad-overlay-slot,
  .ytp-ad-image-overlay,
  .ytp-ad-overlay-image,
  #player-ads,
  #masthead-ad,
  #merch-shelf,
  #offer-module,
  #movie-offer,
  #sparkles-container,
  ytd-ad-slot-renderer,
  ytd-rich-item-renderer:has(.ytd-ad-slot-renderer),
  ytd-in-feed-ad-layout-renderer,
  ytd-banner-promo-renderer,
  ytd-video-masthead-ad-v3-renderer,
  ytd-video-masthead-ad-advertiser-info-renderer,
  ytd-primetime-promo-renderer,
  ytd-display-ad-renderer,
  ytd-statement-banner-renderer,
  ytd-promoted-sparkles-text-search-renderer,
  ytd-promoted-video-renderer,
  ytd-compact-promoted-video-renderer,
  ytd-promoted-sparkles-web-renderer,
  ytd-action-companion-ad-renderer,
  ytd-player-legacy-desktop-watch-ads-renderer,
  ytm-promoted-sparkles-web-renderer,
  ytm-companion-ad-renderer,
  .ytd-mealbar-promo-renderer,
  ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
  #related ytd-promoted-video-renderer,
  tp-yt-paper-dialog:has(#dismiss-button),
  .ytp-suggested-action,
  .iv-branding,
  .annotation,
  .ytp-ce-element,
  ytd-movie-offer-module-renderer
  { display: none !important; }
`;

// ─── ANTI-FINGERPRINTING SHIELD ─────────────────────────────────────────────────
function runAntiFingerprint() {
  'use strict';
  if (window.__osloAntiFingerprintActive) return;
  window.__osloAntiFingerprintActive = true;

  // ── Noise seed (random per page load) ──
  const seed = Math.random() * 10000;
  function noise(x) {
    const n = Math.sin(seed + x) * 10000;
    return n - Math.floor(n);
  }

  // ── Canvas Fingerprint Protection ──
  try {
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (sx, sy, sw, sh) {
      const imageData = origGetImageData.call(this, sx, sy, sw, sh);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        if (noise(i + seed) > 0.9) {
          data[i] = Math.max(0, Math.min(255, data[i] + (noise(i) > 0.5 ? 1 : -1)));
          data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + (noise(i + 1) > 0.5 ? 1 : -1)));
          data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + (noise(i + 2) > 0.5 ? 1 : -1)));
        }
      }
      return imageData;
    };

    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (type, quality) {
      const ctx = this.getContext('2d');
      if (ctx) {
        try {
          const w = this.width, h = this.height;
          if (w > 0 && h > 0) {
            const imgData = ctx.getImageData(0, 0, w, h);
            ctx.putImageData(imgData, 0, 0);
          }
        } catch (e) { }
      }
      return origToDataURL.call(this, type, quality);
    };

    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      const ctx = this.getContext('2d');
      if (ctx) {
        try {
          const w = this.width, h = this.height;
          if (w > 0 && h > 0) {
            const imgData = ctx.getImageData(0, 0, w, h);
            ctx.putImageData(imgData, 0, 0);
          }
        } catch (e) { }
      }
      return origToBlob.call(this, callback, type, quality);
    };
  } catch (e) { }

  // ── WebGL Fingerprint Protection ──
  try {
    const origGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      // UNMASKED_VENDOR_WEBGL
      if (param === 0x9245) return 'Google Inc. (Intel)';
      // UNMASKED_RENDERER_WEBGL
      if (param === 0x9246) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
      return origGetParameter.call(this, param);
    };

    const origGetExtension = WebGLRenderingContext.prototype.getExtension;
    WebGLRenderingContext.prototype.getExtension = function (name) {
      if (name === 'WEBGL_debug_renderer_info') {
        return {
          UNMASKED_VENDOR_WEBGL: 0x9245,
          UNMASKED_RENDERER_WEBGL: 0x9246
        };
      }
      return origGetExtension.call(this, name);
    };

    const origReadPixels = WebGLRenderingContext.prototype.readPixels;
    WebGLRenderingContext.prototype.readPixels = function (x, y, width, height, format, type, pixels) {
      origReadPixels.call(this, x, y, width, height, format, type, pixels);
      for (let i = 0; i < pixels.length; i++) {
        if (noise(i + seed) > 0.95) {
          pixels[i] = Math.max(0, Math.min(255, pixels[i] + (noise(i) > 0.5 ? 1 : -1)));
        }
      }
    };

    if (typeof WebGL2RenderingContext !== 'undefined') {
      const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (param) {
        if (param === 0x9245) return 'Google Inc. (Intel)';
        if (param === 0x9246) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
        return origGetParameter2.call(this, param);
      };

      const origGetExtension2 = WebGL2RenderingContext.prototype.getExtension;
      WebGL2RenderingContext.prototype.getExtension = function (name) {
        if (name === 'WEBGL_debug_renderer_info') {
          return {
            UNMASKED_VENDOR_WEBGL: 0x9245,
            UNMASKED_RENDERER_WEBGL: 0x9246
          };
        }
        return origGetExtension2.call(this, name);
      };

      const origReadPixels2 = WebGL2RenderingContext.prototype.readPixels;
      WebGL2RenderingContext.prototype.readPixels = function (x, y, width, height, format, type, pixels) {
        origReadPixels2.call(this, x, y, width, height, format, type, pixels);
        for (let i = 0; i < pixels.length; i++) {
          if (noise(i + seed) > 0.95) {
            pixels[i] = Math.max(0, Math.min(255, pixels[i] + (noise(i) > 0.5 ? 1 : -1)));
          }
        }
      };
    }
  } catch (e) { }

  // ── AudioContext Fingerprint Protection ──
  try {
    const AC = typeof AudioContext !== 'undefined' ? AudioContext : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
    if (AC) {
      const origCreateAnalyser = AC.prototype.createAnalyser;
      AC.prototype.createAnalyser = function () {
        const analyser = origCreateAnalyser.call(this);
        const origGetFloatFreqData = analyser.getFloatFrequencyData.bind(analyser);
        analyser.getFloatFrequencyData = function (array) {
          origGetFloatFreqData(array);
          for (let i = 0; i < array.length; i++) {
            array[i] += (noise(i + seed) - 0.5) * 0.1;
          }
        };
        return analyser;
      };

      if (typeof OfflineAudioContext !== 'undefined') {
        const origRender = OfflineAudioContext.prototype.startRendering;
        OfflineAudioContext.prototype.startRendering = function () {
          return origRender.call(this).then(buffer => {
            for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
              const data = buffer.getChannelData(ch);
              for (let i = 0; i < data.length; i++) {
                data[i] += (noise(i + ch * 1000 + seed) - 0.5) * 0.0001;
              }
            }
            return buffer;
          });
        };
      }
    }
  } catch (e) { }

  // ── Navigator properties spoofing ──
  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  } catch (e) { }
  try {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  } catch (e) { }
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const mimes = [
          { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" }
        ];
        const mockPlugin = {
          name: "Chrome PDF Viewer",
          filename: "internal-pdf-viewer",
          description: "Portable Document Format",
          length: mimes.length,
          item: (index) => mimes[index],
          namedItem: (name) => mimes.find(m => m.type === name)
        };
        return {
          length: 1,
          item: (index) => index === 0 ? mockPlugin : null,
          namedItem: (name) => name === "Chrome PDF Viewer" ? mockPlugin : null,
          refresh: () => { },
          [Symbol.iterator]: function* () { yield mockPlugin; }
        };
      }
    });
  } catch (e) { }
  try {
    Object.defineProperty(navigator, 'mimeTypes', {
      get: () => {
        const mockMime = {
          type: "application/pdf",
          suffixes: "pdf",
          description: "Portable Document Format",
          enabledPlugin: { name: "Chrome PDF Viewer" }
        };
        return {
          length: 1,
          item: (index) => index === 0 ? mockMime : null,
          namedItem: (name) => name === "application/pdf" ? mockMime : null,
          [Symbol.iterator]: function* () { yield mockMime; }
        };
      }
    });
  } catch (e) { }

  // ── Screen resolution spoofing ──
  try {
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
  } catch (e) { }

  // ── Battery API blocking ──
  if (navigator.getBattery) {
    navigator.getBattery = () => Promise.reject(new Error('Battery API is not available'));
  }

  // ── Block sendBeacon to known trackers ──
  try {
    const origSendBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function (url, data) {
      if (typeof url === 'string') {
        const l = url.toLowerCase();
        if (l.includes('google-analytics') || l.includes('doubleclick') ||
          l.includes('googlesyndication') || l.includes('googletagmanager') ||
          l.includes('facebook.net') || l.includes('analytics') ||
          l.includes('/collect') || l.includes('/beacon') ||
          l.includes('scorecardresearch') || l.includes('quantserve') ||
          l.includes('comscore') || l.includes('demdex') ||
          l.includes('bluekai') || l.includes('krxd') ||
          l.includes('moatads') || l.includes('doubleverify')) {
          return true; // Pretend it was sent successfully
        }
      }
      return origSendBeacon.call(navigator, url, data);
    };
  } catch (e) { }

  // ── Prevent WebRTC IP leak (basic) ──
  try {
    if (typeof RTCPeerConnection !== 'undefined') {
      const origRTC = RTCPeerConnection;
      window.RTCPeerConnection = function (config, constraints) {
        const pc = new origRTC(config, constraints);
        return pc;
      };
      window.RTCPeerConnection.prototype = origRTC.prototype;
    }
  } catch (e) { }
}

// ─── GENERIC AD BLOCKER SCRIPT ──────────────────────────────────────────────────
function runGenericAdBlocker() {
  'use strict';
  if (window.__osloGenericAdBlockActive) return;
  window.__osloGenericAdBlockActive = true;

  function cleanAds() {
    try {
      document.querySelectorAll('iframe').forEach(iframe => {
        try {
          const src = (iframe.src || '').toLowerCase();
          if (src.includes('doubleclick.net') || src.includes('googlesyndication.com') ||
            src.includes('googleadservices.com') || src.includes('adnxs.com') ||
            src.includes('taboola.com') || src.includes('outbrain.com') ||
            src.includes('criteo') || src.includes('amazon-adsystem') ||
            src.includes('popads.net') || src.includes('exoclick.com') ||
            src.includes('buysellads.com') || src.includes('/ads/') ||
            src.includes('/pagead/')) {
            iframe.remove();
          }
        } catch (e) { }
      });
      document.querySelectorAll('[data-ad], [data-ad-slot], [data-ad-client], [data-google-query-id]').forEach(el => el.remove());
      document.querySelectorAll('ins.adsbygoogle, .adsbygoogle').forEach(el => el.remove());
      document.querySelectorAll('div[id^="div-gpt-ad"]').forEach(el => el.remove());
    } catch (e) { }
  }

  if (document.body) {
    cleanAds();
  }
  const observer = new MutationObserver(() => cleanAds());
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  setInterval(cleanAds, 2000);
}

// ─── YOUTUBE AD SKIPPER SCRIPT ──────────────────────────────────────────────────
function runYouTubeAdSkipper() {
  'use strict';
  if (window.__osloAdBlockerActive) return;
  window.__osloAdBlockerActive = true;

  let savedVolume = null;

  function handleAds() {
    try {
      const player = document.querySelector('.html5-video-player');
      const video = document.querySelector('video');
      if (!player || !video) return;

      const isAdPlaying = player.classList.contains('ad-showing') ||
        player.classList.contains('ad-interrupting') ||
        document.querySelector('.ytp-ad-player-overlay') !== null;

      if (isAdPlaying) {
        const skipSelectors = [
          '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern', '.ytp-skip-ad-button',
          'button.ytp-ad-skip-button', '.ytp-ad-skip-button-slot button',
          '.ytp-ad-skip-button-container button', '[id="skip-button:"] button',
          '.ytp-ad-skip-button-text',
        ];
        for (const sel of skipSelectors) {
          const btn = document.querySelector(sel);
          if (btn) { btn.click(); return; }
        }

        if (video.duration && isFinite(video.duration) && video.duration > 0) {
          if (savedVolume === null) savedVolume = video.volume;
          video.volume = 0;
          video.currentTime = video.duration - 0.1;
          video.playbackRate = 16;
        }

        document.querySelectorAll(
          '.ytp-ad-overlay-container, .ytp-ad-text-overlay, .ytp-ad-overlay-slot, .ytp-ad-image-overlay'
        ).forEach(el => el.remove());
      } else {
        if (savedVolume !== null) {
          video.volume = savedVolume;
          video.playbackRate = 1;
          savedVolume = null;
        }
      }
    } catch (e) { }
  }

  function removePromotedItems() {
    try {
      document.querySelectorAll(
        'ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-banner-promo-renderer, ' +
        'ytd-promoted-sparkles-text-search-renderer, ytd-promoted-video-renderer, ' +
        'ytd-compact-promoted-video-renderer, ytd-display-ad-renderer, ' +
        'ytd-promoted-sparkles-web-renderer, ytd-statement-banner-renderer, ' +
        'ytd-video-masthead-ad-v3-renderer, ytd-primetime-promo-renderer, ' +
        '#masthead-ad, #player-ads, #merch-shelf, #offer-module'
      ).forEach(el => el.remove());
    } catch (e) { }
  }

  function dismissPopups() {
    try {
      const premiumPopup = document.querySelector('ytd-popup-container tp-yt-paper-dialog');
      if (premiumPopup) {
        const dismissBtn = premiumPopup.querySelector('#dismiss-button, .dismiss-button, yt-button-renderer');
        if (dismissBtn) dismissBtn.click();
      }
      const pausePopup = document.querySelector('.ytp-pause-overlay-container');
      if (pausePopup) { const btn = pausePopup.querySelector('button'); if (btn) btn.click(); }
      const surveyPopup = document.querySelector('ytd-enforcement-message-view-model');
      if (surveyPopup) surveyPopup.remove();
    } catch (e) { }
  }

  // Intercept fetch
  try {
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      if (typeof url === 'string') {
        const l = url.toLowerCase();
        if (l.includes('/pagead/') || l.includes('/ptracking') || l.includes('/api/stats/ads') ||
          l.includes('/api/stats/atr') || l.includes('/get_midroll_info') ||
          l.includes('/log_interaction') || l.includes('/log_event') ||
          l.includes('/youtubei/v1/player/ad_break') || l.includes('doubleclick.net') ||
          l.includes('googlesyndication.com') || l.includes('/pcs/activeview') ||
          l.includes('imasdk.googleapis.com') || l.includes('s0.2mdn.net')) {
          return new Promise(() => { });
        }
      }
      return origFetch.apply(this, args);
    };
  } catch (e) { }

  // Intercept XHR
  try {
    const origXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      if (typeof url === 'string') {
        const l = url.toLowerCase();
        if (l.includes('/pagead/') || l.includes('/ptracking') || l.includes('/api/stats/ads') ||
          l.includes('/get_midroll_info') || l.includes('doubleclick.net') ||
          l.includes('googlesyndication.com') || l.includes('imasdk.googleapis.com')) {
          return origXHROpen.call(this, method, 'about:blank', ...rest);
        }
      }
      return origXHROpen.call(this, method, url, ...rest);
    };
  } catch (e) { }

  function startObserver() {
    try {
      const observer = new MutationObserver(() => {
        handleAds(); removePromotedItems(); dismissPopups();
      });
      const target = document.getElementById('movie_player') || document.querySelector('.html5-video-player') || document.body;
      if (target) {
        observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'src'] });
      }
      setInterval(() => { handleAds(); removePromotedItems(); dismissPopups(); }, 1000);
    } catch (e) { }
  }

  function init() {
    handleAds();
    removePromotedItems();
    dismissPopups();
    startObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  try {
    const origPush = history.pushState;
    history.pushState = function (...a) {
      origPush.apply(this, a);
      setTimeout(() => { handleAds(); removePromotedItems(); dismissPopups(); }, 500);
    };
    const origReplace = history.replaceState;
    history.replaceState = function (...a) {
      origReplace.apply(this, a);
      setTimeout(() => { handleAds(); removePromotedItems(); dismissPopups(); }, 500);
    };
    window.addEventListener('yt-navigate-finish', () => {
      setTimeout(() => { handleAds(); removePromotedItems(); dismissPopups(); }, 300);
    });
  } catch (e) { }
}

function runPasswordManager() {
  'use strict';

  let lastTypedUsername = '';
  let lastTypedPassword = '';

  function isUsernameInput(el) {
    const type = el.getAttribute('type') || 'text';
    if (type === 'email' || type === 'username') return true;
    if (type !== 'text' && type !== 'hidden') return false;

    const name = (el.getAttribute('name') || '').toLowerCase();
    const id = (el.getAttribute('id') || '').toLowerCase();
    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();

    if (autocomplete === 'username' || autocomplete === 'email') return true;
    if (name.includes('user') || name.includes('email') || name.includes('login') || name.includes('ident')) return true;
    if (id.includes('user') || id.includes('email') || id.includes('login') || id.includes('ident')) return true;
    if (placeholder.includes('user') || placeholder.includes('email') || placeholder.includes('eposta') || placeholder.includes('kullanıcı')) return true;

    const excludeNames = ['q', 'search', 'query', 'term', 's', 'keyword'];
    if (excludeNames.some(ex => name.includes(ex) || id.includes(ex))) {
      return false;
    }

    return true;
  }

  // Monitor input fields globally
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.tagName === 'INPUT') {
      const type = el.getAttribute('type') || 'text';
      if (type === 'password') {
        lastTypedPassword = el.value;
      } else if (isUsernameInput(el)) {
        if (el.value.trim().length > 1) {
          lastTypedUsername = el.value.trim();
        }
      }
    }
  });

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.tagName === 'INPUT') {
      const type = el.getAttribute('type') || 'text';
      if (type === 'password') {
        lastTypedPassword = el.value;
      } else if (isUsernameInput(el)) {
        if (el.value.trim().length > 1) {
          lastTypedUsername = el.value.trim();
        }
      }
    }
  });

  function checkAndSendLoginDetails() {
    if (!lastTypedPassword) return;

    let username = '';

    // 1. Try to find a visible or hidden username field in the DOM near the password input
    const passwordInput = document.querySelector('input[type="password"]');
    if (passwordInput) {
      const form = passwordInput.closest('form') || document;
      const allInputs = Array.from(form.querySelectorAll('input'));
      const pwdIdx = allInputs.indexOf(passwordInput);

      // Search backward from password input
      for (let i = pwdIdx - 1; i >= 0; i--) {
        const input = allInputs[i];
        if (isUsernameInput(input)) {
          if (input.value.trim()) {
            username = input.value.trim();
            break;
          }
        }
      }

      // If still not found, search forward or globally in the form
      if (!username) {
        for (const input of allInputs) {
          if (input !== passwordInput && isUsernameInput(input) && input.value.trim()) {
            username = input.value.trim();
            break;
          }
        }
      }
    }

    // 2. Fall back to the last typed username
    if (!username) {
      username = lastTypedUsername;
    }

    if (username && lastTypedPassword) {
      const origin = (window.location.origin === 'null' || !window.location.origin) ? 'file://local-test' : window.location.origin;
      ipcRenderer.send('login-form-submitted', {
        origin: origin,
        username: username,
        password: lastTypedPassword
      });
    }
  }

  // Intercept form submissions
  document.addEventListener('submit', (e) => {
    const passwordInput = e.target.querySelector('input[type="password"]');
    if (passwordInput && passwordInput.value) {
      lastTypedPassword = passwordInput.value;
      checkAndSendLoginDetails();
    }
  });

  // Intercept clicks on submit/login buttons
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button, input[type="submit"], input[type="button"], [role="button"]');
    if (el) {
      const passwordInput = document.querySelector('input[type="password"]');
      if (passwordInput && passwordInput.value) {
        lastTypedPassword = passwordInput.value;
        // Delay slightly to let input/change event handlers execute first
        setTimeout(checkAndSendLoginDetails, 100);
      }
    }
  });

  // Intercept Enter key in password inputs
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const el = e.target;
      if (el.tagName === 'INPUT' && el.getAttribute('type') === 'password') {
        lastTypedPassword = el.value;
        setTimeout(checkAndSendLoginDetails, 100);
      }
    }
  });

  // 2. Autofill logic
  let autofillDone = false;
  function tryAutofill() {
    if (autofillDone) return;
    const passwordInput = document.querySelector('input[type="password"]');
    if (passwordInput) {
      const origin = (window.location.origin === 'null' || !window.location.origin) ? 'file://local-test' : window.location.origin;
      ipcRenderer.invoke('get-saved-credentials', origin).then(creds => {
        if (creds && creds.length > 0) {
          const form = passwordInput.closest('form') || document;
          const allInputs = Array.from(form.querySelectorAll('input'));
          const pwdIdx = allInputs.indexOf(passwordInput);
          let usernameInput = null;
          for (let i = pwdIdx - 1; i >= 0; i--) {
            const input = allInputs[i];
            if (isUsernameInput(input)) {
              usernameInput = input;
              break;
            }
          }

          if (!usernameInput) {
            // Find any username input in the form
            for (const input of allInputs) {
              if (input !== passwordInput && isUsernameInput(input)) {
                usernameInput = input;
                break;
              }
            }
          }

          const cred = creds[0]; // Use first matching credential
          if (usernameInput) {
            usernameInput.value = cred.username;
            usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
            usernameInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
          passwordInput.value = cred.password;
          passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
          passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
          autofillDone = true;
        }
      });
    }
  }

  // Run on load and periodically (covers client-side SPA rendering)
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:' || window.location.protocol === 'file:') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryAutofill);
    } else {
      tryAutofill();
    }
    // Periodically try to autofill
    const intervalId = setInterval(() => {
      if (autofillDone) {
        clearInterval(intervalId);
      } else {
        tryAutofill();
      }
    }, 1000);
    // Stop trying after 10 seconds to save CPU
    setTimeout(() => clearInterval(intervalId), 10000);
  }
}

// ─── INITIAL LIFECYCLE EXECUTION ───────────────────────────────────────────────
if (window.location.protocol === 'http:' || window.location.protocol === 'https:' || window.location.protocol === 'file:') {
  runPasswordManager();
}

let adBlockEnabled = false;
let fingerprintProtectionEnabled = false;
try {
  adBlockEnabled = ipcRenderer.sendSync('adblock-get-sync');
  const shields = ipcRenderer.sendSync('privacy-shields-get-sync');
  fingerprintProtectionEnabled = !!(shields && shields.fingerprintProtection);
} catch (e) {
  console.error('Failed to query ad blocker state:', e);
}

if ((adBlockEnabled || fingerprintProtectionEnabled) && (window.location.protocol === 'http:' || window.location.protocol === 'https:')) {
  // 1. Anti-fingerprinting shield (runs immediately at document_start in main world)
  webFrame.executeJavaScript(`(${runAntiFingerprint.toString()})();`);
}

if (adBlockEnabled && (window.location.protocol === 'http:' || window.location.protocol === 'https:')) {
  // 2. Generic ad blocker script
  webFrame.executeJavaScript(`(${runGenericAdBlocker.toString()})();`);

  // 3. YouTube ad skipper (if on YouTube)
  if (window.location.hostname.includes('youtube.com') || window.location.hostname.includes('youtu.be')) {
    webFrame.executeJavaScript(`(${runYouTubeAdSkipper.toString()})();`);
  }

  // 4. Cosmetic CSS injection
  webFrame.insertCSS(cosmeticFilterCSS);
}

// ─── CONTEXT BRIDGE EXPOSURE ───────────────────────────────────────────────────
contextBridge.exposeInMainWorld('oslo', {
  // Tabs control
  createTab: (data) => ipcRenderer.send('tab-create', data),
  closeTab: (tabId) => ipcRenderer.send('tab-close', tabId),
  selectTab: (tabId) => ipcRenderer.send('tab-select', tabId),
  navigate: (tabId, url) => ipcRenderer.send('tab-navigate', { tabId, url }),
  goBack: (tabId) => ipcRenderer.send('tab-back', tabId),
  goForward: (tabId) => ipcRenderer.send('tab-forward', tabId),
  reload: (tabId) => ipcRenderer.send('tab-reload', tabId),
  updateTabSpace: (tabId, space) => ipcRenderer.send('tab-update-space', { tabId, space }),
  reorderTabs: (tabIds) => ipcRenderer.send('tabs-reorder', tabIds),
  muteTab: (tabId, mute) => ipcRenderer.send('tab-mute', { tabId, mute }),

  // Storage & Features
  getBookmarks: () => ipcRenderer.invoke('bookmarks-get'),
  addBookmark: (bookmark) => ipcRenderer.invoke('bookmarks-add', bookmark),
  removeBookmark: (url) => ipcRenderer.invoke('bookmarks-remove', url),
  updateBookmark: (oldUrl, bookmark) => ipcRenderer.invoke('bookmarks-update', { oldUrl, bookmark }),
  setBookmarks: (bookmarks) => ipcRenderer.invoke('bookmarks-set', bookmarks),
  exportBookmarks: () => ipcRenderer.invoke('bookmarks-export'),
  importBookmarks: () => ipcRenderer.invoke('bookmarks-import'),
  getHistory: () => ipcRenderer.invoke('history-get'),
  clearHistory: (range) => ipcRenderer.invoke('history-clear', range),
  sleepTab: (tabId) => ipcRenderer.send('tab-sleep', tabId),

  // Unified Settings API
  getAllSettings: () => ipcRenderer.invoke('settings-get-all'),
  setSetting: (key, value) => ipcRenderer.invoke('settings-set', { key, value }),
  selectNewtabWallpaperFile: () => ipcRenderer.invoke('newtab-wallpaper-select-file'),
  exportSettings: () => ipcRenderer.invoke('settings-export'),
  importSettings: () => ipcRenderer.invoke('settings-import'),
  resetSettings: () => ipcRenderer.invoke('settings-reset'),
  onSettingsUpdated: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('ui-settings-updated', listener);
    return () => ipcRenderer.removeListener('ui-settings-updated', listener);
  },

  // Legacy broadcast compatibility mappings
  broadcastSetting: (type, value) => {
    const keyMap = { 'wallpaper': 'newtabWallpaper', 'newtab-wallpaper': 'newtabWallpaper' };
    const key = keyMap[type] || type;
    return ipcRenderer.invoke('settings-set', { key, value });
  },
  onSettingBroadcast: (callback) => {
    const listener = (event, data) => {
      const typeMap = { 'newtabWallpaper': 'wallpaper' };
      callback({ type: typeMap[data.key] || data.key, value: data.value });
    };
    ipcRenderer.on('ui-settings-updated', listener);
    return () => ipcRenderer.removeListener('ui-settings-updated', listener);
  },

  // Settings & AdBlock
  getAdBlockerState: () => ipcRenderer.invoke('adblock-get'),
  setAdBlockerState: (enabled) => ipcRenderer.invoke('adblock-set', enabled),
  getBlockedCount: () => ipcRenderer.invoke('adblock-get-count'),
  getHttpsOnlyState: () => ipcRenderer.invoke('httpsonly-get'),
  setHttpsOnlyState: (enabled) => ipcRenderer.invoke('httpsonly-set', enabled),
  getSearchEngine: () => ipcRenderer.invoke('searchengine-get'),
  setSearchEngine: (engine) => ipcRenderer.invoke('searchengine-set', engine),
  getCustomCss: () => ipcRenderer.invoke('custom-css-get'),
  setCustomCss: (css) => ipcRenderer.invoke('custom-css-set', css),

  // Download controls
  pauseDownload: (id) => ipcRenderer.send('download-pause', id),
  resumeDownload: (id) => ipcRenderer.send('download-resume', id),
  cancelDownload: (id) => ipcRenderer.send('download-cancel', id),
  getDownloads: () => ipcRenderer.invoke('downloads-get'),
  clearDownloads: () => ipcRenderer.invoke('downloads-clear'),

  // Spaces control
  getSpaces: () => ipcRenderer.invoke('spaces-get'),
  addSpace: (name) => ipcRenderer.invoke('spaces-add', name),
  deleteSpace: (name) => ipcRenderer.invoke('spaces-delete', name),
  updateSpace: (oldName, space) => ipcRenderer.invoke('spaces-update', { oldName, space }),

  // Find in page
  findInPage: (text, options) => ipcRenderer.send('find-in-page', { text, options }),
  stopFindInPage: (action) => ipcRenderer.send('stop-find-in-page', { action }),
  onFindResult: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('find-result', listener);
    return () => ipcRenderer.removeListener('find-result', listener);
  },

  // Window Operations
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  newWindow: () => ipcRenderer.send('window-new'),
  updateBounds: (bounds) => ipcRenderer.send('tab-bounds', bounds),
  showBookmarksFolderMenu: (folderId, x, y) => ipcRenderer.send('show-bookmarks-folder-menu', { folderId, x, y }),
  openDownloadedFile: (filePath) => ipcRenderer.send('download-open', filePath),
  openExternalLink: (url) => ipcRenderer.send('open-external', url),

  // Events from Main Process
  onTabCreated: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('ui-tab-created', listener);
    return () => ipcRenderer.removeListener('ui-tab-created', listener);
  },
  onTabUpdated: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('ui-tab-updated', listener);
    return () => ipcRenderer.removeListener('ui-tab-updated', listener);
  },
  onTabClosed: (callback) => {
    const listener = (event, tabId) => callback(tabId);
    ipcRenderer.on('ui-tab-closed', listener);
    return () => ipcRenderer.removeListener('ui-tab-closed', listener);
  },
  onTabSelected: (callback) => {
    const listener = (event, tabId) => callback(tabId);
    ipcRenderer.on('ui-tab-selected', listener);
    return () => ipcRenderer.removeListener('ui-tab-selected', listener);
  },
  onAdBlocked: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('ad-blocked', listener);
    return () => ipcRenderer.removeListener('ad-blocked', listener);
  },
  onDownloadProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
  onHotkey: (callback) => {
    ipcRenderer.on('ui-hotkey-newtab', () => callback('newtab'));
    ipcRenderer.on('ui-hotkey-closetab', () => callback('closetab'));
    ipcRenderer.on('ui-hotkey-incognitotab', () => callback('incognitotab'));
    ipcRenderer.on('ui-hotkey-nexttab', () => callback('nexttab'));
    ipcRenderer.on('ui-hotkey-prevtab', () => callback('prevtab'));
    ipcRenderer.on('ui-hotkey-togglebookmarks', () => callback('togglebookmarks'));
    ipcRenderer.on('ui-hotkey-togglehistory', () => callback('togglehistory'));
    ipcRenderer.on('ui-hotkey-findinpage', () => callback('findinpage'));
  },

  // Permission APIs
  respondToPermission: (id, decision) => ipcRenderer.send('permission-response', { id, decision }),
  onPermissionRequest: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('ui-permission-request', listener);
    return () => ipcRenderer.removeListener('ui-permission-request', listener);
  },
  getPermissions: () => ipcRenderer.invoke('permissions-get-all'),
  deletePermission: (key) => ipcRenderer.invoke('permissions-delete', key),
  setPermission: (key, value) => ipcRenderer.invoke('permissions-set', key, value),
  getSiteData: () => ipcRenderer.invoke('site-data-get'),
  clearSiteData: (domain) => ipcRenderer.invoke('site-data-clear', domain),
  getCertificateExceptions: () => ipcRenderer.invoke('certificate-exceptions-get'),
  deleteCertificateException: (host) => ipcRenderer.invoke('certificate-exceptions-delete', host),
  clearCertificateExceptions: () => ipcRenderer.invoke('certificate-exceptions-clear'),

  // Updates & Telemetry APIs
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: (url, version) => ipcRenderer.invoke('download-update', { url, version }),
  onUpdateDownloadProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('update-download-progress', listener);
    return () => ipcRenderer.removeListener('update-download-progress', listener);
  },
  logTelemetryEvent: (action, data) => ipcRenderer.send('telemetry-log-event', { action, data }),
  logTelemetryCrash: (error) => ipcRenderer.send('telemetry-log-crash', error),
  getTelemetryLogs: () => ipcRenderer.invoke('telemetry-get-logs'),
  clearTelemetryLogs: () => ipcRenderer.invoke('telemetry-clear-logs'),
  getSystemInfo: () => ipcRenderer.invoke('system-info-get'),
  clearBrowserData: () => ipcRenderer.invoke('clear-browser-data'),

  // Password Manager APIs
  getPasswords: () => ipcRenderer.invoke('passwords-get'),
  saveCredential: (cred) => ipcRenderer.invoke('passwords-save', cred),
  deleteCredential: (id) => ipcRenderer.invoke('passwords-delete', id),
  importPasswords: () => ipcRenderer.invoke('passwords-import'),
  exportPasswords: () => ipcRenderer.invoke('passwords-export'),
  onPasswordSavePrompt: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('ui-password-save-prompt', listener);
    return () => ipcRenderer.removeListener('ui-password-save-prompt', listener);
  },

  // Session & Zoom APIs
  getSession: () => ipcRenderer.invoke('session-get'),
  setTabPinned: (tabId, isPinned) => ipcRenderer.send('tab-set-pinned', { tabId, isPinned }),
  setTabZoom: (tabId, zoom) => ipcRenderer.send('tab-set-zoom', { tabId, zoom }),
  onZoomChanged: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('ui-zoom-changed', listener);
    return () => ipcRenderer.removeListener('ui-zoom-changed', listener);
  }
});
