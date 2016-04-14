/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { Ci } = require("chrome");
const { TabActor } = require("./webbrowser");

/**
 * Creates a WindowActor for debugging a single window, like a browser window in
 * Firefox, but it can be used to reach any window in the process.  Most of the
 * implementation is inherited from TabActor. WindowActor exposes all tab actors
 * via its form() request, like TabActor.
 *
 * You can request a specific window's actor via RootActor.getWindow().
 *
 * @param connection DebuggerServerConnection
 *        The connection to the client.
 * @param window mozIDOMWindowProxy
 *        The window.
 */
function WindowActor(connection, window) {
  TabActor.call(this, connection);

  let docShell = window.QueryInterface(Ci.nsIInterfaceRequestor)
                       .getInterface(Ci.nsIDocShell);
  Object.defineProperty(this, "docShell", {
    value: docShell,
    configurable: true
  });
}

WindowActor.prototype = Object.create(TabActor.prototype);

// TODO: This setting is mysteriously named, we should split up the
// functionality that is triggered by it.
WindowActor.prototype.isRootActor = true;

exports.WindowActor = WindowActor;
