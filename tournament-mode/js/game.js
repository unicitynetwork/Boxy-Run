"use strict";
(() => {
  // src/render/colors.ts
  var Colors = {
    cherry: 14900586,
    blue: 1401021,
    white: 14209233,
    black: 0,
    brown: 5845806,
    peach: 16767673,
    yellow: 16776960,
    olive: 5597999,
    grey: 6908265,
    sand: 12759680,
    brownDark: 2300175,
    green: 6723840
  };

  // src/render/scene.ts
  function createScene() {
    const element = document.getElementById("world");
    if (!element) {
      throw new Error("createScene: #world element not found in DOM");
    }
    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true
    });
    renderer.setSize(element.clientWidth, element.clientHeight);
    renderer.shadowMap.enabled = true;
    element.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const fog = new THREE.Fog(12245988, 1, 6e4);
    scene.fog = fog;
    const camera = new THREE.PerspectiveCamera(
      60,
      element.clientWidth / element.clientHeight,
      1,
      12e4
    );
    camera.position.set(0, 1500, -2e3);
    camera.lookAt(new THREE.Vector3(0, 600, -5e3));
    window.camera = camera;
    const light = new THREE.HemisphereLight(16777215, 16777215, 1);
    scene.add(light);
    const groundGeom = new THREE.BoxGeometry(3e3, 20, 12e4);
    const groundMat = new THREE.MeshPhongMaterial({
      color: Colors.sand,
      flatShading: true
    });
    const ground = new THREE.Mesh(groundGeom, groundMat);
    ground.position.set(0, -400, -6e4);
    ground.castShadow = true;
    ground.receiveShadow = true;
    scene.add(ground);
    window.addEventListener(
      "resize",
      () => {
        renderer.setSize(element.clientWidth, element.clientHeight);
        camera.aspect = element.clientWidth / element.clientHeight;
        camera.updateProjectionMatrix();
      },
      false
    );
    return { element, renderer, scene, camera, fog };
  }
  function renderFrame(handle) {
    handle.renderer.render(handle.scene, handle.camera);
  }
  function syncFog(handle, fogDistance) {
    handle.fog.far = fogDistance;
  }

  // src/sim/math.ts
  function sinusoid(frequency, minimum, maximum, phase, time) {
    const amplitude = 0.5 * (maximum - minimum);
    const angularFrequency = 2 * Math.PI * frequency;
    const phaseRadians = phase * Math.PI / 180;
    const offset = amplitude * Math.sin(angularFrequency * time + phaseRadians);
    const average = (minimum + maximum) / 2;
    return average + offset;
  }

  // src/sim/state.ts
  var TICK_HZ = 60;
  var TICK_SECONDS = 1 / TICK_HZ;
  var DEFAULT_CONFIG = {
    moveSpeed: 1e4,
    spawnDistance: 4500,
    // Matches the original `Math.floor(600 * (moveSpeed / 6000) / TICK_HZ)` = 16.
    scorePerTick: Math.floor(600 * (1e4 / 6e3) / TICK_HZ),
    coinScoreBonus: 250,
    jumpDuration: 0.6,
    jumpHeight: 2e3,
    characterStepFreq: 2,
    laneWidth: 800,
    laneSwitchSpeed: 4e3
  };

  // src/render/character-mesh.ts
  var DEG_TO_RAD = Math.PI / 180;
  function createBox(dx, dy, dz, color, x, y, z) {
    const geom = new THREE.BoxGeometry(dx, dy, dz);
    const mat = new THREE.MeshPhongMaterial({ color, flatShading: true });
    const box = new THREE.Mesh(geom, mat);
    box.castShadow = true;
    box.receiveShadow = true;
    box.position.set(x, y, z);
    return box;
  }
  function createGroup(x, y, z) {
    const group = new THREE.Group();
    group.position.set(x, y, z);
    return group;
  }
  function createLimb(dx, dy, dz, color, x, y, z) {
    const limb = createGroup(x, y, z);
    const offset = -1 * (Math.max(dx, dz) / 2 + dy / 2);
    const limbBox = createBox(dx, dy, dz, color, 0, offset, 0);
    limb.add(limbBox);
    return limb;
  }
  function createCharacterMesh(scene, colorOverrides) {
    const skin = colorOverrides?.skin ?? Colors.brown;
    const hair = colorOverrides?.hair ?? Colors.black;
    const shirt = colorOverrides?.shirt ?? Colors.yellow;
    const shorts = colorOverrides?.shorts ?? Colors.olive;
    const face = createBox(100, 100, 60, skin, 0, 0, 0);
    const hairBox = createBox(105, 20, 65, hair, 0, 50, 0);
    const head = createGroup(0, 260, -25);
    head.add(face);
    head.add(hairBox);
    const torso = createBox(150, 190, 40, shirt, 0, 100, 0);
    const leftLowerArm = createLimb(20, 120, 30, skin, 0, -170, 0);
    const leftArm = createLimb(30, 140, 40, skin, -100, 190, -10);
    leftArm.add(leftLowerArm);
    const rightLowerArm = createLimb(20, 120, 30, skin, 0, -170, 0);
    const rightArm = createLimb(30, 140, 40, skin, 100, 190, -10);
    rightArm.add(rightLowerArm);
    const leftLowerLeg = createLimb(40, 200, 40, skin, 0, -200, 0);
    const leftLeg = createLimb(50, 170, 50, shorts, -50, -10, 30);
    leftLeg.add(leftLowerLeg);
    const rightLowerLeg = createLimb(40, 200, 40, skin, 0, -200, 0);
    const rightLeg = createLimb(50, 170, 50, shorts, 50, -10, 30);
    rightLeg.add(rightLowerLeg);
    const root = createGroup(0, 0, -4e3);
    root.add(head);
    root.add(torso);
    root.add(leftArm);
    root.add(rightArm);
    root.add(leftLeg);
    root.add(rightLeg);
    scene.add(root);
    return {
      root,
      head,
      torso,
      leftArm,
      rightArm,
      leftLowerArm,
      rightLowerArm,
      leftLeg,
      rightLeg,
      leftLowerLeg,
      rightLowerLeg
    };
  }
  function syncCharacterMesh(mesh, state, config) {
    const char = state.character;
    mesh.root.position.set(char.x, char.y, char.z);
    if (char.isJumping) {
      return;
    }
    const runningClock = (state.tick - char.runningStartTick) / TICK_HZ;
    const f = config.characterStepFreq;
    mesh.head.rotation.x = sinusoid(2 * f, -10, -5, 0, runningClock) * DEG_TO_RAD;
    mesh.torso.rotation.x = sinusoid(2 * f, -10, -5, 180, runningClock) * DEG_TO_RAD;
    mesh.leftArm.rotation.x = sinusoid(f, -70, 50, 180, runningClock) * DEG_TO_RAD;
    mesh.rightArm.rotation.x = sinusoid(f, -70, 50, 0, runningClock) * DEG_TO_RAD;
    mesh.leftLowerArm.rotation.x = sinusoid(f, 70, 140, 180, runningClock) * DEG_TO_RAD;
    mesh.rightLowerArm.rotation.x = sinusoid(f, 70, 140, 0, runningClock) * DEG_TO_RAD;
    mesh.leftLeg.rotation.x = sinusoid(f, -20, 80, 0, runningClock) * DEG_TO_RAD;
    mesh.rightLeg.rotation.x = sinusoid(f, -20, 80, 180, runningClock) * DEG_TO_RAD;
    mesh.leftLowerLeg.rotation.x = sinusoid(f, -130, 5, 240, runningClock) * DEG_TO_RAD;
    mesh.rightLowerLeg.rotation.x = sinusoid(f, -130, 5, 60, runningClock) * DEG_TO_RAD;
  }

  // src/render/coin-mesh.ts
  var COIN_SPIN_RATE = 1.2;
  function createCoinMeshPool(scene) {
    return { scene, meshes: /* @__PURE__ */ new Map() };
  }
  function createCoinMesh(coin) {
    const mesh = new THREE.Object3D();
    const geom = new THREE.CylinderGeometry(80, 80, 20, 32);
    const mat = new THREE.MeshPhongMaterial({
      color: Colors.yellow,
      flatShading: true
    });
    const inner = new THREE.Mesh(geom, mat);
    inner.rotation.z = Math.PI / 2;
    inner.castShadow = true;
    inner.receiveShadow = true;
    mesh.add(inner);
    mesh.position.set(coin.x, coin.y, coin.z);
    return mesh;
  }
  function syncCoinMeshes(pool, coins, tick2) {
    const live = new Set(coins);
    for (const [coin, mesh] of pool.meshes) {
      if (!live.has(coin)) {
        pool.scene.remove(mesh);
        pool.meshes.delete(coin);
      }
    }
    const spin = tick2 * COIN_SPIN_RATE * TICK_SECONDS;
    for (const coin of coins) {
      const existing = pool.meshes.get(coin);
      if (!existing) {
        const mesh = createCoinMesh(coin);
        pool.meshes.set(coin, mesh);
        pool.scene.add(mesh);
        mesh.rotation.y = spin;
      } else {
        existing.position.set(coin.x, coin.y, coin.z);
        existing.rotation.y = spin;
      }
    }
  }

  // src/render/hud.ts
  var cachedElements = null;
  function elements() {
    if (cachedElements === null) {
      cachedElements = {
        score: document.getElementById("score"),
        coins: document.getElementById("coins"),
        mobileScoreStrong: document.getElementById("mobile-score")?.querySelector("strong"),
        mobileCoinsStrong: document.getElementById("mobile-coins")?.querySelector("strong")
      };
    }
    return cachedElements;
  }
  function updateHud(state) {
    const els = elements();
    const scoreText = String(state.score);
    const coinsText = String(state.coinCount);
    if (els.score) els.score.innerHTML = scoreText;
    if (els.coins) els.coins.innerHTML = coinsText;
    if (els.mobileScoreStrong) els.mobileScoreStrong.innerHTML = scoreText;
    if (els.mobileCoinsStrong) els.mobileCoinsStrong.innerHTML = coinsText;
  }

  // src/render/skins.ts
  var SKINS = [
    {
      name: "Classic",
      colors: { skin: Colors.brown, hair: Colors.black, shirt: Colors.yellow, shorts: Colors.olive },
      preview: Colors.yellow
    },
    {
      name: "Crimson",
      colors: { skin: Colors.peach, hair: Colors.black, shirt: Colors.cherry, shorts: 1710638 },
      preview: Colors.cherry
    },
    {
      name: "Ocean",
      colors: { skin: Colors.brown, hair: Colors.black, shirt: Colors.blue, shorts: Colors.white },
      preview: Colors.blue
    },
    {
      name: "Shadow",
      colors: { skin: Colors.grey, hair: Colors.black, shirt: 1710638, shorts: 3355443 },
      preview: 1710638
    },
    {
      name: "Solar",
      colors: { skin: Colors.peach, hair: Colors.brownDark, shirt: 16347926, shorts: Colors.yellow },
      preview: 16347926
    },
    {
      name: "Forest",
      colors: { skin: Colors.brown, hair: Colors.black, shirt: Colors.green, shorts: Colors.brownDark },
      preview: Colors.green
    },
    {
      name: "Royal",
      colors: { skin: Colors.peach, hair: Colors.brownDark, shirt: 7093162, shorts: Colors.olive },
      preview: 7093162
    },
    {
      name: "Ghost",
      colors: { skin: Colors.white, hair: Colors.white, shirt: 15790320, shorts: 13421772 },
      preview: 15790320
    }
  ];
  function getSkin(name) {
    if (!name) return SKINS[0];
    const lower = name.toLowerCase();
    return SKINS.find((s) => s.name.toLowerCase() === lower) ?? SKINS[0];
  }
  function getOpponentSkin(playerSkin) {
    return playerSkin.name === "Crimson" ? SKINS[0] : SKINS[1];
  }

  // src/render/tree-mesh.ts
  function createTreeMeshPool(scene) {
    return { scene, meshes: /* @__PURE__ */ new Map() };
  }
  function createTreeMesh(tree) {
    const mesh = new THREE.Object3D();
    const top = makeCylinder(1, 300, 300, 4, Colors.green, 0, 1e3, 0);
    const mid = makeCylinder(1, 400, 400, 4, Colors.green, 0, 800, 0);
    const bottom = makeCylinder(1, 500, 500, 4, Colors.green, 0, 500, 0);
    const trunk = makeCylinder(100, 100, 250, 32, Colors.brownDark, 0, 125, 0);
    mesh.add(top);
    mesh.add(mid);
    mesh.add(bottom);
    mesh.add(trunk);
    mesh.position.set(tree.x, tree.y, tree.z);
    mesh.scale.set(tree.scale, tree.scale, tree.scale);
    return mesh;
  }
  function makeCylinder(radiusTop, radiusBottom, height, radialSegments, color, x, y, z) {
    const geom = new THREE.CylinderGeometry(
      radiusTop,
      radiusBottom,
      height,
      radialSegments
    );
    const mat = new THREE.MeshPhongMaterial({ color, flatShading: true });
    const cyl = new THREE.Mesh(geom, mat);
    cyl.castShadow = true;
    cyl.receiveShadow = true;
    cyl.position.set(x, y, z);
    return cyl;
  }
  function syncTreeMeshes(pool, trees) {
    const live = new Set(trees);
    for (const [tree, mesh] of pool.meshes) {
      if (!live.has(tree)) {
        pool.scene.remove(mesh);
        pool.meshes.delete(tree);
      }
    }
    for (const tree of trees) {
      const existing = pool.meshes.get(tree);
      if (!existing) {
        const mesh = createTreeMesh(tree);
        pool.meshes.set(tree, mesh);
        pool.scene.add(mesh);
      } else {
        existing.position.set(tree.x, tree.y, tree.z);
      }
    }
  }

  // src/render/sync.ts
  function createRenderState(scene, playerSkin = SKINS[0]) {
    return {
      character: createCharacterMesh(scene.scene, playerSkin.colors),
      trees: createTreeMeshPool(scene.scene),
      coins: createCoinMeshPool(scene.scene),
      opponent: null,
      playerSkin
    };
  }
  function addOpponentMesh(render, scene) {
    if (render.opponent) return;
    const oppSkin = getOpponentSkin(render.playerSkin);
    render.opponent = createCharacterMesh(scene.scene, oppSkin.colors);
  }
  function removeOpponentMesh(render, scene) {
    if (!render.opponent) return;
    scene.scene.remove(render.opponent.root);
    render.opponent = null;
  }
  function syncRender(state, render, scene, config) {
    syncCharacterMesh(render.character, state, config);
    syncTreeMeshes(render.trees, state.trees);
    syncCoinMeshes(render.coins, state.coins, state.tick);
    syncFog(scene, state.fogDistance);
    updateHud(state);
  }
  function syncOpponent(opponentState, render, config) {
    if (!render.opponent) return;
    syncCharacterMesh(render.opponent, opponentState, config);
  }

  // src/sim/rng.ts
  function seedRng(target, seed) {
    target.rngState = seed >>> 0;
  }
  function rngNext(target) {
    target.rngState = target.rngState + 1831565813 >>> 0;
    let t = target.rngState;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }

  // src/sim/spawn.ts
  var TREE_Y = -400;
  var COIN_Y = 200;
  function spawnTreeRow(state, config, z, probability, minScale, maxScale) {
    for (let lane = -1; lane <= 1; lane++) {
      if (rngNext(state) < probability) {
        const scale = minScale + (maxScale - minScale) * rngNext(state);
        state.trees.push({
          x: lane * config.laneWidth,
          y: TREE_Y,
          z,
          scale
        });
      }
    }
  }
  function spawnCoinRow(state, config, z, probability) {
    for (let lane = -1; lane <= 1; lane++) {
      if (rngNext(state) < probability) {
        state.coins.push({
          x: lane * config.laneWidth,
          y: COIN_Y,
          z,
          collected: false
        });
      }
    }
  }

  // src/sim/init.ts
  var CHARACTER_Z = -4e3;
  var INITIAL_TREE_PROB = 0.2;
  var INITIAL_MAX_TREE_SIZE = 0.5;
  var INITIAL_FOG_DISTANCE = 6e4;
  function makeInitialState(seed, config = DEFAULT_CONFIG) {
    const state = {
      seed: seed >>> 0,
      rngState: 0,
      // seeded below by seedRng
      tick: 0,
      score: 0,
      coinCount: 0,
      gameOver: false,
      difficulty: 0,
      treePresenceProb: INITIAL_TREE_PROB,
      maxTreeSize: INITIAL_MAX_TREE_SIZE,
      fogDistance: INITIAL_FOG_DISTANCE,
      lastTreeRowZ: -12e4,
      trees: [],
      coins: [],
      character: {
        x: 0,
        y: 0,
        z: CHARACTER_Z,
        isJumping: false,
        isSwitchingLeft: false,
        isSwitchingRight: false,
        currentLane: 0,
        runningStartTick: 0,
        jumpStartTick: 0,
        queuedActions: []
      }
    };
    seedRng(state, state.seed);
    for (let i = 10; i < 40; i++) {
      spawnTreeRow(
        state,
        config,
        i * -3e3,
        state.treePresenceProb,
        0.5,
        state.maxTreeSize
      );
      if (i % 2 === 0) {
        spawnCoinRow(state, config, i * -3e3 + 1500, 0.3);
      }
    }
    return state;
  }

  // src/sim/character.ts
  function updateCharacter(state, config) {
    const char = state.character;
    const currentTick = state.tick;
    const currentTime = currentTick / TICK_HZ;
    if (!char.isJumping && !char.isSwitchingLeft && !char.isSwitchingRight && char.queuedActions.length > 0) {
      const action = char.queuedActions.shift();
      switch (action) {
        case "up":
          char.isJumping = true;
          char.jumpStartTick = currentTick;
          break;
        case "left":
          if (char.currentLane !== -1) {
            char.isSwitchingLeft = true;
          }
          break;
        case "right":
          if (char.currentLane !== 1) {
            char.isSwitchingRight = true;
          }
          break;
      }
    }
    if (char.isJumping) {
      const jumpStartSec = char.jumpStartTick / TICK_HZ;
      const runningStartSec = char.runningStartTick / TICK_HZ;
      const jumpClock = currentTime - jumpStartSec;
      char.y = config.jumpHeight * Math.sin(1 / config.jumpDuration * Math.PI * jumpClock) + sinusoid(
        2 * config.characterStepFreq,
        0,
        20,
        0,
        jumpStartSec - runningStartSec
      );
      if (jumpClock > config.jumpDuration) {
        char.isJumping = false;
        char.runningStartTick += Math.round(config.jumpDuration * TICK_HZ);
      }
    } else {
      const runningClock = currentTime - char.runningStartTick / TICK_HZ;
      char.y = sinusoid(2 * config.characterStepFreq, 0, 20, 0, runningClock);
      const laneSwitchPerTick = config.laneSwitchSpeed * TICK_SECONDS;
      if (char.isSwitchingLeft) {
        char.x -= laneSwitchPerTick;
        const targetX = (char.currentLane - 1) * config.laneWidth;
        if (char.x <= targetX) {
          char.currentLane = char.currentLane - 1;
          char.x = char.currentLane * config.laneWidth;
          char.isSwitchingLeft = false;
        }
      }
      if (char.isSwitchingRight) {
        char.x += laneSwitchPerTick;
        const targetX = (char.currentLane + 1) * config.laneWidth;
        if (char.x >= targetX) {
          char.currentLane = char.currentLane + 1;
          char.x = char.currentLane * config.laneWidth;
          char.isSwitchingRight = false;
        }
      }
    }
  }

  // src/sim/collision.ts
  function characterBox(character) {
    return {
      minX: character.x - 115,
      maxX: character.x + 115,
      minY: character.y - 310,
      maxY: character.y + 320,
      minZ: character.z - 40,
      maxZ: character.z + 40
    };
  }
  function treeBox(tree) {
    const halfWidth = tree.scale * 250;
    const height = tree.scale * 1150;
    return {
      minX: tree.x - halfWidth,
      maxX: tree.x + halfWidth,
      minY: tree.y,
      maxY: tree.y + height,
      minZ: tree.z - halfWidth,
      maxZ: tree.z + halfWidth
    };
  }
  function coinBox(coin) {
    return {
      minX: coin.x - 80,
      maxX: coin.x + 80,
      minY: coin.y - 80,
      maxY: coin.y + 80,
      minZ: coin.z - 100,
      maxZ: coin.z + 100
    };
  }
  function aabbIntersect(a, b) {
    return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
  }

  // src/sim/tick.ts
  var LEVEL_LENGTH = 30;
  var NEW_ROW_SPAWN_Z = -12e4;
  var COIN_ROW_Z_OFFSET = 1500;
  function tick(state, config) {
    if (state.gameOver) return;
    let shouldSpawnNewRow = false;
    if (state.trees.length === 0) {
      shouldSpawnNewRow = true;
    } else {
      const lastTree = state.trees[state.trees.length - 1];
      if (lastTree.z > state.lastTreeRowZ + config.spawnDistance) {
        shouldSpawnNewRow = true;
      }
    }
    if (shouldSpawnNewRow) {
      state.difficulty += 1;
      if (state.difficulty % LEVEL_LENGTH === 0) {
        const level = state.difficulty / LEVEL_LENGTH;
        switch (level) {
          case 1:
            state.treePresenceProb = 0.35;
            state.maxTreeSize = 0.5;
            break;
          case 2:
            state.treePresenceProb = 0.35;
            state.maxTreeSize = 0.85;
            break;
          case 3:
            state.treePresenceProb = 0.5;
            state.maxTreeSize = 0.85;
            break;
          case 4:
            state.treePresenceProb = 0.5;
            state.maxTreeSize = 1.1;
            break;
          case 5:
            state.treePresenceProb = 0.5;
            state.maxTreeSize = 1.1;
            break;
          case 6:
            state.treePresenceProb = 0.55;
            state.maxTreeSize = 1.1;
            break;
          default:
            state.treePresenceProb = 0.55;
            state.maxTreeSize = 1.25;
        }
      }
      if (state.difficulty >= 5 * LEVEL_LENGTH && state.difficulty < 6 * LEVEL_LENGTH) {
        state.fogDistance -= 15e3 / LEVEL_LENGTH;
      } else if (state.difficulty >= 8 * LEVEL_LENGTH && state.difficulty < 9 * LEVEL_LENGTH) {
        state.fogDistance -= 3e3 / LEVEL_LENGTH;
      }
      spawnTreeRow(
        state,
        config,
        NEW_ROW_SPAWN_Z,
        state.treePresenceProb,
        0.5,
        state.maxTreeSize
      );
      state.lastTreeRowZ = NEW_ROW_SPAWN_Z;
      if (rngNext(state) < 0.5) {
        spawnCoinRow(
          state,
          config,
          NEW_ROW_SPAWN_Z + COIN_ROW_Z_OFFSET,
          0.2
        );
      }
    }
    const moveDistance = config.moveSpeed * TICK_SECONDS;
    for (const tree of state.trees) {
      tree.z += moveDistance;
    }
    for (const coin of state.coins) {
      coin.z += moveDistance;
    }
    state.trees = state.trees.filter((t) => t.z < 0);
    state.coins = state.coins.filter((c) => c.z < 0);
    updateCharacter(state, config);
    const charBox = characterBox(state.character);
    for (let i = state.coins.length - 1; i >= 0; i--) {
      const coin = state.coins[i];
      if (coin.collected) continue;
      if (aabbIntersect(charBox, coinBox(coin))) {
        coin.collected = true;
        state.coinCount += 1;
        state.score += config.coinScoreBonus;
        state.coins.splice(i, 1);
      }
    }
    for (const tree of state.trees) {
      if (aabbIntersect(charBox, treeBox(tree))) {
        state.gameOver = true;
        break;
      }
    }
    state.score += config.scorePerTick;
    state.tick += 1;
  }

  // tournament/protocol/messages.ts
  var PROTOCOL_VERSION = 0;

  // tournament/client/client.ts
  var TournamentClient = class {
    constructor(opts) {
      this.ws = null;
      this.opts = opts;
    }
    /**
     * Open the WebSocket connection. Resolves when the socket is open.
     * Rejects if the connection fails.
     */
    connect() {
      return new Promise((resolve, reject) => {
        const Ctor = this.opts.WebSocketCtor ?? WebSocket;
        const ws = new Ctor(this.opts.url);
        this.ws = ws;
        ws.onopen = () => resolve();
        ws.onerror = (e) => reject(e);
        ws.onclose = () => {
          this.ws = null;
          this.opts.onClose?.();
        };
        ws.onmessage = (e) => {
          let msg;
          try {
            msg = JSON.parse(
              typeof e.data === "string" ? e.data : e.data.toString()
            );
          } catch {
            return;
          }
          this.dispatch(msg);
        };
      });
    }
    disconnect() {
      this.ws?.close();
    }
    isConnected() {
      return this.ws !== null && this.ws.readyState === 1;
    }
    // ── Protocol actions ──────────────────────────────────────────────
    join(tournamentId, txHash = "stub", amount = "10", coinId = "stub", signature = "stub") {
      this.send({
        type: "join",
        v: PROTOCOL_VERSION,
        tournamentId,
        identity: { nametag: this.opts.nametag, pubkey: this.opts.pubkey },
        entry: { txHash, amount, coinId },
        signature
      });
    }
    ready(matchId) {
      this.send({ type: "match-ready", v: PROTOCOL_VERSION, matchId });
    }
    unready(matchId) {
      this.send({ type: "match-unready", v: PROTOCOL_VERSION, matchId });
    }
    sendInput(matchId, tick2, payload) {
      this.send({
        type: "input",
        v: PROTOCOL_VERSION,
        matchId,
        tick: tick2,
        payload
      });
    }
    submitResult(matchId, finalTick, score, winner, inputsHash, resultHash) {
      this.send({
        type: "result",
        v: PROTOCOL_VERSION,
        matchId,
        finalTick,
        score,
        winner,
        inputsHash,
        resultHash
      });
    }
    leave(reason) {
      this.send({ type: "leave", v: PROTOCOL_VERSION, reason });
    }
    // ── Internal ──────────────────────────────────────────────────────
    send(msg) {
      if (!this.ws || this.ws.readyState !== 1) {
        console.error("[tournament-client] send() called but not connected");
        return;
      }
      this.ws.send(JSON.stringify(msg));
    }
    dispatch(msg) {
      switch (msg.type) {
        case "lobby-state":
          this.opts.onLobbyState?.(msg);
          break;
        case "bracket":
          this.opts.onBracket?.(msg);
          break;
        case "round-open":
          this.opts.onRoundOpen?.(msg);
          break;
        case "opponent-ready":
          this.opts.onOpponentReady?.(msg);
          break;
        case "match-start":
          this.opts.onMatchStart?.(msg);
          break;
        case "opponent-input":
          this.opts.onOpponentInput?.(msg);
          break;
        case "match-end":
          this.opts.onMatchEnd?.(msg);
          break;
        case "tournament-end":
          this.opts.onTournamentEnd?.(msg);
          break;
        case "error":
          this.opts.onError?.(msg);
          break;
      }
    }
  };

  // src/game/main.ts
  function getWallet() {
    return window.SphereWallet ?? null;
  }
  function walletNametag() {
    return getWallet()?.identity?.nametag ?? null;
  }
  function walletCanPlay() {
    const w = getWallet();
    if (!w) return true;
    return w.isDepositPaid;
  }
  var KEY_LEFT = 37;
  var KEY_UP = 38;
  var KEY_RIGHT = 39;
  var KEY_P = 80;
  var KEY_A = 65;
  var KEY_W = 87;
  var KEY_D = 68;
  var KEY_ENTER = 13;
  window.addEventListener("load", () => {
    const params = new URLSearchParams(location.search);
    const skinParam = params.get("skin");
    const isTournament = params.get("tournament") === "1";
    if (skinParam) {
      const skin = getSkin(skinParam);
      if (isTournament) startTournamentMode(params, skin);
      else startSinglePlayer(params, skin);
      return;
    }
    showSkinSelector((skin) => {
      if (isTournament) startTournamentMode(params, skin);
      else startSinglePlayer(params, skin);
    });
  });
  function startSinglePlayer(params, skin) {
    const seedParam = params.get("seed");
    const seed = seedParam ? parseInt(seedParam, 10) >>> 0 : Math.random() * 4294967295 >>> 0;
    console.log("Boxy Run seed:", seed, "skin:", skin.name);
    const config = DEFAULT_CONFIG;
    const scene = createScene();
    const render = createRenderState(scene, skin);
    const state = makeInitialState(seed, config);
    let paused = true;
    syncRender(state, render, scene, config);
    renderFrame(scene);
    let lastFrameTime = performance.now();
    let tickAccumulator = 0;
    const keysAllowed = {};
    document.addEventListener("keydown", (e) => {
      if (state.gameOver) return;
      const key = e.keyCode;
      if (keysAllowed[key] === false) return;
      keysAllowed[key] = false;
      if (paused && key > 18) {
        if (!walletCanPlay()) return;
        paused = false;
        lastFrameTime = performance.now();
        tickAccumulator = 0;
        hideOverlay();
        getWallet()?.updateUI("playing");
        return;
      }
      if (key === KEY_P) {
        paused = !paused;
        if (!paused) lastFrameTime = performance.now();
        else showOverlay("Paused. Press any key to resume.");
        return;
      }
      if (paused) return;
      const action = keyToAction(key);
      if (action) state.character.queuedActions.push(action);
    });
    document.addEventListener("keyup", (e) => {
      keysAllowed[e.keyCode] = true;
    });
    function loop() {
      const now = performance.now();
      let delta = (now - lastFrameTime) / 1e3;
      lastFrameTime = now;
      delta = Math.min(delta, 0.1);
      if (!paused && !state.gameOver) {
        tickAccumulator += delta;
        while (tickAccumulator >= TICK_SECONDS && !state.gameOver) {
          tick(state, config);
          tickAccumulator -= TICK_SECONDS;
        }
      }
      syncRender(state, render, scene, config);
      renderFrame(scene);
      if (state.gameOver && !paused) {
        paused = true;
        const w = getWallet();
        if (w?.isConnected) {
          w.requestPayout(state.coinCount);
          w.resetDeposit();
          w.updateUI("gameover");
          showOverlay(
            `Game over! You earned <strong>${state.coinCount} ${w.coinId}</strong>`
          );
        } else {
          showOverlay(
            `Game over! Score: ${state.score}, Coins: ${state.coinCount}. Reload to try again.`
          );
        }
        const nickname = walletNametag() || "anonymous";
        submitScore(nickname, state.score, state.coinCount);
      }
      requestAnimationFrame(loop);
    }
    window.__boxyDebug = {
      get seed() {
        return state.seed;
      },
      get tick() {
        return state.tick;
      },
      get score() {
        return state.score;
      },
      get state() {
        return state;
      }
    };
    requestAnimationFrame(loop);
  }
  function startTournamentMode(params, skin) {
    const name = params.get("name") || "@player";
    const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
    const serverUrl = params.get("server") || `${wsProto}//${location.host}`;
    const tournamentId = params.get("tid") || "boxyrun-alpha-1";
    console.log(`Tournament mode: ${name} \u2192 ${serverUrl} (${tournamentId}) skin: ${skin.name}`);
    const config = DEFAULT_CONFIG;
    const scene = createScene();
    const render = createRenderState(scene, skin);
    let myState = makeInitialState(0, config);
    let opponentState = null;
    let matchId = null;
    let mySide = "A";
    let matchActive = false;
    let matchOver = false;
    let resultSubmitted = false;
    let opponentDeathNotified = false;
    let myDeathNotified = false;
    let lastFrameTime = performance.now();
    let tickAccumulator = 0;
    const keysAllowed = {};
    showOverlay(`Connecting to ${serverUrl}...`);
    const client = new TournamentClient({
      url: serverUrl,
      nametag: name,
      pubkey: name.replace("@", "") + "00".repeat(31),
      onLobbyState: (msg) => {
        showOverlay(
          `Lobby: ${msg.players.length}/${msg.capacity} players<br>` + msg.players.map((p) => p.nametag).join(", ") + "<br><br>Waiting for more players..."
        );
      },
      onBracket: (msg) => {
        console.log("Bracket received:", msg.rounds);
      },
      onRoundOpen: (msg) => {
        matchId = msg.matchId;
        showOverlay(
          `Match ready! vs ${msg.opponent}<br>Press ENTER when ready`
        );
      },
      onOpponentReady: (msg) => {
        if (msg.ready) {
          showOverlay(
            `Opponent is ready! Press ENTER to start`
          );
        }
      },
      onMatchStart: (msg) => {
        console.log("Match start!", msg);
        matchId = msg.matchId;
        mySide = msg.youAre;
        const seed = parseInt(msg.seed, 16) >>> 0;
        myState = makeInitialState(seed, config);
        opponentState = makeInitialState(seed, config);
        matchActive = true;
        matchOver = false;
        resultSubmitted = false;
        opponentDeathNotified = false;
        myDeathNotified = false;
        lastFrameTime = performance.now();
        tickAccumulator = 0;
        removeOpponentMesh(render, scene);
        addOpponentMesh(render, scene);
        hideOverlay();
      },
      onOpponentInput: (msg) => {
        if (!opponentState) return;
        try {
          const action = atob(msg.payload);
          if (action === "up" || action === "left" || action === "right") {
            opponentState.character.queuedActions.push(action);
          }
        } catch {
        }
      },
      onMatchEnd: (msg) => {
        console.log("Match end:", msg);
        removeOpponentHud();
        showOverlay(
          `Match over! Winner: ${msg.winner}<br>Reason: ${msg.reason}`
        );
      },
      onTournamentEnd: (msg) => {
        console.log("Tournament end:", msg);
        const lines = msg.standings.map((s) => `#${s.place} ${s.nametag}`).join("<br>");
        showOverlay(
          `Tournament complete!<br><br>${lines}<br><br>Reload to play again.`
        );
      },
      onError: (msg) => {
        console.error("Tournament error:", msg);
      }
    });
    client.connect().then(() => {
      console.log("Connected to tournament server");
      client.join(tournamentId);
    }).catch((err) => {
      showOverlay(`Failed to connect: ${err}`);
    });
    document.addEventListener("keydown", (e) => {
      const key = e.keyCode;
      if (keysAllowed[key] === false) return;
      keysAllowed[key] = false;
      if (key === KEY_ENTER && matchId && !matchActive) {
        client.ready(matchId);
        showOverlay("Waiting for opponent...");
        return;
      }
      if (!matchActive || matchOver) return;
      const action = keyToAction(key);
      if (action) {
        myState.character.queuedActions.push(action);
        if (matchId) {
          client.sendInput(matchId, myState.tick, btoa(action));
        }
      }
    });
    document.addEventListener("keyup", (e) => {
      keysAllowed[e.keyCode] = true;
    });
    function loop() {
      const now = performance.now();
      let delta = (now - lastFrameTime) / 1e3;
      lastFrameTime = now;
      delta = Math.min(delta, 0.1);
      if (matchActive && !matchOver) {
        tickAccumulator += delta;
        while (tickAccumulator >= TICK_SECONDS && !matchOver) {
          tick(myState, config);
          if (opponentState) tick(opponentState, config);
          if (opponentState?.gameOver && !opponentDeathNotified) {
            opponentDeathNotified = true;
            showDeathBanner(
              "OPPONENT DOWN",
              `Their final score: ${opponentState.score}. Keep running to beat it!`
            );
          }
          if (myState.gameOver && !myDeathNotified) {
            myDeathNotified = true;
            if (!opponentState?.gameOver) {
              showDeathBanner(
                "YOU DIED",
                `Your score: ${myState.score}. Watching opponent...`
              );
            }
          }
          const bothDead = myState.gameOver && (opponentState?.gameOver ?? true);
          if (bothDead && !resultSubmitted && matchId) {
            matchOver = true;
            matchActive = false;
            resultSubmitted = true;
            removeDeathBanner();
            const myScore = myState.score;
            const oppScore = opponentState?.score ?? 0;
            const oppSide = mySide === "A" ? "B" : "A";
            const winner = myScore >= oppScore ? mySide : oppSide;
            const scores = {
              A: mySide === "A" ? myScore : oppScore,
              B: mySide === "B" ? myScore : oppScore
            };
            const finalTick = Math.max(
              myState.tick,
              opponentState?.tick ?? 0
            );
            const resultHash = `${myState.seed}-${finalTick}-${scores.A}-${scores.B}-${winner}`;
            client.submitResult(
              matchId,
              finalTick,
              scores,
              winner,
              "inputs-hash-stub",
              resultHash
            );
            const status = winner === mySide ? "You win!" : "You lose!";
            showOverlay(
              `${status}<br>Your score: ${myScore} vs Opponent: ${oppScore}`
            );
            break;
          }
          tickAccumulator -= TICK_SECONDS;
        }
      }
      if (opponentState && matchActive) {
        updateOpponentHud(opponentState);
      }
      syncRender(myState, render, scene, config);
      if (opponentState) syncOpponent(opponentState, render, config);
      renderFrame(scene);
      requestAnimationFrame(loop);
    }
    window.__boxyDebug = {
      get myState() {
        return myState;
      },
      get opponentState() {
        return opponentState;
      },
      get matchId() {
        return matchId;
      },
      get mySide() {
        return mySide;
      },
      get matchActive() {
        return matchActive;
      }
    };
    syncRender(myState, render, scene, config);
    renderFrame(scene);
    requestAnimationFrame(loop);
  }
  function keyToAction(key) {
    if (key === KEY_UP || key === KEY_W) return "up";
    if (key === KEY_LEFT || key === KEY_A) return "left";
    if (key === KEY_RIGHT || key === KEY_D) return "right";
    return null;
  }
  function showOverlay(text) {
    const el = document.getElementById("variable-content");
    if (el) {
      el.style.visibility = "visible";
      el.innerHTML = text;
    }
  }
  function hideOverlay() {
    const el = document.getElementById("variable-content");
    if (el) el.style.visibility = "hidden";
    const controls = document.getElementById("controls");
    if (controls) controls.style.display = "none";
  }
  var opponentHudEl = null;
  function updateOpponentHud(oppState) {
    if (!opponentHudEl) {
      opponentHudEl = document.createElement("div");
      opponentHudEl.id = "opponent-hud";
      opponentHudEl.style.cssText = "position:fixed;top:16px;right:16px;z-index:100;background:rgba(0,0,0,0.7);color:#e35d6a;padding:10px 16px;border-radius:6px;font-family:monospace;font-size:14px;border:1px solid rgba(227,93,106,0.3);pointer-events:none;";
      document.body.appendChild(opponentHudEl);
    }
    const status = oppState.gameOver ? " [DEAD]" : "";
    opponentHudEl.innerHTML = `<span style="font-size:11px;opacity:0.6">OPPONENT</span><br>Score: ${oppState.score}${status}`;
  }
  function removeOpponentHud() {
    if (opponentHudEl) {
      opponentHudEl.remove();
      opponentHudEl = null;
    }
  }
  var deathBannerEl = null;
  function showDeathBanner(title, subtitle) {
    removeDeathBanner();
    deathBannerEl = document.createElement("div");
    deathBannerEl.style.cssText = "position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:150;background:rgba(0,0,0,0.8);color:#fff;padding:24px 40px;border-radius:8px;text-align:center;font-family:monospace;pointer-events:none;border:1px solid rgba(255,255,255,0.15);animation:fadeInBanner 0.3s ease;";
    deathBannerEl.innerHTML = `<div style="font-size:20px;font-weight:bold;margin-bottom:8px;letter-spacing:0.1em">${title}</div><div style="font-size:13px;color:#94a3b8">${subtitle}</div>`;
    if (!document.getElementById("death-banner-style")) {
      const style = document.createElement("style");
      style.id = "death-banner-style";
      style.textContent = "@keyframes fadeInBanner{from{opacity:0;transform:translate(-50%,-50%) scale(0.95)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}";
      document.head.appendChild(style);
    }
    document.body.appendChild(deathBannerEl);
    setTimeout(() => {
      if (deathBannerEl) {
        deathBannerEl.style.transition = "opacity 0.5s";
        deathBannerEl.style.opacity = "0.4";
      }
    }, 3e3);
  }
  function removeDeathBanner() {
    if (deathBannerEl) {
      deathBannerEl.remove();
      deathBannerEl = null;
    }
  }
  function submitScore(nickname, score, coins) {
    fetch("/api/scores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname, score, coins })
    }).then((r) => r.json()).then((d) => console.log("Score submitted:", d)).catch((e) => console.log("Score submission failed (API may be offline):", e));
  }
  function showSkinSelector(onSelect) {
    const overlay = document.createElement("div");
    overlay.id = "skin-selector";
    overlay.style.cssText = "position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:monospace;color:#e2e8f0;";
    const title = document.createElement("div");
    title.style.cssText = "font-size:24px;font-weight:bold;margin-bottom:8px;letter-spacing:0.1em;";
    title.textContent = "CHOOSE YOUR RUNNER";
    overlay.appendChild(title);
    const sub = document.createElement("div");
    sub.style.cssText = "font-size:13px;color:#64748b;margin-bottom:32px;";
    sub.textContent = "Each coin collected adds 250 to your score";
    overlay.appendChild(sub);
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(4,1fr);gap:16px;max-width:560px;width:90%;";
    for (const skin of SKINS) {
      const card = document.createElement("button");
      const hex = "#" + skin.preview.toString(16).padStart(6, "0");
      card.style.cssText = "background:rgba(255,255,255,0.05);border:2px solid rgba(255,255,255,0.1);border-radius:8px;padding:16px 8px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:10px;transition:all 0.2s;color:#e2e8f0;font-family:monospace;";
      const figure = document.createElement("div");
      figure.style.cssText = "width:40px;height:60px;position:relative;";
      const head = document.createElement("div");
      const skinHex = "#" + skin.colors.skin.toString(16).padStart(6, "0");
      const hairHex = "#" + skin.colors.hair.toString(16).padStart(6, "0");
      head.style.cssText = `width:20px;height:20px;background:${skinHex};border-radius:4px;margin:0 auto;position:relative;border-top:4px solid ${hairHex};`;
      figure.appendChild(head);
      const torso = document.createElement("div");
      torso.style.cssText = `width:28px;height:22px;background:${hex};border-radius:3px;margin:2px auto 0;`;
      figure.appendChild(torso);
      const shortsHex = "#" + skin.colors.shorts.toString(16).padStart(6, "0");
      const shorts = document.createElement("div");
      shorts.style.cssText = `width:28px;height:10px;background:${shortsHex};border-radius:0 0 3px 3px;margin:1px auto 0;`;
      figure.appendChild(shorts);
      const legs = document.createElement("div");
      legs.style.cssText = `width:20px;height:12px;margin:1px auto 0;display:flex;gap:4px;justify-content:center;`;
      const legL = document.createElement("div");
      legL.style.cssText = `width:6px;height:12px;background:${skinHex};border-radius:2px;`;
      const legR = legL.cloneNode(true);
      legs.appendChild(legL);
      legs.appendChild(legR);
      figure.appendChild(legs);
      card.appendChild(figure);
      const label = document.createElement("div");
      label.style.cssText = "font-size:11px;font-weight:600;letter-spacing:0.1em;";
      label.textContent = skin.name.toUpperCase();
      card.appendChild(label);
      card.addEventListener("mouseenter", () => {
        card.style.borderColor = hex;
        card.style.background = "rgba(255,255,255,0.1)";
        card.style.transform = "translateY(-2px)";
      });
      card.addEventListener("mouseleave", () => {
        card.style.borderColor = "rgba(255,255,255,0.1)";
        card.style.background = "rgba(255,255,255,0.05)";
        card.style.transform = "translateY(0)";
      });
      card.addEventListener("click", () => {
        overlay.remove();
        onSelect(skin);
      });
      grid.appendChild(card);
    }
    overlay.appendChild(grid);
    document.body.appendChild(overlay);
  }
})();
