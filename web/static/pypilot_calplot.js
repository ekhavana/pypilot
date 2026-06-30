/*
#   Copyright (C) 2026 Sean D'Epagnier
#
# This Program is free software; you can redistribute it and/or
# modify it under the terms of the GNU General Public
# License as published by the Free Software Foundation; either
# version 3 of the License, or (at your option) any later version.
#
# Vanilla-JS calibration plot for the redesigned pypilot GUI.
# Ported from calibration_plot.js (no jQuery, embeddable in the SPA).
# Renders the raw IMU sensor points on a sphere via WebGL so calibration
# can be verified from the Calibration tab.
*/

(function () {
    "use strict";

    var gl = null, canvas = null, started = false;
    var shaderprogram, _Pmatrix, _Vmatrix, _Mmatrix, _color, _position;
    var sphere_vertex_buffer, point_history_buffer, sigmapoints_buffer, points_buffer;
    var sphere_vertices = [];
    var point_history = [], sigmapoints = [], points = [];
    var accel_calibration = [0, 0, 0, 1];
    var compass_calibration = [0, 0, 0, 30, 0];
    var currentPlot = "compass";
    var calibration_log = { accel: [], compass: [] };

    var proj_matrix, view_matrix, mo_matrix;
    var THETA = 0, PHI = 0, dX = 0, dY = 0, drag = false, old_x, old_y;
    var AMORTIZATION = 0.95;

    var plots = ["accel", "compass"];

    /* -------- geometry: tessellated icosahedron sphere wireframe -------- */
    function buildSphere() {
        var t = (1 + Math.sqrt(5)) / 2;
        var v = [[0, 1, t], [0, 1, -t], [0, -1, t], [0, -1, -t],
                 [1, t, 0], [1, -t, 0], [-1, t, 0], [-1, -t, 0],
                 [t, 0, 1], [t, 0, -1], [-t, 0, 1], [-t, 0, -1]];
        var d = Math.sqrt(1 + t * t);
        var i, j;
        for (i = 0; i < v.length; i++)
            for (j = 0; j < v.length; j++) v[i][j] /= d;
        var triangles = [[0, 2, 8], [0, 2, 10], [1, 3, 9], [1, 3, 11],
                         [4, 6, 0], [4, 6, 1], [5, 7, 2], [5, 7, 3],
                         [8, 9, 4], [8, 9, 5], [10, 11, 6], [10, 11, 7],
                         [0, 4, 8], [1, 6, 11], [5, 9, 3], [7, 11, 3],
                         [0, 10, 6], [1, 9, 4], [2, 8, 5], [2, 10, 7]];

        function normalize(x, y, z) { var l = Math.sqrt(x * x + y * y + z * z); return [x / l, y / l, z / l]; }
        function line(v0, v1) {
            var c = 4, k;
            for (k = 0; k < c; k++) {
                var d0 = k / c, d1 = (k + 1) / c;
                var va = normalize(v0[0] * (1 - d0) + v1[0] * d0, v0[1] * (1 - d0) + v1[1] * d0, v0[2] * (1 - d0) + v1[2] * d0);
                var vb = normalize(v0[0] * (1 - d1) + v1[0] * d1, v0[1] * (1 - d1) + v1[1] * d1, v0[2] * (1 - d1) + v1[2] * d1);
                sphere_vertices.push(va[0], va[1], va[2], vb[0], vb[1], vb[2]);
            }
        }
        function tess(v0, v1, v2, n) {
            if (n === 0) { line(v0, v1); line(v1, v2); line(v2, v0); return; }
            var va = normalize((v0[0] + v1[0]) / 2, (v0[1] + v1[1]) / 2, (v0[2] + v1[2]) / 2);
            var vb = normalize((v1[0] + v2[0]) / 2, (v1[1] + v2[1]) / 2, (v1[2] + v2[2]) / 2);
            var vc = normalize((v2[0] + v0[0]) / 2, (v2[1] + v0[1]) / 2, (v2[2] + v0[2]) / 2);
            tess(v0, vc, va, n - 1); tess(va, vb, v1, n - 1);
            tess(v2, vb, vc, n - 1); tess(va, vb, vc, n - 1);
        }
        for (var ti = 0; ti < triangles.length; ti++)
            tess(v[triangles[ti][0]], v[triangles[ti][1]], v[triangles[ti][2]], 1);
    }

    function compile(type, src) {
        var s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        return s;
    }

    function getProjection(angle, a, zMin, zMax) {
        var ang = Math.tan((angle * 0.5) * Math.PI / 180);
        return [0.5 / ang, 0, 0, 0, 0, 0.5 * a / ang, 0, 0,
                0, 0, -(zMax + zMin) / (zMax - zMin), -1,
                0, 0, (-2 * zMax * zMin) / (zMax - zMin), 0];
    }
    function rotateX(m, a) {
        var c = Math.cos(a), s = Math.sin(a), m1 = m[1], m5 = m[5], m9 = m[9];
        m[1] = m[1] * c - m[2] * s; m[5] = m[5] * c - m[6] * s; m[9] = m[9] * c - m[10] * s;
        m[2] = m[2] * c + m1 * s; m[6] = m[6] * c + m5 * s; m[10] = m[10] * c + m9 * s;
    }
    function rotateY(m, a) {
        var c = Math.cos(a), s = Math.sin(a), m0 = m[0], m4 = m[4], m8 = m[8];
        m[0] = c * m[0] + s * m[2]; m[4] = c * m[4] + s * m[6]; m[8] = c * m[8] + s * m[10];
        m[2] = c * m[2] - s * m0; m[6] = c * m[6] - s * m4; m[10] = c * m[10] - s * m8;
    }

    function animate() {
        if (!gl) return;
        if (!drag) { dX *= AMORTIZATION; dY *= AMORTIZATION; THETA += dX; PHI += dY; }
        gl.enable(gl.DEPTH_TEST);
        gl.clearColor(0, 0, 0, 1); gl.clearDepth(2);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        mo_matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        rotateY(mo_matrix, THETA); rotateX(mo_matrix, PHI);

        gl.uniformMatrix4fv(_Pmatrix, false, proj_matrix);
        gl.uniformMatrix4fv(_Vmatrix, false, view_matrix);
        gl.uniformMatrix4fv(_Mmatrix, false, mo_matrix);

        gl.uniform3f(_color, 0.2, 0.4, 0.9);
        gl.bindBuffer(gl.ARRAY_BUFFER, sphere_vertex_buffer);
        gl.vertexAttribPointer(_position, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.LINES, 0, sphere_vertices.length / 3);

        gl.uniform3f(_color, 1, 1, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, sigmapoints_buffer);
        gl.vertexAttribPointer(_position, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.POINTS, 0, sigmapoints.length);

        gl.uniform3f(_color, 0, 1, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, points_buffer);
        gl.vertexAttribPointer(_position, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.POINTS, 0, points.length);

        if (point_history.length >= 5) {
            gl.uniform3f(_color, 0, 1, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, point_history_buffer);
            gl.vertexAttribPointer(_position, 3, gl.FLOAT, false, 0, 0);
            gl.drawArrays(gl.POINTS, 0, point_history.length - 5);
            gl.uniform3f(_color, 1, 0, 0);
            gl.drawArrays(gl.POINTS, point_history.length - 5, 5);
        }
        window.requestAnimationFrame(animate);
    }

    function convertPoints(data, cal) {
        var p = [], x = cal[0], y = cal[1], z = cal[2], s = cal[3];
        for (var i = 0; i < data.length; i++) {
            var c = data[i];
            p.push((c[0] - x) / s, (c[1] - y) / s, (c[2] - z) / s);
        }
        return p;
    }

    function bindDrag() {
        function down(px, py) { drag = true; old_x = px; old_y = py; }
        function move(px, py) {
            if (!drag) return;
            dX = (px - old_x) * 2 * Math.PI / canvas.width;
            dY = (py - old_y) * 2 * Math.PI / canvas.height;
            THETA += dX; PHI += dY; old_x = px; old_y = py;
        }
        canvas.addEventListener("mousedown", function (e) { down(e.pageX, e.pageY); e.preventDefault(); });
        canvas.addEventListener("mouseup", function () { drag = false; });
        canvas.addEventListener("mouseout", function () { drag = false; });
        canvas.addEventListener("mousemove", function (e) { move(e.pageX, e.pageY); e.preventDefault(); });
        canvas.addEventListener("touchstart", function (e) { var t = e.touches[0]; down(t.pageX, t.pageY); e.preventDefault(); }, { passive: false });
        canvas.addEventListener("touchend", function () { drag = false; });
        canvas.addEventListener("touchmove", function (e) { var t = e.touches[0]; move(t.pageX, t.pageY); e.preventDefault(); }, { passive: false });
    }

    var CalPlot = {
        ok: false,
        currentPlot: function () { return currentPlot; },

        // names that should always be watched while the plot is visible
        metaWatches: function () {
            var names = ["imu.error", "imu.warning"];
            var suffix = [".calibration", ".calibration.age", ".calibration.log", ".calibration.warning"];
            for (var p = 0; p < plots.length; p++)
                for (var s = 0; s < suffix.length; s++)
                    names.push("imu." + plots[p] + suffix[s]);
            return names;
        },
        // per-plot point streams (heavier, only for the selected plot)
        plotWatches: function (plot) {
            return ["imu." + plot, "imu." + plot + ".calibration.sigmapoints", "imu." + plot + ".calibration.points"];
        },

        init: function (cvs) {
            if (started) return CalPlot.ok;
            canvas = cvs;
            try { gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl"); }
            catch (e) { gl = null; }
            if (!gl) { CalPlot.ok = false; return false; }

            buildSphere();
            sphere_vertex_buffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, sphere_vertex_buffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(sphere_vertices), gl.STATIC_DRAW);
            point_history_buffer = gl.createBuffer();
            sigmapoints_buffer = gl.createBuffer();
            points_buffer = gl.createBuffer();

            var vert = "attribute vec3 position;uniform mat4 Pmatrix;uniform mat4 Vmatrix;uniform mat4 Mmatrix;" +
                "void main(void){gl_Position=Pmatrix*Vmatrix*Mmatrix*vec4(position,1.);gl_PointSize=3.0;}";
            var frag = "precision mediump float;uniform vec3 vColor;void main(void){gl_FragColor=vec4(vColor,1.);}";
            shaderprogram = gl.createProgram();
            gl.attachShader(shaderprogram, compile(gl.VERTEX_SHADER, vert));
            gl.attachShader(shaderprogram, compile(gl.FRAGMENT_SHADER, frag));
            gl.linkProgram(shaderprogram);
            _Pmatrix = gl.getUniformLocation(shaderprogram, "Pmatrix");
            _Vmatrix = gl.getUniformLocation(shaderprogram, "Vmatrix");
            _Mmatrix = gl.getUniformLocation(shaderprogram, "Mmatrix");
            _color = gl.getUniformLocation(shaderprogram, "vColor");
            _position = gl.getAttribLocation(shaderprogram, "position");
            gl.enableVertexAttribArray(_position);
            gl.useProgram(shaderprogram);

            proj_matrix = getProjection(40, canvas.width / canvas.height, 1, 100);
            view_matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
            view_matrix[14] -= 3;

            bindDrag();
            started = true;
            CalPlot.ok = true;
            animate();
            return true;
        },

        setPlot: function (plot) {
            currentPlot = plot;
            point_history = [];
            sigmapoints = [];
            points = [];
        },

        // process a pypilot data object; updates buffers + info element ids
        handle: function (data) {
            var s, n, id, el;
            for (s = 0; s < 2; s++) {
                n = "imu." + ["error", "warning"][s];
                if (n in data) { el = document.getElementById("cal_imu_" + ["error", "warning"][s]); if (el) el.textContent = data[n] || ""; }
            }
            var infos = ["accel", "compass"], suffix = ["", "age", "log"];
            for (var a = 0; a < infos.length; a++)
                for (var b = 0; b < suffix.length; b++) {
                    var name = "imu." + infos[a] + ".calibration";
                    id = infos[a] + "_calibration";
                    if (suffix[b]) { name += "." + suffix[b]; id += "_" + suffix[b]; }
                    if (name in data) {
                        var value = data[name];
                        if (!suffix[b]) {
                            value = value[0];
                            if (infos[a] === "accel") accel_calibration = value; else compass_calibration = value;
                        }
                        if (suffix[b] === "log") {
                            calibration_log[infos[a]].push(value);
                            if (calibration_log[infos[a]].length > 4) calibration_log[infos[a]].shift();
                            value = calibration_log[infos[a]].join("\n");
                        }
                        el = document.getElementById(id);
                        if (el) el.textContent = (typeof value === "object") ? JSON.stringify(value) : value;
                    }
                }

            if (!CalPlot.ok) return;
            var cal = currentPlot === "accel" ? accel_calibration : compass_calibration;

            n = "imu." + currentPlot;
            if (n in data) {
                point_history.push(data[n]);
                if (point_history.length > 40) point_history.shift();
                gl.bindBuffer(gl.ARRAY_BUFFER, point_history_buffer);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(convertPoints(point_history, cal)), gl.STATIC_DRAW);
            }
            n = "imu." + currentPlot + ".calibration.sigmapoints";
            if (n in data && data[n]) {
                sigmapoints = data[n];
                gl.bindBuffer(gl.ARRAY_BUFFER, sigmapoints_buffer);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(convertPoints(sigmapoints, cal)), gl.STATIC_DRAW);
            }
            n = "imu." + currentPlot + ".calibration.points";
            if (n in data && data[n]) {
                points = data[n];
                gl.bindBuffer(gl.ARRAY_BUFFER, points_buffer);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(convertPoints(points, cal)), gl.STATIC_DRAW);
            }
        }
    };

    window.CalPlot = CalPlot;
})();
