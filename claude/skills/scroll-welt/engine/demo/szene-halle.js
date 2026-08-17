/* Demo scene 3 — a real three.js segment.
 *
 * The camera flies down the aisle of a store hall toward the lit doorway at the
 * far end. Everything the camera does comes from t: position and look-at are
 * sampled from two splines by treiber-three.js, and `update(t)` only turns the
 * things that are allowed to depend on t (the door light swelling as we
 * approach). No clock, no frame counter — scroll runs backwards too.
 *
 * three itself is resolved by the driver. This page carries an importmap that
 * points the bare specifier "three" at demo/vendor/three/, so the driver's
 * `import('three')` branch is the one being used — the same branch a project
 * with a bundler would hit.
 */

const halleSzene = createThreeSzene({
  fov: 46,
  near: 0.05,
  far: 120,
  background: 0xE4D6BC,

  // Down the aisle, drifting slightly right, ending in front of the doorway.
  spline: [
    [-0.6, 1.55, 14.0],
    [ 0.5, 1.62,  9.5],
    [-0.3, 1.48,  5.0],
    [ 0.35, 1.55, 0.6],
  ],
  lookAt: [
    [0.0, 1.45, 6.0],
    [0.1, 1.42, 0.0],
    [0.0, 1.50, -7.0],
  ],

  build(three, scene) {
    scene.fog = new three.Fog(0xE4D6BC, 10, 44);

    const mat = (c, rough) => new three.MeshStandardMaterial({ color: c, roughness: rough == null ? 0.85 : rough });
    const WOOD = mat(0x8C6A4A), WOOD2 = mat(0xA9835E), PLASTER = mat(0xE2D2B6), FLOOR = mat(0xB08A64, 0.95);
    const GLASS = new three.MeshStandardMaterial({ color: 0x7E9E86, roughness: 0.25, metalness: 0.05 });
    const CRATE = mat(0x7E5D40);

    // floor + side walls + back wall with a doorway opening
    const floor = new three.Mesh(new three.PlaneGeometry(16, 60), FLOOR);
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = -14;
    scene.add(floor);

    for (const sx of [-5.4, 5.4]) {
      const wall = new three.Mesh(new three.PlaneGeometry(60, 7), PLASTER);
      wall.rotation.y = sx < 0 ? Math.PI / 2 : -Math.PI / 2;
      wall.position.set(sx, 3.5, -14);
      scene.add(wall);
    }
    const back = new three.Mesh(new three.PlaneGeometry(10.8, 7), PLASTER);
    back.position.set(0, 3.5, -9.4);
    scene.add(back);

    // the lit doorway the camera aims at
    const doorLight = new three.Mesh(new three.PlaneGeometry(2.4, 3.6),
      new three.MeshBasicMaterial({ color: 0xFFF4D8 }));
    doorLight.position.set(0, 1.8, -9.3);
    scene.add(doorLight);
    const doorFrame = new three.Mesh(new three.BoxGeometry(2.9, 4.1, 0.18), WOOD);
    doorFrame.position.set(0, 2.05, -9.42);
    scene.add(doorFrame);

    // shelving down both sides, with jars on them
    const jarGeo = new three.CylinderGeometry(0.16, 0.16, 0.36, 12);
    const boxGeo = new three.BoxGeometry(0.42, 0.34, 0.42);
    for (let row = 0; row < 2; row++) {
      const x = row ? 3.1 : -3.1;
      for (let i = 0; i < 7; i++) {
        const z = 10.5 - i * 3.0;
        const frame = new three.Mesh(new three.BoxGeometry(1.5, 3.4, 0.16), WOOD);
        frame.position.set(x, 1.7, z - 1.3); frame.rotation.y = Math.PI / 2;
        scene.add(frame);
        for (let s = 0; s < 3; s++) {
          const shelf = new three.Mesh(new three.BoxGeometry(1.5, 0.09, 2.4), WOOD2);
          shelf.position.set(x, 0.75 + s * 1.05, z);
          scene.add(shelf);
          // Deterministic placement: index arithmetic, never Math.random —
          // the scene has to look the same on every visit and every export.
          const n = (i * 3 + s + row * 5) % 4 + 1;
          for (let k = 0; k < n; k++) {
            const useJar = ((i + s + k + row) % 3) !== 0;
            const m = new three.Mesh(useJar ? jarGeo : boxGeo, useJar ? GLASS : CRATE);
            m.position.set(x + ((k % 2) ? 0.22 : -0.22),
                           0.75 + s * 1.05 + (useJar ? 0.23 : 0.22),
                           z - 0.9 + k * 0.52);
            scene.add(m);
          }
        }
      }
    }

    // a few crates in the aisle so the parallax of the flight is readable
    for (const [cx, cz, cs] of [[-1.5, 6.2, 0.9], [1.7, 2.4, 1.1], [-1.2, -2.6, 0.8]]) {
      const c = new three.Mesh(new three.BoxGeometry(cs, cs * 0.8, cs), CRATE);
      c.position.set(cx, cs * 0.4, cz);
      c.rotation.y = cx * 0.4;
      scene.add(c);
    }

    scene.add(new three.AmbientLight(0xF3E6CE, 1.5));
    const key = new three.DirectionalLight(0xFFF0D0, 1.9);
    key.position.set(2.5, 6, 4);
    scene.add(key);
    const door = new three.PointLight(0xFFE9B8, 26, 26, 2);
    door.position.set(0, 2.1, -8.4);
    scene.add(door);
    scene.userData.doorLamp = door;
  },

  // Pure in t: the doorway brightens as the camera closes on it.
  update(t, { scene }) {
    const lamp = scene.userData.doorLamp;
    if (lamp) lamp.intensity = 16 + 22 * t * t;
  },
});

if (typeof window !== 'undefined') {
  window.halleSzene = halleSzene;
  window.HALLE_SEGMENT = {
    kind: 'szene', id: 'halle', label: 'Das Lager',
    scroll: 1.6, linger: 0.35,
    render: halleSzene,
    accent: '#8C6A4A',
    eyebrow: 'Und dahinter',
    title: 'Im Lager.',
    body: 'Dieses Segment ist echtes 3D. Die Kamera folgt einer Spline, es gibt keine Naht zu bauen, und der Treiber kopiert den WebGL-Frame einmal je Bild in das Canvas der Engine.',
    tags: ['Treiber: three', 'Spline-Kamera', 'keine Naht'],
  };
}
