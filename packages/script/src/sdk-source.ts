/**
 * The SDK: trusted JavaScript evaluated in the sandbox before the user's script (ADR-0036). It
 * only RECORDS calls; the host expands and validates them (expand.ts). It is not the security
 * boundary, so everything it records is re-validated on the host.
 *
 * It reads `__SEED` and `__DATA` (the snapshot from snapshot.ts), uses no `Date` or
 * `Math.random`, and leaves exactly two names in the script's scope: the frozen global
 * `kynimo` and the const `__collect` the runner calls. Everything else is closed over.
 */
export const SDK_SOURCE = String.raw`
"use strict";
const __collect = (() => {
  const stringify = JSON.stringify;
  const isArray = Array.isArray;
  const freeze = Object.freeze;
  const keys = Object.keys;
  const getProto = Object.getPrototypeOf;
  const objProto = Object.prototype;
  const imul = Math.imul;
  const floor = Math.floor;
  const isInteger = Number.isInteger;
  const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

  const data = deepFreeze(__DATA);
  const entries = [];
  const handles = new WeakSet();

  // ---- helpers -------------------------------------------------------------------------------

  function deepFreeze(value) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      freeze(value);
      for (const k of keys(value)) deepFreeze(value[k]);
    }
    return value;
  }

  /** The line of the script frame that called into the SDK, when the stack has one. */
  const callerLine = () => {
    const stack = new Error().stack;
    if (typeof stack !== "string") return undefined;
    const m = /script\.ts:(\d+)/.exec(stack);
    return m ? Number(m[1]) : undefined;
  };

  const isPlain = (v) => {
    if (v === null || typeof v !== "object") return false;
    const proto = getProto(v);
    return proto === objProto || proto === null;
  };

  /** Copies plain objects and arrays, replacing layer handles by their ids. */
  const plain = (value) => {
    if (value !== null && typeof value === "object") {
      if (handles.has(value)) return value.id;
      if (isArray(value)) return value.map(plain);
      if (isPlain(value)) {
        const out = {};
        for (const k of keys(value)) out[k] = plain(value[k]);
        return out;
      }
    }
    return value;
  };

  const record = (entry) => {
    const line = callerLine();
    if (line !== undefined) entry.line = line;
    entries.push(entry);
  };

  const describe = (selector) => {
    try {
      return stringify(plain(selector));
    } catch (e) {
      return String(selector);
    }
  };

  /** '*' matches any run of characters (same algorithm as the host's LayerSelector). */
  const globMatch = (pattern, text) => {
    let p = 0;
    let t = 0;
    let star = -1;
    let mark = 0;
    while (t < text.length) {
      if (p < pattern.length && pattern[p] === "*") {
        star = p++;
        mark = t;
      } else if (p < pattern.length && pattern[p] === text[t]) {
        p++;
        t++;
      } else if (star >= 0) {
        p = star + 1;
        t = ++mark;
      } else return false;
    }
    while (pattern[p] === "*") p++;
    return p === pattern.length;
  };

  // ---- state ---------------------------------------------------------------------------------

  // Every layer record the script can see, per composition, top-first. Added layers join it;
  // removed layers leave it.
  const compositions = new Map();
  const usedIds = new Set(data.layerIds);
  let nextLayerNumber = 1;

  const makeRecord = (c, l) => ({
    id: l.id,
    name: l.name,
    type: l.type,
    composition: c,
    parent: l.parent,
    inFrame: l.inFrame,
    outFrame: l.outFrame,
    startFrame: l.startFrame,
    transform: l.transform,
    animated: l.animated,
    text: l.text,
    removed: false,
  });

  const handleCache = new Map();
  const handleOf = (rec) => {
    let h = handleCache.get(rec.id);
    if (h === undefined) {
      h = makeHandle(rec);
      handleCache.set(rec.id, h);
    }
    return h;
  };

  const alive = (rec) => {
    if (rec.removed) throw new Error("layer '" + rec.id + "' was removed by this script");
    return rec;
  };

  /** Layer records matching a selector (a handle, an id string or { name?, type?, composition? }). */
  const matching = (selector, within) => {
    const all = [];
    for (const c of compositions.values()) {
      if (within !== undefined && c.id !== within) continue;
      for (const rec of c.view) all.push(rec);
    }
    if (typeof selector === "string") return all.filter((r) => r.id === selector);
    if (selector !== null && typeof selector === "object" && handles.has(selector)) {
      return all.filter((r) => r.id === selector.id);
    }
    if (!isPlain(selector) || keys(selector).length === 0) {
      throw new Error(
        "a layer selector is an id string, a layer, or an object with name, type and/or composition",
      );
    }
    for (const k of keys(selector)) {
      if (k !== "name" && k !== "type" && k !== "composition") {
        throw new Error("unknown selector field '" + k + "'; use name, type and/or composition");
      }
    }
    return all.filter(
      (r) =>
        (selector.name === undefined || globMatch(String(selector.name), r.name)) &&
        (selector.type === undefined || r.type === selector.type) &&
        (selector.composition === undefined || r.composition === selector.composition),
    );
  };

  const exactlyOne = (selector, within) => {
    const found = matching(selector, within);
    if (found.length === 1) return handleOf(found[0]);
    const where = within === undefined ? "" : " in composition '" + within + "'";
    throw new Error(
      found.length === 0
        ? "no layer matches " + describe(selector) + where
        : found.length +
          " layers match " + describe(selector) + where + " (" +
          found.slice(0, 5).map((r) => r.id).join(", ") +
          (found.length > 5 ? ", ..." : "") +
          "); a selector must match exactly one layer",
    );
  };

  // ---- layers --------------------------------------------------------------------------------

  function makeHandle(rec) {
    const layerRef = () => alive(rec).id;
    const handle = {
      get id() { return rec.id; },
      get name() { return rec.name; },
      get type() { return rec.type; },
      get composition() { return rec.composition; },
      get parentId() { return rec.parent; },
      get inFrame() { return rec.inFrame; },
      get outFrame() { return rec.outFrame; },
      get startFrame() { return rec.startFrame; },
      get transform() { return rec.transform; },
      get animated() { return rec.animated; },
      get text() { return rec.text; },
      set(property, value) {
        record({ kind: "op", op: { op: "setTransformTrack", layer: layerRef(), property, track: { value: plain(value) } } });
      },
      keyframes(property, keyframes) {
        record({ kind: "op", op: { op: "setTransformTrack", layer: layerRef(), property, track: { keyframes: plain(keyframes) } } });
      },
      update(patch) {
        record({ kind: "op", op: { op: "updateLayer", layer: layerRef(), set: plain(patch) } });
        if (isPlain(patch) && typeof patch.name === "string") rec.name = patch.name;
      },
      parent(layer) {
        const id = layerRef();
        record({ kind: "op", op: { op: "setParent", layer: id, parent: layer === null ? null : plain(layer) } });
      },
      remove() {
        const id = layerRef();
        record({ kind: "op", op: { op: "removeLayer", layer: id } });
        rec.removed = true;
        const c = compositions.get(rec.composition);
        if (c !== undefined) c.view = c.view.filter((r) => r !== rec);
      },
      behavior(behavior, options) {
        const b = plain(behavior);
        const op = {
          op: "addBehavior",
          layer: layerRef(),
          behavior: { ...(b && typeof b.type === "string" ? { name: b.type } : {}), enabled: true, ...b },
        };
        if (options && options.id !== undefined) op.id = options.id;
        if (options && options.index !== undefined) op.index = options.index;
        record({ kind: "op", op });
      },
      animate(input) {
        record({ kind: "animate", input: { ...plain(input), layers: layerRef() } });
      },
      preset(id, params, stagger) {
        const input = { layers: layerRef(), preset: id };
        if (params !== undefined) input.params = plain(params);
        if (stagger !== undefined) input.stagger = plain(stagger);
        record({ kind: "preset", input });
      },
    };
    handles.add(handle);
    return freeze(handle);
  }

  // ---- compositions --------------------------------------------------------------------------

  const compositionHandles = new Map();

  const makeComposition = (c) => {
    const comp = {
      id: c.id,
      name: c.name,
      width: c.width,
      height: c.height,
      fps: c.fps,
      durationFrames: c.durationFrames,
      scale: c.scale,
      get layers() {
        return freeze(c.view.map(handleOf));
      },
      frames(milliseconds) {
        if (!isInteger(milliseconds)) throw new RangeError("milliseconds must be a whole number");
        if (milliseconds <= 0) return 0;
        const denominator = c.fps.den * 1000;
        return Math.max(1, floor((2 * milliseconds * c.fps.num + denominator) / (2 * denominator)));
      },
      layer(selector) {
        return exactlyOne(selector, c.id);
      },
      find(selector) {
        return matching(selector, c.id).map(handleOf);
      },
      add(type, props, options) {
        if (typeof type !== "string") throw new Error("add(type, props): type must be a layer type string");
        if (props === null || typeof props !== "object" || isArray(props)) {
          throw new Error("add(type, props): props must be an object");
        }
        let id;
        if (options && options.id !== undefined) {
          id = options.id;
          if (typeof id !== "string" || !ID_PATTERN.test(id)) {
            throw new Error("layer id '" + String(id) + "' must be 1-64 characters: lowercase letters, digits, '-' or '_', starting with a letter or digit");
          }
          if (usedIds.has(id)) throw new Error("layer id '" + id + "' is already in use");
        } else {
          while (usedIds.has("layer-" + nextLayerNumber)) nextLayerNumber++;
          id = "layer-" + nextLayerNumber;
        }
        usedIds.add(id);
        const body = plain(props);
        const op = { op: "addLayer", composition: c.id, id, layer: { type, ...body } };
        let at = 0;
        if (options && options.index !== undefined) {
          op.index = options.index;
          at = options.index;
        }
        record({ kind: "op", op });
        const rec = {
          id,
          name: typeof body.name === "string" ? body.name : "",
          type,
          composition: c.id,
          parent: typeof body.parent === "string" ? body.parent : null,
          inFrame: typeof body.inFrame === "number" ? body.inFrame : 0,
          outFrame: typeof body.outFrame === "number" ? body.outFrame : c.durationFrames,
          startFrame: typeof body.startFrame === "number" ? body.startFrame : 0,
          transform: freeze({}),
          animated: freeze([]),
          text: type === "text" && body.content && typeof body.content.value === "string" ? body.content.value : undefined,
          removed: false,
        };
        c.view.splice(isInteger(at) && at >= 0 ? Math.min(at, c.view.length) : 0, 0, rec);
        return handleOf(rec);
      },
    };
    return freeze(comp);
  };

  for (const c of data.compositions) {
    const state = { ...c, view: [] };
    state.view = c.layers.map((l) => makeRecord(c.id, l));
    compositions.set(c.id, state);
    compositionHandles.set(c.id, makeComposition(state));
  }

  // ---- random --------------------------------------------------------------------------------

  // mulberry32, the same integer math as @kynimo/intent, divided by 2**32.
  let state32 = __SEED >>> 0;
  const random = () => {
    state32 = (state32 + 0x6d2b79f5) >>> 0;
    let t = state32;
    t = imul(t ^ (t >>> 15), t | 1);
    t ^= t + imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // ---- the public object ---------------------------------------------------------------------

  const intent = (kind) => (input) => {
    record({ kind, input: plain(input) });
  };

  const kynimo = {
    random,
    tokens: deepFreeze(data.tokens),
    assets: deepFreeze(data.assets),
    composition(id) {
      const wanted = id === undefined ? data.mainCompositionId : id;
      const found = compositionHandles.get(wanted);
      if (found === undefined) {
        throw new Error(
          "no composition '" + String(wanted) + "'; available: " + [...compositionHandles.keys()].join(", "),
        );
      }
      return found;
    },
    layer(selector) {
      return exactlyOne(selector);
    },
    op(op) {
      record({ kind: "op", op: plain(op) });
    },
    animate: intent("animate"),
    preset: intent("preset"),
    stagger: intent("stagger"),
    retime: intent("retime"),
  };

  Object.defineProperty(globalThis, "kynimo", {
    value: freeze(kynimo),
    writable: false,
    configurable: false,
    enumerable: true,
  });

  return () => stringify(entries);
})();
`;
