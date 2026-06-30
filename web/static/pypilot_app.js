/*
#   Copyright (C) 2026 Sean D'Epagnier
#
# This Program is free software; you can redistribute it and/or
# modify it under the terms of the GNU General Public
# License as published by the Free Software Foundation; either
# version 3 of the License, or (at your option) any later version.
#
# Redesigned pypilot web GUI - vanilla JS, no jQuery.
# Speaks the same socket.io protocol as the classic GUI so it is a drop-in.
*/

(function () {
    "use strict";

    var T = (typeof _ === "function") ? _ : function (s) { return s; };
    var $ = function (id) { return document.getElementById(id); };

    var socket = null;
    var watches = {};          // name -> period currently requested
    var listValues = {};       // metadata from pypilot_values
    var lastValues = {};       // last received value for every name
    var gains = [];            // ap.*.* AutopilotGain names
    var confNames = [];        // RangeSetting names
    var profiledNames = [];
    var currentView = "control";
    var touch = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;

    var calPlotOpen = false, calPlotInited = false;
    var advOpen = false;
    var advControls = {};      // name -> update(value) for the advanced editor

    // always-on watches the UI needs regardless of the active view
    var PRIMARY = [
        "ap.enabled", "ap.mode", "ap.modes", "ap.heading_command", "ap.pilot",
        "ap.tack.timeout", "ap.tack.state", "ap.tack.direction",
        "profile", "profiles", "rudder.source",
        "imu.heading_offset", "imu.compass.calibration.locked", "imu.accel.calibration.locked",
        "rudder.range", "nmea.client", "signalk.host",
        "imu.error", "imu.warning", "servo.controller", "servo.flags"
    ];
    var STATS = ["servo.amp_hours", "servo.voltage", "servo.controller_temp",
                 "servo.motor_temp", "ap.runtime", "ap.version", "servo.engaged"];

    // state mirrored from server
    var st = {
        heading: 0, headingCommand: 0, enabled: false,
        mode: "compass", modes: [], pilot: "basic",
        profile: "default", profiles: ["default"],
        rudderSource: "none", tackState: "none"
    };

    // local command tracking for incremental steering
    var headingLocalCommand = 0;
    var headingSetTime = 0;
    var servoCommand = 0, servoCommandTimeout = 0;

    var pingTimes = [];
    var pingStart = 0;

    /* ------------------------------------------------------------------ */
    /* protocol                                                            */
    /* ------------------------------------------------------------------ */
    function set(name, value) {
        try { socket.emit("pypilot", name + "=" + JSON.stringify(value)); }
        catch (e) { console.warn("set fail", e); }
    }

    function watch(name, period) {
        if (period === undefined) period = true;
        if (period === false && !(name in watches && watches[name] !== false)) return;
        watches[name] = period;
        try { socket.emit("pypilot", 'watch={"' + name + '":' + JSON.stringify(period) + "}"); }
        catch (e) { console.warn("watch fail", e); }
    }

    function watchMany(names, on, period) {
        for (var i = 0; i < names.length; i++) watch(names[i], on ? period : false);
    }

    /* ------------------------------------------------------------------ */
    /* helpers                                                             */
    /* ------------------------------------------------------------------ */
    function round(v, d) { var m = Math.pow(10, d); return Math.round(v * m) / m; }

    function headingStr(h) {
        if (h === false || h === null || h === undefined) return "---";
        h = round(Number(h), 1);
        if (st.mode === "wind" || st.mode === "true wind") {
            if (h > 0) return "+" + h;
        }
        return String(h);
    }

    function setConnection(state) {
        var pill = $("conn-pill");
        var txt = $("conn-text");
        pill.classList.remove("ok", "warn");
        if (state === "connected") { pill.classList.add("ok"); txt.textContent = T("Connected"); }
        else if (state === "disconnected") { pill.classList.add("warn"); txt.textContent = T("Disconnected"); }
        else { txt.textContent = T("Not Connected"); }
    }

    /* ------------------------------------------------------------------ */
    /* compass rose (canvas)                                               */
    /* ------------------------------------------------------------------ */
    function drawCompass() {
        var c = $("compass");
        if (!c) return;
        var dpr = window.devicePixelRatio || 1;
        var size = c.clientWidth || 200;
        if (c.width !== size * dpr) { c.width = size * dpr; c.height = size * dpr; }
        var ctx = c.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size, size);
        var cx = size / 2, cy = size / 2, r = size / 2 - 6;
        var style = getComputedStyle(document.body);
        var border = style.getPropertyValue("--border").trim() || "#2a3744";
        var dim = style.getPropertyValue("--text-dim").trim() || "#8aa0b2";
        var text = style.getPropertyValue("--text").trim() || "#e7eef5";
        var accent = style.getPropertyValue("--accent").trim() || "#36a3ff";

        ctx.lineWidth = 2;
        ctx.strokeStyle = border;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();

        var heading = Number(st.heading) || 0;
        // rotate ring so current heading is up
        for (var a = 0; a < 360; a += 30) {
            var ang = (a - heading - 90) * Math.PI / 180;
            var x1 = cx + Math.cos(ang) * r;
            var y1 = cy + Math.sin(ang) * r;
            var x2 = cx + Math.cos(ang) * (r - (a % 90 === 0 ? 14 : 8));
            var y2 = cy + Math.sin(ang) * (r - (a % 90 === 0 ? 14 : 8));
            ctx.strokeStyle = a % 90 === 0 ? text : dim;
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        }
        var labels = { 0: "N", 90: "E", 180: "S", 270: "W" };
        ctx.fillStyle = dim;
        ctx.font = (size / 12) + "px sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        for (var d in labels) {
            var la = (Number(d) - heading - 90) * Math.PI / 180;
            ctx.fillText(labels[d], cx + Math.cos(la) * (r - 26), cy + Math.sin(la) * (r - 26));
        }

        // fixed heading marker (boat) pointing up
        ctx.fillStyle = text;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r + 2);
        ctx.lineTo(cx - 7, cy - r + 18);
        ctx.lineTo(cx + 7, cy - r + 18);
        ctx.closePath(); ctx.fill();

        // command needle (relative to heading)
        if (st.enabled) {
            var rel = (Number(st.headingCommand) - heading) * Math.PI / 180;
            var na = rel - Math.PI / 2;
            ctx.strokeStyle = accent;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(na) * (r - 4), cy + Math.sin(na) * (r - 4));
            ctx.stroke();
        }
        ctx.fillStyle = accent;
        ctx.beginPath(); ctx.arc(cx, cy, 5, 0, 2 * Math.PI); ctx.fill();
    }

    /* ------------------------------------------------------------------ */
    /* range control factory (used for gains + config)                    */
    /* ------------------------------------------------------------------ */
    function makeRange(parent, name, displayName, opts) {
        opts = opts || {};
        var info = listValues[name] || {};
        var min = ("min" in info) ? Number(info.min) : 0;
        var max = ("max" in info) ? Number(info.max) : 1;
        var units = opts.units || info.units || "";

        var wrap = document.createElement("div");
        wrap.className = "range-ctl";
        wrap.innerHTML =
            '<div class="rc-name"></div>' +
            '<div class="rc-val">--</div>' +
            '<div class="rc-body"></div>';
        wrap.querySelector(".rc-name").textContent = displayName + (units ? " (" + units + ")" : "");
        var valEl = wrap.querySelector(".rc-val");
        var body = wrap.querySelector(".rc-body");

        var range = max - min;

        function stepBtn(text, pct) {
            var b = document.createElement("button");
            b.className = "rc-step";
            b.textContent = text;
            b.onclick = function () {
                var cur = parseFloat(valEl.textContent);
                if (isNaN(cur)) cur = min;
                var nv = cur + pct * range / 100;
                nv = Math.max(min, Math.min(max, nv));
                set(name, nv);
            };
            return b;
        }

        var slider = document.createElement("input");
        slider.type = "range";
        slider.min = min; slider.max = max; slider.step = (range / 1000) || 0.001;
        slider.oninput = function () { valEl.textContent = round(this.valueAsNumber, 3); };
        slider.onchange = function () { set(name, this.valueAsNumber); };

        if (touch) {
            body.appendChild(stepBtn("<<", -10));
            body.appendChild(stepBtn("<", -1));
            var track = document.createElement("div");
            track.className = "bar-track";
            var fill = document.createElement("div");
            fill.className = "bar-fill";
            track.appendChild(fill);
            body.appendChild(track);
            body.appendChild(stepBtn(">", 1));
            body.appendChild(stepBtn(">>", 10));
            wrap._update = function (v) {
                valEl.textContent = round(v, 3);
                fill.style.width = (100 * (v - min) / range) + "%";
            };
        } else {
            body.appendChild(slider);
            wrap._update = function (v) {
                valEl.textContent = round(v, 3);
                slider.value = v;
            };
        }
        wrap._name = name;
        parent.appendChild(wrap);
        return wrap;
    }

    /* ------------------------------------------------------------------ */
    /* build dynamic sections from pypilot_values                          */
    /* ------------------------------------------------------------------ */
    var rangeControls = {};   // name -> wrap element

    function buildGains() {
        gains = [];
        for (var name in listValues)
            if ("AutopilotGain" in listValues[name] && name.indexOf("ap.") === 0)
                gains.push(name);

        var pilotSel = $("pilot");
        pilotSel.innerHTML = "";
        var choices = (listValues["ap.pilot"] && listValues["ap.pilot"].choices) || [st.pilot];
        for (var i = 0; i < choices.length; i++) {
            var o = document.createElement("option");
            o.value = choices[i]; o.textContent = choices[i];
            pilotSel.appendChild(o);
        }
        pilotSel.value = st.pilot;
        pilotSel.onchange = function () { set("ap.pilot", this.value); showGains(); };

        var cont = $("gain-container");
        cont.innerHTML = "";
        for (var g = 0; g < gains.length; g++) {
            var sp = gains[g].split(".");   // ap.<pilot>.<sub>
            var w = makeRange(cont, gains[g], sp[3]);
            w.dataset.pilot = sp[2];
            rangeControls[gains[g]] = w;
        }
        showGains();
    }

    function showGains() {
        var p = $("pilot").value;
        var cont = $("gain-container");
        var children = cont.querySelectorAll(".range-ctl");
        for (var i = 0; i < children.length; i++)
            children[i].style.display = children[i].dataset.pilot === p ? "" : "none";
    }

    function buildConfig() {
        confNames = [];
        for (var name in listValues)
            if (listValues[name].type === "RangeSetting") confNames.push(name);
        confNames.sort();

        var cont = $("config-container");
        cont.innerHTML = "";
        var profiled = document.createElement("div");
        for (var i = 0; i < confNames.length; i++) {
            var info = listValues[confNames[i]];
            var w = makeRange(info.profiled ? profiled : cont, confNames[i], confNames[i], { units: info.units });
            rangeControls[confNames[i]] = w;
        }
        if (profiled.children.length) {
            var note = document.createElement("p");
            note.className = "muted";
            note.textContent = T("The following settings are captured by the current profile");
            cont.appendChild(note);
            cont.appendChild(profiled);
        }

        profiledNames = [];
        for (var n in listValues) if ("profiled" in listValues[n]) profiledNames.push(n);
    }

    function buildModes() {
        var sel = $("mode");
        sel.innerHTML = "";
        for (var i = 0; i < st.modes.length; i++) {
            var o = document.createElement("option");
            o.value = st.modes[i]; o.textContent = st.modes[i];
            sel.appendChild(o);
        }
        sel.value = st.mode;
    }

    /* ------------------------------------------------------------------ */
    /* advanced editor: every pypilot value, live (like the client page)   */
    /* ------------------------------------------------------------------ */
    function buildAdvanced() {
        var cont = $("advanced-container");
        if (!cont) return;
        cont.innerHTML = "";
        advControls = {};
        var names = Object.keys(listValues).sort();

        for (var i = 0; i < names.length; i++) {
            (function (name) {
                var info = listValues[name] || {};
                var type = info.type;
                var row = document.createElement("div");
                row.className = "adv-row";
                row.dataset.name = name;

                var nameEl = document.createElement("div");
                nameEl.className = "adv-name";
                nameEl.textContent = name + (info.units ? " (" + info.units + ")" : "");
                row.appendChild(nameEl);

                var ctl = document.createElement("div");
                ctl.className = "adv-ctl";
                row.appendChild(ctl);

                if (type === "RangeProperty" || type === "RangeSetting" || "AutopilotGain" in info) {
                    var min = ("min" in info) ? Number(info.min) : 0;
                    var max = ("max" in info) ? Number(info.max) : 1;
                    var s = document.createElement("input");
                    s.type = "range"; s.min = min; s.max = max;
                    s.step = ((max - min) / 1000) || 0.0001;
                    var num = document.createElement("span");
                    num.className = "adv-num"; num.textContent = "--";
                    s.onchange = function () { set(name, s.valueAsNumber); };
                    s.oninput = function () { num.textContent = round(s.valueAsNumber, 4); };
                    ctl.appendChild(s); ctl.appendChild(num);
                    advControls[name] = function (v) { s.value = v; num.textContent = round(Number(v), 4); };
                } else if (type === "BooleanProperty") {
                    var cb = document.createElement("input");
                    cb.type = "checkbox";
                    cb.onchange = function () { set(name, cb.checked); };
                    ctl.appendChild(cb);
                    advControls[name] = function (v) { cb.checked = !!v; };
                } else if (type === "EnumProperty") {
                    var sel = document.createElement("select");
                    var choices = info.choices || [];
                    for (var c = 0; c < choices.length; c++) {
                        var o = document.createElement("option");
                        o.value = String(choices[c]); o.textContent = String(choices[c]);
                        sel.appendChild(o);
                    }
                    sel.onchange = function () { set(name, sel.value); };
                    ctl.appendChild(sel);
                    advControls[name] = function (v) { sel.value = String(v); };
                } else if (type === "ResettableValue") {
                    var val = document.createElement("span");
                    val.className = "adv-val"; val.textContent = "--";
                    var btn = document.createElement("button");
                    btn.className = "btn"; btn.textContent = T("Reset");
                    btn.onclick = function () { set(name, 0); };
                    ctl.appendChild(val); ctl.appendChild(btn);
                    advControls[name] = function (v) { val.textContent = String(v); };
                } else {
                    var ro = document.createElement("span");
                    ro.className = "adv-val"; ro.textContent = "--";
                    ctl.appendChild(ro);
                    advControls[name] = function (v) {
                        ro.textContent = (typeof v === "object") ? JSON.stringify(v) : String(v);
                    };
                }
                cont.appendChild(row);
            })(names[i]);
        }
        updateAdvanced(lastValues);
        filterAdvanced();
    }

    function updateAdvanced(data) {
        for (var name in data)
            if (advControls[name]) advControls[name](data[name]);
    }

    function filterAdvanced() {
        var f = ($("adv_filter") && $("adv_filter").value || "").toLowerCase();
        var rows = $("advanced-container").querySelectorAll(".adv-row");
        for (var i = 0; i < rows.length; i++)
            rows[i].style.display = rows[i].dataset.name.toLowerCase().indexOf(f) === -1 ? "none" : "";
    }

    /* ------------------------------------------------------------------ */
    /* incoming value updates                                              */
    /* ------------------------------------------------------------------ */
    function applyData(data) {
        for (var k in data) lastValues[k] = data[k];
        if ("ap.mode" in data) { st.mode = data["ap.mode"]; $("mode").value = st.mode; }
        if ("ap.modes" in data) { st.modes = data["ap.modes"]; buildModes(); }
        if ("ap.heading" in data) { st.heading = data["ap.heading"]; $("heading").textContent = headingStr(st.heading); drawCompass(); }
        if ("ap.heading_command" in data) { st.headingCommand = data["ap.heading_command"]; $("heading_command").textContent = headingStr(st.headingCommand); drawCompass(); }

        if ("ap.enabled" in data) { st.enabled = data["ap.enabled"]; renderEngaged(); drawCompass(); }

        if ("rudder.source" in data) {
            st.rudderSource = data["rudder.source"];
            $("center_button").style.visibility = (st.rudderSource === "none") ? "hidden" : "visible";
        }

        if ("ap.tack.state" in data) {
            st.tackState = data["ap.tack.state"];
            $("tack_state").textContent = st.tackState;
            $("tack-btn").textContent = (st.tackState === "none") ? T("Tack") : T("Cancel");
        }
        if ("ap.tack.timeout" in data) $("tack_timeout").textContent = round(data["ap.tack.timeout"], 1);

        if ("ap.pilot" in data) { st.pilot = data["ap.pilot"]; $("pilot").value = st.pilot; showGains(); }
        if ("profile" in data) { st.profile = String(data["profile"]); $("profile").value = st.profile; }
        if ("profiles" in data) { st.profiles = data["profiles"]; renderProfiles(); }

        // gains + config sliders
        for (var name in rangeControls)
            if (name in data && rangeControls[name]._update) rangeControls[name]._update(Number(data[name]));

        // calibration
        if ("imu.heading" in data) $("imu_heading").textContent = round(data["imu.heading"], 1);
        if ("imu.pitch" in data) $("pitch").textContent = round(data["imu.pitch"], 1);
        if ("imu.roll" in data) $("roll").textContent = round(data["imu.roll"], 1);
        if ("imu.alignmentCounter" in data) $("levelprogress").style.width = (100 - data["imu.alignmentCounter"]) + "%";
        if ("imu.heading_offset" in data) $("imu_heading_offset").value = data["imu.heading_offset"];
        if ("imu.accel.calibration.locked" in data) $("accel_lock").checked = !!data["imu.accel.calibration.locked"];
        if ("imu.compass.calibration.locked" in data) $("compass_lock").checked = !!data["imu.compass.calibration.locked"];
        if ("rudder.angle" in data) $("rudder").textContent = round(data["rudder.angle"], 1);
        if ("rudder.range" in data) $("rudder_range").value = data["rudder.range"];

        if ("nmea.client" in data) $("nmea_client").value = data["nmea.client"];
        if ("signalk.host" in data) $("signalk_host").value = data["signalk.host"];

        // statistics
        if ("servo.amp_hours" in data) $("amp_hours").textContent = round(data["servo.amp_hours"], 4);
        if ("servo.voltage" in data) $("voltage").textContent = round(data["servo.voltage"], 3);
        if ("servo.controller_temp" in data) $("controller_temp").textContent = data["servo.controller_temp"];
        if ("servo.motor_temp" in data) $("motor_temp").textContent = data["servo.motor_temp"];
        if ("ap.runtime" in data) $("runtime").textContent = data["ap.runtime"];
        if ("ap.version" in data) $("version").textContent = data["ap.version"];
        if ("servo.engaged" in data) $("servo_engaged").textContent = data["servo.engaged"] ? T("Engaged") : T("Disengaged");
        if ("servo.flags" in data) $("servoflags").textContent = data["servo.flags"];

        // errors
        if ("imu.error" in data) $("aperror0").textContent = data["imu.error"] || "";
        if ("imu.warning" in data) $("imu_warning").textContent = data["imu.warning"] || "";
        if ("servo.controller" in data) $("aperror1").textContent = (data["servo.controller"] === "none") ? T("no motor controller!") : "";

        if (calPlotOpen && typeof CalPlot !== "undefined") CalPlot.handle(data);
        if (advOpen) updateAdvanced(data);
    }

    function renderEngaged() {
        var b = $("engage");
        if (st.enabled) { b.classList.add("on"); b.textContent = T("ENGAGED"); $("tack-btn").style.display = ""; }
        else { b.classList.remove("on"); b.textContent = T("STANDBY"); }
        // steer labels
        var labels = st.enabled ? ["10", "1", "1", "10"] : ["<<", "<", ">", ">>"];
        $("port10").textContent = labels[0];
        $("port1").textContent = labels[1];
        $("star1").textContent = labels[2];
        $("star10").textContent = labels[3];
        $("center_span").style.display = st.enabled ? "none" : "";
    }

    function renderProfiles() {
        var sel = $("profile");
        sel.innerHTML = "";
        for (var i = 0; i < st.profiles.length; i++) {
            var o = document.createElement("option");
            o.value = st.profiles[i]; o.textContent = st.profiles[i];
            sel.appendChild(o);
        }
        sel.value = st.profile;
    }

    /* ------------------------------------------------------------------ */
    /* steering interaction                                                */
    /* ------------------------------------------------------------------ */
    function move(x) {
        if (!st.enabled) return;
        var time = Date.now();
        if (time - headingSetTime > 1000) headingLocalCommand = st.headingCommand;
        headingSetTime = time;
        if (st.mode.indexOf("wind") !== -1) x = -x;
        headingLocalCommand += x;
        set("ap.heading_command", headingLocalCommand);
    }

    function pollServo() {
        if (servoCommandTimeout > 0) {
            servoCommandTimeout--;
            if (servoCommandTimeout > 0) setTimeout(pollServo, 50);
            else servoCommand = 0;
            set("servo.command", servoCommand);
        }
    }

    function steerDown(servoAmt, headAmt) {
        if (st.enabled) { servoCommandTimeout = 0; move(headAmt); return; }
        servoCommand = servoAmt;
        servoCommandTimeout = 120;
        set("servo.command", servoCommand);
        setTimeout(pollServo, 50);
    }

    function steerUp() {
        if (st.enabled) { servoCommandTimeout = 0; return; }
        servoCommandTimeout -= 112;
        if (servoCommandTimeout <= 0) { servoCommandTimeout = 0; servoCommand = 0; set("servo.command", 0); }
    }

    function bindSteer() {
        var map = { port10: [1, -10], port1: [0.7, -1], star1: [-0.7, 1], star10: [-1, 10] };
        Object.keys(map).forEach(function (id) {
            var el = $(id);
            var m = map[id];
            el.addEventListener("pointerdown", function (e) { e.preventDefault(); steerDown(m[0], m[1]); });
            el.addEventListener("pointerup", function (e) { e.preventDefault(); steerUp(); });
            el.addEventListener("contextmenu", function (e) { e.preventDefault(); });
        });
        $("center_button").onclick = function () { set("servo.position_command", 0); };

        $("engage").onclick = function () {
            if (st.enabled) set("ap.enabled", false);
            else { set("ap.heading_command", st.heading); set("ap.enabled", true); }
        };

        $("mode").onchange = function () { set("ap.mode", this.value); };

        $("tack-btn").onclick = function () {
            if (st.tackState === "none") openView("tack");
            else set("ap.tack.state", "none");
        };
        $("tack_port").onclick = function () { set("ap.tack.direction", "port"); set("ap.tack.state", "begin"); openView("control"); };
        $("tack_starboard").onclick = function () { set("ap.tack.direction", "starboard"); set("ap.tack.state", "begin"); openView("control"); };
        $("tack_cancel").onclick = function () { set("ap.tack.state", "none"); openView("control"); };
    }

    /* ------------------------------------------------------------------ */
    /* profiles + calibration + config bindings                            */
    /* ------------------------------------------------------------------ */
    function bindControls() {
        $("profile").onchange = function () { set("profile", this.value); };
        $("add_profile").onclick = function () {
            var p = prompt(T("Enter profile name."));
            if (!p) return;
            if (st.profiles.includes(p)) { alert(T("Already have profile") + " " + p); return; }
            st.profiles.push(p); set("profile", p);
        };
        $("remove_profile").onclick = function () {
            if (!confirm(T("Remove current profile?"))) return;
            set("profiles", st.profiles.filter(function (p) { return p !== st.profile; }));
        };

        $("level").onclick = function () { set("imu.alignmentCounter", 100); };
        $("imu_heading_offset").onchange = function () { set("imu.heading_offset", this.value); };
        $("accel_lock").onchange = function () { set("imu.accel.calibration.locked", this.checked); };
        $("compass_lock").onchange = function () { set("imu.compass.calibration.locked", this.checked); };

        $("rudder_centered").onclick = function () { set("rudder.calibration_state", "centered"); };
        $("rudder_port_range").onclick = function () { set("rudder.calibration_state", "port range"); };
        $("rudder_starboard_range").onclick = function () { set("rudder.calibration_state", "starboard range"); };
        $("rudder_reset").onclick = function () { set("rudder.calibration_state", "reset"); };
        $("rudder_range").onchange = function () { set("rudder.range", this.value); };

        $("nmea_client").onchange = function () { set("nmea.client", this.value); };
        $("signalk_host").onchange = function () { set("signalk.host", this.value); };
        $("reset_amp_hours").onclick = function () { set("servo.amp_hours", 0); };
    }

    function bindCalPlot() {
        var card = $("calplot-card");
        if (!card) return;
        card.addEventListener("toggle", function () {
            calPlotOpen = card.open;
            if (calPlotOpen && !calPlotInited && typeof CalPlot !== "undefined") {
                calPlotInited = CalPlot.init($("calcanvas"));
                if (!calPlotInited) {
                    var cv = $("calcanvas");
                    if (cv) { cv.style.display = "none"; }
                    var msg = document.createElement("p");
                    msg.className = "muted";
                    msg.textContent = T("WebGL is not available in this browser; the 3D plot cannot be shown.");
                    cv.parentNode.insertBefore(msg, cv);
                }
            }
            applyWatches();
        });
        var accel = $("calplot_accel"), compass = $("calplot_compass");
        function pick(p) {
            if (typeof CalPlot !== "undefined") CalPlot.setPlot(p);
            applyWatches();
        }
        if (accel) accel.addEventListener("change", function () { if (this.checked) pick("accel"); });
        if (compass) compass.addEventListener("change", function () { if (this.checked) pick("compass"); });
    }

    function bindAdvanced() {
        var card = $("advanced-card");
        if (!card) return;
        card.addEventListener("toggle", function () {
            advOpen = card.open;
            if (advOpen) buildAdvanced();
            applyWatches();
        });
        var filter = $("adv_filter");
        if (filter) filter.addEventListener("input", filterAdvanced);
    }

    function bindWifi() {
        var card = $("wifi-card");
        if (!card) return;
        var cfg = (typeof wifiConfig !== "undefined" && wifiConfig) ? wifiConfig : {};
        var fields = {
            mode: "wifi_mode", ssid: "wifi_ssid", key: "wifi_key",
            client_ssid: "wifi_client_ssid", client_key: "wifi_client_key",
            client_address: "wifi_client_address"
        };
        for (var k in fields) if ($(fields[k]) && (k in cfg)) $(fields[k]).value = cfg[k];

        function updateMode() {
            var m = $("wifi_mode").value;
            $("wifi-master").style.display = m.indexOf("Master") !== -1 ? "" : "none";
            $("wifi-managed").style.display = m.indexOf("Managed") !== -1 ? "" : "none";
        }
        $("wifi_mode").addEventListener("change", updateMode);
        updateMode();

        $("wifi_submit").addEventListener("click", function () {
            var data = new URLSearchParams();
            for (var f in fields) if ($(fields[f])) data.append(f, $(fields[f]).value);
            $("wifi_status").textContent = T("Saving...");
            fetch("/wifi", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: data.toString()
            }).then(function (r) {
                $("wifi_status").textContent = r.ok ? T("Saved. Applying network settings...") : T("Error saving wifi settings");
            }).catch(function () {
                $("wifi_status").textContent = T("Error saving wifi settings");
            });
        });
    }

    /* ------------------------------------------------------------------ */
    /* watches per view                                                    */
    /* ------------------------------------------------------------------ */
    function desiredWatches() {
        var d = {};
        function add(names, period) { for (var i = 0; i < names.length; i++) d[names[i]] = period; }
        add(PRIMARY, 0.5);
        var v = currentView;
        if (v === "control") add(["ap.heading", "rudder.source"], 0.5);
        else if (v === "gain") add(gains, 1);
        else if (v === "calibration") add(["imu.heading", "imu.pitch", "imu.roll", "rudder.angle"], 0.5);
        else if (v === "config") add(confNames, 1);
        else if (v === "stats") add(STATS, 1);

        if (v === "calibration" && calPlotOpen && typeof CalPlot !== "undefined") {
            add(CalPlot.metaWatches(), true);
            add(CalPlot.plotWatches(CalPlot.currentPlot()), 0.25);
        }
        if (v === "config" && advOpen) add(Object.keys(listValues), 1);
        return d;
    }

    function applyWatches() {
        var d = desiredWatches();
        var n;
        for (n in watches) if (watches[n] !== false && !(n in d)) watch(n, false);
        for (n in d) if (watches[n] !== d[n]) watch(n, d[n]);
    }

    /* ------------------------------------------------------------------ */
    /* navigation                                                          */
    /* ------------------------------------------------------------------ */
    function openView(name) {
        currentView = name;
        var views = document.querySelectorAll(".view");
        for (var i = 0; i < views.length; i++)
            views[i].classList.toggle("active", views[i].id === "view-" + name);
        var navs = document.querySelectorAll(".bottomnav button");
        for (var j = 0; j < navs.length; j++)
            navs[j].classList.toggle("active", navs[j].dataset.view === name);
        if (name === "control") drawCompass();
        applyWatches();
    }

    /* ------------------------------------------------------------------ */
    /* theme                                                               */
    /* ------------------------------------------------------------------ */
    function setTheme(name) {
        document.body.setAttribute("data-theme", name);
        document.cookie = "theme=" + name + ";max-age=31536000;path=/";
        $("theme-btn").textContent = name === "dark" ? "\u2600" : "\u263E";
        drawCompass();
    }
    function getTheme() {
        var m = document.cookie.match("(^|;) ?theme=([^;]*)(;|$)");
        return m ? m[2] : "dark";
    }

    /* ------------------------------------------------------------------ */
    /* socket wiring                                                       */
    /* ------------------------------------------------------------------ */
    function connect() {
        socket = io.connect(location.protocol + "//" + document.domain + ":" + pypilot_web_port);

        socket.on("connect", function () {
            setInterval(function () {
                pingStart = Date.now();
                try { socket.emit("ping"); } catch (e) { /* ignore */ }
            }, 5000);
        });

        socket.on("pong", function () {
            pingTimes.push(Date.now() - pingStart);
            pingTimes = pingTimes.slice(-30);
            var sum = pingTimes.reduce(function (a, b) { return a + b; }, 0);
            $("ping-pong").textContent = round(sum / pingTimes.length, 1) + " ms";
        });

        socket.on("pypilot_disconnect", function () { setConnection("disconnected"); });

        socket.on("pypilot_values", function (msg) {
            listValues = JSON.parse(msg);
            watches = {};
            rangeControls = {};
            advControls = {};
            lastValues = {};
            setConnection("connected");

            buildModes();
            buildGains();
            buildConfig();
            renderProfiles();
            if (advOpen) buildAdvanced();
            applyWatches();
        });

        socket.on("pypilot", function (msg) { applyData(JSON.parse(msg)); });
    }

    /* ------------------------------------------------------------------ */
    /* init                                                                */
    /* ------------------------------------------------------------------ */
    document.addEventListener("DOMContentLoaded", function () {
        setConnection("init");
        setTheme(getTheme());

        // nav
        var navs = document.querySelectorAll(".bottomnav button");
        for (var i = 0; i < navs.length; i++)
            navs[i].addEventListener("click", function () { openView(this.dataset.view); });

        $("theme-btn").onclick = function () {
            setTheme(document.body.getAttribute("data-theme") === "dark" ? "light" : "dark");
        };

        // language selector
        var langSel = $("language");
        if (langSel && typeof languages !== "undefined") {
            languages.forEach(function (l) {
                var o = document.createElement("option");
                o.value = l; o.textContent = l;
                langSel.appendChild(o);
            });
            langSel.value = (typeof language !== "undefined") ? language : "default";
            langSel.onchange = function () { socket.emit("language", this.value); };
        }

        bindSteer();
        bindControls();
        bindCalPlot();
        bindAdvanced();
        bindWifi();
        renderEngaged();
        openView("control");

        window.addEventListener("resize", drawCompass);
        connect();
    });
})();
