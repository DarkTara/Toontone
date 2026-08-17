(function () {
  const imageCache = new Map();

  function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 160, g: 160, b: 160 };
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  function rgbToLab({ r, g, b }) {
    let R = r / 255, G = g / 255, B = b / 255;
    R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
    G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
    B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;
    let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    let y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
    let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    const f = v => v > 0.008856 ? Math.pow(v, 1 / 3) : (7.787 * v) + 16 / 116;
    x = f(x); y = f(y); z = f(z);
    return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
  }

  function deltaE(a, b) {
    return Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
  }

  function loadImage(src) {
    if (imageCache.has(src)) return imageCache.get(src);
    const promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Impossible de charger le logo.'));
      img.src = src;
    });
    imageCache.set(src, promise);
    return promise;
  }

  async function create(canvas, src, targetHex, tolerance = 42) {
    const img = await loadImage(src);
    const maxW = 760, maxH = 390;
    const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);

    const original = ctx.getImageData(0, 0, w, h);
    let mask = new Uint8Array(w * h);
    let currentTarget = targetHex;
    let currentTolerance = Number(tolerance) || 42;

    function rebuildMask(nextTarget = currentTarget, nextTolerance = currentTolerance) {
      currentTarget = nextTarget;
      currentTolerance = Math.max(3, Math.min(100, Number(nextTolerance) || 42));
      const targetLab = rgbToLab(hexToRgb(currentTarget));
      mask = new Uint8Array(w * h);
      const d = original.data;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        if (d[i + 3] < 20) continue;
        const lab = rgbToLab({ r: d[i], g: d[i + 1], b: d[i + 2] });
        if (deltaE(lab, targetLab) <= currentTolerance) mask[p] = 1;
      }
    }

    function render(replacementHex = null) {
      const out = new ImageData(new Uint8ClampedArray(original.data), w, h);
      const repl = replacementHex ? hexToRgb(replacementHex) : { r: 166, g: 166, b: 166 };
      const d = out.data;
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        if (!mask[p]) continue;
        d[i] = repl.r;
        d[i + 1] = repl.g;
        d[i + 2] = repl.b;
      }
      ctx.putImageData(out, 0, 0);
    }

    function sampleAtEvent(evt) {
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(w - 1, Math.floor((evt.clientX - rect.left) * w / rect.width)));
      const y = Math.max(0, Math.min(h - 1, Math.floor((evt.clientY - rect.top) * h / rect.height)));
      const i = (y * w + x) * 4;
      const d = original.data;
      if (d[i + 3] < 20) return null;
      return rgbToHex(d[i], d[i + 1], d[i + 2]);
    }

    rebuildMask(targetHex, tolerance);
    render(null);
    function maskStats() {
      let count = 0;
      for (const v of mask) count += v;
      return { matchedPixels: count, totalPixels: mask.length, ratio: mask.length ? count / mask.length : 0 };
    }

    return { render, rebuildMask, sampleAtEvent, maskStats, width: w, height: h };
  }

  window.LogoTone = { create };
})();
