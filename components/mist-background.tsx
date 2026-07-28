'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Volumetric mist backdrop — "VAR booth at a night match".
 *
 * A single full-screen WebGL fragment shader. Two independently drifting fog
 * decks (a slow, large, dim FAR deck and a faster, tighter NEAR deck) are each
 * domain-warped fbm over 3D simplex noise, then composited front-to-back with
 * aerial-perspective dimming on the far deck. That gives real parallax and
 * depth rather than one animated blob.
 *
 * Zero dependencies. Everything is deliberately budgeted:
 *  - peak composited alpha is hard-clamped (see MIST_ALPHA_CEILING in the
 *    shader) so body text keeps WCAG AA over the mist,
 *  - the loop runs at ~30fps, at <=1.5x DPR, and stops while the tab is hidden,
 *  - `prefers-reduced-motion: reduce` renders exactly one static frame,
 *  - if WebGL is unavailable the canvas is dropped silently and the CSS-only
 *    `.mist-fallback` gradient layer carries the look.
 */

/* -------------------------------------------------------------------------- */
/* Shaders                                                                     */
/* -------------------------------------------------------------------------- */

const VERTEX_SRC = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

/*
 * snoise(vec3) below is the canonical Ashima Arts / Stefan Gustavson
 * "webgl-noise" 3D simplex implementation (MIT licensed, github.com/ashima/
 * webgl-noise). Kept verbatim so it stays recognisable/auditable.
 */
const FRAGMENT_SRC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uRes;
uniform float uTime;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);

  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// 2-octave fbm — used as the domain-warp driver.
float fbm2(vec3 p) {
  float f = 0.0;
  float a = 0.55;
  for (int i = 0; i < 2; i++) {
    f += a * snoise(p);
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return f;
}

// 3-octave fbm — the visible density field.
float fbm3(vec3 p) {
  float f = 0.0;
  float a = 0.55;
  for (int i = 0; i < 3; i++) {
    f += a * snoise(p);
    p = p * 2.07 + 19.3;
    a *= 0.5;
  }
  return f;
}

// Interleaved gradient noise — sub-LSB dither, kills banding at these very
// low alphas without reading as film grain.
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
  vec2 res = uRes;
  vec2 fc  = gl_FragCoord.xy;
  vec2 uv  = fc / res;                       // uv.y == 0 at the BOTTOM
  vec2 p   = (fc - 0.5 * res) / res.y;       // aspect-correct, centred
  float t  = uTime;

  // Fog banks are wide and flat, so squash the sampling space vertically —
  // features come out stretched along the horizon instead of puffy/cloudy.
  vec2 pf = p * vec2(1.0, 1.75);
  vec2 pn = p * vec2(1.0, 2.30);

  // ---- FAR DECK: broad, slow, dim ------------------------------------
  vec3 fa = vec3(pf * 0.85 + vec2(t * 0.0090, t * 0.0032), t * 0.016);
  float fw = fbm2(fa);
  vec3 fb = vec3(
    pf * 1.05 + vec2(fw * 0.62, fw * 0.30) + vec2(t * 0.0125, 0.0),
    t * 0.021 + fw * 0.25
  );
  float far = fbm3(fb) * 0.5 + 0.5;
  far = smoothstep(0.24, 0.86, far);

  // ---- NEAR DECK: tighter, faster, opposite drift -> parallax ---------
  vec3 na = vec3(pn * 2.10 - vec2(t * 0.0265, t * 0.0090), t * 0.045);
  float nw = fbm2(na);
  vec3 nb = vec3(
    pn * 2.55 + vec2(nw * 0.95, -nw * 0.50) - vec2(t * 0.0380, 0.0),
    t * 0.058 + nw * 0.45
  );
  float near = fbm3(nb) * 0.5 + 0.5;
  near = smoothstep(0.40, 0.88, near);

  // ---- Shaping -------------------------------------------------------
  // Ground fog: peaks in the lower third, eases off at the very bottom
  // edge (the page footer lives there) and thins out toward the top.
  float rise  = smoothstep(0.00, 0.20, uv.y);
  float decay = 1.0 - smoothstep(0.18, 0.92, uv.y);
  float ground = 0.24 + 0.86 * mix(0.62, 1.0, rise) * decay;

  // A little haze up top so the stadium light spots have something to bleed
  // into.
  float topBand = smoothstep(0.58, 1.0, uv.y) * 0.42;

  float farMask  = ground * 0.85 + topBand;
  float nearMask = ground * 0.95 + topBand * 0.45;

  // Relief pocket behind the hero copy — keeps headline contrast pristine.
  vec2 cd = (uv - vec2(0.5, 0.60)) * vec2(1.25, 1.0);
  float relief = 1.0 - 0.45 * exp(-dot(cd, cd) * 7.0);

  // ---- Front-to-back composite ---------------------------------------
  float aFar  = clamp(far  * farMask,  0.0, 1.0) * 0.082;
  float aNear = clamp(near * nearMask, 0.0, 1.0) * 0.090;
  float alpha = (aNear + aFar * (1.0 - aNear)) * relief;

  // ---- Tint: cold slate body, green + blue light bleed ---------------
  // Bleed origins mirror body::before (green at 15%/-10%, blue at 100%/0%
  // in CSS coords, i.e. uv.y flipped).
  float gMask = smoothstep(0.78, 0.02, length((uv - vec2(0.14, 1.06)) * vec2(0.85, 1.25)));
  float bMask = smoothstep(0.82, 0.02, length((uv - vec2(1.00, 0.98)) * vec2(0.80, 1.20)));

  vec3 slate     = vec3(0.40, 0.48, 0.58);
  vec3 mistGreen = vec3(0.24, 0.55, 0.42);
  vec3 mistBlue  = vec3(0.22, 0.40, 0.62);

  vec3 tint = slate;
  tint = mix(tint, mistGreen, gMask * 0.55);
  tint = mix(tint, mistBlue,  bMask * 0.50);

  // Aerial perspective: the far deck is dimmer and cooler than the near deck.
  float depth = aNear / max(alpha, 1e-4);
  vec3 col = mix(tint * 0.70, tint, clamp(depth, 0.0, 1.0));

  // ---- Dither + hard contrast ceiling --------------------------------
  alpha += (ign(fc) - 0.5) * 0.0075;

  // MIST_ALPHA_CEILING: never let the veil exceed this.
  // Worst case (this ceiling actually reached, over the brightest tint):
  // composited backdrop Y ~= 0.0138, holding --muted-foreground at ~6.1:1 and
  // --foreground at ~15.0:1. Where text actually sits (footer, lower centre)
  // alpha lands nearer 0.113 -> Y ~= 0.0107 -> --muted-foreground ~6.4:1.
  // Both are comfortably clear of the 4.5:1 AA floor.
  alpha = clamp(alpha, 0.0, 0.155);

  gl_FragColor = vec4(col * alpha, alpha); // premultiplied
}
`;

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

type AnyGL = WebGLRenderingContext | WebGL2RenderingContext;

const TARGET_FPS = 30;
const FRAME_MS = 1000 / TARGET_FPS;
const MAX_DPR = 1.5;
/** Fog is low-frequency, so we render well under 1:1 and let the browser
 *  upscale. The bilinear filtering reads as an extra (free) blur and cuts
 *  fragment cost ~3x versus native resolution. */
const BASE_QUALITY = 0.55;
/** Hard cap on the longest internal buffer edge (protects 4K + hi-dpi phones). */
const MAX_EDGE = 900;
/** Adaptive degrade: if we can't hold ~22fps, step resolution down (twice max). */
const DEGRADE_STEP = 0.7;
const MAX_DEGRADES = 2;
const SAMPLE_FRAMES = 60;
const SLOW_FRAME_MS = 46;

function compile(gl: AnyGL, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    // Intentionally silent: this layer is decorative, never a hard failure.
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function MistBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [glReady, setGlReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let raf = 0;
    let gl: AnyGL | null = null;
    let program: WebGLProgram | null = null;
    let vs: WebGLShader | null = null;
    let fs: WebGLShader | null = null;
    let buffer: WebGLBuffer | null = null;
    let ro: ResizeObserver | null = null;

    /* ---- context ---- */
    const attrs: WebGLContextAttributes = {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
      failIfMajorPerformanceCaveat: false,
    };

    try {
      gl =
        (canvas.getContext('webgl2', attrs) as WebGL2RenderingContext | null) ??
        (canvas.getContext('webgl', attrs) as WebGLRenderingContext | null);
    } catch {
      gl = null;
    }
    // `getContext` hands back the SAME object for the life of a canvas element,
    // so a context that was lost earlier is still lost here — treat that as
    // "no WebGL" and let the CSS fallback carry the look.
    if (!gl || gl.isContextLost()) {
      gl = null;
      if (!disposed) setGlReady(false);
      return;
    }

    // Release our GPU objects and let .mist-fallback carry the look. Never
    // throws, never logs — this layer is decoration, not a feature.
    //
    // Deliberately does NOT call WEBGL_lose_context.loseContext(): React reuses
    // the same <canvas> element across StrictMode's mount → unmount → remount
    // (and across every Fast Refresh of this file), and because getContext
    // always returns the same object, losing it here would permanently brick
    // the canvas for the remount — shaders then fail to compile, we bail again,
    // and neither the shader nor the fallback ever paints. Dropping our
    // reference is enough; the driver reclaims the context with the element.
    const bail = () => {
      if (!gl) return;
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      buffer = null;
      program = null;
      vs = null;
      fs = null;
      gl = null;
      // Reveal the CSS fallback. Without this a first-mount success followed by
      // a later failure would leave data-gl="true" on both children, hiding the
      // fallback behind a canvas that is no longer being drawn.
      if (!disposed) setGlReady(false);
    };

    /* ---- program ---- */
    vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    if (!vs || !fs) return bail();

    program = gl.createProgram();
    if (!program) return bail();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return bail();
    gl.useProgram(program);

    /* ---- full-screen triangle ---- */
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(program, 'uRes');
    const uTime = gl.getUniformLocation(program, 'uTime');

    gl.clearColor(0, 0, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    /* ---- sizing ---- */
    let quality = BASE_QUALITY;
    const resize = () => {
      if (!gl || disposed) return false;
      const cssW = canvas.clientWidth || window.innerWidth;
      const cssH = canvas.clientHeight || window.innerHeight;
      let scale = Math.min(window.devicePixelRatio || 1, MAX_DPR) * quality;
      const longest = Math.max(cssW, cssH) * scale;
      if (longest > MAX_EDGE) scale *= MAX_EDGE / longest;

      const w = Math.max(1, Math.round(cssW * scale));
      const h = Math.max(1, Math.round(cssH * scale));
      if (w === canvas.width && h === canvas.height) return false;

      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
      return true;
    };
    resize();

    /* ---- draw ---- */
    const draw = (seconds: number) => {
      if (!gl || disposed) return;
      gl.uniform1f(uTime, seconds);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // Start mid-field so the first painted frame is already interesting.
    const START_T = 240;
    draw(START_T);
    if (!disposed) setGlReady(true);

    /* ---- motion ---- */
    const motionQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;

    let elapsed = START_T;
    let lastFrame = 0;
    let lastTick = 0;
    let sampled = 0;
    let sampledMs = 0;
    let degrades = 0;

    const loop = (now: number) => {
      if (disposed) return;
      raf = window.requestAnimationFrame(loop);
      if (now - lastFrame < FRAME_MS - 1) return;
      // Advance by wall time (clamped) so pauses never cause a jump.
      const delta = lastTick ? Math.min((now - lastTick) / 1000, 0.25) : 0;
      if (lastFrame) {
        sampledMs += now - lastFrame;
        sampled += 1;
      }
      lastTick = now;
      lastFrame = now;
      elapsed += delta;
      draw(elapsed);

      // Adaptive: if this device can't keep up, shrink the buffer once or twice
      // rather than burning the frame budget forever.
      if (sampled >= SAMPLE_FRAMES) {
        if (sampledMs / sampled > SLOW_FRAME_MS && degrades < MAX_DEGRADES) {
          degrades += 1;
          quality *= DEGRADE_STEP;
          resize();
        }
        sampled = 0;
        sampledMs = 0;
      }
    };

    const stopLoop = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      lastTick = 0;
      lastFrame = 0;
      sampled = 0;
      sampledMs = 0;
    };

    const startLoop = () => {
      if (disposed || raf) return;
      // A context lost at runtime leaves `gl` non-null but dead; without this
      // a later visibilitychange / resize / motion-preference change would spin
      // a 30fps rAF issuing no-op GL calls forever.
      if (!gl || gl.isContextLost()) return;
      if (motionQuery?.matches) return; // reduced motion: static frame only
      if (typeof document !== 'undefined' && document.hidden) return;
      raf = window.requestAnimationFrame(loop);
    };

    startLoop();

    /* ---- listeners ---- */
    const onVisibility = () => {
      if (document.hidden) stopLoop();
      else startLoop();
    };

    const onMotionChange = () => {
      if (motionQuery?.matches) {
        stopLoop();
        draw(elapsed);
      } else {
        startLoop();
      }
    };

    const onResize = () => {
      if (resize() && !raf) draw(elapsed); // repaint when the loop is parked
    };

    const onContextLost = (event: Event) => {
      event.preventDefault();
      stopLoop();
      if (!disposed) setGlReady(false); // silently reveal the CSS fallback
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    canvas.addEventListener('webglcontextlost', onContextLost);

    if (motionQuery) {
      if (typeof motionQuery.addEventListener === 'function') {
        motionQuery.addEventListener('change', onMotionChange);
      } else if (typeof motionQuery.addListener === 'function') {
        motionQuery.addListener(onMotionChange);
      }
    }

    if (typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(onResize);
      ro.observe(canvas);
    }

    /* ---- teardown ---- */
    return () => {
      disposed = true;
      stopLoop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      if (motionQuery) {
        if (typeof motionQuery.removeEventListener === 'function') {
          motionQuery.removeEventListener('change', onMotionChange);
        } else if (typeof motionQuery.removeListener === 'function') {
          motionQuery.removeListener(onMotionChange);
        }
      }
      ro?.disconnect();
      bail();
    };
  }, []);

  return (
    <div className="mist-layer" aria-hidden="true">
      {/* Static CSS mist. Always mounted; it is the sole layer whenever WebGL
          is unavailable, and cross-fades out once the shader is live. */}
      <div className="mist-fallback" data-gl={glReady ? 'true' : 'false'} />
      <canvas ref={canvasRef} className="mist-canvas" data-gl={glReady ? 'true' : 'false'} />
    </div>
  );
}

export default MistBackground;
