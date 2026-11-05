/*
 * Kynimo mockup engine stand-in.
 * A tiny scene document (scenes → layers → keyframe tracks) and a deterministic
 * renderer: the same document + frame always draws the same pixels. No wall-clock
 * time or randomness in evaluation; the waveform is seeded from the document id.
 * Demo content ("Relay 2.0") is synthetic.
 */
(() => {
  // ---------- easing (normalised so every curve lands exactly on 1) ----------
  const springCrit = (p) => {
    const w = 9;
    return (1 - (1 + w * p) * Math.exp(-w * p)) / (1 - (1 + w) * Math.exp(-w));
  };
  const springBounce = (p) => {
    const z = 0.62;
    const w = 12;
    const wd = w * Math.sqrt(1 - z * z);
    const x = (t) =>
      1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z / Math.sqrt(1 - z * z)) * Math.sin(wd * t));
    return x(p) / x(1);
  };
  const cine = (p) => (p >= 1 ? 1 : (1 - 2 ** (-10 * p)) / (1 - 2 ** -10));
  const EASE = {
    linear: (p) => p,
    spring: springCrit,
    bounce: springBounce,
    cine,
    cut: (p) => (p >= 1 ? 1 : 0),
  };
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  // ---------- guideline packs ----------
  const PACKS = {
    playful: {
      id: "playful",
      name: "Playful SaaS",
      note: "Springy, bright, quick. Bounce only on the reveal that earns it.",
      palette: {
        primary: "#2D45E8",
        paper: "#F4F1EA",
        deep: "#10163F",
        onPrimary: "#F4F1EA",
        onPaper: "#10163F",
        onDeep: "#F4F1EA",
        accent: "#FF7A59",
      },
      display: { family: "Archivo", weight: 900, tracking: -0.035 },
      body: { family: "Geist", weight: 500, tracking: -0.01 },
      ease: {},
    },
    keynote: {
      id: "keynote",
      name: "Keynote",
      note: "One idea per frame. Slow pushes, long holds, nothing bounces.",
      palette: {
        primary: "#050505",
        paper: "#F5F5F7",
        deep: "#050505",
        onPrimary: "#FFFFFF",
        onPaper: "#1D1D1F",
        onDeep: "#FFFFFF",
        accent: "#2997FF",
      },
      display: { family: "Geist", weight: 600, tracking: -0.04 },
      body: { family: "Geist", weight: 400, tracking: -0.01 },
      ease: { bounce: "cine", spring: "cine" },
    },
    editorial: {
      id: "editorial",
      name: "Editorial",
      note: "Type leads. Generous holds, one ink, quiet transitions.",
      palette: {
        primary: "#EAE3D4",
        paper: "#EAE3D4",
        deep: "#1C1A17",
        onPrimary: "#1C1A17",
        onPaper: "#1C1A17",
        onDeep: "#EAE3D4",
        accent: "#1F4FBF",
      },
      display: { family: "Instrument Serif", weight: 400, tracking: -0.02 },
      body: { family: "Geist", weight: 400, tracking: 0 },
      ease: { bounce: "cine", spring: "cine" },
    },
    brutalist: {
      id: "brutalist",
      name: "Brutalist",
      note: "Hard cuts, no easing, black on white. Loud on purpose.",
      palette: {
        primary: "#FFFFFF",
        paper: "#FFFFFF",
        deep: "#000000",
        onPrimary: "#000000",
        onPaper: "#000000",
        onDeep: "#FFFFFF",
        accent: "#000000",
      },
      display: { family: "Archivo", weight: 900, tracking: -0.05 },
      body: { family: "Archivo", weight: 700, tracking: -0.01 },
      ease: { bounce: "cut", spring: "cut", cine: "cut" },
    },
  };

  // ---------- the document ----------
  function createComposition() {
    return {
      formatVersion: 1,
      id: "relay-launch",
      project: "Relay",
      name: "Launch reel",
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 450,
      style: "playful",
      audio: { name: "Brightside — 120 BPM", bpm: 120 },
      scenes: [
        {
          id: "S01",
          name: "Title slam",
          start: 0,
          end: 119,
          bg: "primary",
          layers: [
            {
              id: "L01",
              name: "Wordmark",
              type: "text",
              component: "Kinetic type",
              props: {
                text: "Relay",
                x: 192,
                y: 600,
                size: 300,
                font: "display",
                color: "onPrimary",
              },
              tracks: {
                dy: [
                  { f: 4, v: 140 },
                  { f: 26, v: 0, e: "spring" },
                ],
                opacity: [
                  { f: 4, v: 0 },
                  { f: 12, v: 1 },
                ],
              },
            },
            {
              id: "L02",
              name: "Version",
              type: "text",
              component: "Kinetic type",
              props: {
                text: "2.0",
                after: "L01",
                gap: 44,
                y: 600,
                size: 300,
                font: "display",
                color: "accent",
              },
              tracks: {
                scale: [
                  { f: 28, v: 0.4 },
                  { f: 48, v: 1, e: "bounce" },
                ],
                opacity: [
                  { f: 28, v: 0 },
                  { f: 33, v: 1 },
                ],
              },
            },
            {
              id: "L03",
              name: "Tagline",
              type: "text",
              props: {
                text: "The team inbox, rebuilt.",
                x: 192,
                y: 728,
                size: 64,
                font: "body",
                color: "onPrimary",
              },
              tracks: {
                dy: [
                  { f: 50, v: 30 },
                  { f: 72, v: 0, e: "cine" },
                ],
                opacity: [
                  { f: 50, v: 0 },
                  { f: 62, v: 1 },
                ],
              },
            },
            {
              id: "L04",
              name: "Underline",
              type: "rect",
              props: { x: 192, y: 790, w: 460, h: 12, color: "accent" },
              tracks: {
                w: [
                  { f: 58, v: 0 },
                  { f: 86, v: 460, e: "cine" },
                ],
              },
            },
          ],
        },
        {
          id: "S02",
          name: "Ships today",
          start: 120,
          end: 269,
          bg: "paper",
          transition: { type: "shutter", frames: 16, slits: 8 },
          layers: [
            {
              id: "L05",
              name: "Headline",
              type: "text",
              component: "Kinetic type",
              props: {
                text: "Ships today.",
                x: 120,
                y: 500,
                size: 210,
                font: "display",
                color: "onPaper",
              },
              tracks: {
                dy: [
                  { f: 128, v: 90 },
                  { f: 150, v: 0, e: "spring" },
                ],
                opacity: [
                  { f: 128, v: 0 },
                  { f: 136, v: 1 },
                ],
              },
            },
            {
              id: "L06",
              name: "Feature list",
              type: "list",
              component: "List · stagger",
              props: {
                items: ["Live cursors", "Offline sync", "2× faster boot"],
                x: 192,
                y: 660,
                size: 60,
                gap: 88,
                font: "body",
                color: "onPaper",
                bullet: "accent",
                start: 186,
                stagger: 0,
              },
              tracks: {},
            },
          ],
        },
        {
          id: "S03",
          name: "Logo out",
          start: 270,
          end: 449,
          bg: "deep",
          transition: { type: "shutter", frames: 16, slits: 8 },
          layers: [
            {
              id: "L08",
              name: "Logo",
              type: "logo",
              component: "Logo reveal",
              props: { x: 960, y: 440, size: 220, color: "onDeep", bar: "primary" },
              tracks: {
                scale: [
                  { f: 280, v: 0.82 },
                  { f: 302, v: 1, e: "spring" },
                ],
                opacity: [
                  { f: 280, v: 0 },
                  { f: 288, v: 1 },
                ],
              },
            },
            {
              id: "L09",
              name: "URL",
              type: "text",
              props: {
                text: "relay.dev",
                x: 960,
                y: 700,
                size: 96,
                font: "display",
                color: "onDeep",
                align: "center",
              },
              tracks: {
                dy: [
                  { f: 300, v: 24 },
                  { f: 324, v: 0, e: "cine" },
                ],
                opacity: [
                  { f: 300, v: 0 },
                  { f: 310, v: 1 },
                ],
              },
            },
            {
              id: "L10",
              name: "Availability",
              type: "text",
              props: {
                text: "Out now for Mac, Windows and the web.",
                x: 960,
                y: 780,
                size: 40,
                font: "body",
                color: "onDeep",
                align: "center",
              },
              tracks: {
                opacity: [
                  { f: 318, v: 0 },
                  { f: 332, v: 0.72 },
                ],
              },
            },
          ],
        },
      ],
      findings: [
        {
          id: "Q1",
          rule: "title-safe",
          severity: "error",
          layer: "L05",
          scene: "S02",
          frame: 142,
          message: "Headline starts 120px from the left edge. Title-safe needs 192px.",
          fix: "Move L05 x 120 → 192, aligned with the feature list",
          status: "open",
        },
        {
          id: "Q2",
          rule: "simultaneous-motion",
          severity: "warning",
          layer: "L06",
          scene: "S02",
          frame: 186,
          message: "3 elements start moving on F0186. Playful SaaS allows 2 per beat.",
          fix: "Stagger list items by 6 frames",
          status: "open",
        },
      ],
      passed: [
        { rule: "contrast", detail: "lowest 7.9:1 (S01 tagline)" },
        { rule: "readability", detail: "every word on screen ≥ 1.2s" },
        { rule: "token-easing", detail: "all 14 tracks use pack easings" },
        { rule: "beat-sync", detail: "scene cuts land on downbeats" },
      ],
    };
  }

  function applyFix(comp, findingId) {
    const f = comp.findings.find((x) => x.id === findingId);
    if (!f) return comp;
    if (f.rule === "title-safe") findLayer(comp, "L05").props.x = 192;
    if (f.rule === "simultaneous-motion") findLayer(comp, "L06").props.stagger = 6;
    f.status = "fixed";
    return comp;
  }

  function findLayer(comp, id) {
    for (const s of comp.scenes) for (const l of s.layers) if (l.id === id) return l;
    return null;
  }
  function sceneAt(comp, f) {
    for (let i = 0; i < comp.scenes.length; i++) {
      const s = comp.scenes[i];
      if (f >= s.start && f <= s.end) return i;
    }
    return comp.scenes.length - 1;
  }

  // ---------- evaluation ----------
  function trackValue(track, f, fallback, pack) {
    if (!track || track.length === 0) return fallback;
    if (f <= track[0].f) return track[0].v;
    const last = track[track.length - 1];
    if (f >= last.f) return last.v;
    for (let i = 0; i < track.length - 1; i++) {
      const a = track[i];
      const b = track[i + 1];
      if (f >= a.f && f <= b.f) {
        const name = pack.ease?.[b.e] || b.e || "linear";
        const p = (f - a.f) / (b.f - a.f);
        return a.v + (b.v - a.v) * (EASE[name] || EASE.linear)(p);
      }
    }
    return fallback;
  }

  function fontFor(pack, role, size) {
    const t = role === "display" ? pack.display : pack.body;
    return { css: `${t.weight} ${size}px "${t.family}"`, tracking: t.tracking * size };
  }
  function setLetterSpacing(ctx, px) {
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${px}px`;
  }

  function layerBox(ctx, comp, layer, pack) {
    const p = layer.props;
    if (layer.type === "text") {
      const ft = fontFor(pack, p.font, p.size);
      ctx.font = ft.css;
      setLetterSpacing(ctx, ft.tracking);
      const w = ctx.measureText(p.text).width;
      let x = p.x;
      if (p.after) {
        const ref = layerBox(ctx, comp, findLayer(comp, p.after), pack);
        x = ref.x + ref.w + (p.gap || 0);
      }
      if (p.align === "center") x -= w / 2;
      return { x, y: p.y - p.size * 0.74, w, h: p.size * 0.74 };
    }
    if (layer.type === "rect") return { x: p.x, y: p.y, w: p.w, h: p.h };
    if (layer.type === "list") {
      const ft = fontFor(pack, p.font, p.size);
      ctx.font = ft.css;
      setLetterSpacing(ctx, ft.tracking);
      const w = Math.max(...p.items.map((t) => ctx.measureText(t).width)) + p.size * 0.6;
      return { x: p.x, y: p.y - p.size * 0.74, w, h: p.gap * (p.items.length - 1) + p.size * 0.74 };
    }
    if (layer.type === "logo")
      return { x: p.x - p.size / 2, y: p.y - p.size / 2, w: p.size, h: p.size };
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  function drawLayer(ctx, comp, layer, f, pack) {
    const p = layer.props;
    const pal = pack.palette;
    const t = layer.tracks || {};
    const opacity = trackValue(t.opacity, f, 1, pack);
    if (opacity <= 0.001 && layer.type !== "list") return;
    const dy = trackValue(t.dy, f, 0, pack);
    const scale = trackValue(t.scale, f, 1, pack);
    ctx.save();
    ctx.globalAlpha = opacity;
    if (layer.type === "text") {
      const ft = fontFor(pack, p.font, p.size);
      const box = layerBox(ctx, comp, layer, pack);
      ctx.font = ft.css;
      setLetterSpacing(ctx, ft.tracking);
      ctx.fillStyle = pal[p.color] || p.color;
      ctx.textBaseline = "alphabetic";
      const cx = box.x + box.w / 2;
      const cy = p.y - p.size * 0.37;
      ctx.translate(cx, cy + dy);
      ctx.scale(scale, scale);
      ctx.fillText(p.text, box.x - cx, p.y - cy);
    } else if (layer.type === "rect") {
      const w = trackValue(t.w, f, p.w, pack);
      ctx.fillStyle = pal[p.color] || p.color;
      ctx.fillRect(p.x, p.y + dy, w, p.h);
    } else if (layer.type === "list") {
      const ft = fontFor(pack, p.font, p.size);
      ctx.font = ft.css;
      setLetterSpacing(ctx, ft.tracking);
      ctx.textBaseline = "alphabetic";
      const easeName = pack.ease?.spring || "spring";
      p.items.forEach((item, i) => {
        const s = p.start + i * p.stagger;
        const k = clamp01((f - s) / 18);
        const e = EASE[easeName](k);
        const a = clamp01((f - s) / 8);
        if (a <= 0) return;
        const y = p.y + i * p.gap + (1 - e) * 60;
        ctx.globalAlpha = a;
        ctx.fillStyle = pal[p.bullet] || p.bullet;
        ctx.fillRect(p.x, y - p.size * 0.42, p.size * 0.26, p.size * 0.26);
        ctx.fillStyle = pal[p.color] || p.color;
        ctx.fillText(item, p.x + p.size * 0.6, y);
      });
    } else if (layer.type === "logo") {
      const s = p.size;
      ctx.translate(p.x, p.y + dy);
      ctx.scale(scale, scale);
      ctx.fillStyle = pal[p.color] || p.color;
      roundRect(ctx, -s / 2, -s / 2, s, s, s * 0.24);
      ctx.fill();
      ctx.fillStyle = pal[p.bar] || p.bar;
      const bw = [0.56, 0.42, 0.28];
      bw.forEach((w, i) => {
        roundRect(ctx, -s * 0.28, -s * 0.2 + i * s * 0.17, s * w, s * 0.09, s * 0.045);
        ctx.fill();
      });
    }
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawScene(ctx, comp, scene, f, pack) {
    ctx.fillStyle = pack.palette[scene.bg];
    ctx.fillRect(0, 0, comp.width, comp.height);
    for (const layer of scene.layers) drawLayer(ctx, comp, layer, f, pack);
  }

  /** Shutter slits: each of n vertical slits opens from its centre, staggered left→right. */
  function shutterClip(ctx, w, h, n, progress, stagger = 0.06) {
    const sw = w / n;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const local = clamp01((progress - i * stagger) / (1 - stagger * (n - 1)));
      const open = cine(local) * sw;
      if (open <= 0) continue;
      ctx.rect(i * sw + (sw - open) / 2, 0, open + 0.5, h);
    }
    ctx.clip();
  }

  /** Render frame f of the composition into ctx (already scaled to composition units). */
  function renderFrame(ctx, comp, f, packId) {
    const base = PACKS[packId || comp.style] || PACKS.playful;
    const pack = comp.palette ? { ...base, palette: { ...base.palette, ...comp.palette } } : base;
    const idx = sceneAt(comp, f);
    const scene = comp.scenes[idx];
    const tr = scene.transition;
    if (tr && idx > 0 && f < scene.start + tr.frames) {
      const prev = comp.scenes[idx - 1];
      drawScene(ctx, comp, prev, prev.end, pack);
      ctx.save();
      if (pack.ease?.cine === "cut") {
        ctx.beginPath();
        ctx.rect(0, 0, f - scene.start >= tr.frames / 2 ? comp.width : 0, comp.height);
        ctx.clip();
      } else {
        shutterClip(ctx, comp.width, comp.height, tr.slits, (f - scene.start + 1) / tr.frames);
      }
      drawScene(ctx, comp, scene, f, pack);
      ctx.restore();
    } else {
      drawScene(ctx, comp, scene, f, pack);
    }
  }

  // ---------- ordered dither ----------
  const BAYER8 = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
    28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47,
    7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
  ];
  const hex = (h) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];

  /** Draw an ordered-dither version of src into dst (same pixel size). */
  function ditherInto(src, dst, cell = 4, dark = "#0C0B0A", light = "#EDE8DF") {
    const sw = Math.max(1, Math.ceil(src.width / cell));
    const sh = Math.max(1, Math.ceil(src.height / cell));
    const small = document.createElement("canvas");
    small.width = sw;
    small.height = sh;
    const sctx = small.getContext("2d", { willReadFrequently: true });
    sctx.drawImage(src, 0, 0, sw, sh);
    const img = sctx.getImageData(0, 0, sw, sh);
    const d = img.data;
    const D = hex(dark);
    const L = hex(light);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const i = (y * sw + x) * 4;
        const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        const c = lum > (BAYER8[(y % 8) * 8 + (x % 8)] + 0.5) / 64 ? L : D;
        d[i] = c[0];
        d[i + 1] = c[1];
        d[i + 2] = c[2];
        d[i + 3] = 255;
      }
    }
    sctx.putImageData(img, 0, 0);
    const dctx = dst.getContext("2d");
    dctx.save();
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.imageSmoothingEnabled = false;
    dctx.drawImage(small, 0, 0, dst.width, dst.height);
    dctx.restore();
  }

  // ---------- seeded waveform for the audio track ----------
  function seeded(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return () => {
      h += 0x6d2b79f5;
      let t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function waveform(comp, bins) {
    const rnd = seeded(comp.id);
    const beat = (comp.fps * 60) / comp.audio.bpm;
    const out = [];
    for (let i = 0; i < bins; i++) {
      const f = (i / bins) * comp.duration;
      const phase = (f % beat) / beat;
      const kick = Math.exp(-phase * 6);
      out.push(0.18 + 0.5 * kick + 0.32 * rnd());
    }
    return out;
  }

  // ---------- a canvas player with a dither → colour reveal ----------
  const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  class Player {
    constructor(canvas, comp, { pack, onFrame } = {}) {
      this.canvas = canvas;
      this.comp = comp;
      this.pack = pack || comp.style;
      this.onFrame = onFrame || (() => {});
      this.frame = 0;
      this.playing = false;
      this.reveal = 1; // 0 = dithered, 1 = full colour
      this.color = document.createElement("canvas");
      this.dith = document.createElement("canvas");
      this._raf = 0;
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas);
      this.resize();
    }
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round((w * this.comp.height) / this.comp.width));
      for (const c of [this.canvas, this.color, this.dith]) {
        c.width = w;
        c.height = h;
      }
      this.draw();
    }
    draw() {
      const { canvas, color, comp } = this;
      const cctx = color.getContext("2d");
      const s = color.width / comp.width;
      cctx.setTransform(s, 0, 0, s, 0, 0);
      renderFrame(cctx, comp, this.frame, this.pack);
      const ctx = canvas.getContext("2d");
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (this.reveal >= 1) {
        ctx.drawImage(color, 0, 0);
      } else {
        const cell = Math.max(2, Math.round(canvas.width / 240));
        ditherInto(color, this.dith, cell);
        ctx.drawImage(this.dith, 0, 0);
        if (this.reveal > 0) {
          ctx.save();
          shutterClip(ctx, canvas.width, canvas.height, 12, this.reveal);
          ctx.drawImage(color, 0, 0);
          ctx.restore();
        }
      }
      this.onFrame(this.frame);
    }
    setFrame(f) {
      this.frame = Math.max(0, Math.min(this.comp.duration - 1, Math.round(f)));
      this.draw();
    }
    play() {
      if (this.playing) return;
      this.playing = true;
      let last = performance.now();
      let acc = 0;
      const step = (now) => {
        if (!this.playing) return;
        acc += (now - last) / 1000;
        last = now;
        const adv = Math.floor(acc * this.comp.fps);
        if (adv > 0) {
          acc -= adv / this.comp.fps;
          this.frame = (this.frame + adv) % this.comp.duration;
          this.draw();
        }
        this._raf = requestAnimationFrame(step);
      };
      this._raf = requestAnimationFrame(step);
    }
    pause() {
      this.playing = false;
      cancelAnimationFrame(this._raf);
      this.draw();
    }
    /** Resolve from ordered dither to full colour through shutter slits. */
    revealIn(ms = 900) {
      return new Promise((resolve) => {
        if (reduced()) {
          this.reveal = 1;
          this.draw();
          resolve();
          return;
        }
        const t0 = performance.now();
        const tick = (now) => {
          this.reveal = Math.min(1, (now - t0) / ms);
          if (!this.playing) this.draw();
          if (this.reveal < 1) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
    }
  }

  function timecode(f, fps = 30) {
    const s = Math.floor(f / fps);
    const fr = f % fps;
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}:${String(fr).padStart(2, "0")}`;
  }
  const frameAddr = (f) => `F${String(f).padStart(4, "0")}`;

  async function fontsReady() {
    const loads = [
      '900 100px "Archivo"',
      '800 100px "Archivo"',
      '500 100px "Geist"',
      '600 100px "Geist"',
      '400 100px "Geist"',
      '400 100px "Instrument Serif"',
      '700 100px "Archivo"',
    ].map((f) => document.fonts.load(f).catch(() => null));
    await Promise.all(loads);
    await document.fonts.ready;
  }

  window.Kynimo = {
    PACKS,
    EASE,
    createComposition,
    applyFix,
    findLayer,
    sceneAt,
    layerBox,
    renderFrame,
    ditherInto,
    waveform,
    Player,
    timecode,
    frameAddr,
    fontsReady,
    reduced,
  };
})();
