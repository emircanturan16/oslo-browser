const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, dialog } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const Store = require('./store');
const adblock = require('./adblock');

// GitHub repository configuration for updates
const GITHUB_REPO = 'emircanturan16/oslo-browser'; // Format: 'owner/repo'

// Create local stores
let activeDownloads = {}; // downloadId -> { item, win, name, total }

const DEFAULT_SETTINGS = {
  searchEngine: 'google',
  adblockEnabled: true,
  blockedCount: 0,
  httpsOnlyEnabled: false,
  httpsOnlyExceptions: '',
  customCss: '',
  customCssEnabled: true,
  theme: 'dark',
  accentColor: '#00ddff',
  compactMode: false,
  tabCornerStyle: 'rounded',
  activeTabStyle: 'filled',
  tabHeight: 36,
  sidebarAutoHide: false,
  sidebarIconOnly: false,
  sidebarWidth: 240,
  topBarAutoHide: false,
  uiFontSize: 'normal',
  defaultPageZoom: 1,
  reduceMotion: false,
  transparencyEnabled: true,
  language: 'tr',
  newtabBackgroundType: 'default',
  newtabWallpaper: '',
  newtabBackgroundColor: '#0b0c0e',
  newtabPresetWallpaper: 'aurora',
  newtabShowClock: true,
  newtabShowDate: true,
  newtabShowWeather: true,
  newtabShowSearch: true,
  newtabShowShortcuts: true,
  homeButtonEnabled: false,
  homePageUrl: '',
  bookmarksBarEnabled: false,
  historyLimit: 2000,
  telemetryEnabled: true,
  dnsOverHttpsEnabled: false,
  dnsOverHttpsProvider: 'cloudflare',
  dnsOverHttpsCustomProvider: '',
  cookiePolicy: 'block-third-party',
  clearCookiesOnExit: false,
  trackingProtectionLevel: 'balanced',
  fingerprintProtection: true,
  refererPolicy: 'cross-origin',
  webRtcIpProtection: true,
  dangerousDownloadsProtection: 'warn',
  passwordSecurityWarnings: true,
  clearHistoryOnExit: false,
  clearCacheOnExit: false,
  clearDownloadsOnExit: false,
  clearLocalStorageOnExit: false,
  incognitoForgetDownloads: true,
  incognitoBlockThirdPartyCookies: true,
  permissionNotifications: 'ask',
  permissionCamera: 'ask',
  permissionMicrophone: 'ask',
  permissionLocation: 'ask',
  permissionClipboard: 'ask',
  permissionAutoplay: 'allow',
  globalPrivacyControl: true,
  sessionRestoreEnabled: false,
  savePasswordsEnabled: true,
  autofillEnabled: true,
  sleepTabsEnabled: true,
  sleepTabsTimeout: 15,
  downloadPromptEnabled: false
};

const settingsStore = new Store('settings', DEFAULT_SETTINGS);
const bookmarksStore = new Store('bookmarks', { bookmarks: [] });
const historyStore = new Store('history', { history: [] });
const downloadsStore = new Store('downloads', { downloads: [] });
const spacesStore = new Store('spaces', { spaces: ['Genel'] });
const telemetryStore = new Store('telemetry', { events: [], crashes: [] });
const faviconCacheStore = new Store('favicon-cache', { cache: {} });
const sessionStore = new Store('session', { tabs: [], tabOrders: {} });
const passwordsStore = new Store('passwords', { passwords: [] });
const certificateExceptionsStore = new Store('certificate-exceptions', { exceptions: {} });

// DNS-over-HTTPS Setup
const dohTemplates = {
  cloudflare: 'https://chrome.cloudflare-dns.com/dns-query',
  google: 'https://dns.google/dns-query',
  quad9: 'https://dns.quad9.net/dns-query'
};

const dnsEnabled = settingsStore.get('dnsOverHttpsEnabled') || false;
if (dnsEnabled) {
  const provider = settingsStore.get('dnsOverHttpsProvider') || 'cloudflare';
  const customTemplate = settingsStore.get('dnsOverHttpsCustomProvider') || '';
  const template = provider === 'custom' && customTemplate ? customTemplate : (dohTemplates[provider] || dohTemplates.cloudflare);
  app.commandLine.appendSwitch('enable-features', 'DnsOverHttps');
  app.commandLine.appendSwitch('dns-over-https-templates', template);
}

if (settingsStore.get('webRtcIpProtection') !== false) {
  app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
  app.commandLine.appendSwitch('webrtc-ip-handling-policy', 'disable_non_proxied_udp');
}

if (settingsStore.get('permissionAutoplay') === 'block') {
  app.commandLine.appendSwitch('autoplay-policy', 'user-gesture-required');
}

// Uncaught exceptions crash logging
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception in Main Process:', error);
  if (settingsStore.get('telemetryEnabled')) {
    const crashes = telemetryStore.get('crashes') || [];
    crashes.push({
      timestamp: Date.now(),
      message: error.message || String(error),
      stack: error.stack || '',
      process: 'main'
    });
    if (crashes.length > 50) crashes.splice(0, crashes.length - 50);
    telemetryStore.set('crashes', crashes);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection in Main Process:', reason);
  if (settingsStore.get('telemetryEnabled')) {
    const crashes = telemetryStore.get('crashes') || [];
    crashes.push({
      timestamp: Date.now(),
      message: reason ? (reason.message || String(reason)) : 'Unhandled Rejection',
      stack: reason ? (reason.stack || '') : '',
      process: 'main'
    });
    if (crashes.length > 50) crashes.splice(0, crashes.length - 50);
    telemetryStore.set('crashes', crashes);
  }
});

let windows = new Set();
let tabs = {}; // tabId -> { id, view, url, title, isLoading, isIncognito, space, lastActive, isSleeping }
let activeTabs = {}; // windowId -> activeTabId
let windowBounds = {}; // windowId -> bounds
let tabOrders = {}; // windowId -> [tabId, tabId, ...]
let incognitoSession = null;
let pendingPermissionRequests = {};
let permissionRequestId = 0;
const permissionsStore = new Store('permissions', { permissions: {} });

function getNetworkPrivacyOptions() {
  return {
    cookiePolicy: settingsStore.get('cookiePolicy') || 'block-third-party',
    trackingProtectionLevel: settingsStore.get('trackingProtectionLevel') || 'balanced',
    fingerprintProtection: settingsStore.get('fingerprintProtection') !== false,
    refererPolicy: settingsStore.get('refererPolicy') || 'cross-origin',
    globalPrivacyControl: settingsStore.get('globalPrivacyControl') !== false,
    incognitoBlockThirdPartyCookies: settingsStore.get('incognitoBlockThirdPartyCookies') !== false,
    httpsOnlyExceptions: settingsStore.get('httpsOnlyExceptions') || ''
  };
}

function syncNetworkPrivacyOptions() {
  adblock.setPrivacyOptions(getNetworkPrivacyOptions());
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false, // frameless window for Zen-like design
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#111214'
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  windows.add(win);

  // Context Menu for main UI (editable inputs copy/paste)
  win.webContents.on('context-menu', (event, params) => {
    const { Menu, MenuItem } = require('electron');
    const menu = new Menu();
    const lang = settingsStore.get('language') || 'tr';
    const labels = {
      cut: lang === 'tr' ? 'Kes' : (lang === 'fr' ? 'Couper' : 'Cut'),
      copy: lang === 'tr' ? 'Kopyala' : (lang === 'fr' ? 'Copier' : 'Copy'),
      paste: lang === 'tr' ? 'Yapıştır' : (lang === 'fr' ? 'Coller' : 'Paste'),
      selectAll: lang === 'tr' ? 'Tümünü Seç' : (lang === 'fr' ? 'Tout sélectionner' : 'Select All')
    };

    if (params.isEditable) {
      menu.append(new MenuItem({ label: labels.cut, role: 'cut' }));
      menu.append(new MenuItem({ label: labels.copy, role: 'copy' }));
      menu.append(new MenuItem({ label: labels.paste, role: 'paste' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: labels.selectAll, role: 'selectAll' }));
      menu.popup({ window: win });
    } else if (params.selectionText && params.selectionText.trim() !== '') {
      menu.append(new MenuItem({ label: labels.copy, role: 'copy' }));
      menu.popup({ window: win });
    }
  });

  win.on('closed', () => {
    windows.delete(win);
    // Destroy all tabs belonging to this window
    Object.keys(tabs).forEach(id => {
      if (tabs[id] && tabs[id].windowId === win.id) {
        destroyTab(id);
      }
    });
    delete activeTabs[win.id];
    delete windowBounds[win.id];
  });

  return win;
}

// Setup common listeners for a tab's webContents
function setupTabListeners(tab) {
  if (!tab.view) return;
  const wc = tab.view.webContents;
  const tabId = tab.id;
  const getWin = () => BrowserWindow.fromId(tab.windowId);

  wc.on('did-start-loading', () => {
    tab.isLoading = true;
    sendToUI(getWin(), 'ui-tab-updated', { id: tabId, isLoading: true });
  });

  wc.on('did-stop-loading', () => {
    tab.isLoading = false;
    sendToUI(getWin(), 'ui-tab-updated', { id: tabId, isLoading: false });
  });

  wc.on('page-title-updated', (event, title) => {
    tab.title = title;
    sendToUI(getWin(), 'ui-tab-updated', { id: tabId, title: title });
  });

  wc.on('page-favicon-updated', (event, favicons) => {
    if (favicons && favicons.length > 0) {
      tab.favicon = favicons[0];
      sendToUI(getWin(), 'ui-tab-updated', { id: tabId, favicon: favicons[0] });

      // Save to cache
      try {
        const domain = new URL(tab.url).hostname;
        if (domain) {
          const cache = faviconCacheStore.get('cache') || {};
          cache[domain] = favicons[0];
          faviconCacheStore.set('cache', cache);
        }
      } catch (e) { }
    }
  });

  wc.on('did-navigate', (event, newUrl) => {
    tab.url = newUrl;
    tab.canGoBack = wc.canGoBack();
    tab.canGoForward = wc.canGoForward();

    // Check favicon cache
    try {
      const domain = new URL(newUrl).hostname;
      if (domain) {
        const cache = faviconCacheStore.get('cache') || {};
        if (cache[domain]) {
          tab.favicon = cache[domain];
        }
      }
    } catch (e) { }

    sendToUI(getWin(), 'ui-tab-updated', {
      id: tabId,
      url: newUrl,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      favicon: tab.favicon || null
    });

    // Add to history if not incognito
    if (!tab.isIncognito && !newUrl.includes('newtab.html') && !newUrl.startsWith('file://')) {
      const historyEntry = {
        title: tab.title || newUrl,
        url: newUrl,
        timestamp: Date.now()
      };
      const history = historyStore.get('history') || [];
      const todayStr = new Date().toDateString();
      const duplicateIdx = history.findIndex(h => {
        return h.url === newUrl && new Date(h.timestamp).toDateString() === todayStr;
      });

      if (duplicateIdx !== -1) {
        history[duplicateIdx].timestamp = Date.now();
        history[duplicateIdx].title = tab.title || newUrl;
      } else {
        history.push(historyEntry);
      }

      const limit = parseInt(settingsStore.get('historyLimit'), 10) || 2000;
      if (history.length > limit) {
        history.splice(0, history.length - limit);
      }
      historyStore.set('history', history);
    }
    saveSession();
  });

  wc.on('did-navigate-in-page', (event, newUrl) => {
    tab.url = newUrl;
    tab.canGoBack = wc.canGoBack();
    tab.canGoForward = wc.canGoForward();
    sendToUI(getWin(), 'ui-tab-updated', {
      id: tabId,
      url: newUrl,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward
    });
    saveSession();
  });

  wc.on('found-in-page', (event, result) => {
    sendToUI(getWin(), 'find-result', result);
  });

  wc.on('media-started-playing', () => {
    tab.isPlayingAudio = true;
    sendToUI(getWin(), 'ui-tab-updated', { id: tabId, isPlayingAudio: true });
  });

  wc.on('media-stopped-playing', () => {
    tab.isPlayingAudio = false;
    sendToUI(getWin(), 'ui-tab-updated', { id: tabId, isPlayingAudio: false });
  });

  // Support open-link-in-new-window (target="_blank") and popups
  wc.setWindowOpenHandler((details) => {
    if (details.features) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            preload: path.join(__dirname, '../preload.js'),
            contextIsolation: true,
            nodeIntegration: false
          }
        }
      };
    }
    sendToUI(getWin(), 'ui-tab-created', { url: details.url, isIncognito: tab.isIncognito, space: tab.space });
    return { action: 'deny' };
  });

  // Intercept Keyboard Shortcuts inside page views
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown') {
      const isControl = process.platform === 'darwin' ? input.meta : input.control;

      // Ctrl + T (New Tab)
      if (isControl && input.key.toLowerCase() === 't') {
        event.preventDefault();
        sendToUI(getWin(), 'ui-hotkey-newtab');
      }
      // Ctrl + R (Reload)
      if (isControl && input.key.toLowerCase() === 'r') {
        event.preventDefault();
        wc.reload();
      }
      // Ctrl + L (Focus Address Bar)
      if (isControl && input.key.toLowerCase() === 'l') {
        event.preventDefault();
        sendToUI(getWin(), 'ui-hotkey-focusaddress');
      }
      // Ctrl + D (Add Bookmark)
      if (isControl && input.key.toLowerCase() === 'd') {
        event.preventDefault();
        sendToUI(getWin(), 'ui-hotkey-bookmark');
      }
      // Alt + Left (Go Back)
      if (input.alt && input.key === 'ArrowLeft') {
        event.preventDefault();
        if (wc.canGoBack()) wc.goBack();
      }
      // Alt + Right (Go Forward)
      if (input.alt && input.key === 'ArrowRight') {
        event.preventDefault();
        if (wc.canGoForward()) wc.goForward();
      }
      // Ctrl + W (Close Active Tab)
      if (isControl && input.key.toLowerCase() === 'w') {
        event.preventDefault();
        sendToUI(getWin(), 'ui-hotkey-closetab');
      }
      // Ctrl + N (New Window)
      if (isControl && input.key.toLowerCase() === 'n' && !input.shift) {
        event.preventDefault();
        createMainWindow();
      }
      // Ctrl + Shift + P or N (New Incognito Tab)
      if (isControl && input.shift && (input.key.toLowerCase() === 'p' || input.key.toLowerCase() === 'n')) {
        event.preventDefault();
        sendToUI(getWin(), 'ui-hotkey-incognitotab');
      }
      // Ctrl + Tab (Next Tab)
      if (isControl && input.key === 'Tab' && !input.shift) {
        event.preventDefault();
        sendToUI(getWin(), 'ui-hotkey-nexttab');
      }
      // Ctrl + Shift + Tab (Prev Tab)
      if (isControl && input.key === 'Tab' && input.shift) {
        event.preventDefault();
        sendToUI(getWin(), 'ui-hotkey-prevtab');
      }
      // Ctrl + B (Toggle Bookmarks Panel)
      if (isControl && input.key.toLowerCase() === 'b') {
        event.preventDefault();
        sendToUI(getWin(), 'ui-hotkey-togglebookmarks');
      }
      // Ctrl + H (Toggle History Panel)
      if (isControl && input.key.toLowerCase() === 'h') {
        event.preventDefault();
        sendToUI(getWin(), 'ui-hotkey-togglehistory');
      }
      // Ctrl + F (Find in Page)
      if (isControl && input.key.toLowerCase() === 'f') {
        event.preventDefault();
        sendToUI(getWin(), 'ui-hotkey-findinpage');
      }
      // Ctrl + P (Print)
      if (isControl && input.key.toLowerCase() === 'p') {
        event.preventDefault();
        wc.print();
      }
      // Ctrl + = or Ctrl + + (Zoom In)
      if (isControl && (input.key === '=' || input.key === '+')) {
        event.preventDefault();
        const currentZoom = wc.getZoomFactor();
        const nextZoom = currentZoom + 0.1;
        if (nextZoom <= 3.0) {
          wc.setZoomFactor(nextZoom);
          tab.zoomFactor = nextZoom;
          sendToUI(getWin(), 'ui-zoom-changed', { tabId, zoom: nextZoom });
          saveSession();
        }
      }
      // Ctrl + - (Zoom Out)
      if (isControl && input.key === '-') {
        event.preventDefault();
        const currentZoom = wc.getZoomFactor();
        const nextZoom = currentZoom - 0.1;
        if (nextZoom >= 0.3) {
          wc.setZoomFactor(nextZoom);
          tab.zoomFactor = nextZoom;
          sendToUI(getWin(), 'ui-zoom-changed', { tabId, zoom: nextZoom });
          saveSession();
        }
      }
      // Ctrl + 0 (Reset Zoom)
      if (isControl && input.key === '0') {
        event.preventDefault();
        wc.setZoomFactor(1.0);
        tab.zoomFactor = 1.0;
        sendToUI(getWin(), 'ui-zoom-changed', { tabId, zoom: 1.0 });
        saveSession();
      }
    }
  });

  // Custom CSS injection
  wc.on('did-finish-load', () => {
    const customCss = settingsStore.get('customCss');
    if (settingsStore.get('customCssEnabled') !== false && customCss) {
      wc.insertCSS(customCss).catch(err => console.error('Failed to inject custom CSS:', err));
    }
  });

  // Native Context Menu inside pages
  wc.on('context-menu', (event, params) => {
    const { Menu, MenuItem } = require('electron');
    const menu = new Menu();
    const lang = settingsStore.get('language') || 'tr';
    const labels = {
      back: lang === 'tr' ? 'Geri' : (lang === 'fr' ? 'Retour' : 'Back'),
      forward: lang === 'tr' ? 'İleri' : (lang === 'fr' ? 'Suivant' : 'Forward'),
      reload: lang === 'tr' ? 'Yeniden Yükle' : (lang === 'fr' ? 'Recharger' : 'Reload'),
      cut: lang === 'tr' ? 'Kes' : (lang === 'fr' ? 'Couper' : 'Cut'),
      copy: lang === 'tr' ? 'Kopyala' : (lang === 'fr' ? 'Copier' : 'Copy'),
      paste: lang === 'tr' ? 'Yapıştır' : (lang === 'fr' ? 'Coller' : 'Paste'),
      selectAll: lang === 'tr' ? 'Tümünü Seç' : (lang === 'fr' ? 'Tout sélectionner' : 'Select All'),
      openLinkNewTab: lang === 'tr' ? 'Bağlantıyı Yeni Sekmede Aç' : (lang === 'fr' ? 'Ouvrir le lien dans un nouvel onglet' : 'Open Link in New Tab'),
      openLinkNewIncognitoTab: lang === 'tr' ? 'Bağlantıyı Yeni Gizli Sekmede Aç' : (lang === 'fr' ? 'Ouvrir le lien dans un nouvel onglet privé' : 'Open Link in New Incognito Tab')
    };

    if (params.linkURL) {
      menu.append(new MenuItem({
        label: labels.openLinkNewTab,
        click: () => {
          sendToUI(getWin(), 'ui-tab-created', { url: params.linkURL, space: tab.space });
        }
      }));
      menu.append(new MenuItem({
        label: labels.openLinkNewIncognitoTab,
        click: () => {
          sendToUI(getWin(), 'ui-tab-created', { url: params.linkURL, isIncognito: true, space: tab.space });
        }
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (params.isEditable) {
      menu.append(new MenuItem({ label: labels.cut, role: 'cut' }));
      menu.append(new MenuItem({ label: labels.copy, role: 'copy' }));
      menu.append(new MenuItem({ label: labels.paste, role: 'paste' }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: labels.selectAll, role: 'selectAll' }));
    } else if (params.selectionText && params.selectionText.trim() !== '') {
      menu.append(new MenuItem({ label: labels.copy, role: 'copy' }));
    } else {
      menu.append(new MenuItem({ label: labels.back, enabled: wc.canGoBack(), click: () => wc.goBack() }));
      menu.append(new MenuItem({ label: labels.forward, enabled: wc.canGoForward(), click: () => wc.goForward() }));
      menu.append(new MenuItem({ label: labels.reload, click: () => wc.reload() }));
    }
    menu.popup({ window: getWin() });
  });
}

// Helpers for Tab management
function createTab(url, isIncognito = false, space = 'Genel', winId = null, tabId = null, isPinned = false, zoomFactor = null) {
  const finalTabId = tabId || ('tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9));
  const defaultZoom = parseFloat(settingsStore.get('defaultPageZoom')) || 1.0;
  const initialZoom = typeof zoomFactor === 'number' ? zoomFactor : defaultZoom;

  const viewSession = isIncognito ? incognitoSession : session.defaultSession;

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      session: viewSession,
      plugins: true
    }
  });

  const lang = settingsStore.get('language') || 'tr';
  const defaultTitle = lang === 'tr' ? 'Yeni Sekme' : (lang === 'fr' ? 'Nouvel Onglet' : 'New Tab');

  const tab = {
    id: finalTabId,
    view: view,
    url: url || '',
    title: defaultTitle,
    isLoading: false,
    isIncognito: isIncognito,
    space: space,
    windowId: winId,
    lastActive: Date.now(),
    isSleeping: false,
    isPinned: isPinned,
    zoomFactor: initialZoom
  };

  tabs[finalTabId] = tab;

  if (initialZoom !== 1.0) {
    view.webContents.setZoomFactor(initialZoom);
  }

  if (winId) {
    if (!tabOrders[winId]) tabOrders[winId] = [];
    if (!tabOrders[winId].includes(finalTabId)) {
      tabOrders[winId].push(finalTabId);
    }
  }

  // Precheck favicon cache
  if (url) {
    try {
      const domain = new URL(url).hostname;
      if (domain) {
        const cache = faviconCacheStore.get('cache') || {};
        if (cache[domain]) {
          tab.favicon = cache[domain];
        }
      }
    } catch (e) { }
  }

  setupTabListeners(tab);

  // Load the initial URL or local newtab.html
  if (url) {
    view.webContents.loadURL(formatUrl(url));
  } else {
    view.webContents.loadFile(path.join(__dirname, '../newtab/newtab.html'));
  }

  return tab;
}

function destroyTab(tabId) {
  const tab = tabs[tabId];
  if (!tab) return;

  if (tab.view) {
    const win = BrowserWindow.fromId(tab.windowId);
    if (win && win.contentView.children.includes(tab.view)) {
      win.contentView.removeChildView(tab.view);
    }
    // Clean up webContents
    tab.view.webContents.close();
  }
  if (tab.windowId && tabOrders[tab.windowId]) {
    tabOrders[tab.windowId] = tabOrders[tab.windowId].filter(id => id !== tabId);
  }
  delete tabs[tabId];
}

async function sleepTab(tabId) {
  const tab = tabs[tabId];
  if (!tab || tab.isSleeping) return;

  tab.isSleeping = true;
  tab.scrollX = 0;
  tab.scrollY = 0;

  const win = BrowserWindow.fromId(tab.windowId);
  if (tab.view) {
    try {
      const scroll = await tab.view.webContents.executeJavaScript('({ x: window.scrollX, y: window.scrollY })');
      tab.scrollX = scroll.x || 0;
      tab.scrollY = scroll.y || 0;
    } catch (e) {
      // Ignore
    }

    if (win && win.contentView.children.includes(tab.view)) {
      win.contentView.removeChildView(tab.view);
    }
    tab.view.webContents.close();
    tab.view = null;
  }

  sendToUI(win, 'ui-tab-updated', { id: tabId, isSleeping: true });
}

function wakeTab(tabId) {
  const tab = tabs[tabId];
  if (!tab || !tab.isSleeping) return;

  const viewSession = tab.isIncognito ? incognitoSession : session.defaultSession;

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      session: viewSession,
      plugins: true
    }
  });

  tab.view = view;
  tab.isSleeping = false;
  tab.lastActive = Date.now();

  setupTabListeners(tab);

  if (tab.url) {
    view.webContents.loadURL(formatUrl(tab.url));
  } else {
    view.webContents.loadFile(path.join(__dirname, '../newtab/newtab.html'));
  }

  const win = BrowserWindow.fromId(tab.windowId);

  // Restore scroll positions after finish-load
  view.webContents.once('did-finish-load', () => {
    if (tab.scrollX > 0 || tab.scrollY > 0) {
      const x = tab.scrollX;
      const y = tab.scrollY;
      setTimeout(() => {
        if (view.webContents && !view.webContents.isDestroyed()) {
          view.webContents.executeJavaScript(`window.scrollTo(${x}, ${y})`).catch(() => { });
        }
      }, 100);
    }
  });

  sendToUI(win, 'ui-tab-updated', { id: tabId, isSleeping: false });
}

function selectTab(tabId) {
  const tab = tabs[tabId];
  if (!tab) return;

  const win = BrowserWindow.fromId(tab.windowId) || [...windows][0];
  if (!win) return;

  // Wake up if sleeping
  if (tab.isSleeping) {
    wakeTab(tabId);
  }

  // Update last active
  tab.lastActive = Date.now();

  const prevActiveTabId = activeTabs[win.id];

  // Remove previous active view of THIS window from win.contentView
  if (prevActiveTabId && tabs[prevActiveTabId] && tabs[prevActiveTabId].view) {
    if (win.contentView.children.includes(tabs[prevActiveTabId].view)) {
      win.contentView.removeChildView(tabs[prevActiveTabId].view);
    }
  }

  activeTabs[win.id] = tabId;

  const bounds = windowBounds[win.id] || { x: 0, y: 0, width: 0, height: 0 };

  if (bounds.width > 0 && bounds.height > 0 && tab.view) {
    if (!win.contentView.children.includes(tab.view)) {
      win.contentView.addChildView(tab.view);
    }
    tab.view.setBounds(bounds);
  }

  // Focus the new web contents
  if (tab.view) {
    tab.view.webContents.focus();
    tab.canGoBack = tab.view.webContents.canGoBack();
    tab.canGoForward = tab.view.webContents.canGoForward();
  }

  sendToUI(win, 'ui-tab-updated', {
    id: tabId,
    canGoBack: tab.canGoBack || false,
    canGoForward: tab.canGoForward || false
  });

  sendToUI(win, 'ui-tab-selected', tabId);
}

function formatUrl(val) {
  let url = val.trim();
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://')) {
    return url;
  }

  // Check if it looks like a domain name
  const domainPattern = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?(\/\S*)?$/;
  if (domainPattern.test(url)) {
    return 'https://' + url;
  }

  // Default search query
  const engine = settingsStore.get('searchEngine') || 'google';
  const searchEngines = {
    google: 'https://www.google.com/search?q=',
    duckduckgo: 'https://duckduckgo.com/?q=',
    bing: 'https://www.bing.com/search?q=',
    yahoo: 'https://search.yahoo.com/search?p=',
    yandex: 'https://yandex.com/search/?text=',
    brave: 'https://search.brave.com/search?q=',
    ecosia: 'https://www.ecosia.org/search?q=',
    startpage: 'https://www.startpage.com/do/dsearch?query='
  };
  const searchUrl = searchEngines[engine] || searchEngines.google;
  return searchUrl + encodeURIComponent(url);
}

function sendToUI(win, channel, data) {
  if (win && win.webContents) {
    win.webContents.send(channel, data);
  } else {
    windows.forEach(w => {
      if (w.webContents) {
        w.webContents.send(channel, data);
      }
    });
  }
}

function saveSession() {
  if (!settingsStore.get('sessionRestoreEnabled')) {
    sessionStore.set('tabs', []);
    sessionStore.set('tabOrders', {});
    return;
  }
  const sessionTabs = Object.values(tabs).map(tab => {
    let url = tab.url;
    if (tab.view && !tab.isSleeping && tab.view.webContents) {
      try {
        url = tab.view.webContents.getURL();
      } catch (e) { }
    }
    return {
      id: tab.id,
      url: url,
      space: tab.space,
      isPinned: !!tab.isPinned,
      title: tab.title,
      lastActive: tab.lastActive,
      isSleeping: !!tab.isSleeping,
      windowId: tab.windowId,
      zoomFactor: tab.zoomFactor || 1.0
    };
  });
  sessionStore.set('tabs', sessionTabs);
  sessionStore.set('tabOrders', tabOrders);
}

// Download manager handler
function setupDownloadListener(sessionInstance, isIncognito = false) {
  sessionInstance.on('will-download', (event, item, webContents) => {
    const fileName = item.getFilename();
    const totalBytes = item.getTotalBytes();
    const downloadId = Date.now();
    const dangerousExtensions = new Set(['exe', 'msi', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'jar', 'scr', 'com', 'reg']);
    const fileExtension = path.extname(fileName).replace('.', '').toLowerCase();
    const dangerousMode = settingsStore.get('dangerousDownloadsProtection') || 'warn';

    console.log(`[Download Manager] will-download event triggered for file: ${fileName}, size: ${totalBytes} bytes`);

    let win = null;
    try {
      win = BrowserWindow.fromWebContents(webContents);
      const tab = Object.values(tabs).find(t => t.view && t.view.webContents === webContents);
      if (tab && tab.windowId) {
        win = win || BrowserWindow.fromId(tab.windowId);
      }
    } catch (e) {
      console.error('[Download Manager] Error finding window for webContents:', e);
    }

    const safeWin = (win && !win.isDestroyed()) ? win : null;

    if (dangerousExtensions.has(fileExtension) && dangerousMode === 'block') {
      event.preventDefault();
      sendToUI(safeWin, 'download-progress', {
        id: downloadId,
        name: fileName,
        status: 'cancelled',
        progress: 0,
        received: 0,
        total: totalBytes
      });
      return;
    }

    const lang = settingsStore.get('language') || 'tr';
    const title = lang === 'tr' ? 'Farklı Kaydet' : (lang === 'fr' ? 'Enregistrer sous' : 'Save As');
    const defaultPath = path.join(app.getPath('downloads'), fileName);

    console.log(`[Download Manager] Save dialog default path: ${defaultPath}`);

    const promptUser = settingsStore.get('downloadPromptEnabled') === true;
    if (promptUser) {
      item.setSaveDialogOptions({
        title: title,
        defaultPath: defaultPath
      });
    } else {
      item.setSavePath(defaultPath);
    }

    activeDownloads[downloadId] = {
      item,
      win: safeWin,
      name: fileName,
      total: totalBytes
    };

    if (dangerousExtensions.has(fileExtension) && dangerousMode === 'warn') {
      const lang = settingsStore.get('language') || 'tr';
      const titleWarn = lang === 'tr' ? 'Güvenli İndirme Uyarısı' : (lang === 'fr' ? 'Avertissement de téléchargement' : 'Download Safety Warning');
      const messageWarn = lang === 'tr'
        ? `"${fileName}" riskli bir dosya türü olabilir. İndirmeye devam edilsin mi?`
        : (lang === 'fr'
          ? `"${fileName}" peut être un type de fichier risqué. Continuer le téléchargement ?`
          : `"${fileName}" may be a risky file type. Continue downloading?`);
      const warningOptions = {
        type: 'warning',
        buttons: lang === 'tr' ? ['Devam Et', 'İptal'] : (lang === 'fr' ? ['Continuer', 'Annuler'] : ['Continue', 'Cancel']),
        defaultId: 1,
        cancelId: 1,
        title: titleWarn,
        message: messageWarn
      };
      item.pause();
      const warningDialog = safeWin ? dialog.showMessageBox(safeWin, warningOptions) : dialog.showMessageBox(warningOptions);
      warningDialog.then(({ response }) => {
        if (response === 0 && !item.isDestroyed?.()) {
          item.resume();
        } else {
          item.cancel();
        }
      }).catch(() => item.cancel());
    }

    // Immediately broadcast initial progress state to the UI
    sendToUI(safeWin, 'download-progress', {
      id: downloadId,
      name: fileName,
      status: 'progressing',
      progress: 0,
      received: 0,
      total: totalBytes
    });

    item.on('updated', (event, state) => {
      if (state === 'interrupted') {
        console.log(`[Download Manager] Download interrupted: ${fileName}`);
        sendToUI(safeWin, 'download-progress', {
          id: downloadId,
          name: fileName,
          status: 'interrupted',
          progress: 0
        });
      } else if (state === 'progressing') {
        const progress = totalBytes > 0 ? Math.round((item.getReceivedBytes() / totalBytes) * 100) : 0;
        sendToUI(safeWin, 'download-progress', {
          id: downloadId,
          name: fileName,
          status: item.isPaused() ? 'paused' : 'progressing',
          progress: progress,
          received: item.getReceivedBytes(),
          total: totalBytes
        });
      }
    });

    item.once('done', (event, state) => {
      console.log(`[Download Manager] Download done state: ${state} for: ${fileName}`);
      delete activeDownloads[downloadId];
      const dlEntry = {
        id: downloadId,
        name: fileName,
        status: state === 'completed' ? 'completed' : (state === 'cancelled' ? 'cancelled' : 'failed'),
        progress: state === 'completed' ? 100 : 0,
        path: state === 'completed' ? item.getSavePath() : '',
        received: item.getReceivedBytes(),
        total: totalBytes,
        timestamp: Date.now()
      };
      if (!(isIncognito && settingsStore.get('incognitoForgetDownloads') !== false)) {
        downloadsStore.push('downloads', dlEntry);
      }
      sendToUI(safeWin, 'download-progress', dlEntry);
    });
  });
}

// IPC Listeners
ipcMain.on('tab-create', (event, data) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const winId = win ? win.id : null;
  const url = typeof data === 'string' ? data : (data ? data.url : null);
  const isIncognito = data && typeof data === 'object' ? !!data.isIncognito : false;
  const space = data && typeof data === 'object' ? data.space || 'Genel' : 'Genel';
  const tabId = data && typeof data === 'object' ? data.id || null : null;
  const isPinned = data && typeof data === 'object' ? !!data.isPinned : false;
  const zoomFactor = data && typeof data === 'object' && typeof data.zoomFactor === 'number' ? data.zoomFactor : null;

  const tab = createTab(url, isIncognito, space, winId, tabId, isPinned, zoomFactor);
  sendToUI(win, 'ui-tab-created', {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    isLoading: tab.isLoading,
    isIncognito: tab.isIncognito,
    space: tab.space,
    isPinned: tab.isPinned,
    zoomFactor: tab.zoomFactor
  });

  if (tab.view && tab.zoomFactor !== 1.0) {
    tab.view.webContents.setZoomFactor(tab.zoomFactor);
  }

  selectTab(tab.id);
  saveSession();
});

ipcMain.on('tab-sleep', (event, tabId) => {
  const tab = tabs[tabId];
  if (tab) {
    const win = BrowserWindow.fromId(tab.windowId);
    if (win && tabId !== activeTabs[win.id]) {
      sleepTab(tabId);
    }
  }
});

ipcMain.on('tabs-reorder', (event, tabIds) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && Array.isArray(tabIds)) {
    tabOrders[win.id] = tabIds;
    saveSession();
  }
});

ipcMain.on('tab-close', (event, tabId) => {
  const tab = tabs[tabId];
  if (!tab) return;
  const win = BrowserWindow.fromId(tab.windowId);
  if (!win) return;

  const wasActive = (activeTabs[win.id] === tabId);
  const closedTabSpace = tab.space || 'Genel';

  destroyTab(tabId);
  sendToUI(win, 'ui-tab-closed', tabId);

  // If active tab was closed, select another tab if possible
  if (wasActive) {
    let windowOrder = tabOrders[win.id] || [];
    let tabIds = windowOrder.filter(id => tabs[id] && tabs[id].space === closedTabSpace);
    if (tabIds.length === 0) {
      tabIds = Object.keys(tabs).filter(id => tabs[id].windowId === win.id && tabs[id].space === closedTabSpace);
    }

    if (tabIds.length > 0) {
      selectTab(tabIds[tabIds.length - 1]);
    } else {
      let remainingAll = windowOrder.filter(id => tabs[id]);
      if (remainingAll.length === 0) {
        remainingAll = Object.keys(tabs).filter(id => tabs[id].windowId === win.id);
      }

      if (remainingAll.length > 0) {
        selectTab(remainingAll[remainingAll.length - 1]);
      } else {
        activeTabs[win.id] = null;
        const newTab = createTab(null, false, closedTabSpace, win.id);
        sendToUI(win, 'ui-tab-created', {
          id: newTab.id,
          url: newTab.url,
          title: newTab.title,
          isLoading: newTab.isLoading,
          isIncognito: newTab.isIncognito,
          space: newTab.space
        });
        selectTab(newTab.id);
      }
    }
  }
  saveSession();
});

ipcMain.on('tab-select', (event, tabId) => {
  selectTab(tabId);
});

ipcMain.on('tab-navigate', (event, { tabId, url }) => {
  const tab = tabs[tabId];
  if (tab) {
    if (tab.isSleeping) {
      wakeTab(tabId);
    }
    const targetUrl = (url || '').trim();
    if (targetUrl === 'oslo://newtab' || targetUrl === '') {
      tab.view.webContents.loadFile(path.join(__dirname, '../newtab/newtab.html'));
    } else {
      tab.view.webContents.loadURL(formatUrl(targetUrl));
    }
  }
});

ipcMain.on('tab-back', (event, tabId) => {
  const tab = tabs[tabId];
  if (tab && tab.view && tab.view.webContents.canGoBack()) {
    tab.view.webContents.goBack();
  }
});

ipcMain.on('tab-forward', (event, tabId) => {
  const tab = tabs[tabId];
  if (tab && tab.view && tab.view.webContents.canGoForward()) {
    tab.view.webContents.goForward();
  }
});

ipcMain.on('tab-reload', (event, tabId) => {
  const tab = tabs[tabId];
  if (tab && tab.view) {
    tab.view.webContents.reload();
  }
});

ipcMain.on('tab-update-space', (event, { tabId, space }) => {
  const tab = tabs[tabId];
  if (tab) {
    tab.space = space;
    const win = BrowserWindow.fromId(tab.windowId);
    sendToUI(win, 'ui-tab-updated', { id: tabId, space: space });
    saveSession();
  }
});

ipcMain.on('tab-set-zoom', (event, { tabId, zoom }) => {
  const tab = tabs[tabId];
  if (tab) {
    tab.zoomFactor = zoom;
    if (tab.view && !tab.isSleeping && tab.view.webContents) {
      tab.view.webContents.setZoomFactor(zoom);
    }
    const win = BrowserWindow.fromId(tab.windowId);
    sendToUI(win, 'ui-zoom-changed', { tabId, zoom });
    saveSession();
  }
});

// Update WebContentsView position and size based on Renderer UI container
ipcMain.on('tab-bounds', (event, bounds) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;

  windowBounds[win.id] = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  };

  const activeId = activeTabs[win.id];
  if (activeId && tabs[activeId] && tabs[activeId].view) {
    const tab = tabs[activeId];
    if (windowBounds[win.id].width === 0 && windowBounds[win.id].height === 0) {
      if (win.contentView.children.includes(tab.view)) {
        win.contentView.removeChildView(tab.view);
      }
    } else {
      if (!win.contentView.children.includes(tab.view)) {
        win.contentView.addChildView(tab.view);
      }
      tab.view.setBounds(windowBounds[win.id]);
    }
  }
});

// Window Control IPC
ipcMain.on('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

ipcMain.on('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  }
});

ipcMain.on('window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

ipcMain.on('window-new', () => {
  createMainWindow();
});

ipcMain.on('download-open', (event, filePath) => {
  if (filePath) {
    shell.openPath(filePath);
  }
});

ipcMain.on('open-external', (event, url) => {
  if (url) {
    shell.openExternal(url);
  }
});

// Storage and Preferences IPC handlers
ipcMain.handle('bookmarks-get', () => {
  return bookmarksStore.get('bookmarks');
});

function buildNativeBookmarksMenu(bookmarks, folderId, win) {
  const { Menu, MenuItem } = require('electron');
  const items = bookmarks.filter(b => {
    const bFolderId = b.folderId === undefined ? null : b.folderId;
    return bFolderId === folderId;
  });
  if (items.length === 0) {
    const menu = new Menu();
    menu.append(new MenuItem({ label: '(Klasör boş)', enabled: false }));
    return menu;
  }
  const menu = new Menu();
  items.forEach(b => {
    if (b.isFolder) {
      const submenu = buildNativeBookmarksMenu(bookmarks, b.id, win);
      menu.append(new MenuItem({
        label: `📁 ${b.title}`,
        submenu: submenu
      }));
    } else {
      menu.append(new MenuItem({
        label: b.title,
        click: () => {
          const activeTabId = activeTabs[win.id];
          if (activeTabId && tabs[activeTabId]) {
            const targetUrl = b.url || '';
            if (tabs[activeTabId].isSleeping) {
              wakeTab(activeTabId);
            }
            if (tabs[activeTabId].view) {
              tabs[activeTabId].view.webContents.loadURL(formatUrl(targetUrl));
            }
          }
        }
      }));
    }
  });
  return menu;
}

ipcMain.on('show-bookmarks-folder-menu', (event, { folderId, x, y }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const bookmarks = bookmarksStore.get('bookmarks') || [];
  const menu = buildNativeBookmarksMenu(bookmarks, folderId, win);
  menu.popup({
    window: win,
    x: x ? Math.round(x) : undefined,
    y: y ? Math.round(y) : undefined
  });
});

ipcMain.handle('bookmarks-set', (event, bookmarks) => {
  bookmarksStore.set('bookmarks', bookmarks);
  return bookmarks;
});

ipcMain.handle('bookmarks-add', (event, bookmark) => {
  const bookmarks = bookmarksStore.get('bookmarks');
  if (!bookmarks.some(b => b.url === bookmark.url)) {
    bookmarksStore.push('bookmarks', bookmark);
  }
  return bookmarksStore.get('bookmarks');
});

ipcMain.handle('bookmarks-remove', (event, url) => {
  bookmarksStore.filter('bookmarks', b => b.url !== url);
  return bookmarksStore.get('bookmarks');
});

ipcMain.handle('bookmarks-update', (event, { oldUrl, bookmark }) => {
  const bookmarks = bookmarksStore.get('bookmarks') || [];
  const index = bookmarks.findIndex(b => b.url === oldUrl);
  if (index !== -1) {
    // If the URL changed, make sure we don't collide with an existing one unless it is the same bookmark
    bookmarks[index] = bookmark;
    bookmarksStore.set('bookmarks', bookmarks);
  }
  return bookmarksStore.get('bookmarks');
});

ipcMain.handle('history-get', () => {
  return historyStore.get('history');
});

ipcMain.handle('history-clear', (event, range) => {
  if (!range || range === 'all') {
    historyStore.set('history', []);
  } else {
    const history = historyStore.get('history') || [];
    const now = Date.now();
    let threshold = 0;
    if (range === 'hour') threshold = now - 60 * 60 * 1000;
    else if (range === 'day') threshold = now - 24 * 60 * 60 * 1000;
    else if (range === 'week') threshold = now - 7 * 24 * 60 * 60 * 1000;

    if (threshold > 0) {
      const filtered = history.filter(item => item.timestamp < threshold);
      historyStore.set('history', filtered);
    }
  }
  return [];
});

function isNewerVersion(current, latest) {
  const parse = v => v.split('.').map(Number);
  const curParts = parse(current);
  const latParts = parse(latest);
  for (let i = 0; i < Math.max(curParts.length, latParts.length); i++) {
    const curVal = curParts[i] || 0;
    const latVal = latParts[i] || 0;
    if (latVal > curVal) return true;
    if (curVal > latVal) return false;
  }
  return false;
}

ipcMain.handle('check-for-updates', async () => {
  const currentVersion = app.getVersion();
  try {
    const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: {
        'User-Agent': 'oslo-browser-updater'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned status ${response.status}`);
    }

    const release = await response.json();
    const latestVersion = release.tag_name.replace(/^v/, '');

    let downloadUrl = 'https://oslobrowser.com/download';
    if (release.assets && release.assets.length > 0) {
      const winAsset = release.assets.find(asset => asset.name.endsWith('.exe') || asset.name.endsWith('.zip'));
      if (winAsset) {
        downloadUrl = winAsset.browser_download_url;
      } else {
        downloadUrl = release.html_url;
      }
    } else {
      downloadUrl = release.html_url;
    }

    return {
      updateAvailable: isNewerVersion(currentVersion, latestVersion),
      currentVersion,
      latestVersion,
      releaseNotes: release.body || '',
      downloadUrl
    };
  } catch (error) {
    console.error('Failed to check for updates from GitHub:', error);
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: currentVersion,
      releaseNotes: '',
      downloadUrl: '',
      error: error.message
    };
  }
});

ipcMain.handle('download-update', async (event, { url, version }) => {
  const fs = require('fs');
  const https = require('https');
  const { spawn } = require('child_process');
  const os = require('os');
  const path = require('path');
  
  const win = BrowserWindow.fromWebContents(event.sender);
  const tempDir = os.tmpdir();
  const installerPath = path.join(tempDir, `OSLO-Browser-${version}-Setup.exe`);
  
  const file = fs.createWriteStream(installerPath);
  
  return new Promise((resolve, reject) => {
    function download(downloadUrl) {
      https.get(downloadUrl, {
        headers: {
          'User-Agent': 'oslo-browser-updater'
        }
      }, (response) => {
        // Redirect
        if (response.statusCode === 302 || response.statusCode === 301) {
          download(response.headers.location);
          return;
        }
        
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: status ${response.statusCode}`));
          return;
        }
        
        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloadedSize = 0;
        
        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          const progress = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0;
          if (win && !win.isDestroyed()) {
            win.webContents.send('update-download-progress', { progress });
          }
        });
        
        response.pipe(file);
        
        file.on('finish', () => {
          file.close();
          
          try {
            // Spawn the installer detached from OSLO so it remains alive after OSLO exits
            const child = spawn(installerPath, [], {
              detached: true,
              stdio: 'ignore'
            });
            child.unref();
            
            // Quit the app immediately so the installer can overwrite locked executable/resources
            setTimeout(() => {
              app.quit();
            }, 500);
            
            resolve({ success: true });
          } catch (err) {
            console.error('Failed to spawn installer:', err);
            reject(err);
          }
        });
      }).on('error', (err) => {
        fs.unlink(installerPath, () => {});
        reject(err);
      });
    }
    
    download(url);
  });
});

ipcMain.handle('system-info-get', () => {
  const os = require('os');
  return {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    totalMem: Math.round(os.totalmem() / (1024 * 1024 * 1024)) + ' GB',
    freeMem: Math.round(os.freemem() / (1024 * 1024 * 1024)) + ' GB',
    cpuModel: os.cpus()[0]?.model || 'Unknown',
    uptime: Math.round(os.uptime() / 3600) + ' hours'
  };
});

ipcMain.handle('clear-browser-data', async () => {
  try {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({
      storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
    });
    return { success: true };
  } catch (error) {
    console.error('Failed to clear browser data:', error);
    return { success: false, message: error.message };
  }
});

ipcMain.on('telemetry-log-event', (event, { action, data }) => {
  if (settingsStore.get('telemetryEnabled')) {
    const events = telemetryStore.get('events') || [];
    events.push({
      timestamp: Date.now(),
      action,
      data
    });
    if (events.length > 100) events.splice(0, events.length - 100);
    telemetryStore.set('events', events);
  }
});

ipcMain.on('telemetry-log-crash', (event, error) => {
  if (settingsStore.get('telemetryEnabled') && error) {
    const crashes = telemetryStore.get('crashes') || [];
    crashes.push({
      timestamp: Date.now(),
      message: error.message || String(error),
      stack: error.stack || '',
      process: 'renderer'
    });
    if (crashes.length > 50) crashes.splice(0, crashes.length - 50);
    telemetryStore.set('crashes', crashes);
  }
});

ipcMain.handle('telemetry-get-logs', () => {
  return {
    events: telemetryStore.get('events') || [],
    crashes: telemetryStore.get('crashes') || []
  };
});

ipcMain.handle('telemetry-clear-logs', () => {
  telemetryStore.set('events', []);
  telemetryStore.set('crashes', []);
  return { success: true };
});

ipcMain.handle('permissions-get-all', () => {
  return permissionsStore.get('permissions') || {};
});

ipcMain.handle('permissions-delete', (event, key) => {
  const saved = permissionsStore.get('permissions') || {};
  delete saved[key];
  permissionsStore.set('permissions', saved);
  return saved;
});

ipcMain.handle('permissions-set', (event, key, value) => {
  const saved = permissionsStore.get('permissions') || {};
  if (value === null || value === undefined) {
    delete saved[key];
  } else {
    saved[key] = value;
  }
  permissionsStore.set('permissions', saved);
  return saved;
});

ipcMain.handle('site-data-get', async () => {
  const cookies = await session.defaultSession.cookies.get({});
  const grouped = new Map();

  cookies.forEach(cookie => {
    const domain = String(cookie.domain || '').replace(/^\./, '') || 'local';
    if (!grouped.has(domain)) {
      grouped.set(domain, {
        domain,
        cookieCount: 0,
        secureCookieCount: 0,
        sessionCookieCount: 0
      });
    }
    const item = grouped.get(domain);
    item.cookieCount += 1;
    if (cookie.secure) item.secureCookieCount += 1;
    if (!cookie.expirationDate) item.sessionCookieCount += 1;
  });

  return Array.from(grouped.values()).sort((a, b) => a.domain.localeCompare(b.domain));
});

ipcMain.handle('site-data-clear', async (event, domain) => {
  const cleanDomain = String(domain || '').replace(/^\./, '');
  if (!cleanDomain) return { success: false, message: 'missing_domain' };

  const cookies = await session.defaultSession.cookies.get({});
  const matches = cookies.filter(cookie => String(cookie.domain || '').replace(/^\./, '') === cleanDomain);
  await Promise.all(matches.map(cookie => {
    const scheme = cookie.secure ? 'https' : 'http';
    const cookieUrl = `${scheme}://${cleanDomain}${cookie.path || '/'}`;
    return session.defaultSession.cookies.remove(cookieUrl, cookie.name).catch(() => null);
  }));

  await Promise.all(['http', 'https'].map(scheme => {
    return session.defaultSession.clearStorageData({
      origin: `${scheme}://${cleanDomain}`,
      storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'websql', 'serviceworkers', 'cachestorage']
    }).catch(() => null);
  }));

  return { success: true };
});

ipcMain.handle('certificate-exceptions-get', () => {
  return certificateExceptionsStore.get('exceptions') || {};
});

ipcMain.handle('certificate-exceptions-delete', (event, host) => {
  const exceptions = certificateExceptionsStore.get('exceptions') || {};
  delete exceptions[host];
  certificateExceptionsStore.set('exceptions', exceptions);
  return exceptions;
});

ipcMain.handle('certificate-exceptions-clear', () => {
  certificateExceptionsStore.set('exceptions', {});
  return {};
});

ipcMain.handle('downloads-get', () => {
  return downloadsStore.get('downloads') || [];
});

ipcMain.handle('downloads-clear', () => {
  downloadsStore.set('downloads', []);
  return [];
});

ipcMain.handle('spaces-get', () => {
  const raw = spacesStore.get('spaces') || ['Genel'];
  let migrated = raw.map(s => {
    let obj = typeof s === 'string' ? { name: s, emoji: '🌐', color: '#000000' } : s;
    if (obj.name === 'Genel') {
      obj.color = '#000000';
    }
    return obj;
  });
  if (JSON.stringify(raw) !== JSON.stringify(migrated)) {
    spacesStore.set('spaces', migrated);
  }
  return migrated;
});

ipcMain.handle('spaces-add', (event, space) => {
  const raw = spacesStore.get('spaces') || ['Genel'];
  let spaces = raw.map(s => {
    let obj = typeof s === 'string' ? { name: s, emoji: '🌐', color: '#000000' } : s;
    if (obj.name === 'Genel') {
      obj.color = '#000000';
    }
    return obj;
  });

  const spaceObj = typeof space === 'string' ? { name: space, emoji: '🌐', color: '#10b981' } : space;
  if (!spaces.some(s => s.name === spaceObj.name)) {
    spaces.push(spaceObj);
    spacesStore.set('spaces', spaces);
  }
  return spaces;
});

ipcMain.handle('spaces-delete', (event, spaceName) => {
  const raw = spacesStore.get('spaces') || ['Genel'];
  let spaces = raw.map(s => {
    let obj = typeof s === 'string' ? { name: s, emoji: '🌐', color: '#000000' } : s;
    if (obj.name === 'Genel') {
      obj.color = '#000000';
    }
    return obj;
  });

  let filtered = spaces.filter(s => s.name !== spaceName);
  if (filtered.length === 0) {
    filtered.push({ name: 'Genel', emoji: '🌐', color: '#000000' });
  }
  spacesStore.set('spaces', filtered);
  return filtered;
});

ipcMain.handle('spaces-update', (event, { oldName, space }) => {
  const raw = spacesStore.get('spaces') || ['Genel'];
  let spaces = raw.map(s => {
    let obj = typeof s === 'string' ? { name: s, emoji: '🌐', color: '#000000' } : s;
    if (obj.name === 'Genel') {
      obj.color = '#000000';
    }
    return obj;
  });

  const idx = spaces.findIndex(s => s.name === oldName);
  if (idx !== -1) {
    if (space.name === 'Genel' || oldName === 'Genel') {
      space.color = '#000000';
    }
    spaces[idx] = space;
    spacesStore.set('spaces', spaces);
  }
  return spaces;
});

ipcMain.on('find-in-page', (event, { text, options }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const activeTabId = activeTabs[win.id];
  if (activeTabId && tabs[activeTabId] && tabs[activeTabId].view) {
    tabs[activeTabId].view.webContents.findInPage(text, options);
  }
});

ipcMain.on('stop-find-in-page', (event, { action }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const activeTabId = activeTabs[win.id];
  if (activeTabId && tabs[activeTabId] && tabs[activeTabId].view) {
    tabs[activeTabId].view.webContents.stopFindInPage(action);
  }
});

// Unified Settings Handlers
ipcMain.handle('settings-get-all', () => {
  return settingsStore.data;
});

function applySetting(key, value) {
  const networkPrivacyKeys = new Set([
    'cookiePolicy',
    'trackingProtectionLevel',
    'fingerprintProtection',
    'refererPolicy',
    'globalPrivacyControl',
    'incognitoBlockThirdPartyCookies',
    'httpsOnlyExceptions'
  ]);

  if (key === 'adblockEnabled') {
    adblock.setAdBlockEnabled(value);
  } else if (key === 'httpsOnlyEnabled') {
    adblock.setHttpsOnlyEnabled(value);
  } else if (networkPrivacyKeys.has(key)) {
    syncNetworkPrivacyOptions();
  } else if (key === 'customCss' && settingsStore.get('customCssEnabled') !== false) {
    Object.values(tabs).forEach(tab => {
      if (tab.view && !tab.isSleeping) {
        tab.view.webContents.insertCSS(value).catch(() => { });
      }
    });
  } else if (key === 'customCssEnabled' && value && settingsStore.get('customCss')) {
    const customCss = settingsStore.get('customCss');
    Object.values(tabs).forEach(tab => {
      if (tab.view && !tab.isSleeping) {
        tab.view.webContents.insertCSS(customCss).catch(() => { });
      }
    });
  } else if (key === 'defaultPageZoom') {
    const zoom = parseFloat(value) || 1.0;
    Object.values(tabs).forEach(tab => {
      tab.zoomFactor = zoom;
      if (tab.view && !tab.isSleeping && tab.view.webContents) {
        tab.view.webContents.setZoomFactor(zoom);
      }
      const tabWindow = BrowserWindow.fromId(tab.windowId);
      sendToUI(tabWindow, 'ui-zoom-changed', { tabId: tab.id, zoom });
    });
    saveSession();
  }

  // Broadcast to main window and all active tabs
  const broadcastData = { key, value };
  windows.forEach(win => {
    sendToUI(win, 'ui-settings-updated', broadcastData);
  });
  Object.values(tabs).forEach(tab => {
    if (tab.view && !tab.isSleeping && tab.view.webContents) {
      tab.view.webContents.send('ui-settings-updated', broadcastData);
    }
  });
}

ipcMain.handle('settings-set', (event, { key, value }) => {
  settingsStore.set(key, value);
  applySetting(key, value);
  return value;
});

ipcMain.handle('settings-export', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Ayarları Dışa Aktar',
    defaultPath: 'oslo-settings.json',
    filters: [{ name: 'JSON Files', extensions: ['json'] }]
  });

  if (canceled || !filePath) return false;

  const fs = require('fs');
  try {
    fs.writeFileSync(filePath, JSON.stringify(settingsStore.data, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error('Failed to export settings:', error);
    throw error;
  }
});

ipcMain.handle('settings-import', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Ayarları İçe Aktar',
    properties: ['openFile'],
    filters: [{ name: 'JSON Files', extensions: ['json'] }]
  });

  if (canceled || !filePaths || filePaths.length === 0) return null;

  const fs = require('fs');
  try {
    const content = fs.readFileSync(filePaths[0], 'utf-8');
    const imported = JSON.parse(content);
    if (!imported || typeof imported !== 'object' || Array.isArray(imported)) {
      throw new Error('Geçersiz ayar dosyası formatı.');
    }

    // Apply settings key-by-key
    for (const [key, value] of Object.entries(imported)) {
      if (key in DEFAULT_SETTINGS) {
        settingsStore.set(key, value);
        applySetting(key, value);
      }
    }

    return settingsStore.data;
  } catch (error) {
    console.error('Failed to import settings:', error);
    throw error;
  }
});

ipcMain.handle('settings-reset', async (event) => {
  try {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      settingsStore.set(key, value);
      applySetting(key, value);
    }
    return settingsStore.data;
  } catch (error) {
    console.error('Failed to reset settings:', error);
    throw error;
  }
});

ipcMain.handle('newtab-wallpaper-select-file', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Yeni Sekme Arka Planı Seç',
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (canceled || !filePaths || filePaths.length === 0) {
    return null;
  }

  return pathToFileURL(filePaths[0]).toString();
});

// Password Management IPC Handlers
ipcMain.handle('passwords-get', () => {
  return passwordsStore.get('passwords') || [];
});

ipcMain.handle('passwords-save', (event, credential) => {
  const list = passwordsStore.get('passwords') || [];

  // Check if same origin and username already exist to overwrite
  const idx = list.findIndex(p => p.origin === credential.origin && p.username === credential.username);
  if (idx !== -1) {
    list[idx].password = credential.password;
  } else {
    const newEntry = {
      id: 'pw_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      origin: credential.origin,
      username: credential.username,
      password: credential.password
    };
    list.push(newEntry);
  }

  passwordsStore.set('passwords', list);
  return list;
});

ipcMain.handle('passwords-delete', (event, id) => {
  let list = passwordsStore.get('passwords') || [];
  list = list.filter(p => p.id !== id);
  passwordsStore.set('passwords', list);
  return list;
});

// CSV Parser Helper for importing passwords
function parsePasswordsCsv(content) {
  const lines = content.split(/\r?\n/);
  if (lines.length < 2) return [];

  const splitCsvLine = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++; // Skip next quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = splitCsvLine(lines[0]).map(h => h.toLowerCase());

  // Find column indices based on common CSV headers
  let urlIdx = headers.findIndex(h => h.includes('url') || h.includes('website') || h.includes('origin') || h.includes('link'));
  let userIdx = headers.findIndex(h => h.includes('username') || h.includes('login') || h.includes('user') || h.includes('email'));
  let passIdx = headers.findIndex(h => h.includes('password') || h.includes('pass') || h.includes('şifre') || h.includes('sifre'));

  // Fallbacks if headers are missing or unrecognized (Chrome export typically has name,url,username,password)
  if (urlIdx === -1) urlIdx = headers.findIndex(h => h === 'name') !== -1 ? 1 : 0;
  if (userIdx === -1) userIdx = urlIdx === 0 ? 1 : 2;
  if (passIdx === -1) passIdx = userIdx + 1;

  // Safety bounds check fallback
  if (urlIdx === -1) urlIdx = 0;
  if (userIdx === -1) userIdx = 1;
  if (passIdx === -1) passIdx = 2;

  const imported = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = splitCsvLine(line);
    const maxIdx = Math.max(urlIdx, userIdx, passIdx);
    if (cells.length <= maxIdx) continue;

    let origin = cells[urlIdx];
    const username = cells[userIdx];
    const password = cells[passIdx];

    if (!origin || !username || !password) continue;

    // Ensure origin starts with a protocol
    if (!/^https?:\/\//i.test(origin)) {
      if (origin.includes('.')) {
        origin = 'https://' + origin;
      } else {
        origin = 'http://' + origin;
      }
    }

    imported.push({ origin, username, password });
  }
  return imported;
}

ipcMain.handle('passwords-import', async (event) => {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const { canceled, filePaths } = await dialog.showOpenDialog(focusedWindow, {
    title: 'Şifreleri İçe Aktar (CSV)',
    filters: [
      { name: 'CSV Files', extensions: ['csv'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });

  if (canceled || filePaths.length === 0) {
    return { success: false, message: 'canceled' };
  }

  try {
    const fs = require('fs');
    const filePath = filePaths[0];
    const content = fs.readFileSync(filePath, 'utf-8');
    const imported = parsePasswordsCsv(content);

    if (imported.length === 0) {
      return { success: false, message: 'no_credentials_found' };
    }

    const list = passwordsStore.get('passwords') || [];
    let addedCount = 0;
    let updatedCount = 0;

    for (const item of imported) {
      const idx = list.findIndex(p => p.origin === item.origin && p.username === item.username);
      if (idx !== -1) {
        if (list[idx].password !== item.password) {
          list[idx].password = item.password;
          updatedCount++;
        }
      } else {
        list.push({
          id: 'pw_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9) + '_' + addedCount,
          origin: item.origin,
          username: item.username,
          password: item.password
        });
        addedCount++;
      }
    }

    passwordsStore.set('passwords', list);
    return { success: true, added: addedCount, updated: updatedCount, total: imported.length };
  } catch (error) {
    console.error('Failed to import passwords:', error);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('passwords-export', async (event) => {
  const list = passwordsStore.get('passwords') || [];
  if (list.length === 0) {
    return { success: false, message: 'no_passwords_to_export' };
  }

  const focusedWindow = BrowserWindow.getFocusedWindow();
  const { canceled, filePath } = await dialog.showSaveDialog(focusedWindow, {
    title: 'Şifreleri Dışarı Aktar (CSV)',
    defaultPath: 'oslo_passwords.csv',
    filters: [
      { name: 'CSV Files', extensions: ['csv'] }
    ]
  });

  if (canceled || !filePath) {
    return { success: false, message: 'canceled' };
  }

  try {
    const fs = require('fs');
    let csvContent = 'name,url,username,password\n';

    const escapeCsv = (str) => {
      if (typeof str !== 'string') return '';
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    };

    for (const p of list) {
      let name = p.origin;
      try {
        const urlObj = new URL(p.origin);
        name = urlObj.hostname;
      } catch (e) { }

      csvContent += `${escapeCsv(name)},${escapeCsv(p.origin)},${escapeCsv(p.username)},${escapeCsv(p.password)}\n`;
    }

    fs.writeFileSync(filePath, csvContent, 'utf-8');
    return { success: true, count: list.length };
  } catch (error) {
    console.error('Failed to export passwords:', error);
    return { success: false, message: error.message };
  }
});

ipcMain.handle('get-saved-credentials', (event, origin) => {
  if (!settingsStore.get('autofillEnabled')) return [];
  const list = passwordsStore.get('passwords') || [];
  return list.filter(p => p.origin === origin);
});

// Handle form submissions from preload.js
ipcMain.on('login-form-submitted', (event, data) => {
  console.log('[PasswordManager] login-form-submitted received:', JSON.stringify({ origin: data.origin, username: data.username, hasPassword: !!data.password }));

  if (!settingsStore.get('savePasswordsEnabled')) {
    console.log('[PasswordManager] savePasswordsEnabled is disabled, ignoring.');
    return;
  }
  if (!data.origin || !data.username || !data.password) {
    console.log('[PasswordManager] Missing data fields, ignoring.');
    return;
  }

  const list = passwordsStore.get('passwords') || [];
  const existing = list.find(p => p.origin === data.origin && p.username === data.username);

  // If it doesn't exist or has a different password, prompt to save/update
  if (!existing || existing.password !== data.password) {
    console.log('[PasswordManager] Credential is new or updated, looking for window to show prompt...');

    // Try to find the tab by matching event.sender to tab.view.webContents
    let tab = Object.values(tabs).find(t => t.view && t.view.webContents === event.sender);
    let win = null;

    if (tab && tab.windowId) {
      win = BrowserWindow.fromId(tab.windowId);
      console.log('[PasswordManager] Found tab via direct match, windowId:', tab.windowId);
    }

    // Fallback: use BrowserWindow.fromWebContents which traverses parent chain
    if (!win) {
      win = BrowserWindow.fromWebContents(event.sender);
      console.log('[PasswordManager] Fallback: BrowserWindow.fromWebContents result:', win ? win.id : 'null');
    }

    // Last resort: use the first available window
    if (!win && windows.size > 0) {
      win = Array.from(windows)[0];
      console.log('[PasswordManager] Last resort: using first window, id:', win.id);
    }

    if (win) {
      console.log('[PasswordManager] Sending ui-password-save-prompt to window', win.id);
      sendToUI(win, 'ui-password-save-prompt', {
        origin: data.origin,
        username: data.username,
        password: data.password,
        isUpdate: !!existing
      });
    } else {
      console.log('[PasswordManager] ERROR: No window found to show prompt!');
    }
  } else {
    console.log('[PasswordManager] Credential already saved with same password, skipping.');
  }
});

// Legacy Handlers as fallback
ipcMain.handle('adblock-get', () => {
  return adblock.isAdBlockEnabled();
});
ipcMain.on('adblock-get-sync', (event) => {
  event.returnValue = adblock.isAdBlockEnabled();
});
ipcMain.on('privacy-shields-get-sync', (event) => {
  event.returnValue = {
    adBlockEnabled: adblock.isAdBlockEnabled(),
    fingerprintProtection: settingsStore.get('fingerprintProtection') !== false
  };
});
ipcMain.handle('adblock-set', (event, enabled) => {
  adblock.setAdBlockEnabled(enabled);
  settingsStore.set('adblockEnabled', enabled);
  return enabled;
});
ipcMain.handle('adblock-get-count', () => {
  return settingsStore.get('blockedCount') || 0;
});
ipcMain.handle('httpsonly-get', () => {
  return settingsStore.get('httpsOnlyEnabled') || false;
});
ipcMain.handle('httpsonly-set', (event, enabled) => {
  settingsStore.set('httpsOnlyEnabled', enabled);
  adblock.setHttpsOnlyEnabled(enabled);
  return enabled;
});
ipcMain.handle('searchengine-get', () => {
  return settingsStore.get('searchEngine');
});
ipcMain.handle('searchengine-set', (event, engine) => {
  settingsStore.set('searchEngine', engine);
  return engine;
});
ipcMain.handle('custom-css-get', () => {
  return settingsStore.get('customCss') || '';
});
ipcMain.handle('custom-css-set', (event, css) => {
  settingsStore.set('customCss', css);
  if (settingsStore.get('customCssEnabled') !== false) {
    Object.values(tabs).forEach(tab => {
      if (tab.view && !tab.isSleeping) {
        tab.view.webContents.insertCSS(css).catch(() => { });
      }
    });
  }
  return css;
});

// Enhanced Download Controls
ipcMain.on('download-pause', (event, id) => {
  const download = activeDownloads[id];
  const item = download && (download.item || download);
  if (item && !item.isPaused()) {
    try {
      item.pause();
      sendToUI(download.win, 'download-progress', {
        id,
        name: download.name,
        status: 'paused',
        progress: Math.max(0, Math.min(Math.round(item.getPercentComplete()) || 0, 100)),
        received: item.getReceivedBytes(),
        total: download.total
      });
    } catch (err) {
      console.error('[Download Manager] Failed to pause download:', err);
    }
  }
});
ipcMain.on('download-resume', (event, id) => {
  const download = activeDownloads[id];
  const item = download && (download.item || download);
  if (item && item.isPaused()) {
    try {
      item.resume();
      sendToUI(download.win, 'download-progress', {
        id,
        name: download.name,
        status: 'progressing',
        progress: Math.max(0, Math.min(Math.round(item.getPercentComplete()) || 0, 100)),
        received: item.getReceivedBytes(),
        total: download.total
      });
    } catch (err) {
      console.error('[Download Manager] Failed to resume download:', err);
    }
  }
});
ipcMain.on('download-cancel', (event, id) => {
  const download = activeDownloads[id];
  const item = download && (download.item || download);
  if (item) {
    try {
      item.cancel();
      sendToUI(download.win, 'download-progress', {
        id,
        name: download.name,
        status: 'cancelled',
        progress: 0,
        received: item.getReceivedBytes(),
        total: download.total
      });
    } catch (err) {
      console.error('[Download Manager] Failed to cancel download:', err);
      delete activeDownloads[id];
    }
  }
});

// Memory Saver / Sleeping Tabs Background Timer
setInterval(() => {
  if (settingsStore.get('sleepTabsEnabled') === false) return;

  const now = Date.now();
  const sleepTimeoutMinutes = parseFloat(settingsStore.get('sleepTabsTimeout')) || 15;
  const sleepThreshold = sleepTimeoutMinutes * 60 * 1000;

  Object.keys(tabs).forEach(id => {
    const tab = tabs[id];
    if (!tab.view || !tab.view.webContents) return;
    // Memory Saver / Sleeping Tabs Background Timer
    const win = BrowserWindow.fromWebContents(tab.view.webContents);
    const activeId = win ? activeTabs[win.id] : null;
    if (id === activeId || tab.isSleeping || tab.isLoading || tab.isIncognito) return;

    if (now - tab.lastActive > sleepThreshold) {
      sleepTab(id);
    }
  });
}, 30000); // Check every 30 seconds

// App Startup
app.whenReady().then(() => {
  // SSL Certificate error popup handling
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    event.preventDefault();
    const win = BrowserWindow.fromWebContents(webContents);
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch (e) { }

    const exceptions = certificateExceptionsStore.get('exceptions') || {};
    if (exceptions[host]) {
      callback(true);
      return;
    }

    const lang = settingsStore.get('language') || 'tr';
    const title = lang === 'tr' ? 'Güvenlik Uyarısı' : (lang === 'fr' ? 'Alerte de Sécurité' : 'Security Warning');
    const message = lang === 'tr' ? `"${url}" sitesinin güvenlik sertifikası güvenilmez.` :
      (lang === 'fr' ? `Le certificat de sécurité pour "${url}" n'est pas fiable.` :
        `The security certificate for "${url}" is not trusted.`);
    const detail = lang === 'tr' ? `Hata: ${error}\nYine de devam etmek istiyor musunuz?` :
      (lang === 'fr' ? `Erreur: ${error}\nVoulez-vous continuer quand même ?` :
        `Error: ${error}\nDo you want to proceed anyway?`);
    const buttons = lang === 'tr' ? ['Yine de Devam Et', 'Geri Dön'] :
      (lang === 'fr' ? ['Continuer', 'Retour'] : ['Proceed Anyway', 'Go Back']);

    const certificateDialogOptions = {
      type: 'warning',
      buttons: buttons,
      defaultId: 1,
      cancelId: 1,
      title: title,
      message: message,
      detail: detail
    };
    const certificateDialog = win && !win.isDestroyed()
      ? dialog.showMessageBox(win, certificateDialogOptions)
      : dialog.showMessageBox(certificateDialogOptions);
    certificateDialog.then(({ response }) => {
      if (response === 0) {
        const current = certificateExceptionsStore.get('exceptions') || {};
        current[host] = {
          host,
          error,
          url,
          addedAt: Date.now()
        };
        certificateExceptionsStore.set('exceptions', current);
        callback(true);
      } else {
        callback(false);
      }
    });
  });

  // Sync adblocker state
  adblock.setAdBlockEnabled(settingsStore.get('adblockEnabled'));
  adblock.setHttpsOnlyEnabled(settingsStore.get('httpsOnlyEnabled') || false);
  syncNetworkPrivacyOptions();
  adblock.setupAdBlocker(session.defaultSession, 'default');

  // Set up downloads for default session
  setupDownloadListener(session.defaultSession);

  // Sync adblocker callback
  adblock.setOnBlockCallback((url) => {
    const current = settingsStore.get('blockedCount') || 0;
    settingsStore.set('blockedCount', current + 1);
    windows.forEach(win => {
      sendToUI(win, 'ad-blocked', { url, total: current + 1 });
    });
  });

  // Create incognito session
  incognitoSession = session.fromPartition('incognito');

  // Clean User Agents to resemble standard Chrome (removing Electron/App references)
  const cleanUserAgent = (sessionInstance) => {
    try {
      const rawUa = sessionInstance.getUserAgent();
      const cleanUa = rawUa
        .replace(/Electron\/[0-9.]+\s?/g, '')
        .replace(/oslobrowser\/[0-9.]+\s?/gi, '')
        .trim();
      sessionInstance.setUserAgent(cleanUa);
    } catch (err) {
      console.error('Failed to clean User Agent:', err);
    }
  };
  cleanUserAgent(session.defaultSession);
  cleanUserAgent(incognitoSession);

  adblock.setupAdBlocker(incognitoSession, 'incognito');
  setupDownloadListener(incognitoSession, true);

  const setupPermissionHandler = (sessionInstance) => {
    sessionInstance.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const requestingUrl = details.requestingUrl || webContents.getURL();
      let domain = '';
      try {
        domain = new URL(requestingUrl).hostname;
      } catch (e) {
        domain = requestingUrl;
      }

      const resolvePermissionType = () => {
        if (permission === 'notifications') return 'notifications';
        if (permission === 'geolocation') return 'location';
        if (permission === 'clipboard-read') return 'clipboard';
        if (permission === 'media') {
          const types = details.mediaTypes || [];
          if (types.includes('video')) return 'camera';
          if (types.includes('audio')) return 'microphone';
          return 'camera';
        }
        return permission;
      };

      const permissionType = resolvePermissionType();
      const defaultSettingMap = {
        notifications: 'permissionNotifications',
        camera: 'permissionCamera',
        microphone: 'permissionMicrophone',
        location: 'permissionLocation',
        clipboard: 'permissionClipboard'
      };

      if (defaultSettingMap[permissionType]) {
        const saved = permissionsStore.get('permissions') || {};
        const decision = saved[`${domain}:${permissionType}`];

        if (decision !== undefined) {
          return callback(decision);
        }

        const defaultDecision = settingsStore.get(defaultSettingMap[permissionType]) || 'ask';
        if (defaultDecision === 'allow') return callback(true);
        if (defaultDecision === 'block') return callback(false);

        // No decision saved, show prompt in the active BrowserWindow
        let win = BrowserWindow.fromWebContents(webContents);
        if (!win) {
          const tab = Object.values(tabs).find(item => item.view && item.view.webContents === webContents);
          if (tab && tab.windowId) {
            win = BrowserWindow.fromId(tab.windowId);
          }
        }
        if (win) {
          const reqId = ++permissionRequestId;
          pendingPermissionRequests[reqId] = { callback, domain, permission: permissionType };
          sendToUI(win, 'ui-permission-request', { id: reqId, domain, permission: permissionType });
        } else {
          callback(false);
        }
      } else {
        callback(true);
      }
    });
  };

  setupPermissionHandler(session.defaultSession);
  setupPermissionHandler(incognitoSession);

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let isCleaningOnQuit = false;
app.on('before-quit', async (event) => {
  if (isCleaningOnQuit) return;

  const shouldClean =
    settingsStore.get('clearHistoryOnExit') ||
    settingsStore.get('clearCookiesOnExit') ||
    settingsStore.get('clearCacheOnExit') ||
    settingsStore.get('clearDownloadsOnExit') ||
    settingsStore.get('clearLocalStorageOnExit');

  if (!shouldClean) return;

  event.preventDefault();
  isCleaningOnQuit = true;

  try {
    if (settingsStore.get('clearHistoryOnExit')) {
      historyStore.set('history', []);
    }
    if (settingsStore.get('clearDownloadsOnExit')) {
      downloadsStore.set('downloads', []);
    }
    if (settingsStore.get('clearCacheOnExit')) {
      await session.defaultSession.clearCache();
    }
    const storages = [];
    if (settingsStore.get('clearCookiesOnExit')) storages.push('cookies');
    if (settingsStore.get('clearLocalStorageOnExit')) {
      storages.push('localstorage', 'indexdb', 'websql', 'filesystem', 'serviceworkers', 'cachestorage');
    }
    if (storages.length > 0) {
      await session.defaultSession.clearStorageData({ storages });
    }
  } catch (error) {
    console.error('Failed to clear data on exit:', error);
  } finally {
    app.quit();
  }
});

// Bookmarks Export Netscape HTML
ipcMain.handle('bookmarks-export', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { filePath } = await dialog.showSaveDialog(win, {
    title: 'Yer İmlerini Dışa Aktar',
    defaultPath: 'bookmarks.html',
    filters: [{ name: 'HTML Files', extensions: ['html'] }]
  });

  if (!filePath) return null;

  const bookmarks = bookmarksStore.get('bookmarks') || [];
  const fs = require('fs');

  const totalLinks = bookmarks.filter(b => !b.isFolder).length;
  const totalFolders = bookmarks.filter(b => b.isFolder).length;

  let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and written by XML-based bookmark parsers. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
`;

  function writeFolder(folderId, indent) {
    const items = bookmarks.filter(b => {
      const bFolderId = b.folderId === undefined ? null : b.folderId;
      return bFolderId === folderId;
    });

    items.forEach(b => {
      const spaceStr = ' '.repeat(indent);
      if (b.isFolder) {
        html += `${spaceStr}<DT><H3 ADD_DATE="0" LAST_MODIFIED="0">${b.title}</H3>\n`;
        html += `${spaceStr}<DL><p>\n`;
        writeFolder(b.id, indent + 4);
        html += `${spaceStr}</DL><p>\n`;
      } else {
        html += `${spaceStr}<DT><A HREF="${b.url}" ADD_DATE="0">${b.title}</A>\n`;
      }
    });
  }

  writeFolder(null, 4);
  html += `</DL><p>\n`;

  fs.writeFileSync(filePath, html, 'utf-8');
  return {
    totalLinks,
    totalFolders
  };
});

// Bookmarks Import Netscape HTML Parser
ipcMain.handle('bookmarks-import', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { filePaths } = await dialog.showOpenDialog(win, {
    title: 'Yer İmlerini İçe Aktar',
    properties: ['openFile'],
    filters: [{ name: 'HTML Files', extensions: ['html'] }]
  });

  if (!filePaths || filePaths.length === 0) return null;

  const fs = require('fs');
  const html = fs.readFileSync(filePaths[0], 'utf-8');
  const lines = html.split('\n');
  const bookmarks = bookmarksStore.get('bookmarks') || [];
  const generateId = () => 'b_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

  let folderStack = [null];
  let currentParentId = null;
  let linksAdded = 0;
  let foldersAdded = 0;

  lines.forEach(line => {
    line = line.trim();

    const h3Match = line.match(/<H3[^>]*>([^<]+)<\/H3>/i);
    if (h3Match) {
      const title = h3Match[1];
      const folderId = generateId();
      bookmarks.push({
        id: folderId,
        isFolder: true,
        title: title,
        folderId: currentParentId
      });
      currentParentId = folderId;
      foldersAdded++;
      return;
    }

    if (line.toUpperCase().startsWith('<DL')) {
      folderStack.push(currentParentId);
      return;
    }

    if (line.toUpperCase().startsWith('</DL')) {
      folderStack.pop();
      currentParentId = folderStack[folderStack.length - 1];
      return;
    }

    const aMatch = line.match(/<A HREF="([^"]+)"[^>]*>([^<]*)<\/A>/i);
    if (aMatch) {
      const url = aMatch[1];
      const title = aMatch[2] || url;
      if (!bookmarks.some(b => b.url === url && b.folderId === currentParentId)) {
        bookmarks.push({
          id: generateId(),
          title: title,
          url: url,
          folderId: currentParentId
        });
        linksAdded++;
      }
    }
  });

  bookmarksStore.set('bookmarks', bookmarks);
  return {
    bookmarks,
    linksAdded,
    foldersAdded
  };
});

// Tab mute IPC
ipcMain.on('tab-mute', (event, { tabId, mute }) => {
  const tab = tabs[tabId];
  if (tab && tab.view) {
    tab.view.webContents.setAudioMuted(mute);
    tab.isMuted = mute;
    const win = BrowserWindow.fromWebContents(event.sender);
    sendToUI(win, 'ui-tab-updated', { id: tabId, isMuted: mute });
    saveSession();
  }
});

// Permission response
ipcMain.on('permission-response', (event, { id, decision }) => {
  const req = pendingPermissionRequests[id];
  if (req) {
    req.callback(decision);

    const saved = permissionsStore.get('permissions') || {};
    saved[`${req.domain}:${req.permission}`] = decision;
    permissionsStore.set('permissions', saved);

    delete pendingPermissionRequests[id];
  }
});

ipcMain.handle('session-get', () => {
  if (!settingsStore.get('sessionRestoreEnabled')) {
    return { tabs: [], tabOrders: {} };
  }
  return {
    tabs: sessionStore.get('tabs') || [],
    tabOrders: sessionStore.get('tabOrders') || {}
  };
});

ipcMain.on('tab-set-pinned', (event, { tabId, isPinned }) => {
  const tab = tabs[tabId];
  if (tab) {
    tab.isPinned = isPinned;
    saveSession();
  }
});
