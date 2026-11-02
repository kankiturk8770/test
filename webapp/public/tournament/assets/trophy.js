// The intro's trophy, real 3D (three.js r160, MIT, assets/vendor): a cup of golden glass on a square smoked-glass base with
// "DEVIL ESPORTS" engraved in gold on all four sides. It turns slowly and floats; drawing stops when it's off screen.
// mountTrophy(host) -> a stop() function; it throws when WebGL isn't there (the caller keeps its picture then).
import * as THREE from './vendor/three.module.min.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';

function engraving() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.textAlign = 'center';
  g.fillStyle = '#fff';
  g.font = '600 150px Teko, "Arial Narrow", sans-serif';
  g.fillText('DEVIL', 256, 150);
  g.font = '500 62px Teko, "Arial Narrow", sans-serif';
  g.save(); g.translate(256, 222); g.scale(1, 1);
  // ESPORTS, letter-spaced
  const word = 'ESPORTS', sp = 18;
  const w = [...word].reduce((a, ch) => a + g.measureText(ch).width + sp, -sp);
  let x = -w / 2;
  g.textAlign = 'left';
  for (const ch of word) { g.fillText(ch, x, 0); x += g.measureText(ch).width + sp; }
  g.restore();
  g.fillRect(70, 176, 90, 5); g.fillRect(352, 176, 90, 5);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export async function mountTrophy(host) {
  try { await document.fonts.load('600 150px Teko'); } catch {}
  const W = host.clientWidth || 220, H = host.clientHeight || 280;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(W, H);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
  const cam = new THREE.PerspectiveCamera(30, W / H, 0.1, 50);
  cam.position.set(0, 0.45, 6.1);
  cam.lookAt(0, 0.08, 0);

  // a warm glow behind it: what the glass bends and tints (glass needs something behind it to look like glass)
  const glowC = document.createElement('canvas'); glowC.width = glowC.height = 256;
  const gg = glowC.getContext('2d'), rg = gg.createRadialGradient(128, 128, 0, 128, 128, 128);
  rg.addColorStop(0, 'rgba(255,200,90,0.95)'); rg.addColorStop(0.35, 'rgba(255,150,40,0.45)'); rg.addColorStop(1, 'rgba(255,120,20,0)');
  gg.fillStyle = rg; gg.fillRect(0, 0, 256, 256);
  const glowT = new THREE.CanvasTexture(glowC); glowT.colorSpace = THREE.SRGBColorSpace;
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), new THREE.MeshBasicMaterial({ map: glowT, transparent: true, depthWrite: false }));
  glow.position.set(0, 0.35, -1.6);
  scene.add(glow);

  const trophy = new THREE.Group();
  scene.add(trophy);

  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffe68a, metalness: 0, roughness: 0, transmission: 1, thickness: 0.35, ior: 1.6, flatShading: true,
    attenuationColor: new THREE.Color(0xffc81a), attenuationDistance: 1.2, clearcoat: 1, clearcoatRoughness: 0.02, iridescence: 0.25, iridescenceIOR: 1.3,
    specularIntensity: 1, specularColor: new THREE.Color(0xfff4d6), envMapIntensity: 2.4, side: THREE.DoubleSide,
  });
  const gold = new THREE.MeshPhysicalMaterial({ color: 0xffcf4d, metalness: 1, roughness: 0.12, clearcoat: 0.8, envMapIntensity: 2.2 });

  // the cup: a turned profile (outside up the bowl, over the lip, back down inside), a knot and a foot
  const p = [];
  const prof = [[0.0, 0.0], [0.30, 0.0], [0.33, 0.04], [0.26, 0.09], [0.1, 0.14], [0.075, 0.24], [0.11, 0.31], [0.12, 0.36], [0.075, 0.42], [0.07, 0.56],
    [0.16, 0.64], [0.34, 0.78], [0.5, 0.98], [0.6, 1.22], [0.63, 1.42], [0.66, 1.47], [0.6, 1.47], [0.57, 1.4], [0.53, 1.2], [0.42, 0.98], [0.24, 0.78], [0.1, 0.7], [0.0, 0.68]];
  for (const [r, y] of prof) p.push(new THREE.Vector2(r, y));
  // 14 facets: cut crystal, every face catches the light
  const cup = new THREE.Mesh(new THREE.LatheGeometry(p, 14), glass);
  cup.position.y = -0.55;
  trophy.add(cup);
  // gold trims: the lip and the knot
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.635, 0.022, 16, 96), gold);
  lip.rotation.x = Math.PI / 2; lip.position.y = -0.55 + 1.47;
  trophy.add(lip);
  const knot = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.03, 16, 48), gold);
  knot.rotation.x = Math.PI / 2; knot.position.y = -0.55 + 0.36;
  trophy.add(knot);
  // handles
  // handles: half rings bulging out of each side of the bowl
  for (const s of [-1, 1]) {
    const h = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.04, 18, 48, Math.PI), gold);
    h.position.set(s * 0.56, -0.55 + 1.12, 0);
    h.rotation.z = s > 0 ? -Math.PI / 2 : Math.PI / 2;
    trophy.add(h);
  }
  // a star of gold inside the bowl: it catches the light through the glass
  const star = new THREE.Shape();
  for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2 + Math.PI / 2, r = i % 2 ? 0.085 : 0.2; i ? star.lineTo(Math.cos(a) * r, Math.sin(a) * r) : star.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
  const starM = new THREE.Mesh(new THREE.ExtrudeGeometry(star, { depth: 0.05, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.012, bevelSegments: 2 }), gold);
  starM.position.set(0, -0.55 + 1.12, -0.02);
  trophy.add(starM);

  // the square base: smoked glass with gold edges, DEVIL ESPORTS engraved on every side
  const baseY = -0.55 - 0.27;
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.5, 1.0),
    new THREE.MeshPhysicalMaterial({ color: 0x1a140c, metalness: 0.2, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.2 }));
  base.position.y = baseY;
  trophy.add(base);
  for (const y of [baseY + 0.255, baseY - 0.255]) {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(1.06, 0.035, 1.06), gold);
    plate.position.y = y;
    trophy.add(plate);
  }
  const eng = engraving();
  const engM = new THREE.MeshPhysicalMaterial({ color: 0xffcf55, metalness: 1, roughness: 0.22, map: eng, alphaMap: eng, transparent: true, envMapIntensity: 1.6,
    emissive: new THREE.Color(0x6a4300), emissiveMap: eng });
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), engM);
    const a = (i * Math.PI) / 2;
    f.position.set(Math.sin(a) * 0.502, baseY, Math.cos(a) * 0.502);
    f.rotation.y = a;
    trophy.add(f);
  }

  const key = new THREE.DirectionalLight(0xfff0d0, 2.2); key.position.set(2, 3, 4); scene.add(key);
  const rim = new THREE.DirectionalLight(0xffa040, 2.5); rim.position.set(-3, 1.5, -2); scene.add(rim);
  const inner = new THREE.PointLight(0xffb030, 3, 2.5); inner.position.set(0, 0.6, 0.2); scene.add(inner);

  let on = true, raf = 0, t0 = performance.now();
  const io = new IntersectionObserver((e) => { on = e[0].isIntersecting; if (on && !raf) raf = requestAnimationFrame(loop); });
  io.observe(host);
  function loop(now) {
    raf = 0;
    if (!on || !host.isConnected) return;
    const t = (now - t0) / 1000;
    trophy.rotation.y = t * 0.55;
    trophy.position.y = Math.sin(t * 1.6) * 0.06;
    trophy.rotation.z = Math.sin(t * 0.9) * 0.035;
    inner.intensity = 2.6 + Math.sin(t * 2.2) * 0.6;
    renderer.render(scene, cam);
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);
  return () => { on = false; io.disconnect(); renderer.dispose(); pmrem.dispose(); host.innerHTML = ''; };
}
