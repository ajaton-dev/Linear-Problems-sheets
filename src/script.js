/* ============================================================================
 * SimplexTableauSheets.js — single-file, sectioned for scaling
 * ============================================================================
 *
 * SECTION MAP
 *  §1  Module state          S, k, STORAGE_KEY
 *  §2  Utilities             $, esc, sb
 *  §3  Core: Fraction        exact rational arithmetic (BigInt)
 *  §4  DOM contract          data-role scheme, selectors, cell builders
 *  §5  Problem form          read/render inputs, preview
 *  §6  Tableau parsing       DOM inputs → { tab } / Fraction[]
 *  §7  Simplex pivot logic   choose entering/leaving, pivot row ops, optimality
 *  §8  Problem model         gen(): validate form → S
 *  §9  Tableau rendering     addTable, renumber
 *  §10 Checking              per-cell compare, mark, reveal
 *  §11 Analysis & hints      optimality/unbounded/degen/multi, highlight
 *  §12 Presets               canned examples
 *  §13 Persistence           localStorage serialize/restore
 *  §14 Event wiring          addEventListener for all UI
 *  §15 Bootstrap             init()
 *
 * WHERE TO ADD FEATURES (quick guide)
 *  New objective/constraint inputs (≥, =, free vars)  → §5 + §8
 *  Big-M / two-phase / artificial vars               → §8 + §7 + §9
 *  Different pivot rule (Bland, max-improvement)     → §7 only
 *  Sensitivity / duals / shadow prices               → §11
 *  Export (CSV, LaTeX, clipboard)                    → §13 + §14
 *  Extra presets                                     → §12
 *  New module state fields                           → §1
 *  New UI hooks / buttons                            → §14
 *  New cell roles or attributes                      → §4 (single source of truth)
 * ============================================================================
 */
(function () {
  "use strict";

  /* ==========================================================================
   * §1  MODULE STATE
   * --------------------------------------------------------------------------
   * S          the current problem model (built by gen in §8)
   * k          tableau counter — see REFACTOR NOTE at renumber() (§9)
   * STORAGE_KEY  versioned so schema changes don't crash on old saves
   *
   * SCALE HERE: any new cross-cutting state (solver mode, current phase,
   *             comparison partner problem, …). Document lifecycle.
   * ========================================================================== */

  var S = null;
  var k = 0;
  var STORAGE_KEY = "simplex-sheet-v2-state";
  var restoring = false;

  /* ==========================================================================
   * §2  UTILITIES
   * --------------------------------------------------------------------------
   * Pure helpers with no dependencies. Safe to call anytime.
   *
   * SCALE HERE: generic string/format helpers. Nothing problem-specific.
   * ========================================================================== */

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }

  function sb(p, i) {
    return p + "<sub>" + i + "</sub>";
  }

  function notifyStaleTableaux() {
    if (!restoring && S && getTableSections().length > 0) {
      $("msg").textContent =
        "Problem form changed — existing tableaux belong to the previous problem. Click Generate to build tableaux for the updated problem.";
    }
  }

  /* ==========================================================================
   * §3  CORE: FRACTION ARITHMETIC
   * --------------------------------------------------------------------------
   * Exact rationals on BigInt. No DOM, no S. Fully unit-testable in Node.
   *
   * SCALE HERE: new operations (neg, pow, cmp, mod, toDecimal).
   *             Keep pure — no DOM references in this section ever.
   * ========================================================================== */

  function absBig(x) {
    return x < 0n ? -x : x;
  }

  function gcd(a, b) {
    while (b !== 0n) {
      var t = a % b;
      a = b;
      b = t;
    }
    return a || 1n;
  }

  function Fraction(n, d) {
    if (d === 0n) throw new Error("Zero denominator");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    var g = gcd(absBig(n), d);
    this.n = n / g;
    this.d = d / g;
  }

  Fraction.zero = function () {
    return new Fraction(0n, 1n);
  };

  Fraction.parseIntOrDec = function (s) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) return null;
    var neg = s[0] === "-";
    if (s[0] === "+" || s[0] === "-") s = s.slice(1);
    if (s.indexOf(".") === -1) {
      var ni = BigInt(s || "0");
      return new Fraction(neg ? -ni : ni, 1n);
    }
    var parts = s.split(".");
    var whole = parts[0] || "0";
    var dec = parts[1] || "";
    var den = 10n ** BigInt(dec.length);
    var num = BigInt(whole + dec);
    return new Fraction(neg ? -num : num, den);
  };

  Fraction.parse = function (s) {
    s = String(s || "")
      .trim()
      .replace(/\s+/g, "")
      .replace(/,/g, ".");
    if (!s) return null;
    var slash = s.indexOf("/");
    if (slash === -1) return Fraction.parseIntOrDec(s);
    if (
      slash === 0 ||
      slash === s.length - 1 ||
      s.indexOf("/", slash + 1) !== -1
    )
      return null;
    var a = Fraction.parseIntOrDec(s.slice(0, slash));
    var b = Fraction.parseIntOrDec(s.slice(slash + 1));
    if (!a || !b || b.n === 0n) return null;
    return a.div(b);
  };

  Fraction.prototype.add = function (o) {
    return new Fraction(this.n * o.d + o.n * this.d, this.d * o.d);
  };

  Fraction.prototype.sub = function (o) {
    return new Fraction(this.n * o.d - o.n * this.d, this.d * o.d);
  };

  Fraction.prototype.mul = function (o) {
    return new Fraction(this.n * o.n, this.d * o.d);
  };

  Fraction.prototype.div = function (o) {
    return new Fraction(this.n * o.d, this.d * o.n);
  };

  Fraction.prototype.eq = function (o) {
    return this.n === o.n && this.d === o.d;
  };

  Fraction.prototype.gt = function (o) {
    return this.n * o.d > o.n * this.d;
  };

  Fraction.prototype.lt = function (o) {
    return this.n * o.d < o.n * this.d;
  };

  Fraction.prototype.isZero = function () {
    return this.n === 0n;
  };

  Fraction.prototype.isPos = function () {
    return this.n > 0n;
  };

  Fraction.prototype.toString = function () {
    if (this.d === 1n) return this.n.toString();
    return this.n + "/" + this.d;
  };

  /* ==========================================================================
   * §4  DOM CONTRACT
   * --------------------------------------------------------------------------
   * The single source of truth for HOW the tableau DOM is addressed:
   *   <input data-role="…" data-row="…" data-col="…">
   *
   * cell() writes attributes; getInput() reads them; getTableSections()
   * lists all tableaux. Everything else in the app talks through this layer.
   *
   * SCALE HERE: adding a new role (e.g. "phase", "artificial", "dual") means
   *   adding it to the writes in §9 and the reads in §6/§10/§11. Do NOT
   *   hand-write `data-role="…"` strings anywhere else — build via cell().
   * ========================================================================== */

  function attrString(attrs) {
    var parts = [];
    Object.keys(attrs || {}).forEach(function (k2) {
      parts.push(" data-" + k2 + '="' + esc(attrs[k2]) + '"');
    });
    return parts.join("");
  }

  function cell(v, cls, attrs) {
    return (
      "<td" +
      (cls ? ' class="' + cls + '"' : "") +
      "><input" +
      attrString(attrs || {}) +
      ' value="' +
      esc(v) +
      '"></td>'
    );
  }

  function getTableSections() {
    return [].slice.call($("out").querySelectorAll("section.tableau"));
  }

  function getInput(section, role, row, col) {
    var sel = 'input[data-role="' + role + '"]';
    if (row != null) sel += '[data-row="' + row + '"]';
    if (col != null) sel += '[data-col="' + col + '"]';
    return section.querySelector(sel);
  }

  /* ==========================================================================
   * §5  PROBLEM FORM  (input + preview)
   * --------------------------------------------------------------------------
   * Reads the raw text inputs from #form and renders the "s.c." preview.
   * Never touches a tableau — this is upstream of everything.
   *
   * SCALE HERE: add new input columns (≥, =, free variables, integer flag).
   *   New constraint types need matching changes in §8 (gen) to interpret.
   *   All UI selectors live here; nothing else should read #form.
   * ========================================================================== */

  function readForm() {
    var res = { z: [], cons: [] };
    $("form")
      .querySelectorAll(".r")
      .forEach(function (r, i) {
        var v = [].map.call(r.querySelectorAll("input"), function (x) {
          return x.value.trim();
        });
        if (i === 0) res.z = v;
        else res.cons.push({ a: v.slice(0, -1), b: v[v.length - 1] });
      });
    return res;
  }

  function renderForm() {
    var o = readForm();
    var n = Math.max(1, Math.min(8, +$("nv").value || 1));
    var m = Math.max(1, Math.min(8, +$("mc").value || 1));
    var h = '<div class="row r"><b>Max z =</b>';
    var i;
    var j;

    for (j = 0; j < n; j++) {
      h +=
        '<input class="c" placeholder="x' +
        (j + 1) +
        '" value="' +
        esc(o.z[j] || "") +
        '">';
    }
    h += "</div>";

    for (i = 0; i < m; i++) {
      var c = o.cons[i] || { a: [], b: "" };
      h += '<div class="row r">';
      for (j = 0; j < n; j++) {
        h +=
          '<input class="c" placeholder="x' +
          (j + 1) +
          '" value="' +
          esc(c.a[j] || "") +
          '">';
      }
      h +=
        '<b>&le;</b><input class="c" placeholder="b" value="' +
        esc(c.b || "") +
        '"></div>';
    }

    $("form").innerHTML = h;
    preview();
    saveStateMaybe();
  }

  function expr(cs) {
    var out = "";
    cs.forEach(function (c, j) {
      c = String(c || "")
        .replace(/\s/g, "")
        .replace(/^\+/, "");
      if (c === "" || c === "0") return;
      var f = Fraction.parse(c);
      if (f && f.isZero()) return;
      var neg = c[0] === "-";
      var mag = neg ? c.slice(1) : c;
      var t = (mag === "1" ? "" : esc(mag)) + sb("x", j + 1);
      out = out === "" ? (neg ? "-" : "") + t : out + (neg ? " - " : " + ") + t;
    });
    return out || "0";
  }

  function preview() {
    var f = readForm();
    var n = f.z.length;
    var names = [];
    var j;

    for (j = 1; j <= n; j++) names.push(sb("x", j));
    var lines = f.cons.map(function (c) {
      return "<div>" + expr(c.a) + " &le; " + esc(c.b || "0") + "</div>";
    });
    lines.push("<div>" + names.join(", ") + " &ge; 0</div>");

    $("prev").innerHTML =
      "<div>Max z = " +
      expr(f.z) +
      '</div><div class="sc"><span>s.c.</span><span class="brace" style="font-size:' +
      Math.max(1.8, f.cons.length * 1.6) +
      'em">{</span><div>' +
      lines.join("") +
      "</div></div>";
  }

  /* ==========================================================================
   * §6  TABLEAU PARSING  (DOM → data)
   * --------------------------------------------------------------------------
   * Turns the user-typed cells of one <section class="tableau"> into plain
   * data objects. No math, no policy — just "what did the user write?"
   *
   * parseCell       single cell → { empty, frac }
   * normBasisLabel  "X_3" / "x3" → "x3" (canonical form)
   * parseObjective  z inputs → Fraction[] padded with m zeros for slacks
   * parseTableau    whole tableau → { basis, cb, A, b, ratios, zj, cjz, zval }
   * getCjFractions  S.cj as Fraction[] (used by pivot math)
   *
   * REFACTOR NOTE: parseTableau and getCjFractions read S.n/S.m/S.cj. Passing
   * S in as an explicit `problem` parameter would make them portable and
   * testable without the global. Not applied yet.
   *
   * SCALE HERE: add parsers for any new cell roles (§4). Nothing in this
   *   section should decide *what to do* with the parsed values.
   * ========================================================================== */

  function normBasisLabel(v) {
    var s = String(v || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
    if (!s) return "";
    var m = s.match(/^([xs])_?(\d+)$/);
    if (!m) return "";
    return m[1] + parseInt(m[2], 10);
  }

  function parseCell(text) {
    var raw = String(text || "").trim();
    if (!raw) return { empty: true, frac: null };
    var f = Fraction.parse(raw);
    if (!f) return { empty: false, frac: null };
    return { empty: false, frac: f };
  }

  function parseObjective(z, m) {
    var out = [];
    var j;
    for (j = 0; j < z.length; j++) {
      var f = Fraction.parse((z[j] || "0").trim() || "0");
      if (!f) return null;
      out.push(f);
    }
    for (var i = 0; i < m; i++) out.push(Fraction.zero());
    return out;
  }

  function parseTableau(section, strict) {
    var m = S.m;
    var N = S.n + S.m;
    var i;
    var j;
    var basis = [];
    var A = [];
    var b = [];
    var cb = [];
    var ratios = [];
    var zj = [];
    var cjz = [];

    for (i = 0; i < m; i++) {
      var bi = getInput(section, "basis", i);
      basis.push(normBasisLabel(bi ? bi.value : ""));

      var cbi = parseCell(getInput(section, "cb", i).value);
      var bbi = parseCell(getInput(section, "b", i).value);
      var ri = parseCell(getInput(section, "ratio", i).value);
      if (strict && (!cbi.frac || !bbi.frac)) return null;

      cb.push(cbi.frac);
      b.push(bbi.frac);
      ratios.push(ri.frac);

      var row = [];
      for (j = 0; j < N; j++) {
        var aij = parseCell(getInput(section, "a", i, j).value);
        if (strict && !aij.frac) return null;
        row.push(aij.frac);
      }
      A.push(row);
    }

    for (j = 0; j < N; j++) {
      var zjj = parseCell(getInput(section, "zj", null, j).value);
      var cjj = parseCell(getInput(section, "cjz", null, j).value);
      if (strict && (!zjj.frac || !cjj.frac)) return null;
      zj.push(zjj.frac);
      cjz.push(cjj.frac);
    }

    var zv = parseCell(getInput(section, "zval").value);
    if (strict && !zv.frac) return null;

    return {
      basis: basis,
      cb: cb,
      A: A,
      b: b,
      ratios: ratios,
      zj: zj,
      cjz: cjz,
      zval: zv.frac,
    };
  }

  function getCjFractions() {
    return S.cj.map(function (v) {
      return Fraction.parse(v);
    });
  }

  /* ==========================================================================
   * §7  SIMPLEX PIVOT LOGIC  (the "brain")
   * --------------------------------------------------------------------------
   * computeStandardChoice(tab)
   *     Dantzig rule: pick max positive c_j − z_j; break ratio ties.
   *     Returns { entering, enteringSet, leavingSet, ratioTie }.
   *
   * buildExpectedNext(prev, currBasis)
   *     Given the user's chosen new basis, produce the expected next tableau
   *     (or an { error } explaining why the pivot is invalid).
   *
   * tableauOptimal(tab)
   *     Every c_j − z_j ≤ 0. No pivot candidates.
   *
   * REFACTOR NOTE: all three read S.n / S.m / S.varKeys / S.cj from module
   * state. Passing `problem` as a parameter would make them pure and let you
   * unit-test them, or run two problems side-by-side. Not applied yet.
   *
   * SCALE HERE: pivot-rule strategies go here. To add Bland's rule, extract
   *   an `enteringRule(tab, problem)` interface and swap at call sites.
   *   Adding artificial-variable handling (Big-M, two-phase) also lives here.
   * ========================================================================== */

  function computeStandardChoice(tab) {
    var N = S.n + S.m;
    var m = S.m;
    var nonBasic = [];
    var j;

    for (j = 0; j < N; j++) {
      if (tab.basis.indexOf(S.varKeys[j]) === -1) nonBasic.push(j);
    }

    var max = null;
    var enterSet = [];
    nonBasic.forEach(function (col) {
      var v = tab.cjz[col];
      if (!v || !v.isPos()) return;
      if (max === null || v.gt(max)) {
        max = v;
        enterSet = [col];
      } else if (v.eq(max)) {
        enterSet.push(col);
      }
    });

    if (!enterSet.length) {
      return {
        enteringSet: [],
        leavingSet: [],
        entering: null,
        ratioTie: false,
      };
    }

    var entering = enterSet[0];
    var minRatio = null;
    var leavingSet = [];
    var i;
    for (i = 0; i < m; i++) {
      var a = tab.A[i][entering];
      var bb = tab.b[i];
      if (!a || !bb || !a.isPos()) continue;
      var r = bb.div(a);
      if (minRatio === null || r.lt(minRatio)) {
        minRatio = r;
        leavingSet = [i];
      } else if (r.eq(minRatio)) {
        leavingSet.push(i);
      }
    }

    return {
      enteringSet: enterSet,
      leavingSet: leavingSet,
      entering: entering,
      ratioTie: leavingSet.length > 1,
    };
  }

  function buildExpectedNext(prev, currBasis) {
    var m = S.m;
    var N = S.n + S.m;
    var i;
    var j;

    var diffs = [];
    for (i = 0; i < m; i++) {
      if (currBasis[i] && currBasis[i] !== prev.basis[i]) diffs.push(i);
    }
    if (diffs.length !== 1) {
      return {
        error:
          "Set basis labels so exactly one row changes from the previous tableau.",
      };
    }

    var leaveRow = diffs[0];
    var enterKey = currBasis[leaveRow];
    var enterCol = S.varKeys.indexOf(enterKey);
    if (enterCol === -1) {
      return {
        error: "The new basic variable label is invalid. Use x1..xn or s1..sm.",
      };
    }
    for (i = 0; i < m; i++) {
      if (i !== leaveRow && prev.basis[i] === enterKey) {
        return {
          error:
            "Basic variable " +
            enterKey +
            " is already basic in another row of the previous tableau.",
        };
      }
    }
    if (!prev.A[leaveRow][enterCol] || prev.A[leaveRow][enterCol].isZero()) {
      return { error: "Pivot element is zero, so this pivot is invalid." };
    }

    var basis = prev.basis.slice();
    basis[leaveRow] = enterKey;

    var piv = prev.A[leaveRow][enterCol];
    var pRow = [];
    for (j = 0; j < N; j++) pRow.push(prev.A[leaveRow][j].div(piv));
    var pB = prev.b[leaveRow].div(piv);

    var A = [];
    var b = [];
    for (i = 0; i < m; i++) {
      if (i === leaveRow) {
        A.push(pRow.slice());
        b.push(pB);
      } else {
        var f = prev.A[i][enterCol];
        var nr = [];
        for (j = 0; j < N; j++) nr.push(prev.A[i][j].sub(f.mul(pRow[j])));
        A.push(nr);
        b.push(prev.b[i].sub(f.mul(pB)));
      }
    }

    var cj = getCjFractions();
    var cb = basis.map(function (bk) {
      return cj[S.varKeys.indexOf(bk)] || Fraction.zero();
    });

    var zj = [];
    for (j = 0; j < N; j++) {
      var zsum = Fraction.zero();
      for (i = 0; i < m; i++) zsum = zsum.add(cb[i].mul(A[i][j]));
      zj.push(zsum);
    }

    var zval = Fraction.zero();
    for (i = 0; i < m; i++) zval = zval.add(cb[i].mul(b[i]));

    var cjz = [];
    for (j = 0; j < N; j++) cjz.push(cj[j].sub(zj[j]));

    var standard = computeStandardChoice(prev);
    var soft = [];
    if (
      standard.enteringSet.length &&
      standard.enteringSet.indexOf(enterCol) === -1
    ) {
      soft.push(
        "Soft note: entering variable is not from the largest c_j - z_j set (ties are valid).",
      );
    }
    if (
      standard.enteringSet.indexOf(enterCol) !== -1 &&
      standard.leavingSet.length
    ) {
      if (standard.leavingSet.indexOf(leaveRow) === -1) {
        soft.push(
          "Soft note: leaving row is not from the minimum ratio set (ties are valid).",
        );
      }
    }

    return {
      basis: basis,
      cb: cb,
      A: A,
      b: b,
      zj: zj,
      cjz: cjz,
      zval: zval,
      enterCol: enterCol,
      soft: soft.join(" "),
    };
  }

  function tableauOptimal(tab) {
    return tab.cjz.every(function (v) {
      return v && !v.isPos();
    });
  }

  /* ==========================================================================
   * §8  PROBLEM MODEL  (gen)
   * --------------------------------------------------------------------------
   * Validates the form, builds the initial S object, and kicks off the first
   * tableau. This is the ONLY place S is created.
   *
   * SCALE HERE: where problem representation grows.
   *   - ≥ / = constraints, slack/surplus/artificial vars  → here
   *   - Big-M cost injection                              → here (before addTable)
   *   - Two-phase setup (phase I objective)               → here
   *   - Free-variable expansion (x = x⁺ − x⁻)             → here
   * All downstream code reads S; it should never be mutated after gen.
   * ========================================================================== */

  function gen() {
    var f = readForm();
    var n = f.z.length;
    var m = f.cons.length;
    var vars = [];
    var varKeys = [];
    var i;
    var j;

    var z = f.z.map(function (v) {
      return (v || "0").trim() || "0";
    });

    var zFr = parseObjective(z, m);
    if (!zFr) {
      $("msg").textContent = "Invalid objective coefficient format.";
      return;
    }
    if (
      zFr.slice(0, n).every(function (v) {
        return v.isZero();
      })
    ) {
      $("msg").textContent =
        "Enter at least one non-zero objective coefficient.";
      return;
    }

    var A = [];
    var b = [];
    for (i = 0; i < m; i++) {
      var row = [];
      for (j = 0; j < n; j++) {
        var af = Fraction.parse((f.cons[i].a[j] || "0").trim() || "0");
        if (!af) {
          $("msg").textContent = "Invalid constraint coefficient format.";
          return;
        }
        row.push(af.toString());
      }
      var bf = Fraction.parse((f.cons[i].b || "0").trim() || "0");
      if (!bf) {
        $("msg").textContent = "Invalid right-hand side format.";
        return;
      }
      A.push(row);
      b.push(bf.toString());
    }

    var neg = b.some(function (v) {
      var fp = Fraction.parse(v);
      return fp && fp.lt(Fraction.zero());
    });

    $("msg").textContent = neg
      ? "A right-hand side is negative: the all-slack starting basis is not feasible, so plain simplex does not apply directly."
      : "";

    for (j = 1; j <= n; j++) {
      vars.push(sb("x", j));
      varKeys.push("x" + j);
    }
    for (i = 1; i <= m; i++) {
      vars.push(sb("s", i));
      varKeys.push("s" + i);
    }

    S = {
      n: n,
      m: m,
      vars: vars,
      varKeys: varKeys,
      cj: zFr.map(function (x) {
        return x.toString();
      }),
      A: A,
      b: b,
      st: document.querySelector('input[name="st"]:checked').value,
    };

    k = 0;
    $("out").innerHTML = "";
    $("resultBox").hidden = true;
    addTable(true);
    $("bar").hidden = false;
    saveStateMaybe();
  }

  /* ==========================================================================
   * §9  TABLEAU RENDERING
   * --------------------------------------------------------------------------
   * addTable(first)  builds one <section class="tableau"> and appends it.
   * renumber()       relabels all tableaux 1..N and syncs k.
   *
   * REFACTOR NOTE: k (module state) and sections.length (DOM) are two sources
   *   of truth. renumber() re-derives k from the DOM. Future: drop k and
   *   compute on demand, or make renumber the only writer.
   *
   * SCALE HERE: adding columns (artificial vars, phase label, dual row,
   *   shadow price column). Layout only — no math, no policy.
   * ========================================================================== */

  function addTable(first) {
    k++;
    var n = S.n;
    var m = S.m;
    var N = n + m;
    var B = S.st === "B";
    var h;
    var i;
    var j;

    var tctl =
      '<div class="tctl">' +
      (!first
        ? '<button class="ghost" data-act="check">Check my work</button><button class="ghost" data-act="reveal">Reveal tableau</button>'
        : "") +
      '<button class="ghost" data-act="remove">Remove</button></div>';

    h =
      '<section class="tableau"><div class="tt"><b>Tableau ' +
      k +
      "</b>" +
      tctl +
      '</div><div class="wrap"><table>';

    var vh = S.vars
      .map(function (v, idx) {
        return (
          "<th" + (idx === 0 && !B ? ' class="sepl"' : "") + ">" + v + "</th>"
        );
      })
      .join("");

    if (B) {
      h +=
        '<tr><th>Max</th><th colspan="2">C<sub>j</sub></th>' +
        S.cj
          .map(function (v) {
            return "<th>" + esc(v) + "</th>";
          })
          .join("") +
        "<th></th></tr>";
      h +=
        "<tr><th>c<sub>B</sub></th><th>B</th><th>b</th>" +
        vh +
        "<th>Ratio</th></tr>";
    } else {
      h +=
        "<tr><th>Basis</th><th>c<sub>B</sub></th>" +
        vh +
        '<th class="sepl">b</th><th>Ratio</th></tr>';
    }

    for (i = 0; i < m; i++) {
      var vals = [];
      for (j = 0; j < N; j++) {
        vals.push(first ? (j < n ? S.A[i][j] : j - n === i ? "1" : "0") : "");
      }
      var cb = first ? "0" : "";
      var bs = first ? "s" + (i + 1) : "";
      var bv = first ? S.b[i] : "";
      var cells = vals
        .map(function (v, idx) {
          return cell(v, idx === 0 && !B ? "sepl" : "", {
            role: "a",
            row: i,
            col: idx,
          });
        })
        .join("");

      h +=
        "<tr>" +
        (B
          ? cell(cb, "", { role: "cb", row: i }) +
            cell(bs, "b", { role: "basis", row: i }) +
            cell(bv, "", { role: "b", row: i }) +
            cells +
            cell("", "", { role: "ratio", row: i })
          : cell(bs, "b", { role: "basis", row: i }) +
            cell(cb, "", { role: "cb", row: i }) +
            cells +
            cell(bv, "sepl", { role: "b", row: i }) +
            cell("", "", { role: "ratio", row: i })) +
        "</tr>";
    }

    var zr = [];
    var cr = [];
    for (j = 0; j < N; j++) {
      zr.push(first ? "0" : "");
      cr.push(first ? S.cj[j] : "");
    }

    var zc = zr
      .map(function (v, idx) {
        return cell(v, idx === 0 && !B ? "sepl" : "", {
          role: "zj",
          col: idx,
        });
      })
      .join("");

    var cc = cr
      .map(function (v, idx) {
        return cell(v, idx === 0 && !B ? "sepl" : "", {
          role: "cjz",
          col: idx,
        });
      })
      .join("");

    if (B) {
      h +=
        '<tr class="z"><td></td><td class="lab">Z<sub>j</sub></td>' +
        cell(first ? "0" : "", "", { role: "zval" }) +
        zc +
        "<td></td></tr>";
      h +=
        '<tr><td class="lab" colspan="3">C<sub>j</sub> - Z<sub>j</sub></td>' +
        cc +
        "<td></td></tr>";
    } else {
      h +=
        '<tr class="z"><td></td><td class="lab">z<sub>j</sub></td>' +
        zc +
        cell(first ? "0" : "", "sepl", { role: "zval" }) +
        "<td></td></tr>";
      h +=
        '<tr><td></td><td class="lab">c<sub>j</sub> - z<sub>j</sub></td>' +
        cc +
        '<td class="sepl"></td><td></td></tr>';
    }

    h += '</table></div><div class="note" data-note></div></section>';
    $("out").insertAdjacentHTML("beforeend", h);
    updateHints();
    renumber();
    saveStateMaybe();
  }

  function renumber() {
    var sections = getTableSections();
    sections.forEach(function (sec, idx) {
      var b = sec.querySelector(".tt > b");
      if (b) b.textContent = "Tableau " + (idx + 1);
    });
    k = sections.length;
  }

  /* ==========================================================================
   * §10  CHECKING USER WORK
   * --------------------------------------------------------------------------
   * clearMarks / mark       per-td visual feedback
   * compareAndMark          diff user's tableau against the expected one
   * fillTableau             "Reveal" — fill in the expected values
   *
   * SCALE HERE: new validation modes (strict pivot rule, partial credit,
   *   "show only wrong cells"). All logic for "did the user get it right"
   *   belongs here.
   * ========================================================================== */

  function clearMarks(section) {
    section.querySelectorAll("td").forEach(function (td) {
      td.classList.remove("chk-ok", "chk-bad");
      td.removeAttribute("data-mark");
      td.removeAttribute("title");
    });
  }

  function mark(input, ok, expected) {
    if (!input) return;
    var td = input.parentElement;
    td.classList.remove("chk-ok", "chk-bad");
    td.removeAttribute("title");
    td.removeAttribute("data-mark");
    td.classList.add(ok ? "chk-ok" : "chk-bad");
    td.setAttribute("data-mark", ok ? "OK" : "ERR");
    if (!ok) td.title = "Expected: " + expected;
  }

  function compareAndMark(currSection, expected, prevSection, prevTab) {
    clearMarks(currSection);
    if (prevSection) clearMarks(prevSection);
    var m = S.m;
    var N = S.n + S.m;
    var i;
    var j;
    var checked = 0;
    var wrong = 0;

    function compareNum(input, want) {
      var p = parseCell(input.value);
      if (p.empty) return;
      checked++;
      if (!p.frac) {
        wrong++;
        mark(input, false, want.toString());
        return;
      }
      var ok = p.frac.eq(want);
      if (!ok) wrong++;
      mark(input, ok, want.toString());
    }

    function compareText(input, want) {
      var v = String(input.value || "").trim();
      if (!v) return;
      checked++;
      var ok = normBasisLabel(v) === want;
      if (!ok) wrong++;
      mark(input, ok, want);
    }

    for (i = 0; i < m; i++) {
      compareText(getInput(currSection, "basis", i), expected.basis[i]);
      compareNum(getInput(currSection, "cb", i), expected.cb[i]);
      compareNum(getInput(currSection, "b", i), expected.b[i]);
      for (j = 0; j < N; j++)
        compareNum(getInput(currSection, "a", i, j), expected.A[i][j]);
    }
    compareNum(getInput(currSection, "zval"), expected.zval);
    for (j = 0; j < N; j++) {
      compareNum(getInput(currSection, "zj", null, j), expected.zj[j]);
      compareNum(getInput(currSection, "cjz", null, j), expected.cjz[j]);
    }

    if (prevSection && prevTab && expected.enterCol != null) {
      for (i = 0; i < m; i++) {
        var ratioInp = getInput(prevSection, "ratio", i);
        if (!ratioInp) continue;
        var aie = prevTab.A[i][expected.enterCol];
        var bi = prevTab.b[i];
        var p = parseCell(ratioInp.value);
        if (p.empty) continue;
        checked++;
        if (aie && aie.isPos() && bi) {
          var wantRatio = bi.div(aie);
          if (!p.frac) {
            wrong++;
            mark(ratioInp, false, wantRatio.toString());
          } else {
            var okRatio = p.frac.eq(wantRatio);
            if (!okRatio) wrong++;
            mark(ratioInp, okRatio, wantRatio.toString());
          }
        } else {
          wrong++;
          mark(ratioInp, false, "N/A (a_ie <= 0)");
        }
      }
    }

    return { checked: checked, wrong: wrong };
  }

  function fillTableau(section, exp) {
    var m = S.m;
    var N = S.n + S.m;
    var i;
    var j;

    for (i = 0; i < m; i++) {
      getInput(section, "basis", i).value = exp.basis[i];
      getInput(section, "cb", i).value = exp.cb[i].toString();
      getInput(section, "b", i).value = exp.b[i].toString();
      getInput(section, "ratio", i).value = "";
      for (j = 0; j < N; j++)
        getInput(section, "a", i, j).value = exp.A[i][j].toString();
    }

    getInput(section, "zval").value = exp.zval.toString();
    for (j = 0; j < N; j++) {
      getInput(section, "zj", null, j).value = exp.zj[j].toString();
      getInput(section, "cjz", null, j).value = exp.cjz[j].toString();
    }

    clearMarks(section);
    var note = section.querySelector("[data-note]");
    note.textContent =
      "Revealed from your chosen pivot." + (exp.soft ? " " + exp.soft : "");
    updateHints();
    saveStateMaybe();
  }

  /* ==========================================================================
   * §11  ANALYSIS & HINTS
   * --------------------------------------------------------------------------
   * analyse(section, forced)   optimality, unbounded, multi-optima, degenerate
   * updateHints()              highlight the standard-rule pivot (col + row)
   *
   * SCALE HERE: sensitivity analysis, shadow prices, dual solution, reduced
   *   costs, per-tableau history summary. All "what does this tableau mean"
   *   logic belongs here. Keep it read-only against S + tab.
   * ========================================================================== */

  function analyse(section, forced) {
    if (!S) {
      $("msg").textContent = "Generate a tableau first.";
      return;
    }

    var sec = section || getTableSections().slice(-1)[0];
    if (!sec) return;

    var tab = parseTableau(sec, true);
    if (!tab) {
      $("msg").textContent =
        "Fill this tableau with valid numbers before analysis.";
      return;
    }

    var N = S.n + S.m;
    var m = S.m;
    var n = S.n;
    var j;

    var nonBasic = [];
    for (j = 0; j < N; j++) {
      if (tab.basis.indexOf(S.varKeys[j]) === -1) nonBasic.push(j);
    }

    var optimal = tableauOptimal(tab);
    var unbounded = false;
    nonBasic.forEach(function (col) {
      if (!tab.cjz[col] || !tab.cjz[col].isPos()) return;
      var hasPos = false;
      for (var i = 0; i < m; i++) {
        if (tab.A[i][col] && tab.A[i][col].isPos()) {
          hasPos = true;
          break;
        }
      }
      if (!hasPos) unbounded = true;
    });

    var multi = false;
    if (optimal) {
      nonBasic.forEach(function (col) {
        if (tab.cjz[col] && tab.cjz[col].isZero()) multi = true;
      });
    }

    var degBasic = tab.b.some(function (bv) {
      return bv && bv.isZero();
    });
    var std = computeStandardChoice(tab);
    var degTie = std.ratioTie;
    var degenerate = degBasic || degTie;

    if (!forced && !optimal) return;

    var xVals = new Array(n).fill(Fraction.zero());
    for (var r = 0; r < m; r++) {
      var bidx = S.varKeys.indexOf(tab.basis[r]);
      if (bidx >= 0 && bidx < n) xVals[bidx] = tab.b[r];
    }

    var z = tab.zval;
    if (!z) {
      z = Fraction.zero();
      var cj = getCjFractions();
      for (j = 0; j < n; j++) z = z.add(cj[j].mul(xVals[j]));
    }

    var lines = [];
    lines.push("<h2>Analysis</h2>");
    if (unbounded) lines.push('<div><span class="pill">Unbounded</span></div>');
    else if (optimal)
      lines.push('<div><span class="pill">Optimal tableau</span></div>');
    else lines.push('<div><span class="pill">Not yet optimal</span></div>');

    lines.push(
      "<div><b>Solution:</b> " +
        xVals
          .map(function (v, idx) {
            return "x" + (idx + 1) + " = " + v.toString();
          })
          .join(", ") +
        "</div>",
    );
    lines.push("<div><b>z</b> = " + z.toString() + "</div>");
    lines.push(
      "<div><b>Cases:</b> " +
        [
          unbounded ? "Unbounded" : "Bounded at this tableau",
          multi ? "Multiple optima" : "No multiple-optima flag",
          degenerate ? "Degenerate" : "Non-degenerate",
        ].join(" | ") +
        "</div>",
    );

    if (degTie)
      lines.push(
        '<div class="note">Ratio tie detected in the standard pivot rule.</div>',
      );

    $("resultBox").innerHTML = lines.join("");
    $("resultBox").hidden = false;
  }

  function updateHints() {
    var on = $("hint").checked;
    getTableSections().forEach(function (sec) {
      sec.querySelectorAll("td").forEach(function (td) {
        td.classList.remove("hint-col", "hint-row");
      });
      if (!on) return;
      var tab = parseTableau(sec, true);
      if (!tab) return;
      var std = computeStandardChoice(tab);
      if (std.entering == null || !std.leavingSet.length) return;
      var e = std.entering;
      var r = std.leavingSet[0];
      sec
        .querySelectorAll('input[data-col="' + e + '"]')
        .forEach(function (inp) {
          inp.parentElement.classList.add("hint-col");
        });
      ["basis", "cb", "b", "ratio"].forEach(function (role) {
        var inp = getInput(sec, role, r);
        if (inp) inp.parentElement.classList.add("hint-row");
      });
      for (var j = 0; j < S.n + S.m; j++) {
        var aij = getInput(sec, "a", r, j);
        if (aij) aij.parentElement.classList.add("hint-row");
      }
    });
  }

  /* ==========================================================================
   * §12  PRESETS
   * --------------------------------------------------------------------------
   * Canned examples. Zero coupling to anything else except loadPreset,
   *   which writes to the form (§5) and calls renderForm.
   *
   * SCALE HERE: add new examples. Each is {label, z, cons}. If your new
   *   features (≥, =, phases) need different preset shapes, extend here and
   *   loadPreset; nothing else changes.
   * ========================================================================== */

  var PRESETS = {
    p1: {
      label: "P1",
      z: ["3", "2"],
      cons: [
        { a: ["1", "1"], b: "4" },
        { a: ["2", "1"], b: "5" },
      ],
    },
    p2: {
      label: "P2",
      z: ["5", "4", "3"],
      cons: [
        { a: ["2", "3", "1"], b: "5" },
        { a: ["4", "1", "2"], b: "11" },
        { a: ["3", "4", "2"], b: "8" },
      ],
    },
    p3: {
      label: "P3",
      z: ["100", "200"],
      cons: [
        { a: ["1", "1"], b: "150" },
        { a: ["4", "2"], b: "440" },
        { a: ["1", "4"], b: "480" },
        { a: ["1", "0"], b: "90" },
      ],
    },
    p4: {
      label: "P4",
      z: ["60", "30", "50"],
      cons: [
        { a: ["1", "1", "1"], b: "10" },
        { a: ["2", "1", "3"], b: "18" },
        { a: ["1", "2", "1"], b: "12" },
      ],
    },
    unb: {
      label: "Unbounded",
      z: ["3", "1"],
      cons: [
        { a: ["1", "0"], b: "8" },
        { a: ["2", "-3"], b: "5" },
      ],
    },
    mul: {
      label: "Multiple optima",
      z: ["1", "2"],
      cons: [{ a: ["1", "2"], b: "10" }],
    },
    deg: {
      label: "Degenerate",
      z: ["3", "9"],
      cons: [
        { a: ["1", "4"], b: "8" },
        { a: ["1", "2"], b: "4" },
      ],
    },
  };
  function buildPresetButtons() {
    $("presets").innerHTML = Object.keys(PRESETS)
      .map(function (k2) {
        return (
          '<button class="ghost" data-preset="' +
          k2 +
          '">' +
          esc(PRESETS[k2].label) +
          "</button>"
        );
      })
      .join("");
  }
  function loadPreset(id) {
    var p = PRESETS[id];
    if (!p) return;
    $("nv").value = p.z.length;
    $("mc").value = p.cons.length;
    renderForm();

    var rows = $("form").querySelectorAll(".r");
    rows[0].querySelectorAll("input").forEach(function (inp, j) {
      inp.value = p.z[j] || "0";
    });
    for (var i = 1; i < rows.length; i++) {
      var c = p.cons[i - 1];
      var ins = rows[i].querySelectorAll("input");
      for (var j = 0; j < p.z.length; j++) ins[j].value = c.a[j] || "0";
      ins[p.z.length].value = c.b;
    }

    preview();
    notifyStaleTableaux();
    saveStateMaybe();
  }

  /* ==========================================================================
   * §13  PERSISTENCE
   * --------------------------------------------------------------------------
   * localStorage serialize / restore, guarded with try/catch. Schema is
   * versioned via STORAGE_KEY.
   *
   * SCALE HERE: any new state (solver mode, problem history, comparison
   *   partner, export format choice) must be added to BOTH serializeTables /
   *   saveStateMaybe AND restoreState. Bump STORAGE_KEY before changing shape.
   * ========================================================================== */

  function safeReadStorage() {
    try {
      var txt = localStorage.getItem(STORAGE_KEY);
      if (!txt) return null;
      return JSON.parse(txt);
    } catch (_e) {
      return null;
    }
  }

  function safeWriteStorage(obj) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch (_e) {}
  }

  function safeRemoveStorage() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_e) {}
  }

  function serializeTables() {
    return getTableSections().map(function (sec) {
      return [].map
        .call(sec.querySelectorAll("input[data-role]"), function (inp) {
          return {
            role: inp.getAttribute("data-role"),
            row: inp.getAttribute("data-row"),
            col: inp.getAttribute("data-col"),
            value: inp.value,
          };
        })
        .filter(function (x) {
          return x.role;
        });
    });
  }

  function rebuildProblemFromSaved(prob, fallbackStyle) {
    if (!prob || typeof prob.n !== "number" || typeof prob.m !== "number")
      return false;
    var n = prob.n;
    var m = prob.m;
    var vars = [];
    var varKeys = [];
    var i;
    var j;

    var rawCj = Array.isArray(prob.cj) ? prob.cj.slice(0, n) : [];
    while (rawCj.length < n) rawCj.push("0");
    var zFr = parseObjective(rawCj, m);
    if (!zFr) return false;

    var A = [];
    var b = [];
    for (i = 0; i < m; i++) {
      var srcRow = (prob.A && prob.A[i]) || [];
      var row = [];
      for (j = 0; j < n; j++) {
        var af = Fraction.parse(srcRow[j] != null ? srcRow[j] : "0");
        if (!af) return false;
        row.push(af.toString());
      }
      var bf = Fraction.parse(prob.b && prob.b[i] != null ? prob.b[i] : "0");
      if (!bf) return false;
      A.push(row);
      b.push(bf.toString());
    }

    for (j = 1; j <= n; j++) {
      vars.push(sb("x", j));
      varKeys.push("x" + j);
    }
    for (i = 1; i <= m; i++) {
      vars.push(sb("s", i));
      varKeys.push("s" + i);
    }

    S = {
      n: n,
      m: m,
      vars: vars,
      varKeys: varKeys,
      cj: zFr.map(function (x) {
        return x.toString();
      }),
      A: A,
      b: b,
      st: prob.st || prob.style || fallbackStyle || "A",
    };
    return true;
  }

  function saveStateMaybe() {
    if (restoring || !$("autosave").checked) return;
    var state = {
      nv: $("nv").value,
      mc: $("mc").value,
      st: document.querySelector('input[name="st"]:checked').value,
      form: readForm(),
      hasS: !!S,
      problem: S
        ? {
            n: S.n,
            m: S.m,
            cj: S.cj.slice(),
            A: S.A.map(function (r) {
              return r.slice();
            }),
            b: S.b.slice(),
            st: S.st,
          }
        : null,
      tables: S ? serializeTables() : [],
      hint: $("hint").checked,
      autosave: true,
    };
    safeWriteStorage(state);
  }

  function restoreState(st) {
    if (!st) return;
    restoring = true;
    try {
      $("autosave").checked = !!st.autosave;
      if (st.nv) $("nv").value = st.nv;
      if (st.mc) $("mc").value = st.mc;
      renderForm();

      if (st.form) {
        var rows = $("form").querySelectorAll(".r");
        rows[0].querySelectorAll("input").forEach(function (inp, j) {
          inp.value = (st.form.z && st.form.z[j]) || "";
        });
        for (var i = 1; i < rows.length; i++) {
          var cons = (st.form.cons && st.form.cons[i - 1]) || { a: [], b: "" };
          var ins = rows[i].querySelectorAll("input");
          for (var j = 0; j < ins.length - 1; j++)
            ins[j].value = cons.a[j] || "";
          ins[ins.length - 1].value = cons.b || "";
        }
      }

      preview();

      if (st.st) {
        var radio = document.querySelector(
          'input[name="st"][value="' + st.st + '"]',
        );
        if (radio) radio.checked = true;
      }

      if (st.hasS && st.problem && rebuildProblemFromSaved(st.problem, st.st)) {
        k = 0;
        $("out").innerHTML = "";
        $("resultBox").hidden = true;
        var tables = st.tables || [];
        if (tables.length > 0) {
          for (var t = 0; t < tables.length; t++) addTable(t === 0);
        } else {
          addTable(true);
        }
        getTableSections().forEach(function (sec, idx) {
          (tables[idx] || []).forEach(function (item) {
            var inp = getInput(sec, item.role, item.row, item.col);
            if (inp) inp.value = item.value || "";
          });
        });
        $("bar").hidden = false;
        $("hint").checked = !!st.hint;
        updateHints();
      }
    } finally {
      restoring = false;
    }
    saveStateMaybe();
  }

  /* ==========================================================================
   * §14  EVENT WIRING
   * --------------------------------------------------------------------------
   * Every addEventListener / .onclick lives here. New UI buttons plug in here
   * without touching business logic.
   *
   * SCALE HERE: add listeners for new buttons, keyboard shortcuts, drag/drop,
   *   import/export triggers. Keep handlers thin — delegate to §5/§7/§10/§11.
   * ========================================================================== */

  function bindEvents() {
    $("nv").onchange = $("mc").onchange = function () {
      renderForm();
      notifyStaleTableaux();
    };

    $("form").addEventListener("input", function () {
      preview();
      notifyStaleTableaux();
      saveStateMaybe();
    });

    document.querySelectorAll('input[name="st"]').forEach(function (r) {
      r.addEventListener("change", function () {
        notifyStaleTableaux();
        saveStateMaybe();
      });
    });

    $("gen").onclick = gen;

    $("next").onclick = function () {
      if (!S) {
        $("msg").textContent = "Generate first tableau first.";
        return;
      }
      addTable(false);
      $("out").lastElementChild.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    };

    $("analyse").onclick = function () {
      analyse(null, true);
    };

    $("printBtn").onclick = function () {
      window.print();
    };

    $("hint").onchange = function () {
      updateHints();
      saveStateMaybe();
    };

    $("autosave").onchange = function () {
      if (!this.checked) safeRemoveStorage();
      else saveStateMaybe();
    };

    $("presets").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-preset]");
      if (!btn) return;
      loadPreset(btn.getAttribute("data-preset"));
    });

    $("out").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-act]");
      if (!btn) return;

      var sec = btn.closest("section.tableau");
      var act = btn.getAttribute("data-act");

      if (act === "remove") {
        sec.remove();
        renumber();
        updateHints();
        saveStateMaybe();
        return;
      }

      var all = getTableSections();
      var idx = all.indexOf(sec);
      if (idx <= 0) return;

      var prevSec = all[idx - 1];
      var prev = parseTableau(prevSec, true);
      if (!prev) {
        sec.querySelector("[data-note]").textContent =
          "Previous tableau must be fully and validly filled first.";
        return;
      }

      var curr = parseTableau(sec, false);
      var exp = buildExpectedNext(prev, curr.basis);
      if (exp.error) {
        sec.querySelector("[data-note]").textContent = exp.error;
        return;
      }

      if (act === "reveal") {
        fillTableau(sec, exp);
        return;
      }

      var cmp = compareAndMark(sec, exp, prevSec, prev);
      var note =
        "Checked " + cmp.checked + " filled cells; wrong: " + cmp.wrong + ".";
      if (exp.soft) note += " " + exp.soft;
      sec.querySelector("[data-note]").textContent = note;
      if (cmp.wrong === 0) analyse(sec, false);
      updateHints();
      saveStateMaybe();
    });

    $("out").addEventListener("input", function (e) {
      var sec = e.target.closest("section.tableau");
      if (!sec || !S) {
        saveStateMaybe();
        return;
      }
      updateHints();
      saveStateMaybe();
    });
  }

  /* ==========================================================================
   * §15  BOOTSTRAP
   * --------------------------------------------------------------------------
   * Compose the layers. New top-level setup goes here.
   * ========================================================================== */

  function init() {
    buildPresetButtons();
    bindEvents();
    var savedState = safeReadStorage();
    renderForm();
    restoreState(savedState);
  }

  init();
})();
