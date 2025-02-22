/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env browser */
/* globals AddonManager */

"use strict";

loader.lazyImporter(this, "AddonManager",
  "resource://gre/modules/AddonManager.jsm");

const { Cc, Ci } = require("chrome");
const { createClass, DOM: dom } =
  require("devtools/client/shared/vendor/react");
const Services = require("Services");

const Strings = Services.strings.createBundle(
  "chrome://devtools/locale/aboutdebugging.properties");

const MORE_INFO_URL = "https://developer.mozilla.org/docs/Tools" +
                      "/about:debugging#Enabling_add-on_debugging";

module.exports = createClass({
  displayName: "AddonsControls",

  render() {
    let { debugDisabled } = this.props;

    return dom.div({ className: "addons-controls" },
        dom.div({ className: "addons-options" },
          dom.input({
            id: "enable-addon-debugging",
            type: "checkbox",
            checked: !debugDisabled,
            onChange: this.onEnableAddonDebuggingChange,
          }),
          dom.label({
            className: "addons-debugging-label",
            htmlFor: "enable-addon-debugging",
            title: Strings.GetStringFromName("addonDebugging.tooltip")
          }, Strings.GetStringFromName("addonDebugging.label")),
          "(",
          dom.a({ href: MORE_INFO_URL, target: "_blank" },
            Strings.GetStringFromName("addonDebugging.moreInfo")),
          ")"
        ),
        dom.button({
          id: "load-addon-from-file",
          onClick: this.loadAddonFromFile,
        }, Strings.GetStringFromName("loadTemporaryAddon"))
      );
  },

  onEnableAddonDebuggingChange(event) {
    let enabled = event.target.checked;
    Services.prefs.setBoolPref("devtools.chrome.enabled", enabled);
    Services.prefs.setBoolPref("devtools.debugger.remote-enabled", enabled);
  },

  loadAddonFromFile() {
    let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(window,
      Strings.GetStringFromName("selectAddonFromFile2"),
      Ci.nsIFilePicker.modeOpen);
    let res = fp.show();
    if (res == Ci.nsIFilePicker.returnCancel || !fp.file) {
      return;
    }
    let file = fp.file;
    // AddonManager.installTemporaryAddon accepts either
    // addon directory or final xpi file.
    if (!file.isDirectory() && !file.leafName.endsWith(".xpi")) {
      file = file.parent;
    }
    try {
      AddonManager.installTemporaryAddon(file);
    } catch (e) {
      window.alert("Error while installing the addon:\n" + e.message + "\n");
      throw e;
    }
  },
});
