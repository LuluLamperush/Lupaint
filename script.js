    const board = document.getElementById('board');
    const ctx = board.getContext('2d');
    const canvasInfo = document.getElementById('canvasInfo');
    const toastsBox = document.getElementById('toasts');
    const modal = document.getElementById('modal');
    const workNameInput = document.getElementById('workNameInput');
    const fileInput = document.getElementById('fileInput');
    const previewModal = document.getElementById('previewModal');
    const previewImg = document.getElementById('previewImg');

    const SIZES = [8, 16, 32, 48, 64, 128, 256, 512];
    const PALETTE = ['#ffffff', '#0a0a0a', '#f87171', '#ef4444', '#dc2626', '#991b1b', '#fecaca', '#7f1d1d', '#fca5a5', '#404040', '#a3a3a3', '#fde68a'];

    const memStore = {};
    const store = {
      get(key) {
        try {
          return window.localStorage.getItem(key);
        } catch (err) {
          return memStore[key] !== undefined ? memStore[key] : null;
        }
      },
      set(key, value) {
        try {
          window.localStorage.setItem(key, value);
        } catch (err) {
          memStore[key] = value;
        }
      }
    };

    let size = 16;
    let grid = new Array(size * size).fill(null);
    let color = '#dc2626';
    let tool = 'brush';
    let gridOn = true;
    let hoverIdx = -1;
    let strokeActive = false;
    let strokeTool = 'brush';
    let lastIdx = -1;
    let undoStack = [];
    let redoStack = [];
    let recentColors = [];
    let gallery = [];
    let autosaveTimer = null;
    let pendingExportUrl = null;

    const RES = 1024;
    board.width = RES;
    board.height = RES;

    function exportScale() {
      return Math.max(1, Math.min(32, Math.floor(4096 / size)));
    }

    function thumbScale() {
      return Math.max(1, Math.min(8, Math.floor(512 / size)));
    }

    function maxHistory() {
      if (size >= 512) return 8;
      if (size >= 256) return 15;
      if (size >= 128) return 30;
      return 80;
    }

    function toast(msg) {
      const el = document.createElement('div');
      el.className = 'toast-in bg-neutral-950 text-white text-sm font-medium px-5 py-3 rounded-2xl shadow-2xl border-l-4 border-red-600';
      el.textContent = msg;
      toastsBox.appendChild(el);
      setTimeout(() => {
        el.classList.add('toast-out');
        setTimeout(() => el.remove(), 380);
      }, 2400);
    }

    function serialize() {
      return JSON.stringify(grid);
    }

    function pushHistory() {
      undoStack.push(serialize());
      const limit = maxHistory();
      while (undoStack.length > limit) undoStack.shift();
      redoStack = [];
    }

    function undo() {
      if (!undoStack.length) {
        toast('Nothing to undo');
        return;
      }
      redoStack.push(serialize());
      grid = JSON.parse(undoStack.pop());
      render();
      scheduleAutosave();
    }

    function redo() {
      if (!redoStack.length) {
        toast('Nothing to redo');
        return;
      }
      undoStack.push(serialize());
      grid = JSON.parse(redoStack.pop());
      render();
      scheduleAutosave();
    }

    function render() {
      const px = RES / size;
      ctx.clearRect(0, 0, RES, RES);
      for (let i = 0; i < grid.length; i++) {
        if (grid[i]) {
          ctx.fillStyle = grid[i];
          ctx.fillRect((i % size) * px, Math.floor(i / size) * px, px, px);
        }
      }
      if (gridOn) {
        ctx.strokeStyle = 'rgba(10,10,10,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = 0; k <= size; k++) {
          ctx.moveTo(k * px + 0.5, 0);
          ctx.lineTo(k * px + 0.5, RES);
          ctx.moveTo(0, k * px + 0.5);
          ctx.lineTo(RES, k * px + 0.5);
        }
        ctx.stroke();
      }
      if (hoverIdx >= 0) {
        const hx = (hoverIdx % size) * px;
        const hy = Math.floor(hoverIdx / size) * px;
        ctx.fillStyle = strokeTool === 'eraser' || tool === 'eraser' ? 'rgba(10,10,10,0.22)' : hexToRgba(color, 0.45);
        ctx.fillRect(hx, hy, px, px);
        ctx.strokeStyle = '#dc2626';
        ctx.lineWidth = 3;
        ctx.strokeRect(hx + 1.5, hy + 1.5, px - 3, px - 3);
      }
    }

    function hexToRgba(hex, a) {
      const h = hex.replace('#', '');
      const r = parseInt(h.substring(0, 2), 16);
      const g = parseInt(h.substring(2, 4), 16);
      const b = parseInt(h.substring(4, 6), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }

    function idxFromEvent(e) {
      const rect = board.getBoundingClientRect();
      const x = Math.floor(((e.clientX - rect.left) / rect.width) * size);
      const y = Math.floor(((e.clientY - rect.top) / rect.height) * size);
      if (x < 0 || y < 0 || x >= size || y >= size) return -1;
      return y * size + x;
    }

    function applyAt(idx, t) {
      if (idx < 0) return;
      if (t === 'brush') grid[idx] = color;
      else if (t === 'eraser') grid[idx] = null;
    }

    function lineTo(from, to, t) {
      const x0 = from % size, y0 = Math.floor(from / size);
      const x1 = to % size, y1 = Math.floor(to / size);
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      if (steps === 0) {
        applyAt(to, t);
        return;
      }
      for (let s = 0; s <= steps; s++) {
        const xi = Math.round(x0 + ((x1 - x0) * s) / steps);
        const yi = Math.round(y0 + ((y1 - y0) * s) / steps);
        applyAt(yi * size + xi, t);
      }
    }

    function floodFill(start, target) {
      const stack = [start];
      while (stack.length) {
        const cur = stack.pop();
        if (grid[cur] !== target) continue;
        grid[cur] = color;
        const cx = cur % size;
        if (cx > 0) stack.push(cur - 1);
        if (cx < size - 1) stack.push(cur + 1);
        if (cur - size >= 0) stack.push(cur - size);
        if (cur + size < size * size) stack.push(cur + size);
      }
    }

    function setTool(t) {
      tool = t;
      document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.classList.toggle('tool-active', btn.dataset.tool === t);
      });
      board.style.cursor = t === 'picker' ? 'copy' : 'crosshair';
    }

    function setColor(c) {
      color = c;
      document.getElementById('colorInput').value = c;
      document.getElementById('colorHex').textContent = c;
      document.querySelectorAll('.palette-swatch').forEach(sw => {
        sw.classList.toggle('swatch-active', sw.dataset.color === c);
      });
    }

    function rememberColor(c) {
      recentColors = [c, ...recentColors.filter(x => x !== c)].slice(0, 8);
      renderRecent();
    }

    function renderRecent() {
      const box = document.getElementById('recentGrid');
      box.innerHTML = '';
      if (!recentColors.length) {
        document.getElementById('recentWrap').style.display = 'none';
        return;
      }
      document.getElementById('recentWrap').style.display = 'block';
      recentColors.forEach(c => {
        const btn = document.createElement('button');
        btn.className = 'btn-press w-7 h-7 rounded-lg border-2 border-neutral-200 shadow-sm';
        btn.style.background = c;
        btn.title = c;
        btn.addEventListener('click', () => setColor(c));
        box.appendChild(btn);
      });
    }

    function renderPalette() {
      const box = document.getElementById('paletteGrid');
      PALETTE.forEach((c, i) => {
        const btn = document.createElement('button');
        btn.className = 'palette-swatch btn-press w-full aspect-square rounded-xl border-2 border-neutral-200 shadow-sm pop';
        btn.style.background = c;
        btn.style.setProperty('--d', (0.3 + i * 0.04) + 's');
        btn.title = c;
        btn.dataset.color = c;
        btn.addEventListener('click', () => setColor(c));
        box.appendChild(btn);
      });
    }

    function renderSizes() {
      const box = document.getElementById('sizeGrid');
      box.innerHTML = '';
      SIZES.forEach(s => {
        const btn = document.createElement('button');
        btn.className = 'btn-press py-2.5 rounded-xl border-2 text-sm font-semibold transition-colors ' + (s === size ? 'border-red-600 bg-red-600 text-white shadow-lg shadow-red-600/30' : 'border-neutral-200 bg-neutral-50 text-neutral-600 hover:border-red-400');
        btn.textContent = s;
        btn.title = s + ' × ' + s;
        btn.addEventListener('click', () => {
          if (s === size) return;
          pushHistory();
          size = s;
          grid = new Array(size * size).fill(null);
          undoStack = [];
          redoStack = [];
          hoverIdx = -1;
          canvasInfo.textContent = size + ' × ' + size;
          renderSizes();
          render();
          scheduleAutosave();
          toast('Canvas ' + s + ' × ' + s);
        });
        box.appendChild(btn);
      });
    }

    board.addEventListener('pointerdown', e => {
      e.preventDefault();
      board.setPointerCapture(e.pointerId);
      const idx = idxFromEvent(e);
      if (idx < 0) return;
      pushHistory();
      strokeActive = true;
      strokeTool = e.button === 2 ? 'eraser' : tool;
      if (strokeTool === 'fill') {
        if (grid[idx] !== color) floodFill(idx, grid[idx]);
        strokeActive = false;
      } else if (strokeTool === 'picker') {
        if (grid[idx]) {
          setColor(grid[idx]);
          rememberColor(grid[idx]);
          toast('Color picked');
        }
        setTool('brush');
        strokeActive = false;
      } else {
        applyAt(idx, strokeTool);
        lastIdx = idx;
      }
      render();
      scheduleAutosave();
    });

    board.addEventListener('pointermove', e => {
      const idx = idxFromEvent(e);
      if (idx !== hoverIdx) {
        hoverIdx = idx;
        if (!strokeActive) render();
      }
      if (strokeActive && idx >= 0) {
        lineTo(lastIdx < 0 ? idx : lastIdx, idx, strokeTool);
        lastIdx = idx;
        render();
      }
    });

    board.addEventListener('pointerup', () => {
      if (strokeActive) rememberColor(color);
      strokeActive = false;
      lastIdx = -1;
      scheduleAutosave();
    });

    board.addEventListener('pointerleave', () => {
      if (!strokeActive) {
        hoverIdx = -1;
        render();
      }
    });

    board.addEventListener('contextmenu', e => e.preventDefault());

    document.querySelectorAll('.tool-btn').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });

    document.getElementById('colorInput').addEventListener('input', e => setColor(e.target.value));

    document.getElementById('undoBtn').addEventListener('click', undo);
    document.getElementById('redoBtn').addEventListener('click', redo);

    document.getElementById('gridBtn').addEventListener('click', () => {
      gridOn = !gridOn;
      render();
      toast(gridOn ? 'Grid on' : 'Grid hidden');
    });

    document.getElementById('clearBtn').addEventListener('click', () => {
      pushHistory();
      grid = new Array(size * size).fill(null);
      render();
      scheduleAutosave();
      toast('Canvas cleared');
    });

    document.getElementById('importBtn').addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        const img = new Image();
        img.onload = () => {
          pushHistory();
          const tmp = document.createElement('canvas');
          tmp.width = size;
          tmp.height = size;
          const tctx = tmp.getContext('2d');
          tctx.imageSmoothingEnabled = true;
          tctx.drawImage(img, 0, 0, size, size);
          const data = tctx.getImageData(0, 0, size, size).data;
          const next = new Array(size * size).fill(null);
          for (let i = 0; i < size * size; i++) {
            const o = i * 4;
            if (data[o + 3] < 128) continue;
            const r = data[o].toString(16).padStart(2, '0');
            const g = data[o + 1].toString(16).padStart(2, '0');
            const b = data[o + 2].toString(16).padStart(2, '0');
            next[i] = '#' + r + g + b;
          }
          grid = next;
          render();
          scheduleAutosave();
          toast('Image imported');
        };
        img.onerror = () => toast('Could not load image');
        img.src = ev.target.result;
      };
      reader.onerror = () => toast('Could not read file');
      reader.readAsDataURL(file);
      fileInput.value = '';
    });

    function makeImage(data, s, scale) {
      const c = document.createElement('canvas');
      c.width = s * scale;
      c.height = s * scale;
      const cc = c.getContext('2d');
      data.forEach((col, i) => {
        if (col) {
          cc.fillStyle = col;
          cc.fillRect((i % s) * scale, Math.floor(i / s) * scale, scale, scale);
        }
      });
      return c;
    }

    function triggerDownload(url, name) {
      let success = false;
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.rel = 'noopener';
        a.target = '_blank';
        a.style.display = 'none';
        document.body.appendChild(a);
        const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        a.dispatchEvent(evt);
        setTimeout(() => a.remove(), 100);
        success = true;
      } catch (err) {
        success = false;
      }
      return success;
    }

    function saveUrlToFile(url, name) {
      const ok = triggerDownload(url, name);
      if (ok) {
        toast('PNG downloaded');
      } else {
        window.open(url, '_blank');
        toast('Opened in a new tab');
      }
    }

    function openPreview(url) {
      previewImg.src = url;
      previewModal.classList.remove('hidden');
      previewModal.classList.add('flex');
    }

    function closePreview() {
      previewModal.classList.add('hidden');
      previewModal.classList.remove('flex');
      previewImg.src = '';
    }

    document.getElementById('exportBtn').addEventListener('click', () => {
      if (!grid.some(x => x)) {
        toast('Canvas is empty — nothing to download');
        return;
      }
      const c = makeImage(grid, size, exportScale());
      const url = c.toDataURL('image/png');
      pendingExportUrl = url;
      openPreview(url);
    });

    document.getElementById('previewDownload').addEventListener('click', () => {
      const name = 'lupaint-' + size + 'x' + size + '.png';
      if (pendingExportUrl) {
        saveUrlToFile(pendingExportUrl, name);
      }
    });

    document.getElementById('previewClose').addEventListener('click', closePreview);
    document.getElementById('previewBackdrop').addEventListener('click', closePreview);

    function loadGallery() {
      try {
        gallery = JSON.parse(store.get('lupaint_gallery') || '[]');
        if (!Array.isArray(gallery)) gallery = [];
      } catch (err) {
        gallery = [];
      }
    }

    function persistGallery() {
      store.set('lupaint_gallery', JSON.stringify(gallery));
    }

    function renderGallery() {
      const list = document.getElementById('galleryList');
      list.innerHTML = '';
      document.getElementById('galleryCount').textContent = gallery.length;
      if (!gallery.length) {
        const empty = document.createElement('div');
        empty.className = 'border-2 border-dashed border-neutral-700 rounded-2xl p-6 text-center';
        empty.innerHTML = '<p class="text-3xl mb-2">🎨</p><p class="text-xs text-neutral-400">Nothing here yet.<br>Create your first art!</p>';
        list.appendChild(empty);
        return;
      }
      gallery.forEach(work => {
        const card = document.createElement('div');
        card.className = 'gallery-card bg-neutral-900 border border-neutral-800 rounded-2xl p-3';
        const imgWrap = document.createElement('div');
        imgWrap.className = 'checker rounded-xl overflow-hidden mb-3';
        const img = document.createElement('img');
        img.src = work.thumb;
        img.alt = work.name;
        img.className = 'w-full aspect-square object-contain';
        imgWrap.appendChild(img);
        card.appendChild(imgWrap);
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between gap-2';
        const info = document.createElement('div');
        info.className = 'min-w-0';
        const nameEl = document.createElement('p');
        nameEl.className = 'text-sm font-semibold truncate';
        nameEl.textContent = work.name;
        const metaEl = document.createElement('p');
        metaEl.className = 'text-[10px] text-neutral-500';
        metaEl.textContent = work.size + '×' + work.size + ' · ' + work.date;
        info.appendChild(nameEl);
        info.appendChild(metaEl);
        row.appendChild(info);
        const actions = document.createElement('div');
        actions.className = 'flex gap-1.5 shrink-0';
        const openBtn = document.createElement('button');
        openBtn.className = 'btn-press w-8 h-8 rounded-lg bg-red-600 text-white grid place-items-center';
        openBtn.title = 'Open';
        openBtn.innerHTML = '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"></path><path d="M6 16l6-9 6 9H6z"></path></svg>';
        openBtn.addEventListener('click', () => {
          pushHistory();
          size = work.size;
          grid = JSON.parse(work.data);
          undoStack = [];
          redoStack = [];
          hoverIdx = -1;
          canvasInfo.textContent = size + ' × ' + size;
          renderSizes();
          render();
          scheduleAutosave();
          toast('Opened: ' + work.name);
        });
        const delBtn = document.createElement('button');
        delBtn.className = 'btn-press w-8 h-8 rounded-lg bg-neutral-800 text-neutral-300 grid place-items-center hover:bg-red-600 hover:text-white';
        delBtn.title = 'Delete';
        delBtn.innerHTML = '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"></path><path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2"></path><path d="M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13"></path></svg>';
        delBtn.addEventListener('click', () => {
          gallery = gallery.filter(w => w.id !== work.id);
          persistGallery();
          renderGallery();
          toast('Artwork deleted');
        });
        actions.appendChild(openBtn);
        actions.appendChild(delBtn);
        row.appendChild(actions);
        card.appendChild(row);
        list.appendChild(card);
      });
    }

    function openModal() {
      workNameInput.value = 'Artwork ' + (gallery.length + 1);
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      setTimeout(() => workNameInput.focus(), 100);
    }

    function closeModal() {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }

    document.getElementById('saveBtn').addEventListener('click', openModal);
    document.getElementById('modalCancel').addEventListener('click', closeModal);
    document.getElementById('modalBackdrop').addEventListener('click', closeModal);

    function confirmSave() {
      const name = workNameInput.value.trim() || 'Untitled';
      try {
        gallery.unshift({
          id: Date.now(),
          name: name,
          size: size,
          data: serialize(),
          thumb: makeImage(grid, size, thumbScale()).toDataURL('image/png'),
          date: new Date().toLocaleDateString('en-US')
        });
        persistGallery();
        renderGallery();
        closeModal();
        toast('Saved: ' + name);
      } catch (err) {
        toast('Could not save artwork');
      }
    }

    document.getElementById('modalConfirm').addEventListener('click', confirmSave);
    workNameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') confirmSave();
      e.stopPropagation();
    });

    function scheduleAutosave() {
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => {
        store.set('lupaint_current', JSON.stringify({ size: size, grid: grid }));
      }, 400);
    }

    function restoreAutosave() {
      try {
        const raw = store.get('lupaint_current');
        if (!raw) return;
        const data = JSON.parse(raw);
        if (SIZES.includes(data.size) && Array.isArray(data.grid) && data.grid.length === data.size * data.size) {
          size = data.size;
          grid = data.grid;
          canvasInfo.textContent = size + ' × ' + size;
        }
      } catch (err) {}
    }

    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT') return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        openModal();
        return;
      }
      if (e.key === 'Escape') {
        closeModal();
        closePreview();
      }
      const k = e.key.toLowerCase();
      if (k === 'b') setTool('brush');
      if (k === 'e') setTool('eraser');
      if (k === 'g') setTool('fill');
      if (k === 'i') setTool('picker');
    });

    renderPalette();
    renderSizes();
    renderRecent();
    loadGallery();
    renderGallery();
    restoreAutosave();
    renderSizes();
    canvasInfo.textContent = size + ' × ' + size;
    setTool('brush');
    setColor('#dc2626');
    render();
