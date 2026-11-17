// Audio Translator: use YouTube's own caption window instead of a floating overlay.
(() => {
  const VERSION = 'youtube-native-captions-1';
  const PLAYER_SELECTOR = '#container';
  const CAPTION_CONTAINER_ID = 'ytp-caption-window-container';

  if (globalThis.__atOverlay?.version === VERSION && globalThis.__atOverlay.alive()) {
    return;
  }

  // Remove a previous version's custom floating overlay.
  globalThis.__atOverlay?.drop?.();
  const FONT = 'Audio Translator Pixel';
  for (const old of document.querySelectorAll(
    '[data-audio-translator-overlay], div[style*="2147483647"]'
  )) {
    if (
      old.hasAttribute('data-audio-translator-overlay') ||
      old.openOrClosedShadowRoot?.innerHTML.includes(FONT)
    ) {
      old.remove();
    }
  }

  const DEFAULT_SEGMENT_STYLE = [
    'display:inline-block',
    'white-space:pre-wrap',
    'background:rgba(8, 8, 8, 0.75)',
    'font-size:19.6px',
    'color:rgb(255, 255, 255)',
    'fill:rgb(255, 255, 255)',
    'font-family:"YouTube Noto", Roboto, Arial, Helvetica, Verdana, "PT Sans Caption", sans-serif'
  ].join(';');

  let captionContainer = null;
  let captionWindow = null;
  let sourceLayer = null;
  let glossLayer = null;

  let containerWasCreated = false;
  let windowWasCreated = false;
  let sourceWasCreated = false;
  let glossWasCreated = false;

  let sourceBackup = null;
  let glossBackup = null;
  let segmentStyle = DEFAULT_SEGMENT_STYLE;

  let latestRows = [];
  let active = false;
  let disposed = false;
  let port = null;
  let observer = null;

  const cloneChildren = (el) =>
    [...el.childNodes].map((node) => node.cloneNode(true));

  function createCaptionContainer(player) {
    const el = document.createElement('div');
    el.id = CAPTION_CONTAINER_ID;
    el.className = 'ytp-caption-window-container';
    el.dataset.layer = '4';
    el.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    player.appendChild(el);
    containerWasCreated = true;
    return el;
  }

  function findExistingCaptionWindow(parent) {
    const windows = [...parent.children].filter(
      (el) => el.classList?.contains('caption-window')
    );
    if (!windows.length) return null;

    // YouTube's suffix (_0, _1, ...) is not stable between player sessions.
    // Prefer the most recent visible window that already contains caption
    // segments; otherwise reuse the most recent caption window.
    const visibleWithText = [...windows].reverse().find((win) => {
      const style = getComputedStyle(win);
      return win.querySelector('.ytp-caption-segment') &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        win.getClientRects().length > 0;
    });
    if (visibleWithText) return visibleWithText;

    return [...windows].reverse().find((win) => {
      const style = getComputedStyle(win);
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        win.getClientRects().length > 0;
    }) || windows.at(-1);
  }

  function createCaptionWindow(parent) {
    const el = document.createElement('div');
    // Use _0 if it is free, otherwise choose the first unused YouTube-style
    // numeric ID. Never create a duplicate of a window YouTube already made.
    let index = 0;
    while (document.getElementById(`caption-window-_${index}`)) index++;
    el.id = `caption-window-_${index}`;
    el.className = 'caption-window ytp-caption-window-bottom';
    el.dir = 'ltr';
    el.tabIndex = 0;
    el.draggable = true;
    el.style.cssText = [
      'position:absolute',
      'touch-action:none',
      'text-align:center',
      'left:50%',
      'bottom:2%',
      'max-width:96%',
      'width:max-content',
      'transform:translateX(-50%)',
      'pointer-events:none'
    ].join(';');
    parent.appendChild(el);
    windowWasCreated = true;
    return el;
  }

  function findOrCreateCaptionWindow() {
    const player = document.querySelector(PLAYER_SELECTOR);
    if (!player) return null;

    let parent = player.querySelector('#' + CAPTION_CONTAINER_ID);
    if (!parent) parent = createCaptionContainer(player);

    let win = findExistingCaptionWindow(parent);
    if (!win) win = createCaptionWindow(parent);

    return { parent, win };
  }

  function makeCaptionLayer() {
    const layer = document.createElement('span');
    layer.className = 'captions-text';
    layer.style.cssText = 'overflow-wrap:normal;display:block;';
    layer.dataset.audioTranslatorLayer = 'true';
    return layer;
  }

  function restoreLayer(layer, wasCreated, backup) {
    if (!layer?.isConnected) return;
    if (wasCreated) {
      layer.remove();
    } else if (backup) {
      layer.replaceChildren(...backup.map((node) => node.cloneNode(true)));
    }
  }

  function releaseCaptionWindow() {
    restoreLayer(sourceLayer, sourceWasCreated, sourceBackup);
    restoreLayer(glossLayer, glossWasCreated, glossBackup);

    if (windowWasCreated) captionWindow?.remove();
    if (containerWasCreated) captionContainer?.remove();

    captionContainer = null;
    captionWindow = null;
    sourceLayer = null;
    glossLayer = null;

    containerWasCreated = false;
    windowWasCreated = false;
    sourceWasCreated = false;
    glossWasCreated = false;

    sourceBackup = null;
    glossBackup = null;
  }

  function attachCaptionWindow(parent, win) {
    if (
      captionWindow === win &&
      sourceLayer?.isConnected &&
      glossLayer?.isConnected
    ) {
      return;
    }

    releaseCaptionWindow();
    captionContainer = parent;
    captionWindow = win;

    const sample = captionWindow.querySelector('.ytp-caption-segment');
    if (sample?.getAttribute('style')) {
      segmentStyle = sample.getAttribute('style');
    }

    const existing = [...captionWindow.children].filter(
      (el) => el.classList?.contains('captions-text')
    );

    sourceWasCreated = !existing[0];
    sourceLayer = existing[0] || makeCaptionLayer();
    sourceBackup = sourceWasCreated ? null : cloneChildren(sourceLayer);
    if (sourceWasCreated) captionWindow.appendChild(sourceLayer);

    glossWasCreated = !existing[1];
    glossLayer = existing[1] || makeCaptionLayer();
    glossBackup = glossWasCreated ? null : cloneChildren(glossLayer);
    if (glossWasCreated) captionWindow.appendChild(glossLayer);
  }

  function setLayerLines(layer, lines) {
    if (!layer) return;

    const existingLines = [...layer.children].filter(
      (el) => el.classList?.contains('caption-visual-line')
    );
    const displayLines = lines.length ? lines : [''];

    displayLines.forEach((value, index) => {
      let visualLine = existingLines[index];
      if (!visualLine) {
        visualLine = document.createElement('span');
        visualLine.className = 'caption-visual-line';
        visualLine.style.display = 'block';
      }

      let segment = [...visualLine.children].find(
        (el) => el.classList?.contains('ytp-caption-segment')
      );
      if (!segment) {
        segment = document.createElement('span');
        segment.className = 'ytp-caption-segment';
      }

      segment.style.cssText = segmentStyle;
      segment.textContent = value;
      visualLine.replaceChildren(segment);

      const atIndex = layer.children[index] || null;
      if (atIndex !== visualLine) layer.insertBefore(visualLine, atIndex);
    });

    while (layer.children.length > displayLines.length) {
      layer.lastElementChild.remove();
    }
  }

  function splitLines(value) {
    return String(value ?? '').split(/\r?\n/).filter((line) => line.length > 0);
  }

  function renderRows(rows) {
    if (!active) return;

    const visibleRows = rows
      .filter((row) => row && (row.orig || row.text))
      .slice(-2);

    const originals = [];
    const glosses = [];

    for (const row of visibleRows) {
      originals.push(...splitLines(row.orig || row.text || ''));

      // "text" is still sentence translation for now. A future gloss engine
      // can send a separate "gloss" field without changing this DOM renderer.
      const gloss = row.gloss || (
        row.orig && row.text !== row.orig ? row.text : ''
      );
      glosses.push(...splitLines(gloss));
    }

    setLayerLines(sourceLayer, originals.slice(-2));
    setLayerLines(glossLayer, glosses.slice(-2));
  }

  function syncCaptionWindow() {
    if (!active) return;

    const found = findOrCreateCaptionWindow();
    if (!found) return;

    const needsAttach =
      captionWindow !== found.win ||
      !sourceLayer?.isConnected ||
      !glossLayer?.isConnected;

    if (needsAttach) {
      attachCaptionWindow(found.parent, found.win);
    } else {
      captionContainer = found.parent;
    }

    renderRows(latestRows);
  }

  function ensureObserver() {
    if (observer || !document.documentElement) return;

    observer = new MutationObserver(() => {
      if (!active) return;

      const player = document.querySelector(PLAYER_SELECTOR);
      const currentParent = player?.querySelector('#' + CAPTION_CONTAINER_ID);
      const currentWindow = currentParent
        ? findExistingCaptionWindow(currentParent)
        : null;

      if (
        currentWindow !== captionWindow ||
        !sourceLayer?.isConnected ||
        !glossLayer?.isConnected ||
        (captionContainer && !captionContainer.isConnected)
      ) {
        syncCaptionWindow();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function linkToBackground() {
    if (port || !chrome.runtime?.connect) return;

    try {
      port = chrome.runtime.connect({ name: 'overlay' });
    } catch {
      if (!chrome.runtime?.id) cleanup();
      return;
    }

    port.onDisconnect.addListener(() => {
      port = null;
      if (!chrome.runtime?.id) cleanup();
    });
  }

  function stopRendering() {
    active = false;
    observer?.disconnect();
    observer = null;
    latestRows = [];
    releaseCaptionWindow();
  }

  function cleanup() {
    if (disposed) return;
    disposed = true;
    stopRendering();
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.type === 'OVERLAY_ROWS') {
      disposed = false;
      active = true;
      latestRows = Array.isArray(msg.rows) ? msg.rows : [];

      linkToBackground();
      ensureObserver();
      syncCaptionWindow();

      reply(true);
      return;
    }

    if (msg?.type === 'OVERLAY_OFF') {
      stopRendering();
      reply(true);
    }
  });

  globalThis.__atOverlay = {
    version: VERSION,
    alive: () => !!chrome.runtime?.id && !disposed,
    drop: cleanup
  };
})();
