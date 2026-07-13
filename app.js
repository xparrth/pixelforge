'use strict';

/**
 * PixelForge — 8-Bit Retro Canvas Editor
 * Vanilla JS, no dependencies.
 *
 * Architecture notes:
 * - Grid cells are plain <div> elements built once per resize. All paint
 *   interactions use event delegation on the grid container (mousedown /
 *   mouseover), so no per-cell listeners are ever attached — resizing the
 *   grid only means clearing innerHTML and re-appending fresh nodes, with
 *   zero listener leakage.
 * - A single window-level mouseup listener resets the "is painting" flag,
 *   so releasing the mouse button anywhere (even outside the canvas or the
 *   browser viewport) never leaves the app in a stuck drawing state.
 * - `state.cells` is the single source of truth (flat array, row-major,
 *   null = empty/background). The DOM is always a direct reflection of it.
 */

(function () {
  // ---------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------

  const MIN_SIZE = 1;
  const MAX_SIZE = 64;
  const DEFAULT_SIZE = 16;
  const PNG_SCALE = 16; // output pixels per source pixel when exporting PNG

  // PICO-8 fantasy-console palette — a genuine 8-bit reference palette.
  const PALETTE = [
    { hex: '#000000', name: 'Black' },
    { hex: '#1D2B53', name: 'Midnight' },
    { hex: '#7E2553', name: 'Plum' },
    { hex: '#008751', name: 'Forest' },
    { hex: '#AB5236', name: 'Rust' },
    { hex: '#5F574F', name: 'Slate' },
    { hex: '#C2C3C7', name: 'Fog' },
    { hex: '#FFF1E8', name: 'Cream' },
    { hex: '#FF004D', name: 'Ember' },
    { hex: '#FFA300', name: 'Amber' },
    { hex: '#FFEC27', name: 'Sun' },
    { hex: '#00E436', name: 'Lime' },
    { hex: '#29ADFF', name: 'Sky' },
    { hex: '#83769C', name: 'Lilac' },
    { hex: '#FF77A8', name: 'Bubblegum' },
    { hex: '#FFCCAA', name: 'Peach' },
  ];

  const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  const state = {
    size: DEFAULT_SIZE,
    cells: new Array(DEFAULT_SIZE * DEFAULT_SIZE).fill(null),
    activeColor: '#ff004d',
    tool: 'brush', // 'brush' | 'eraser' | 'fill'
    showGridlines: true,
    isPainting: false,
  };

  // Live reference from grid cell index -> its DOM element. Rebuilt on resize.
  let cellElements = [];

  // ---------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------

  const dom = {
    sizePresets: document.getElementById('sizePresets'),
    customSize: document.getElementById('customSize'),
    applyCustomSize: document.getElementById('applyCustomSize'),
    colorPicker: document.getElementById('colorPicker'),
    activeColorPreview: document.getElementById('activeColorPreview'),
    palette: document.getElementById('palette'),
    toolRow: document.getElementById('toolRow'),
    gridlinesToggle: document.getElementById('gridlinesToggle'),
    clearCanvas: document.getElementById('clearCanvas'),
    exportPng: document.getElementById('exportPng'),
    exportJson: document.getElementById('exportJson'),
    importJson: document.getElementById('importJson'),
    pixelGrid: document.getElementById('pixelGrid'),
    exportCanvas: document.getElementById('exportCanvas'),
    statusSize: document.getElementById('statusSize'),
    statusCoords: document.getElementById('statusCoords'),
    statusTool: document.getElementById('statusTool'),
    toast: document.getElementById('toast'),
  };

  // ---------------------------------------------------------------------
  // Toast notifications
  // ---------------------------------------------------------------------

  let toastTimer = null;
  function showToast(message, type) {
    dom.toast.textContent = message;
    dom.toast.classList.remove('is-success', 'is-error');
    if (type) dom.toast.classList.add(type === 'error' ? 'is-error' : 'is-success');
    dom.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      dom.toast.classList.remove('is-visible');
    }, 2600);
  }

  // ---------------------------------------------------------------------
  // Grid construction
  // ---------------------------------------------------------------------

  function buildGridDom(size) {
    dom.pixelGrid.innerHTML = '';
    dom.pixelGrid.style.setProperty('--grid-size', String(size));

    const fragment = document.createDocumentFragment();
    cellElements = new Array(size * size);

    for (let i = 0; i < size * size; i++) {
      const cell = document.createElement('div');
      cell.className = 'pixel-cell';
      cell.dataset.index = String(i);
      fragment.appendChild(cell);
      cellElements[i] = cell;
    }

    dom.pixelGrid.appendChild(fragment);
    applyGridlinesClass();
    renderAllCells();
  }

  function renderAllCells() {
    for (let i = 0; i < state.cells.length; i++) {
      paintCellElement(i, state.cells[i]);
    }
  }

  function paintCellElement(index, color) {
    const el = cellElements[index];
    if (!el) return;
    if (color) {
      el.style.backgroundColor = color;
      el.classList.remove('is-empty');
    } else {
      el.style.backgroundColor = '';
      el.classList.add('is-empty');
    }
  }

  function applyGridlinesClass() {
    dom.pixelGrid.classList.toggle('hide-gridlines', !state.showGridlines);
  }

  // ---------------------------------------------------------------------
  // Cell painting
  // ---------------------------------------------------------------------

  function setCell(index, color) {
    if (state.cells[index] === color) return;
    state.cells[index] = color;
    paintCellElement(index, color);
  }

  function floodFill(startIndex, fillColor) {
    const targetColor = state.cells[startIndex];
    if (targetColor === fillColor) return;

    const size = state.size;
    const startRow = Math.floor(startIndex / size);
    const startCol = startIndex % size;
    const stack = [[startRow, startCol]];
    const visited = new Uint8Array(size * size);
    visited[startIndex] = 1;

    while (stack.length) {
      const [row, col] = stack.pop();
      const idx = row * size + col;
      setCell(idx, fillColor);

      const neighbors = [
        [row - 1, col],
        [row + 1, col],
        [row, col - 1],
        [row, col + 1],
      ];

      for (const [nRow, nCol] of neighbors) {
        if (nRow < 0 || nRow >= size || nCol < 0 || nCol >= size) continue;
        const nIdx = nRow * size + nCol;
        if (visited[nIdx]) continue;
        if (state.cells[nIdx] !== targetColor) continue;
        visited[nIdx] = 1;
        stack.push([nRow, nCol]);
      }
    }
  }

  function applyToolAt(index) {
    if (state.tool === 'brush') {
      setCell(index, state.activeColor);
    } else if (state.tool === 'eraser') {
      setCell(index, null);
    } else if (state.tool === 'fill') {
      floodFill(index, state.activeColor);
    }
  }

  // ---------------------------------------------------------------------
  // Pointer / drag interaction (event delegation)
  // ---------------------------------------------------------------------

  function cellFromEvent(e) {
    const target = e.target.closest('.pixel-cell');
    return target || null;
  }

  function updateHoverStatus(cell) {
    if (!cell) {
      dom.statusCoords.textContent = '—';
      return;
    }
    const index = Number(cell.dataset.index);
    const row = Math.floor(index / state.size);
    const col = index % state.size;
    dom.statusCoords.textContent = `(${col}, ${row})`;
  }

  dom.pixelGrid.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // primary button only
    e.preventDefault();
    const cell = cellFromEvent(e);
    if (!cell) return;
    state.isPainting = true;
    applyToolAt(Number(cell.dataset.index));
  });

  dom.pixelGrid.addEventListener('mouseover', (e) => {
    const cell = cellFromEvent(e);
    updateHoverStatus(cell);
    if (!cell) return;
    if (!state.isPainting) return;
    // Flood fill is a discrete click action, not a drag-paint action.
    if (state.tool === 'fill') return;
    applyToolAt(Number(cell.dataset.index));
  });

  dom.pixelGrid.addEventListener('mouseleave', () => {
    updateHoverStatus(null);
  });

  dom.pixelGrid.addEventListener('dragstart', (e) => e.preventDefault());
  dom.pixelGrid.addEventListener('contextmenu', (e) => e.preventDefault());

  // Global listener guarantees painting stops even if the button is
  // released outside the grid, outside the window, or after a fast drag.
  window.addEventListener('mouseup', () => {
    state.isPainting = false;
  });
  window.addEventListener('blur', () => {
    state.isPainting = false;
  });

  // Basic touch support so the editor also works on mobile/tablet.
  dom.pixelGrid.addEventListener(
    'touchstart',
    (e) => {
      const touch = e.touches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      const cell = el && el.closest('.pixel-cell');
      if (!cell) return;
      e.preventDefault();
      state.isPainting = true;
      applyToolAt(Number(cell.dataset.index));
    },
    { passive: false }
  );

  dom.pixelGrid.addEventListener(
    'touchmove',
    (e) => {
      if (!state.isPainting || state.tool === 'fill') return;
      const touch = e.touches[0];
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      const cell = el && el.closest('.pixel-cell');
      if (!cell) return;
      e.preventDefault();
      applyToolAt(Number(cell.dataset.index));
    },
    { passive: false }
  );

  window.addEventListener('touchend', () => {
    state.isPainting = false;
  });

  // ---------------------------------------------------------------------
  // Color selection
  // ---------------------------------------------------------------------

  function setActiveColor(hex) {
    state.activeColor = hex;
    dom.colorPicker.value = hex;
    dom.activeColorPreview.style.backgroundColor = hex;

    Array.from(dom.palette.children).forEach((swatch) => {
      swatch.classList.toggle('is-active', swatch.dataset.color.toLowerCase() === hex.toLowerCase());
    });

    // Picking a color while erasing implies intent to draw again.
    if (state.tool === 'eraser') {
      setActiveTool('brush');
    }
  }

  function buildPalette() {
    dom.palette.innerHTML = '';
    PALETTE.forEach(({ hex, name }) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'swatch pixel-corners-sm';
      swatch.style.backgroundColor = hex;
      swatch.dataset.color = hex;
      swatch.title = `${name} (${hex})`;
      swatch.setAttribute('aria-label', name);
      dom.palette.appendChild(swatch);
    });
  }

  dom.palette.addEventListener('click', (e) => {
    const swatch = e.target.closest('.swatch');
    if (!swatch) return;
    setActiveColor(swatch.dataset.color);
  });

  dom.colorPicker.addEventListener('input', (e) => {
    setActiveColor(e.target.value);
  });

  // ---------------------------------------------------------------------
  // Tool selection
  // ---------------------------------------------------------------------

  function setActiveTool(tool) {
    state.tool = tool;
    Array.from(dom.toolRow.children).forEach((btn) => {
      const isActive = btn.dataset.tool === tool;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    });
    dom.statusTool.textContent = tool.charAt(0).toUpperCase() + tool.slice(1);
  }

  dom.toolRow.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn--tool');
    if (!btn) return;
    setActiveTool(btn.dataset.tool);
  });

  // ---------------------------------------------------------------------
  // Gridlines toggle
  // ---------------------------------------------------------------------

  dom.gridlinesToggle.addEventListener('change', (e) => {
    state.showGridlines = e.target.checked;
    applyGridlinesClass();
  });

  // ---------------------------------------------------------------------
  // Canvas size (presets + custom)
  // ---------------------------------------------------------------------

  function isCanvasDirty() {
    return state.cells.some((c) => c !== null);
  }

  function resizeGrid(newSize) {
    const clamped = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(newSize)));

    if (clamped === state.size) {
      highlightActivePreset();
      dom.customSize.value = String(clamped);
      return;
    }

    if (isCanvasDirty()) {
      const proceed = window.confirm(
        'Changing the canvas size will clear your current artwork. Continue?'
      );
      if (!proceed) return;
    }

    state.size = clamped;
    state.cells = new Array(clamped * clamped).fill(null);
    buildGridDom(clamped);
    dom.customSize.value = String(clamped);
    dom.statusSize.textContent = `${clamped}×${clamped}`;
    highlightActivePreset();
  }

  function highlightActivePreset() {
    Array.from(dom.sizePresets.children).forEach((btn) => {
      btn.classList.toggle('is-active', Number(btn.dataset.size) === state.size);
    });
  }

  dom.sizePresets.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn--preset');
    if (!btn) return;
    resizeGrid(Number(btn.dataset.size));
  });

  dom.applyCustomSize.addEventListener('click', () => {
    const value = parseInt(dom.customSize.value, 10);
    if (Number.isNaN(value)) {
      showToast('Enter a valid size between 1 and 64.', 'error');
      return;
    }
    resizeGrid(value);
  });

  dom.customSize.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dom.applyCustomSize.click();
  });

  // ---------------------------------------------------------------------
  // Clear canvas
  // ---------------------------------------------------------------------

  dom.clearCanvas.addEventListener('click', () => {
    if (!isCanvasDirty()) {
      showToast('Canvas is already empty.');
      return;
    }
    const proceed = window.confirm('Clear the entire canvas? This cannot be undone.');
    if (!proceed) return;

    state.cells.fill(null);
    renderAllCells();
    showToast('Canvas cleared.', 'success');
  });

  // ---------------------------------------------------------------------
  // Export — PNG
  // ---------------------------------------------------------------------

  function exportPng() {
    const size = state.size;
    const outputSize = size * PNG_SCALE;

    const canvas = dom.exportCanvas;
    canvas.width = outputSize;
    canvas.height = outputSize;

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, outputSize, outputSize);

    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const color = state.cells[row * size + col];
        if (!color) continue; // leave transparent
        ctx.fillStyle = color;
        ctx.fillRect(col * PNG_SCALE, row * PNG_SCALE, PNG_SCALE, PNG_SCALE);
      }
    }

    canvas.toBlob((blob) => {
      if (!blob) {
        showToast('PNG export failed.', 'error');
        return;
      }
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `pixelforge-${size}x${size}.png`);
      URL.revokeObjectURL(url);
      showToast('PNG exported.', 'success');
    }, 'image/png');
  }

  dom.exportPng.addEventListener('click', exportPng);

  // ---------------------------------------------------------------------
  // Export / Import — JSON
  // ---------------------------------------------------------------------

  function exportJson() {
    const payload = {
      app: 'PixelForge',
      version: 1,
      size: state.size,
      cells: state.cells,
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `pixelforge-${state.size}x${state.size}.json`);
    URL.revokeObjectURL(url);
    showToast('JSON exported.', 'success');
  }

  dom.exportJson.addEventListener('click', exportJson);

  function validatePixelForgeData(data) {
    if (!data || typeof data !== 'object') return false;
    if (!Number.isInteger(data.size) || data.size < MIN_SIZE || data.size > MAX_SIZE) return false;
    if (!Array.isArray(data.cells)) return false;
    if (data.cells.length !== data.size * data.size) return false;
    return data.cells.every((c) => c === null || (typeof c === 'string' && HEX_COLOR_RE.test(c)));
  }

  function importJsonFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(String(reader.result));
      } catch (err) {
        showToast('That file is not valid JSON.', 'error');
        return;
      }
      if (!validatePixelForgeData(data)) {
        showToast('Not a valid PixelForge file.', 'error');
        return;
      }

      state.size = data.size;
      state.cells = data.cells.slice();
      buildGridDom(state.size);
      dom.customSize.value = String(state.size);
      dom.statusSize.textContent = `${state.size}×${state.size}`;
      highlightActivePreset();
      showToast('Artwork imported.', 'success');
    };
    reader.onerror = () => showToast('Could not read that file.', 'error');
    reader.readAsText(file);
  }

  dom.importJson.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    importJsonFile(file);
    e.target.value = ''; // allow re-importing the same file later
  });

  // ---------------------------------------------------------------------
  // Shared download helper
  // ---------------------------------------------------------------------

  function triggerDownload(url, filename) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  function init() {
    buildPalette();
    buildGridDom(state.size);
    setActiveColor(state.activeColor);
    setActiveTool(state.tool);
    highlightActivePreset();
    dom.statusSize.textContent = `${state.size}×${state.size}`;
  }

  init();
})();