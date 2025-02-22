/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * Set of actors that expose the Web Animations API to devtools protocol
 * clients.
 *
 * The |Animations| actor is the main entry point. It is used to discover
 * animation players on given nodes.
 * There should only be one instance per debugger server.
 *
 * The |AnimationPlayer| actor provides attributes and methods to inspect an
 * animation as well as pause/resume/seek it.
 *
 * The Web Animation spec implementation is ongoing in Gecko, and so this set
 * of actors should evolve when the implementation progresses.
 *
 * References:
 * - WebAnimation spec:
 *   http://w3c.github.io/web-animations/
 * - WebAnimation WebIDL files:
 *   /dom/webidl/Animation*.webidl
 */

const {Cu} = require("chrome");
const promise = require("promise");
const {Task} = Cu.import("resource://gre/modules/Task.jsm", {});
const protocol = require("devtools/server/protocol");
const {ActorClass, Actor, FrontClass, Front,
       Arg, method, RetVal, types} = protocol;
// Make sure the nodeActor type is know here.
const {NodeActor} = require("devtools/server/actors/inspector");
const events = require("sdk/event/core");

// Types of animations.
const ANIMATION_TYPES = {
  CSS_ANIMATION: "cssanimation",
  CSS_TRANSITION: "csstransition",
  SCRIPT_ANIMATION: "scriptanimation",
  UNKNOWN: "unknown"
};
exports.ANIMATION_TYPES = ANIMATION_TYPES;

/**
 * The AnimationPlayerActor provides information about a given animation: its
 * startTime, currentTime, current state, etc.
 *
 * Since the state of a player changes as the animation progresses it is often
 * useful to call getCurrentState at regular intervals to get the current state.
 *
 * This actor also allows playing, pausing and seeking the animation.
 */
var AnimationPlayerActor = ActorClass({
  typeName: "animationplayer",

  events: {
    "changed": {
      type: "changed",
      state: Arg(0, "json")
    }
  },

  /**
   * @param {AnimationsActor} The main AnimationsActor instance
   * @param {AnimationPlayer} The player object returned by getAnimationPlayers
   */
  initialize: function(animationsActor, player) {
    Actor.prototype.initialize.call(this, animationsActor.conn);

    this.onAnimationMutation = this.onAnimationMutation.bind(this);

    this.walker = animationsActor.walker;
    this.player = player;
    this.node = player.effect.target;

    // Listen to animation mutations on the node to alert the front when the
    // current animation changes.
    this.observer = new this.window.MutationObserver(this.onAnimationMutation);
    this.observer.observe(this.node, {animations: true});
  },

  destroy: function() {
    // Only try to disconnect the observer if it's not already dead (i.e. if the
    // container view hasn't navigated since).
    if (this.observer && !Cu.isDeadWrapper(this.observer)) {
      this.observer.disconnect();
    }
    this.player = this.node = this.observer = this.walker = null;

    Actor.prototype.destroy.call(this);
  },

  get window() {
    return this.node.ownerDocument.defaultView;
  },

  /**
   * Release the actor, when it isn't needed anymore.
   * Protocol.js uses this release method to call the destroy method.
   */
  release: method(function() {}, {release: true}),

  form: function(detail) {
    if (detail === "actorid") {
      return this.actorID;
    }

    let data = this.getCurrentState();
    data.actor = this.actorID;

    // If we know the WalkerActor, and if the animated node is known by it, then
    // return its corresponding NodeActor ID too.
    if (this.walker && this.walker.hasNode(this.node)) {
      data.animationTargetNodeActorID = this.walker.getNode(this.node).actorID;
    }

    return data;
  },

  isCssAnimation: function(player = this.player) {
    return player instanceof this.window.CSSAnimation;
  },

  isCssTransition: function(player = this.player) {
    return player instanceof this.window.CSSTransition;
  },

  isScriptAnimation: function(player = this.player) {
    return player instanceof this.window.Animation && !(
      player instanceof this.window.CSSAnimation ||
      player instanceof this.window.CSSTransition
    );
  },

  getType: function() {
    if (this.isCssAnimation()) {
      return ANIMATION_TYPES.CSS_ANIMATION;
    } else if (this.isCssTransition()) {
      return ANIMATION_TYPES.CSS_TRANSITION;
    } else if (this.isScriptAnimation()) {
      return ANIMATION_TYPES.SCRIPT_ANIMATION;
    }

    return ANIMATION_TYPES.UNKNOWN;
  },

  /**
   * Get the name of this animation. This can be either the animation.id
   * property if it was set, or the keyframe rule name or the transition
   * property.
   * @return {String}
   */
  getName: function() {
    if (this.player.id) {
      return this.player.id;
    } else if (this.isCssAnimation()) {
      return this.player.animationName;
    } else if (this.isCssTransition()) {
      return this.player.transitionProperty;
    }

    return "";
  },

  /**
   * Get the animation duration from this player, in milliseconds.
   * @return {Number}
   */
  getDuration: function() {
    return this.player.effect.getComputedTiming().duration;
  },

  /**
   * Get the animation delay from this player, in milliseconds.
   * @return {Number}
   */
  getDelay: function() {
    return this.player.effect.getComputedTiming().delay;
  },

  /**
   * Get the animation endDelay from this player, in milliseconds.
   * @return {Number}
   */
  getEndDelay: function() {
    return this.player.effect.getComputedTiming().endDelay;
  },

  /**
   * Get the animation iteration count for this player. That is, how many times
   * is the animation scheduled to run.
   * @return {Number} The number of iterations, or null if the animation repeats
   * infinitely.
   */
  getIterationCount: function() {
    let iterations = this.player.effect.getComputedTiming().iterations;
    return iterations === "Infinity" ? null : iterations;
  },

  /**
   * Get the animation iterationStart from this player, in ratio.
   * That is offset of starting position of the animation.
   * @return {Number}
   */
  getIterationStart: function() {
    return this.player.effect.getComputedTiming().iterationStart;
  },

  /**
   * Return the current start of the Animation.
   * @return {Object}
   */
  getState: function() {
    // Remember the startTime each time getState is called, it may be useful
    // when animations get paused. As in, when an animation gets paused, its
    // startTime goes back to null, but the front-end might still be interested
    // in knowing what the previous startTime was. So everytime it is set,
    // remember it and send it along with the newState.
    if (this.player.startTime) {
      this.previousStartTime = this.player.startTime;
    }

    // Note that if you add a new property to the state object, make sure you
    // add the corresponding property in the AnimationPlayerFront' initialState
    // getter.
    return {
      type: this.getType(),
      // startTime is null whenever the animation is paused or waiting to start.
      startTime: this.player.startTime,
      previousStartTime: this.previousStartTime,
      currentTime: this.player.currentTime,
      playState: this.player.playState,
      playbackRate: this.player.playbackRate,
      name: this.getName(),
      duration: this.getDuration(),
      delay: this.getDelay(),
      endDelay: this.getEndDelay(),
      iterationCount: this.getIterationCount(),
      iterationStart: this.getIterationStart(),
      // animation is hitting the fast path or not. Returns false whenever the
      // animation is paused as it is taken off the compositor then.
      isRunningOnCompositor: this.player.isRunningOnCompositor,
      // The document timeline's currentTime is being sent along too. This is
      // not strictly related to the node's animationPlayer, but is useful to
      // know the current time of the animation with respect to the document's.
      documentCurrentTime: this.node.ownerDocument.timeline.currentTime
    };
  },

  /**
   * Get the current state of the AnimationPlayer (currentTime, playState, ...).
   * Note that the initial state is returned as the form of this actor when it
   * is initialized.
   * This protocol method only returns a trimed down version of this state in
   * case some properties haven't changed since last time (since the front can
   * reconstruct those). If you want the full state, use the getState method.
   * @return {Object}
   */
  getCurrentState: method(function() {
    let newState = this.getState();

    // If we've saved a state before, compare and only send what has changed.
    // It's expected of the front to also save old states to re-construct the
    // full state when an incomplete one is received.
    // This is to minimize protocol traffic.
    let sentState = {};
    if (this.currentState) {
      for (let key in newState) {
        if (typeof this.currentState[key] === "undefined" ||
            this.currentState[key] !== newState[key]) {
          sentState[key] = newState[key];
        }
      }
    } else {
      sentState = newState;
    }
    this.currentState = newState;

    return sentState;
  }, {
    request: {},
    response: {
      data: RetVal("json")
    }
  }),

  /**
   * Executed when the current animation changes, used to emit the new state
   * the the front.
   */
  onAnimationMutation: function(mutations) {
    let isCurrentAnimation = animation => animation === this.player;
    let hasCurrentAnimation = animations => animations.some(isCurrentAnimation);
    let hasChanged = false;

    for (let {removedAnimations, changedAnimations} of mutations) {
      if (hasCurrentAnimation(removedAnimations)) {
        // Reset the local copy of the state on removal, since the animation can
        // be kept on the client and re-added, its state needs to be sent in
        // full.
        this.currentState = null;
      }

      if (hasCurrentAnimation(changedAnimations)) {
        // Only consider the state has having changed if any of delay, duration,
        // iterationcount or iterationStart has changed (for now at least).
        let newState = this.getState();
        let oldState = this.currentState;
        hasChanged = newState.delay !== oldState.delay ||
                     newState.iterationCount !== oldState.iterationCount ||
                     newState.iterationStart !== oldState.iterationStart ||
                     newState.duration !== oldState.duration ||
                     newState.endDelay !== oldState.endDelay;
        break;
      }
    }

    if (hasChanged) {
      events.emit(this, "changed", this.getCurrentState());
    }
  },

  /**
   * Pause the player.
   */
  pause: method(function() {
    this.player.pause();
    return this.player.ready;
  }, {
    request: {},
    response: {}
  }),

  /**
   * Play the player.
   * This method only returns when the animation has left its pending state.
   */
  play: method(function() {
    this.player.play();
    return this.player.ready;
  }, {
    request: {},
    response: {}
  }),

  /**
   * Simply exposes the player ready promise.
   *
   * When an animation is created/paused then played, there's a short time
   * during which its playState is pending, before being set to running.
   *
   * If you either created a new animation using the Web Animations API or
   * paused/played an existing one, and then want to access the playState, you
   * might be interested to call this method.
   * This is especially important for tests.
   */
  ready: method(function() {
    return this.player.ready;
  }, {
    request: {},
    response: {}
  }),

  /**
   * Set the current time of the animation player.
   */
  setCurrentTime: method(function(currentTime) {
    this.player.currentTime = currentTime * this.player.playbackRate;
  }, {
    request: {
      currentTime: Arg(0, "number")
    },
    response: {}
  }),

  /**
   * Set the playback rate of the animation player.
   */
  setPlaybackRate: method(function(playbackRate) {
    this.player.playbackRate = playbackRate;
  }, {
    request: {
      currentTime: Arg(0, "number")
    },
    response: {}
  }),

  /**
   * Get data about the keyframes of this animation player.
   * @return {Object} Returns a list of frames, each frame containing the list
   * animated properties as well as the frame's offset.
   */
  getFrames: method(function() {
    return this.player.effect.getFrames();
  }, {
    request: {},
    response: {
      frames: RetVal("json")
    }
  }),

  /**
   * Get data about the animated properties of this animation player.
   * @return {Object} Returns a list of animated properties.
   * Each property contains a list of values and their offsets
   */
  getProperties: method(function() {
    return this.player.effect.getProperties();
  }, {
    request: {},
    response: {
      frames: RetVal("json")
    }
  })
});

exports.AnimationPlayerActor = AnimationPlayerActor;

var AnimationPlayerFront = FrontClass(AnimationPlayerActor, {
  initialize: function(conn, form, detail, ctx) {
    Front.prototype.initialize.call(this, conn, form, detail, ctx);

    this.state = {};
  },

  form: function(form, detail) {
    if (detail === "actorid") {
      this.actorID = form;
      return;
    }
    this._form = form;
    this.state = this.initialState;
  },

  destroy: function() {
    Front.prototype.destroy.call(this);
  },

  /**
   * If the AnimationsActor was given a reference to the WalkerActor previously
   * then calling this getter will return the animation target NodeFront.
   */
  get animationTargetNodeFront() {
    if (!this._form.animationTargetNodeActorID) {
      return null;
    }

    return this.conn.getActor(this._form.animationTargetNodeActorID);
  },

  /**
   * Getter for the initial state of the player. Up to date states can be
   * retrieved by calling the getCurrentState method.
   */
  get initialState() {
    return {
      type: this._form.type,
      startTime: this._form.startTime,
      previousStartTime: this._form.previousStartTime,
      currentTime: this._form.currentTime,
      playState: this._form.playState,
      playbackRate: this._form.playbackRate,
      name: this._form.name,
      duration: this._form.duration,
      delay: this._form.delay,
      endDelay: this._form.endDelay,
      iterationCount: this._form.iterationCount,
      iterationStart: this._form.iterationStart,
      isRunningOnCompositor: this._form.isRunningOnCompositor,
      documentCurrentTime: this._form.documentCurrentTime
    };
  },

  /**
   * Executed when the AnimationPlayerActor emits a "changed" event. Used to
   * update the local knowledge of the state.
   */
  onChanged: protocol.preEvent("changed", function(partialState) {
    let {state} = this.reconstructState(partialState);
    this.state = state;
  }),

  /**
   * Refresh the current state of this animation on the client from information
   * found on the server. Doesn't return anything, just stores the new state.
   */
  refreshState: Task.async(function*() {
    let data = yield this.getCurrentState();
    if (this.currentStateHasChanged) {
      this.state = data;
    }
  }),

  /**
   * getCurrentState interceptor re-constructs incomplete states since the actor
   * only sends the values that have changed.
   */
  getCurrentState: protocol.custom(function() {
    this.currentStateHasChanged = false;
    return this._getCurrentState().then(partialData => {
      let {state, hasChanged} = this.reconstructState(partialData);
      this.currentStateHasChanged = hasChanged;
      return state;
    });
  }, {
    impl: "_getCurrentState"
  }),

  reconstructState: function(data) {
    let hasChanged = false;

    for (let key in this.state) {
      if (typeof data[key] === "undefined") {
        data[key] = this.state[key];
      } else if (data[key] !== this.state[key]) {
        hasChanged = true;
      }
    }

    return {state: data, hasChanged};
  }
});

/**
 * Sent with the 'mutations' event as part of an array of changes, used to
 * inform fronts of the type of change that occured.
 */
types.addDictType("animationMutationChange", {
  // The type of change ("added" or "removed").
  type: "string",
  // The changed AnimationPlayerActor.
  player: "animationplayer"
});

/**
 * The Animations actor lists animation players for a given node.
 */
var AnimationsActor = exports.AnimationsActor = ActorClass({
  typeName: "animations",

  events: {
    "mutations": {
      type: "mutations",
      changes: Arg(0, "array:animationMutationChange")
    }
  },

  initialize: function(conn, tabActor) {
    Actor.prototype.initialize.call(this, conn);
    this.tabActor = tabActor;

    this.onWillNavigate = this.onWillNavigate.bind(this);
    this.onNavigate = this.onNavigate.bind(this);
    this.onAnimationMutation = this.onAnimationMutation.bind(this);

    this.allAnimationsPaused = false;
    events.on(this.tabActor, "will-navigate", this.onWillNavigate);
    events.on(this.tabActor, "navigate", this.onNavigate);
  },

  destroy: function() {
    Actor.prototype.destroy.call(this);
    events.off(this.tabActor, "will-navigate", this.onWillNavigate);
    events.off(this.tabActor, "navigate", this.onNavigate);

    this.stopAnimationPlayerUpdates();
    this.tabActor = this.observer = this.actors = this.walker = null;
  },

  /**
   * Since AnimationsActor doesn't have a protocol.js parent actor that takes
   * care of its lifetime, implementing disconnect is required to cleanup.
   */
  disconnect: function() {
    this.destroy();
  },

  /**
   * Clients can optionally call this with a reference to their WalkerActor.
   * If they do, then AnimationPlayerActor's forms are going to also include
   * NodeActor IDs when the corresponding NodeActors do exist.
   * This, in turns, is helpful for clients to avoid having to go back once more
   * to the server to get a NodeActor for a particular animation.
   * @param {WalkerActor} walker
   */
  setWalkerActor: method(function(walker) {
    this.walker = walker;
  }, {
    request: {
      walker: Arg(0, "domwalker")
    },
    response: {}
  }),

  /**
   * Retrieve the list of AnimationPlayerActor actors for currently running
   * animations on a node and its descendants.
   * Note that calling this method a second time will destroy all previously
   * retrieved AnimationPlayerActors. Indeed, the lifecycle of these actors
   * is managed here on the server and tied to getAnimationPlayersForNode
   * being called.
   * @param {NodeActor} nodeActor The NodeActor as defined in
   * /devtools/server/actors/inspector
   */
  getAnimationPlayersForNode: method(function(nodeActor) {
    let animations = [
      ...nodeActor.rawNode.getAnimations(),
      ...this.getAllAnimations(nodeActor.rawNode)
    ];

    // Destroy previously stored actors
    if (this.actors) {
      this.actors.forEach(actor => actor.destroy());
    }
    this.actors = [];

    for (let i = 0; i < animations.length; i++) {
      let actor = AnimationPlayerActor(this, animations[i]);
      this.actors.push(actor);
    }

    // When a front requests the list of players for a node, start listening
    // for animation mutations on this node to send updates to the front, until
    // either getAnimationPlayersForNode is called again or
    // stopAnimationPlayerUpdates is called.
    this.stopAnimationPlayerUpdates();
    let win = nodeActor.rawNode.ownerDocument.defaultView;
    this.observer = new win.MutationObserver(this.onAnimationMutation);
    this.observer.observe(nodeActor.rawNode, {
      animations: true,
      subtree: true
    });

    return this.actors;
  }, {
    request: {
      actorID: Arg(0, "domnode")
    },
    response: {
      players: RetVal("array:animationplayer")
    }
  }),

  onAnimationMutation: function(mutations) {
    let eventData = [];
    let readyPromises = [];

    for (let {addedAnimations, removedAnimations} of mutations) {
      for (let player of removedAnimations) {
        // Note that animations are reported as removed either when they are
        // actually removed from the node (e.g. css class removed) or when they
        // are finished and don't have forwards animation-fill-mode.
        // In the latter case, we don't send an event, because the corresponding
        // animation can still be seeked/resumed, so we want the client to keep
        // its reference to the AnimationPlayerActor.
        if (player.playState !== "idle") {
          continue;
        }
        // FIXME: In bug 1249219, we support the animation mutation for pseudo
        // elements. However, the timeline may not be ready yet to
        // display those correctly. Therefore, we add this check to bails out if
        // the mutation target is a pseudo-element.
        // Note. Only CSSPseudoElement object has |type| attribute, so if type
        // exists, it is a CSSPseudoElement object.
        if (player.effect.target.type) {
          continue;
        }
        let index = this.actors.findIndex(a => a.player === player);
        if (index !== -1) {
          eventData.push({
            type: "removed",
            player: this.actors[index]
          });
          this.actors.splice(index, 1);
        }
      }

      for (let player of addedAnimations) {
        // If the added player already exists, it means we previously filtered
        // it out when it was reported as removed. So filter it out here too.
        if (this.actors.find(a => a.player === player)) {
          continue;
        }
        // FIXME: In bug 1249219, we support the animation mutation for pseudo
        // elements. However, the timeline may not be ready yet to
        // display those correctly. Therefore, we add this check to bails out if
        // the mutation target is a pseudo-element.
        // Note. Only CSSPseudoElement object has |type| attribute, so if type
        // exists, it is a CSSPseudoElement object.
        if (player.effect.target.type) {
          continue;
        }
        // If the added player has the same name and target node as a player we
        // already have, it means it's a transition that's re-starting. So send
        // a "removed" event for the one we already have.
        let index = this.actors.findIndex(a => {
          let isSameType = a.player.constructor === player.constructor;
          let isSameName = (a.isCssAnimation() &&
                            a.player.animationName === player.animationName) ||
                           (a.isCssTransition() &&
                            a.player.transitionProperty === player.transitionProperty);
          let isSameNode = a.player.effect.target === player.effect.target;

          return isSameType && isSameNode && isSameName;
        });
        if (index !== -1) {
          eventData.push({
            type: "removed",
            player: this.actors[index]
          });
          this.actors.splice(index, 1);
        }

        let actor = AnimationPlayerActor(this, player);
        this.actors.push(actor);
        eventData.push({
          type: "added",
          player: actor
        });
        readyPromises.push(player.ready);
      }
    }

    if (eventData.length) {
      // Let's wait for all added animations to be ready before telling the
      // front-end.
      Promise.all(readyPromises).then(() => {
        events.emit(this, "mutations", eventData);
      });
    }
  },

  /**
   * After the client has called getAnimationPlayersForNode for a given DOM
   * node, the actor starts sending animation mutations for this node. If the
   * client doesn't want this to happen anymore, it should call this method.
   */
  stopAnimationPlayerUpdates: method(function() {
    if (this.observer && !Cu.isDeadWrapper(this.observer)) {
      this.observer.disconnect();
    }
  }, {
    request: {},
    response: {}
  }),

  /**
   * Iterates through all nodes below a given rootNode (optionally also in
   * nested frames) and finds all existing animation players.
   * @param {DOMNode} rootNode The root node to start iterating at. Animation
   * players will *not* be reported for this node.
   * @param {Boolean} traverseFrames Whether we should iterate through nested
   * frames too.
   * @return {Array} An array of AnimationPlayer objects.
   */
  getAllAnimations: function(rootNode, traverseFrames) {
    let animations = [];

    // These loops shouldn't be as bad as they look.
    // Typically, there will be very few nested frames, and getElementsByTagName
    // is really fast even on large DOM trees.
    for (let element of rootNode.getElementsByTagNameNS("*", "*")) {
      if (traverseFrames && element.contentWindow) {
        animations = [
          ...animations,
          ...this.getAllAnimations(element.contentWindow.document, traverseFrames)
        ];
      } else {
        animations = [
          ...animations,
          ...element.getAnimations()
        ];
      }
    }

    return animations;
  },

  onWillNavigate: function({isTopLevel}) {
    if (isTopLevel) {
      this.stopAnimationPlayerUpdates();
    }
  },

  onNavigate: function({isTopLevel}) {
    if (isTopLevel) {
      this.allAnimationsPaused = false;
    }
  },

  /**
   * Pause all animations in the current tabActor's frames.
   */
  pauseAll: method(function() {
    let readyPromises = [];
    // Until the WebAnimations API provides a way to play/pause via the document
    // timeline, we have to iterate through the whole DOM to find all players.
    for (let player of
         this.getAllAnimations(this.tabActor.window.document, true)) {
      player.pause();
      readyPromises.push(player.ready);
    }
    this.allAnimationsPaused = true;
    return promise.all(readyPromises);
  }, {
    request: {},
    response: {}
  }),

  /**
   * Play all animations in the current tabActor's frames.
   * This method only returns when animations have left their pending states.
   */
  playAll: method(function() {
    let readyPromises = [];
    // Until the WebAnimations API provides a way to play/pause via the document
    // timeline, we have to iterate through the whole DOM to find all players.
    for (let player of
         this.getAllAnimations(this.tabActor.window.document, true)) {
      player.play();
      readyPromises.push(player.ready);
    }
    this.allAnimationsPaused = false;
    return promise.all(readyPromises);
  }, {
    request: {},
    response: {}
  }),

  toggleAll: method(function() {
    if (this.allAnimationsPaused) {
      return this.playAll();
    }
    return this.pauseAll();
  }, {
    request: {},
    response: {}
  }),

  /**
   * Toggle (play/pause) several animations at the same time.
   * @param {Array} players A list of AnimationPlayerActor objects.
   * @param {Boolean} shouldPause If set to true, the players will be paused,
   * otherwise they will be played.
   */
  toggleSeveral: method(function(players, shouldPause) {
    return promise.all(players.map(player => {
      return shouldPause ? player.pause() : player.play();
    }));
  }, {
    request: {
      players: Arg(0, "array:animationplayer"),
      shouldPause: Arg(1, "boolean")
    },
    response: {}
  }),

  /**
   * Set the current time of several animations at the same time.
   * @param {Array} players A list of AnimationPlayerActor.
   * @param {Number} time The new currentTime.
   * @param {Boolean} shouldPause Should the players be paused too.
   */
  setCurrentTimes: method(function(players, time, shouldPause) {
    return promise.all(players.map(player => {
      let pause = shouldPause ? player.pause() : promise.resolve();
      return pause.then(() => player.setCurrentTime(time));
    }));
  }, {
    request: {
      players: Arg(0, "array:animationplayer"),
      time: Arg(1, "number"),
      shouldPause: Arg(2, "boolean")
    },
    response: {}
  }),

  /**
   * Set the playback rate of several animations at the same time.
   * @param {Array} players A list of AnimationPlayerActor.
   * @param {Number} rate The new rate.
   */
  setPlaybackRates: method(function(players, rate) {
    for (let player of players) {
      player.setPlaybackRate(rate);
    }
  }, {
    request: {
      players: Arg(0, "array:animationplayer"),
      rate: Arg(1, "number")
    },
    response: {}
  })
});

var AnimationsFront = exports.AnimationsFront = FrontClass(AnimationsActor, {
  initialize: function(client, {animationsActor}) {
    Front.prototype.initialize.call(this, client, {actor: animationsActor});
    this.manage(this);
  },

  destroy: function() {
    Front.prototype.destroy.call(this);
  }
});
