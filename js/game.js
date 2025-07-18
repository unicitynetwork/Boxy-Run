
/**
 *
 * BOXY RUN
 * ----
 * Simple Temple-Run-esque game, created with love by Wan Fung Chui.
 *
 */

/**
 * Constants used in this game.
 */
var Colors = {
	cherry: 0xe35d6a,
	blue: 0x1560bd,
	white: 0xd8d0d1,
	black: 0x000000,
	brown: 0x59332e,
	peach: 0xffdab9,
	yellow: 0xffff00,
	olive: 0x556b2f,
	grey: 0x696969,
	sand: 0xc2b280,
	brownDark: 0x23190f,
	green: 0x669900,
};

var deg2Rad = Math.PI / 180;

// Make a new world when the page is loaded.
window.addEventListener('load', function(){
	PlayerData.init();
	new World();
});

/** 
 *
 * THE WORLD
 * 
 * The world in which Boxy Run takes place.
 *
 */

/** 
  * A class of which the world is an instance. Initializes the game
  * and contains the main game loop.
  *
  */
function World() {

	// Explicit binding of this even in changing contexts.
	var self = this;

	// Scoped variables in this world.
	var element, scene, camera, character, renderer, light,
		objects, paused, keysAllowed, score, difficulty,
		treePresenceProb, maxTreeSize, fogDistance, gameOver,
		coins, coinCount, gameStartTime, gameplayEvents, lastTreeRowZ;

	// Initialize the world.
	init();
	
	/**
	  * Builds the renderer, scene, lights, camera, and the character,
	  * then begins the rendering loop.
	  */
	function init() {

		// Locate where the world is to be located on the screen.
		element = document.getElementById('world');

		// Initialize the renderer.
		renderer = new THREE.WebGLRenderer({
			alpha: true,
			antialias: true
		});
		renderer.setSize(element.clientWidth, element.clientHeight);
		renderer.shadowMap.enabled = true;
		element.appendChild(renderer.domElement);

		// Initialize the scene.
		scene = new THREE.Scene();
		fogDistance = 40000;
		scene.fog = new THREE.Fog(0xbadbe4, 1, fogDistance);

		// Initialize the camera with field of view, aspect ratio,
		// near plane, and far plane.
		camera = new THREE.PerspectiveCamera(
			60, element.clientWidth / element.clientHeight, 1, 120000);
		camera.position.set(0, 1500, -2000);
		camera.lookAt(new THREE.Vector3(0, 600, -5000));
		window.camera = camera;

		// Set up resizing capabilities.
		window.addEventListener('resize', handleWindowResize, false);

		// Initialize the lights.
		light = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
		scene.add(light);

		// Initialize the character and add it to the scene.
		character = new Character();
		scene.add(character.element);

		var ground = createBox(3000, 20, 120000, Colors.sand, 0, -400, -60000);
		scene.add(ground);

		objects = [];
		coins = [];
		coinCount = 0;
		treePresenceProb = 0.2;
		maxTreeSize = 0.5;
		for (var i = 10; i < 40; i++) {
			createRowOfTrees(i * -3000, treePresenceProb, 0.5, maxTreeSize);
			if (i % 2 === 0) { // Only create coins every other row
				createCoins(i * -3000 + 1500, 0.3);
			}
		}

		// The game is paused to begin with and the game is not over.
		gameOver = false;
		paused = true;
		gameplayEvents = [];
		lastTreeRowZ = -120000; // Track last tree row position
		gameStartTime = null; // Reset game start time

		// Start receiving feedback from the player.
		var left = 37;
		var up = 38;
		var right = 39;
		var p = 80;
		
		keysAllowed = {};
		document.addEventListener(
			'keydown',
			function(e) {
				if (!gameOver) {
					var key = e.keyCode;
					if (keysAllowed[key] === false) return;
					keysAllowed[key] = false;
					if (paused && !collisionsDetected() && key > 18) {
						paused = false;
						character.onUnpause();
						document.getElementById(
							"variable-content").style.visibility = "hidden";
						document.getElementById(
							"controls").style.display = "none";
						// Start game timer
						gameStartTime = Date.now();
					} else {
						if (key == p) {
							paused = true;
							character.onPause();
							document.getElementById(
								"variable-content").style.visibility = "visible";
							document.getElementById(
								"variable-content").innerHTML = 
								"Game is paused. Press any key to resume.";
						}
						if (key == up && !paused) {
							character.onUpKeyPressed();
							if (gameStartTime && gameplayEvents.length < 1000) { // Limit array size
								gameplayEvents.push({t: Date.now() - gameStartTime, e: 'jump'});
							}
						}
						if (key == left && !paused) {
							character.onLeftKeyPressed();
							if (gameStartTime && gameplayEvents.length < 1000) { // Limit array size
								gameplayEvents.push({t: Date.now() - gameStartTime, e: 'left'});
							}
						}
						if (key == right && !paused) {
							character.onRightKeyPressed();
							if (gameStartTime && gameplayEvents.length < 1000) { // Limit array size
								gameplayEvents.push({t: Date.now() - gameStartTime, e: 'right'});
							}
						}
					}
				}
			}
		);
		document.addEventListener(
			'keyup',
			function(e) {
				keysAllowed[e.keyCode] = true;
			}
		);
		document.addEventListener(
			'focus',
			function(e) {
				keysAllowed = {};
			}
		);

		// Initialize the scores and difficulty.
		score = 0;
		difficulty = 0;
		document.getElementById("score").innerHTML = score;
		document.getElementById("coins").innerHTML = coinCount;

		// Begin the rendering loop.
		loop();

	}
	
	/**
	  * The main animation loop.
	  */
	function loop() {

		// Update the game.
		if (!paused) {

			// Add more trees and increase the difficulty.
			// Check if we need to spawn a new row (when last row has moved 3000 units)
			var shouldSpawnNewRow = false;
			if (objects.length === 0) {
				// No trees left, spawn immediately
				shouldSpawnNewRow = true;
			} else {
				// Check if the last tree has moved far enough
				var lastTreeZ = objects[objects.length - 1].mesh.position.z;
				if (lastTreeZ > lastTreeRowZ + 3000) {
					shouldSpawnNewRow = true;
				}
			}
			
			if (shouldSpawnNewRow) {
				difficulty += 1;
				var levelLength = 30;
				if (difficulty % levelLength == 0) {
					var level = difficulty / levelLength;
					switch (level) {
						case 1:
							treePresenceProb = 0.35;
							maxTreeSize = 0.5;
							break;
						case 2:
							treePresenceProb = 0.35;
							maxTreeSize = 0.85;
							break;
						case 3:
							treePresenceProb = 0.5;
							maxTreeSize = 0.85;
							break;
						case 4:
							treePresenceProb = 0.5;
							maxTreeSize = 1.1;
							break;
						case 5:
							treePresenceProb = 0.5;
							maxTreeSize = 1.1;
							break;
						case 6:
							treePresenceProb = 0.55;
							maxTreeSize = 1.1;
							break;
						default:
							treePresenceProb = 0.55;
							maxTreeSize = 1.25;
					}
				}
				if ((difficulty >= 5 * levelLength && difficulty < 6 * levelLength)) {
					fogDistance -= (25000 / levelLength);
				} else if (difficulty >= 8 * levelLength && difficulty < 9 * levelLength) {
					fogDistance -= (5000 / levelLength);
				}
				createRowOfTrees(-120000, treePresenceProb, 0.5, maxTreeSize);
				lastTreeRowZ = -120000; // Update last spawn position
				// Only spawn coins occasionally to reduce object count
				if (Math.random() < 0.5) {
					createCoins(-120000 + 1500, 0.2); // Reduced probability
				}
				scene.fog.far = fogDistance;
			}

			// Move the trees closer to the character.
			objects.forEach(function(object) {
				object.mesh.position.z += 100;
			});

			// Move the coins closer to the character and rotate them.
			coins.forEach(function(coin) {
				coin.mesh.position.z += 100;
				coin.mesh.rotation.y += 0.02; // Reduced rotation speed
			});

			// Remove trees that are outside of the world.
			objects = objects.filter(function(object) {
				return object.mesh.position.z < 0;
			});

			// Remove coins that are outside of the world.
			coins = coins.filter(function(coin) {
				return coin.mesh.position.z < 0;
			});

			// Make the character move according to the controls.
			character.update();

			// Check for coin collection.
			checkCoinCollection();

			// Check for collisions between the character and objects.
			if (collisionsDetected()) {
				gameOver = true;
				paused = true;
				document.addEventListener(
        			'keydown',
        			function(e) {
        				if (e.keyCode == 40)
            			document.location.reload(true);
        			}
    			);
    			var variableContent = document.getElementById("variable-content");
    			variableContent.style.visibility = "visible";
    			variableContent.innerHTML = 
    				"Game over! Press the down arrow to try again.";
    			var table = document.getElementById("ranks");
    			var rankNames = ["Typical Engineer", "Couch Potato", "Weekend Jogger", "Daily Runner",
    				"Local Prospect", "Regional Star", "National Champ", "Second Mo Farah"];
    			var rankIndex = Math.floor(score / 15000);

				// If applicable, display the next achievable rank.
				if (score < 124000) {
					var nextRankRow = table.insertRow(0);
					nextRankRow.insertCell(0).innerHTML = (rankIndex <= 5)
						? "".concat((rankIndex + 1) * 15, "k-", (rankIndex + 2) * 15, "k")
						: (rankIndex == 6)
							? "105k-124k"
							: "124k+";
					nextRankRow.insertCell(1).innerHTML = "*Score within this range to earn the next rank*";
				}

				// Display the achieved rank.
				var achievedRankRow = table.insertRow(0);
				achievedRankRow.insertCell(0).innerHTML = (rankIndex <= 6)
					? "".concat(rankIndex * 15, "k-", (rankIndex + 1) * 15, "k").bold()
					: (score < 124000)
						? "105k-124k".bold()
						: "124k+".bold();
				achievedRankRow.insertCell(1).innerHTML = (rankIndex <= 6)
					? "Congrats! You're a ".concat(rankNames[rankIndex], "!").bold()
					: (score < 124000)
						? "Congrats! You're a ".concat(rankNames[7], "!").bold()
						: "Congrats! You exceeded the creator's high score of 123790 and beat the game!".bold();

    			// Display all ranks lower than the achieved rank.
    			if (score >= 120000) {
    				rankIndex = 7;
    			}
    			for (var i = 0; i < rankIndex; i++) {
    				var row = table.insertRow(i);
    				row.insertCell(0).innerHTML = "".concat(i * 15, "k-", (i + 1) * 15, "k");
    				row.insertCell(1).innerHTML = rankNames[i];
    			}
    			if (score > 124000) {
    				var row = table.insertRow(7);
    				row.insertCell(0).innerHTML = "105k-124k";
    				row.insertCell(1).innerHTML = rankNames[7];
    			}

    			// Submit score (will prompt for nickname only if first time)
    			showNicknameInput(score, coinCount, gameplayEvents, gameStartTime);

			}

			// Update the scores.
			score += 10;
			document.getElementById("score").innerHTML = score;

		}

		// Render the page and repeat.
		renderer.render(scene, camera);
		requestAnimationFrame(loop);
	}

	/**
	  * A method called when window is resized.
	  */
	function handleWindowResize() {
		renderer.setSize(element.clientWidth, element.clientHeight);
		camera.aspect = element.clientWidth / element.clientHeight;
		camera.updateProjectionMatrix();
	}

	/**
	 * Creates and returns a row of trees according to the specifications.
	 *
	 * @param {number} POSITION The z-position of the row of trees.
 	 * @param {number} PROBABILITY The probability that a given lane in the row
 	 *                             has a tree.
 	 * @param {number} MINSCALE The minimum size of the trees. The trees have a 
 	 *							uniformly distributed size from minScale to maxScale.
 	 * @param {number} MAXSCALE The maximum size of the trees.
 	 *
	 */
	function createRowOfTrees(position, probability, minScale, maxScale) {
		for (var lane = -1; lane < 2; lane++) {
			var randomNumber = Math.random();
			if (randomNumber < probability) {
				var scale = minScale + (maxScale - minScale) * Math.random();
				var tree = new Tree(lane * 800, -400, position, scale);
				objects.push(tree);
				scene.add(tree.mesh);
			}
		}
	}

	/**
	 * Creates coins at the specified position with given probability.
	 *
	 * @param {number} POSITION The z-position of the coins.
	 * @param {number} PROBABILITY The probability that a coin spawns in a lane.
	 */
	function createCoins(position, probability) {
		for (var lane = -1; lane < 2; lane++) {
			var randomNumber = Math.random();
			if (randomNumber < probability) {
				var coin = new Coin(lane * 800, 200, position);
				coins.push(coin);
				scene.add(coin.mesh);
			}
		}
	}

	/**
	 * Returns true if and only if the character is currently colliding with
	 * an object on the map.
	 */
 	function collisionsDetected() {
 		var charMinX = character.element.position.x - 115;
 		var charMaxX = character.element.position.x + 115;
 		var charMinY = character.element.position.y - 310;
 		var charMaxY = character.element.position.y + 320;
 		var charMinZ = character.element.position.z - 40;
 		var charMaxZ = character.element.position.z + 40;
 		for (var i = 0; i < objects.length; i++) {
 			if (objects[i].collides(charMinX, charMaxX, charMinY, 
 					charMaxY, charMinZ, charMaxZ)) {
 				return true;
 			}
 		}
 		return false;
 	}

	/**
	 * Checks for coin collection and removes collected coins.
	 */
	function checkCoinCollection() {
		var charMinX = character.element.position.x - 115;
		var charMaxX = character.element.position.x + 115;
		var charMinY = character.element.position.y - 310;
		var charMaxY = character.element.position.y + 320;
		var charMinZ = character.element.position.z - 40;
		var charMaxZ = character.element.position.z + 40;
		for (var i = 0; i < coins.length; i++) {
			if (coins[i].collides(charMinX, charMaxX, charMinY,
					charMaxY, charMinZ, charMaxZ)) {
				coins[i].collected = true;
				scene.remove(coins[i].mesh);
				coinCount++;
				document.getElementById("coins").innerHTML = coinCount;
				// Track coin collection event (limit array size)
				if (gameplayEvents.length < 1000) {
					gameplayEvents.push({t: Date.now() - gameStartTime, e: 'coin'});
				}
			}
		}
	}
	
}

/** 
 *
 * IMPORTANT OBJECTS
 * 
 * The character and environmental objects in the game.
 *
 */

/**
 * The player's character in the game.
 */
function Character() {

	// Explicit binding of this even in changing contexts.
	var self = this;

	// Character defaults that don't change throughout the game.
	this.skinColor = Colors.brown;
	this.hairColor = Colors.black;
	this.shirtColor = Colors.yellow;
	this.shortsColor = Colors.olive;
	this.jumpDuration = 0.6;
	this.jumpHeight = 2000;

	// Initialize the character.
	init();

	/**
	  * Builds the character in depth-first order. The parts of are 
  	  * modelled by the following object hierarchy:
	  *
	  * - character (this.element)
	  *    - head
	  *       - face
	  *       - hair
	  *    - torso
	  *    - leftArm
	  *       - leftLowerArm
	  *    - rightArm
	  *       - rightLowerArm
	  *    - leftLeg
	  *       - rightLowerLeg
	  *    - rightLeg
	  *       - rightLowerLeg
	  *
	  * Also set up the starting values for evolving parameters throughout
	  * the game.
	  * 
	  */
	function init() {

		// Build the character.
		self.face = createBox(100, 100, 60, self.skinColor, 0, 0, 0);
		self.hair = createBox(105, 20, 65, self.hairColor, 0, 50, 0);
		self.head = createGroup(0, 260, -25);
		self.head.add(self.face);
		self.head.add(self.hair);

		self.torso = createBox(150, 190, 40, self.shirtColor, 0, 100, 0);

		self.leftLowerArm = createLimb(20, 120, 30, self.skinColor, 0, -170, 0);
		self.leftArm = createLimb(30, 140, 40, self.skinColor, -100, 190, -10);
		self.leftArm.add(self.leftLowerArm);

		self.rightLowerArm = createLimb(
			20, 120, 30, self.skinColor, 0, -170, 0);
		self.rightArm = createLimb(30, 140, 40, self.skinColor, 100, 190, -10);
		self.rightArm.add(self.rightLowerArm);

		self.leftLowerLeg = createLimb(40, 200, 40, self.skinColor, 0, -200, 0);
		self.leftLeg = createLimb(50, 170, 50, self.shortsColor, -50, -10, 30);
		self.leftLeg.add(self.leftLowerLeg);

		self.rightLowerLeg = createLimb(
			40, 200, 40, self.skinColor, 0, -200, 0);
		self.rightLeg = createLimb(50, 170, 50, self.shortsColor, 50, -10, 30);
		self.rightLeg.add(self.rightLowerLeg);

		self.element = createGroup(0, 0, -4000);
		self.element.add(self.head);
		self.element.add(self.torso);
		self.element.add(self.leftArm);
		self.element.add(self.rightArm);
		self.element.add(self.leftLeg);
		self.element.add(self.rightLeg);

		// Initialize the player's changing parameters.
		self.isJumping = false;
		self.isSwitchingLeft = false;
		self.isSwitchingRight = false;
		self.currentLane = 0;
		self.runningStartTime = new Date() / 1000;
		self.pauseStartTime = new Date() / 1000;
		self.stepFreq = 2;
		self.queuedActions = [];

	}

	/**
	 * Creates and returns a limb with an axis of rotation at the top.
	 *
	 * @param {number} DX The width of the limb.
	 * @param {number} DY The length of the limb.
	 * @param {number} DZ The depth of the limb.
	 * @param {color} COLOR The color of the limb.
	 * @param {number} X The x-coordinate of the rotation center.
	 * @param {number} Y The y-coordinate of the rotation center.
	 * @param {number} Z The z-coordinate of the rotation center.
	 * @return {THREE.GROUP} A group that includes a box representing
	 *                       the limb, with the specified properties.
	 *
	 */
	function createLimb(dx, dy, dz, color, x, y, z) {
	    var limb = createGroup(x, y, z);
	    var offset = -1 * (Math.max(dx, dz) / 2 + dy / 2);
		var limbBox = createBox(dx, dy, dz, color, 0, offset, 0);
		limb.add(limbBox);
		return limb;
	}
	
	/**
	 * A method called on the character when time moves forward.
	 */
	this.update = function() {

		// Obtain the curren time for future calculations.
		var currentTime = new Date() / 1000;

		// Apply actions to the character if none are currently being
		// carried out.
		if (!self.isJumping &&
			!self.isSwitchingLeft &&
			!self.isSwitchingRight &&
			self.queuedActions.length > 0) {
			switch(self.queuedActions.shift()) {
				case "up":
					self.isJumping = true;
					self.jumpStartTime = new Date() / 1000;
					break;
				case "left":
					if (self.currentLane != -1) {
						self.isSwitchingLeft = true;
					}
					break;
				case "right":
					if (self.currentLane != 1) {
						self.isSwitchingRight = true;
					}
					break;
			}
		}

		// If the character is jumping, update the height of the character.
		// Otherwise, the character continues running.
		if (self.isJumping) {
			var jumpClock = currentTime - self.jumpStartTime;
			self.element.position.y = self.jumpHeight * Math.sin(
				(1 / self.jumpDuration) * Math.PI * jumpClock) +
				sinusoid(2 * self.stepFreq, 0, 20, 0,
					self.jumpStartTime - self.runningStartTime);
			if (jumpClock > self.jumpDuration) {
				self.isJumping = false;
				self.runningStartTime += self.jumpDuration;
			}
		} else {
			var runningClock = currentTime - self.runningStartTime;
			self.element.position.y = sinusoid(
				2 * self.stepFreq, 0, 20, 0, runningClock);
			self.head.rotation.x = sinusoid(
				2 * self.stepFreq, -10, -5, 0, runningClock) * deg2Rad;
			self.torso.rotation.x = sinusoid(
				2 * self.stepFreq, -10, -5, 180, runningClock) * deg2Rad;
			self.leftArm.rotation.x = sinusoid(
				self.stepFreq, -70, 50, 180, runningClock) * deg2Rad;
			self.rightArm.rotation.x = sinusoid(
				self.stepFreq, -70, 50, 0, runningClock) * deg2Rad;
			self.leftLowerArm.rotation.x = sinusoid(
				self.stepFreq, 70, 140, 180, runningClock) * deg2Rad;
			self.rightLowerArm.rotation.x = sinusoid(
				self.stepFreq, 70, 140, 0, runningClock) * deg2Rad;
			self.leftLeg.rotation.x = sinusoid(
				self.stepFreq, -20, 80, 0, runningClock) * deg2Rad;
			self.rightLeg.rotation.x = sinusoid(
				self.stepFreq, -20, 80, 180, runningClock) * deg2Rad;
			self.leftLowerLeg.rotation.x = sinusoid(
				self.stepFreq, -130, 5, 240, runningClock) * deg2Rad;
			self.rightLowerLeg.rotation.x = sinusoid(
				self.stepFreq, -130, 5, 60, runningClock) * deg2Rad;

			// If the character is not jumping, it may be switching lanes.
			if (self.isSwitchingLeft) {
				self.element.position.x -= 200;
				var offset = self.currentLane * 800 - self.element.position.x;
				if (offset > 800) {
					self.currentLane -= 1;
					self.element.position.x = self.currentLane * 800;
					self.isSwitchingLeft = false;
				}
			}
			if (self.isSwitchingRight) {
				self.element.position.x += 200;
				var offset = self.element.position.x - self.currentLane * 800;
				if (offset > 800) {
					self.currentLane += 1;
					self.element.position.x = self.currentLane * 800;
					self.isSwitchingRight = false;
				}
			}
		}
	}

	/**
	  * Handles character activity when the left key is pressed.
	  */
	this.onLeftKeyPressed = function() {
		self.queuedActions.push("left");
	}

	/**
	  * Handles character activity when the up key is pressed.
	  */
	this.onUpKeyPressed = function() {
		// Allow queuing one jump if not already queued
		var hasQueuedJump = self.queuedActions.indexOf("up") !== -1;
		if (!hasQueuedJump) {
			self.queuedActions.push("up");
		}
	}

	/**
	  * Handles character activity when the right key is pressed.
	  */
	this.onRightKeyPressed = function() {
		self.queuedActions.push("right");
	}

	/**
	  * Handles character activity when the game is paused.
	  */
	this.onPause = function() {
		self.pauseStartTime = new Date() / 1000;
	}

	/**
	  * Handles character activity when the game is unpaused.
	  */
	this.onUnpause = function() {
		var currentTime = new Date() / 1000;
		var pauseDuration = currentTime - self.pauseStartTime;
		self.runningStartTime += pauseDuration;
		if (self.isJumping) {
			self.jumpStartTime += pauseDuration;
		}
	}

}

/**
  * A collidable tree in the game positioned at X, Y, Z in the scene and with
  * scale S.
  */
function Tree(x, y, z, s) {

	// Explicit binding.
	var self = this;

	// The object portrayed in the scene.
	this.mesh = new THREE.Object3D();
    var top = createCylinder(1, 300, 300, 4, Colors.green, 0, 1000, 0);
    var mid = createCylinder(1, 400, 400, 4, Colors.green, 0, 800, 0);
    var bottom = createCylinder(1, 500, 500, 4, Colors.green, 0, 500, 0);
    var trunk = createCylinder(100, 100, 250, 32, Colors.brownDark, 0, 125, 0);
    this.mesh.add(top);
    this.mesh.add(mid);
    this.mesh.add(bottom);
    this.mesh.add(trunk);
    this.mesh.position.set(x, y, z);
	this.mesh.scale.set(s, s, s);
	this.scale = s;

	/**
	 * A method that detects whether this tree is colliding with the character,
	 * which is modelled as a box bounded by the given coordinate space.
	 */
    this.collides = function(minX, maxX, minY, maxY, minZ, maxZ) {
    	var treeMinX = self.mesh.position.x - this.scale * 250;
    	var treeMaxX = self.mesh.position.x + this.scale * 250;
    	var treeMinY = self.mesh.position.y;
    	var treeMaxY = self.mesh.position.y + this.scale * 1150;
    	var treeMinZ = self.mesh.position.z - this.scale * 250;
    	var treeMaxZ = self.mesh.position.z + this.scale * 250;
    	return treeMinX <= maxX && treeMaxX >= minX
    		&& treeMinY <= maxY && treeMaxY >= minY
    		&& treeMinZ <= maxZ && treeMaxZ >= minZ;
    }

}

/**
  * A collectable coin in the game positioned at X, Y, Z in the scene.
  */
function Coin(x, y, z) {

	// Explicit binding.
	var self = this;

	// The object portrayed in the scene.
	this.mesh = new THREE.Object3D();
	var coinGeometry = new THREE.CylinderGeometry(80, 80, 20, 32);
	var coinMaterial = new THREE.MeshPhongMaterial({
		color: Colors.yellow,
		flatShading: true
	});
	var coin = new THREE.Mesh(coinGeometry, coinMaterial);
	coin.rotation.z = Math.PI / 2;
	coin.castShadow = true;
	coin.receiveShadow = true;
	this.mesh.add(coin);
	this.mesh.position.set(x, y, z);
	this.collected = false;

	/**
	 * A method that detects whether this coin is colliding with the character,
	 * which is modelled as a box bounded by the given coordinate space.
	 */
    this.collides = function(minX, maxX, minY, maxY, minZ, maxZ) {
    	if (self.collected) return false;
    	var coinMinX = self.mesh.position.x - 80;
    	var coinMaxX = self.mesh.position.x + 80;
    	var coinMinY = self.mesh.position.y - 80;
    	var coinMaxY = self.mesh.position.y + 80;
    	var coinMinZ = self.mesh.position.z - 20;
    	var coinMaxZ = self.mesh.position.z + 20;
    	return coinMinX <= maxX && coinMaxX >= minX
    		&& coinMinY <= maxY && coinMaxY >= minY
    		&& coinMinZ <= maxZ && coinMaxZ >= minZ;
    }

}

/** 
 *
 * UTILITY FUNCTIONS
 * 
 * Functions that simplify and minimize repeated code.
 *
 */

/**
 * Utility function for generating current values of sinusoidally
 * varying variables.
 *
 * @param {number} FREQUENCY The number of oscillations per second.
 * @param {number} MINIMUM The minimum value of the sinusoid.
 * @param {number} MAXIMUM The maximum value of the sinusoid.
 * @param {number} PHASE The phase offset in degrees.
 * @param {number} TIME The time, in seconds, in the sinusoid's scope.
 * @return {number} The value of the sinusoid.
 *
 */
function sinusoid(frequency, minimum, maximum, phase, time) {
	var amplitude = 0.5 * (maximum - minimum);
	var angularFrequency = 2 * Math.PI * frequency;
	var phaseRadians = phase * Math.PI / 180;
	var offset = amplitude * Math.sin(
		angularFrequency * time + phaseRadians);
	var average = (minimum + maximum) / 2;
	return average + offset;
}

/**
 * Creates an empty group of objects at a specified location.
 *
 * @param {number} X The x-coordinate of the group.
 * @param {number} Y The y-coordinate of the group.
 * @param {number} Z The z-coordinate of the group.
 * @return {Three.Group} An empty group at the specified coordinates.
 *
 */
function createGroup(x, y, z) {
	var group = new THREE.Group();
	group.position.set(x, y, z);
	return group;
}

/**
 * Creates and returns a simple box with the specified properties.
 *
 * @param {number} DX The width of the box.
 * @param {number} DY The height of the box.
 * @param {number} DZ The depth of the box.
 * @param {color} COLOR The color of the box.
 * @param {number} X The x-coordinate of the center of the box.
 * @param {number} Y The y-coordinate of the center of the box.
 * @param {number} Z The z-coordinate of the center of the box.
 * @param {boolean} NOTFLATSHADING True iff the flatShading is false.
 * @return {THREE.Mesh} A box with the specified properties.
 *
 */
function createBox(dx, dy, dz, color, x, y, z, notFlatShading) {
    var geom = new THREE.BoxGeometry(dx, dy, dz);
    var mat = new THREE.MeshPhongMaterial({
		color:color, 
    	flatShading: notFlatShading != true
    });
    var box = new THREE.Mesh(geom, mat);
    box.castShadow = true;
    box.receiveShadow = true;
    box.position.set(x, y, z);
    return box;
}

/**
 * Creates and returns a (possibly asymmetrical) cyinder with the 
 * specified properties.
 *
 * @param {number} RADIUSTOP The radius of the cylinder at the top.
 * @param {number} RADIUSBOTTOM The radius of the cylinder at the bottom.
 * @param {number} HEIGHT The height of the cylinder.
 * @param {number} RADIALSEGMENTS The number of segmented faces around 
 *                                the circumference of the cylinder.
 * @param {color} COLOR The color of the cylinder.
 * @param {number} X The x-coordinate of the center of the cylinder.
 * @param {number} Y The y-coordinate of the center of the cylinder.
 * @param {number} Z The z-coordinate of the center of the cylinder.
 * @return {THREE.Mesh} A box with the specified properties.
 */
function createCylinder(radiusTop, radiusBottom, height, radialSegments, 
						color, x, y, z) {
    var geom = new THREE.CylinderGeometry(
    	radiusTop, radiusBottom, height, radialSegments);
    var mat = new THREE.MeshPhongMaterial({
    	color: color,
    	flatShading: true
    });
    var cylinder = new THREE.Mesh(geom, mat);
    cylinder.castShadow = true;
    cylinder.receiveShadow = true;
    cylinder.position.set(x, y, z);
    return cylinder;
}

/**
 * Generates a QR code for claiming NFT with collected coins
 *
 * @param {number} coins Number of coins collected
 * @param {number} score Player's final score
 */
function generateQRCode(coins, score) {
    // Build game data string with score
    var gameData = 'Score: ' + score;
    
    // Build URL - coins as amount, score in gameData
    var url = 'nfcwallet://mint-request?token=BoxyRun&amount=' + coins + '&tokenData=' + encodeURIComponent(gameData);
    
    // Clear previous QR code
    document.getElementById('qrcode').innerHTML = '';
    
    // Generate QR code
    var qrcode = new QRCode(document.getElementById('qrcode'), {
        text: url,
        width: 256,
        height: 256,
        colorDark: '#000000',
        colorLight: '#FFFFFF',
        correctLevel: QRCode.CorrectLevel.H
    });
}

/**
 * Shows nickname input and handles score submission
 */
function showNicknameInput(finalScore, finalCoins, gameplayEvents, gameStartTime) {
    // If backend is not available, skip directly to QR code
    if (!backendAvailable) {
        showQRCode(finalScore, finalCoins);
        return;
    }
    
    // Check if player already has a nickname
    var existingNickname = PlayerData.getNickname();
    if (existingNickname) {
        // Auto-submit score with existing nickname
        submitScore(existingNickname, finalScore, finalCoins, gameplayEvents, gameStartTime);
        showQRCode(finalScore, finalCoins);
        return;
    }
    
    // First time player - show nickname input
    var nicknameInput = document.getElementById('nickname-input');
    var nicknameField = document.getElementById('nickname-field');
    
    nicknameInput.style.display = 'block';
    nicknameField.value = '';
    nicknameField.focus();
    
    // Handle submit button
    document.getElementById('nickname-submit').onclick = function() {
        var nickname = nicknameField.value.trim();
        if (!nickname || !/^[a-zA-Z0-9_-]{3,20}$/.test(nickname)) {
            nickname = PlayerData.generateRandomNickname();
        }
        PlayerData.setNickname(nickname);
        submitScore(nickname, finalScore, finalCoins, gameplayEvents, gameStartTime);
        showQRCode(finalScore, finalCoins);
    };
    
    // Handle skip button
    document.getElementById('nickname-skip').onclick = function() {
        var nickname = PlayerData.getNickname() || PlayerData.generateRandomNickname();
        PlayerData.setNickname(nickname);
        submitScore(nickname, finalScore, finalCoins, gameplayEvents, gameStartTime);
        showQRCode(finalScore, finalCoins);
    };
    
    // Handle enter key
    nicknameField.onkeypress = function(e) {
        if (e.keyCode === 13) {
            document.getElementById('nickname-submit').click();
        }
    };
}

/**
 * Shows QR code after nickname submission
 */
function showQRCode(score, coins) {
    document.getElementById('nickname-input').style.display = 'none';
    generateQRCode(coins, score);
    document.getElementById('nft-coins').innerHTML = coins;
    document.getElementById('qr-container').style.display = 'block';
}

/**
 * Submits score to backend if it's a new high score
 */
function submitScore(nickname, score, coins, gameplayEvents, gameStartTime) {
    // Don't submit if backend is not available
    if (!backendAvailable) {
        return;
    }
    
    var highScore = PlayerData.getHighScore();
    
    // Update local high score if needed
    if (score > highScore.score) {
        PlayerData.setHighScore(score, coins);
    }
    
    // Always submit to backend - the backend will decide if it's a daily high score
    // Generate gameplay proof with actual events
    var gameplayHash = generateGameplayHash(score, coins, gameplayEvents || []);
    
    // Submit to backend
    fetch('https://41qd87u5g0.execute-api.me-central-1.amazonaws.com/prod/scores', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                nickname: nickname,
                score: score,
                coins: coins,
                gameplay_hash: gameplayHash,
                game_duration: gameStartTime ? Math.floor((Date.now() - gameStartTime) / 1000) : 0
            })
        })
        .then(function(response) {
            return response.json();
        })
        .then(function(data) {
            console.log('Score submitted:', data);
        })
        .catch(function(error) {
            console.error('Error submitting score:', error);
            // Don't show error to user, game continues normally
        });
}

/**
 * Generates a simple hash of gameplay to help verify legitimate play
 */
function generateGameplayHash(score, coins, events) {
    // Use provided events or empty array
    events = events || [];
    
    // Count different event types
    var eventCounts = { jump: 0, left: 0, right: 0, coin: 0 };
    for (var i = 0; i < events.length; i++) {
        var eventType = events[i].e;
        if (eventCounts[eventType] !== undefined) {
            eventCounts[eventType]++;
        }
    }
    
    // Build hash data with more gameplay information
    var hashData = [
        score,
        coins,
        events.length,
        eventCounts.jump,
        eventCounts.left,
        eventCounts.right,
        eventCounts.coin
    ].join('-');
    
    // Add timing data from first and last events
    if (events.length > 0) {
        var firstEvent = events[0];
        var lastEvent = events[events.length - 1];
        hashData += '-' + Math.floor(firstEvent.t / 1000) + '-' + Math.floor(lastEvent.t / 1000);
    }
    
    // Simple hash function
    var hash = 0;
    for (var i = 0; i < hashData.length; i++) {
        var char = hashData.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    
    return Math.abs(hash).toString(16);
}

/**
 * Backend availability flag
 */
var backendAvailable = false;

/**
 * Check if backend is available
 */
function checkBackendAvailability() {
    // Try to ping the backend
    fetch('https://41qd87u5g0.execute-api.me-central-1.amazonaws.com/prod/leaderboard/daily?limit=1', {
        method: 'GET'
    })
    .then(function(response) {
        if (response.ok) {
            backendAvailable = true;
            console.log('Backend is available');
            showScoreFeatures();
        } else {
            hideScoreFeatures();
        }
    })
    .catch(function(error) {
        console.log('Backend not available, hiding score features');
        hideScoreFeatures();
    });
}

/**
 * Show score-related UI elements when backend is available
 */
function showScoreFeatures() {
    // Show player info section
    var playerInfo = document.querySelector('.player-info');
    if (playerInfo) {
        playerInfo.style.display = 'block';
    }
    
    // Show leaderboard
    var leaderboard = document.getElementById('leaderboard');
    if (leaderboard) {
        leaderboard.style.display = 'block';
        fetchAndDisplayLeaderboard();
        // Refresh leaderboard every 30 seconds
        setInterval(fetchAndDisplayLeaderboard, 30000);
    }
    
    // Initialize player data
    var nickname = PlayerData.getNickname();
    if (!nickname) {
        nickname = PlayerData.generateRandomNickname();
        PlayerData.setNickname(nickname);
    } else {
        var nicknameElement = document.getElementById('current-nickname');
        if (nicknameElement) {
            nicknameElement.textContent = nickname;
        }
    }
    
    // Setup nickname change button
    var changeButton = document.getElementById('change-nickname');
    if (changeButton) {
        changeButton.addEventListener('click', function() {
            var newNickname = prompt('Enter new nickname (3-20 characters, alphanumeric only):', PlayerData.getNickname());
            if (newNickname && /^[a-zA-Z0-9_-]{3,20}$/.test(newNickname)) {
                PlayerData.setNickname(newNickname);
            } else if (newNickname) {
                alert('Invalid nickname. Please use 3-20 alphanumeric characters.');
            }
        });
    }
}

/**
 * Hide all score-related UI elements
 */
function hideScoreFeatures() {
    backendAvailable = false;
    
    // Hide player info section
    var playerInfo = document.querySelector('.player-info');
    if (playerInfo) {
        playerInfo.style.display = 'none';
    }
    
    // Hide leaderboard
    var leaderboard = document.getElementById('leaderboard');
    if (leaderboard) {
        leaderboard.style.display = 'none';
    }
    
    // Hide nickname input (will be handled in game over)
    var nicknameInput = document.getElementById('nickname-input');
    if (nicknameInput) {
        nicknameInput.style.display = 'none';
    }
}

/**
 * Player data management functions
 */
var PlayerData = {
    getNickname: function() {
        return localStorage.getItem('boxyrun_nickname') || null;
    },
    
    setNickname: function(nickname) {
        localStorage.setItem('boxyrun_nickname', nickname);
        var nicknameElement = document.getElementById('current-nickname');
        if (nicknameElement) {
            nicknameElement.textContent = nickname;
        }
    },
    
    generateRandomNickname: function() {
        return 'Player-' + Date.now();
    },
    
    getHighScore: function() {
        var data = localStorage.getItem('boxyrun_highscore');
        return data ? JSON.parse(data) : { score: 0, coins: 0, timestamp: null };
    },
    
    setHighScore: function(score, coins) {
        var data = {
            score: score,
            coins: coins,
            timestamp: new Date().toISOString()
        };
        localStorage.setItem('boxyrun_highscore', JSON.stringify(data));
    },
    
    init: function() {
        // Check backend availability
        checkBackendAvailability();
    }
};

/**
 * Fetch and display the daily leaderboard
 */
function fetchAndDisplayLeaderboard() {
    if (!backendAvailable) return;
    
    fetch('https://41qd87u5g0.execute-api.me-central-1.amazonaws.com/prod/leaderboard/daily?limit=10', {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(function(response) {
        if (!response.ok) {
            throw new Error('Failed to fetch leaderboard');
        }
        return response.json();
    })
    .then(function(data) {
        displayLeaderboard(data);
    })
    .catch(function(error) {
        console.error('Error fetching leaderboard:', error);
        var tbody = document.getElementById('leaderboard-body');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="4">Failed to load leaderboard</td></tr>';
        }
    });
}

/**
 * Display leaderboard data in the table
 */
function displayLeaderboard(data) {
    var tbody = document.getElementById('leaderboard-body');
    if (!tbody) return;
    
    // Clear existing rows
    tbody.innerHTML = '';
    
    if (!data.leaderboard || data.leaderboard.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4">No scores yet today!</td></tr>';
        return;
    }
    
    // Add leaderboard entries
    data.leaderboard.forEach(function(entry) {
        var row = tbody.insertRow();
        
        // Rank
        var rankCell = row.insertCell(0);
        rankCell.textContent = entry.rank;
        
        // Player name
        var nameCell = row.insertCell(1);
        nameCell.textContent = entry.nickname;
        
        // Score
        var scoreCell = row.insertCell(2);
        scoreCell.textContent = entry.score.toLocaleString();
        
        // Coins
        var coinsCell = row.insertCell(3);
        coinsCell.textContent = entry.coins;
        
        // Highlight current player
        if (entry.nickname === PlayerData.getNickname()) {
            row.style.backgroundColor = '#e3f2fd';
            row.style.fontWeight = 'bold';
        }
    });
    
    // Update reset time if available
    if (data.reset_time) {
        var resetTime = new Date(data.reset_time);
        var now = new Date();
        var hoursUntilReset = Math.floor((resetTime - now) / (1000 * 60 * 60));
        console.log('Leaderboard resets in', hoursUntilReset, 'hours');
    }
}
