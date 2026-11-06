// In-page experiments for ADR-0016. Classic script; run.mjs calls globalThis.runExperiments.
// Every result is a short SHA-256 of raw RGBA bytes, so runs can be compared exactly.

globalThis.runExperiments = async (W, H, fontB64, origin) => {
  const fontBytes = Uint8Array.from(atob(fontB64), (c) => c.charCodeAt(0)).buffer;
  // CanvasKitInit is a global from canvaskit.js, which run.mjs injects first.
  const CK = await CanvasKitInit({ locateFile: (f) => `${origin}/${f}` });
  const out = {};

  const sha = async (bytes) => {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return [...d]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
  };
  const flipRows = (px) => {
    const row = W * 4;
    const outPx = new Uint8Array(px.length);
    for (let y = 0; y < H; y++) outPx.set(px.subarray((H - 1 - y) * row, (H - y) * row), y * row);
    return outPx;
  };
  const meanAbsError = (a, b) => {
    let e = 0;
    for (let i = 0; i < a.length; i++) e += Math.abs(a[i] - b[i]);
    return Number((e / a.length).toFixed(3));
  };

  const newContext = () => {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      stencil: true,
      depth: false,
    });
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    out.renderer = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    out.floatTargets = Boolean(gl.getExtension("EXT_color_buffer_float"));
    out.maxSamples = gl.getParameter(gl.MAX_SAMPLES);
    return { canvas, gl };
  };

  const program = (gl, fs) => {
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(
      p,
      compile(
        gl.VERTEX_SHADER,
        "#version 300 es\nin vec2 p; out vec2 uv; void main(){ uv=p*0.5+0.5; gl_Position=vec4(p,0,1); }",
      ),
    );
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, "p");
    gl.linkProgram(p);
    return p;
  };

  // One full-screen GPU pass into an offscreen RGBA8 target; returns the target's pixels.
  const pass = (gl, fs, setup) => {
    const p = program(gl, fs);
    gl.useProgram(p);
    const target = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    setup(p);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    return px;
  };

  // A layer texture composited with a separable "multiply" blend (premultiplied) over a
  // procedural background: the shape of every M2 compositing pass.
  const MULTIPLY = `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform sampler2D L; uniform bool flipY;
void main(){ vec4 s = texture(L, flipY ? vec2(uv.x, 1.0 - uv.y) : uv);
  vec3 bg = vec3(0.5 + 0.5*sin(uv.x*20.0), 0.4 + 0.3*cos(uv.y*9.0), 0.7);
  o = vec4(s.rgb*bg + bg*(1.0 - s.a), 1.0); }`;
  const composite = (gl, layerTex, flipY) =>
    pass(gl, MULTIPLY, (p) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, layerTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.uniform1i(gl.getUniformLocation(p, "L"), 0);
      gl.uniform1i(gl.getUniformLocation(p, "flipY"), flipY ? 1 : 0);
    });

  // 1. A GLSL shader pass alone: transcendental functions, loops, fract, pow.
  {
    const { gl } = newContext();
    const px = pass(
      gl,
      `#version 300 es
precision highp float; in vec2 uv; out vec4 o; uniform float t;
void main(){ vec3 a = vec3(0);
  for (int i = 0; i < 24; i++) { float f = float(i);
    a += 0.04*vec3(sin(uv.x*13.1 + f*t), cos(uv.y*7.3 - f), exp(-f*0.1)*fract(uv.x*uv.y*91.7 + f)); }
  o = vec4(pow(clamp(a, 0.0, 1.0), vec3(1.0/2.2))*0.8, 0.8); }`,
      (p) => gl.uniform1f(gl.getUniformLocation(p, "t"), 1.37),
    );
    out.shaderPass = await sha(px);
  }

  // 2. Chosen path: Skia CPU raster -> texture upload -> our WebGL2 composite.
  let cpuRaster;
  {
    let t0 = performance.now();
    const surface = CK.MakeSurface(W, H);
    drawScene(CK, surface.getCanvas(), fontBytes, W, H);
    cpuRaster = surface.getCanvas().readPixels(0, 0, {
      width: W,
      height: H,
      colorType: CK.ColorType.RGBA_8888,
      alphaType: CK.AlphaType.Premul,
      colorSpace: CK.ColorSpace.SRGB,
    });
    surface.delete();
    out.cpuRasterMs = Math.round(performance.now() - t0);
    out.cpuRaster = await sha(cpuRaster);

    const { gl } = newContext();
    t0 = performance.now();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, cpuRaster);
    out.cpuComposite = await sha(composite(gl, tex, true));
    out.uploadCompositeMs = Math.round(performance.now() - t0);
  }

  // 3. Rejected path: Skia's GPU backend on our own WebGL2 context. We draw with Skia, copy
  // its framebuffer into a texture, run one raw composite pass, call the only reset CanvasKit
  // has (internal `_resetContext`), and draw again. Frame 0 is correct; later frames are not.
  {
    const { canvas, gl } = newContext();
    const handle = CK.GetWebGLContext(canvas, {
      antialias: 0,
      premultipliedAlpha: 1,
      preserveDrawingBuffer: 1,
      stencil: 1,
      majorVersion: 2,
    });
    out.sharedSameContextObject = canvas.getContext("webgl2") === gl;
    const gr = CK.MakeWebGLContext(handle);
    const surface = CK.MakeOnScreenGLSurface(gr, W, H, CK.ColorSpace.SRGB, 0, 8);
    out.sharedSkiaVsCpuMae = [];
    out.sharedSkiaFrames = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      drawScene(CK, surface.getCanvas(), fontBytes, W, H);
      surface.flush();
      const skia = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, skia);
      const upright = flipRows(skia);
      out.sharedSkiaFrames.push(await sha(upright));
      out.sharedSkiaVsCpuMae.push(meanAbsError(upright, cpuRaster));
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, W, H);
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, W, H);
      composite(gl, tex, false);
      surface._resetContext();
      out[`sharedFrame${i}Ms`] = Math.round(performance.now() - t0);
    }
    surface.delete();
    gr.delete();
  }

  // 4. Control for 3: the same Skia GPU redraws with no raw GL in between are stable.
  {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const handle = CK.GetWebGLContext(canvas, {
      antialias: 0,
      preserveDrawingBuffer: 1,
      stencil: 1,
      majorVersion: 2,
    });
    const gr = CK.MakeWebGLContext(handle);
    const surface = CK.MakeOnScreenGLSurface(gr, W, H, CK.ColorSpace.SRGB, 0, 8);
    const gl = canvas.getContext("webgl2");
    out.skiaGpuAloneFrames = [];
    for (let i = 0; i < 3; i++) {
      drawScene(CK, surface.getCanvas(), fontBytes, W, H);
      surface.flush();
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      out.skiaGpuAloneFrames.push(await sha(px));
    }
    surface.delete();
    gr.delete();
  }

  return out;
};
