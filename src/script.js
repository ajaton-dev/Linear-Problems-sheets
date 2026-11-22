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
  var STORAGE_KEY = "simplex-sheet-v3-state";
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
        else {
          var relation = r.querySelector("select");
          res.cons.push({
            a: v.slice(0, -1),
            b: v[v.length - 1],
            rel: relation ? relation.value : "<=",
          });
        }
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
      var relation = c.rel || "<=";
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
        '<select aria-label="Constraint relation">' +
        '<option value="&lt;="' +
        (relation === "<=" ? " selected" : "") +
        ">&le;</option>" +
        '<option value="&gt;="' +
        (relation === ">=" ? " selected" : "") +
        ">&ge;</option>" +
        '<option value="="' +
        (relation === "=" ? " selected" : "") +
        ">=</option></select>" +
        '<input class="c" placeholder="b" value="' +
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

  function flipRelation(relation) {
    if (relation === "<=") return ">=";
    if (relation === ">=") return "<=";
    return relation;
  }

  function normalizeConstraint(constraint) {
    var relation = constraint.rel || "<=";
    var rhs = Fraction.parse(constraint.b || "0");
    if (!rhs || !rhs.lt(Fraction.zero())) {
      return {
        a: constraint.a.slice(),
        b: constraint.b || "0",
        rel: relation,
        normalized: false,
      };
    }

    var minusOne = new Fraction(-1n, 1n);
    return {
      a: constraint.a.map(function (value) {
        var coefficient = Fraction.parse(value || "0");
        return coefficient ? coefficient.mul(minusOne).toString() : value;
      }),
      b: rhs.mul(minusOne).toString(),
      rel: flipRelation(relation),
      normalized: true,
    };
  }

  function preview() {
    var f = readForm();
    var n = f.z.length;
    var names = [];
    var j;

    for (j = 1; j <= n; j++) names.push(sb("x", j));
    var lines = f.cons.map(function (c) {
      var normalized = normalizeConstraint(c);
      var relation =
        normalized.rel === "<="
          ? "&le;"
          : normalized.rel === ">="
            ? "&ge;"
            : "=";
      return (
        "<div>" +
        expr(normalized.a) +
        " " +
        relation +
        " " +
        esc(normalized.b) +
        (normalized.normalized ? ' <small>(normalized)</small>' : "") +
        "</div>"
      );
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
   * parseObjective  objective inputs → exact x-column costs
   * parseTableau    problem + tableau section → parsed values and its phase model
   * getCjFractions  explicit tableau cj vector → Fraction[] for pivot math
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
    var m = s.match(/^([xsea])_?(\d+)$/);
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

  function parseObjective(z) {
    var out = [];
    var j;
    for (j = 0; j < z.length; j++) {
      var f = Fraction.parse((z[j] || "0").trim() || "0");
      if (!f) return null;
      out.push(f);
    }
    return out;
  }

  function getTableModel(section, problem) {
    var colsText = section.getAttribute("data-cols");
    var cjText = section.getAttribute("data-cj");
    return {
      phase: section.getAttribute("data-phase") || "single",
      cols: colsText ? JSON.parse(colsText) : problem.cols,
      cj: cjText ? JSON.parse(cjText) : problem.cj,
    };
  }

  function parseTableau(problem, section, strict) {
    var model = getTableModel(section, problem);
    var m = problem.m;
    var N = model.cols.length;
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
      phase: model.phase,
      cols: model.cols,
      cj: model.cj,
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

  function getCjFractions(problem, cj) {
    return cj.map(function (v) {
      return Fraction.parse(v);
    });
  }

  /* ==========================================================================
   * §7  SIMPLEX PIVOT LOGIC  (the "brain")
   * --------------------------------------------------------------------------
   * computeStandardChoice(problem, tab)
   *     Dantzig rule: pick max positive c_j − z_j; break ratio ties.
   *     Returns { entering, enteringSet, leavingSet, ratioTie }.
   *
   * buildExpectedNext(problem, prev, currBasis, cj, cols)
   *     Given the user's chosen new basis, produce the expected next tableau
   *     (or an { error } explaining why the pivot is invalid).
   *
   * tableauOptimal(problem, tab)
   *     Every c_j − z_j ≤ 0. No pivot candidates.
   *
   * These helpers take the problem explicitly and stay independent of the DOM.
   *
   * SCALE HERE: pivot-rule strategies go here. To add Bland's rule, extract
   *   an `enteringRule(tab, problem)` interface and swap at call sites.
   * ========================================================================== */

  function computeStandardChoice(problem, tab) {
    var cols = tab.cols;
    var N = cols.length;
    var m = problem.m;
    var nonBasic = [];
    var j;

    for (j = 0; j < N; j++) {
      if (tab.basis.indexOf(cols[j].key) === -1) nonBasic.push(j);
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

  function buildExpectedNext(problem, prev, currBasis, cjValues, activeCols) {
    var cols = activeCols;
    var m = problem.m;
    var N = cols.length;
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
    var enterCol = cols.findIndex(function (col) {
      return col.key === enterKey;
    });
    if (enterCol === -1) {
      return {
        error: "The new basic variable label is invalid. Use x, s, e or a labels.",
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

    var cj = getCjFractions(problem, cjValues);
    var cb = basis.map(function (bk) {
      var col = cols.findIndex(function (item) {
        return item.key === bk;
      });
      return cj[col] || Fraction.zero();
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

    var standard = computeStandardChoice(problem, prev);
    var soft = [];
    if (piv.lt(Fraction.zero())) {
      soft.push("Soft note: negative pivot, b will go negative.");
    }
    if (
      standard.enteringSet.length &&
      standard.enteringSet.indexOf(enterCol) === -1
    ) {
      soft.push(
        "Soft note: entering variable is not from the largest c_j - z_j set (ties are valid).",
      );
    }

    var minRatio = null;
    var leavingRows = [];
    for (i = 0; i < m; i++) {
      var ratioPivot = prev.A[i][enterCol];
      if (!ratioPivot || !ratioPivot.isPos()) continue;
      var ratio = prev.b[i].div(ratioPivot);
      if (minRatio === null || ratio.lt(minRatio)) {
        minRatio = ratio;
        leavingRows = [i];
      } else if (ratio.eq(minRatio)) {
        leavingRows.push(i);
      }
    }
    if (leavingRows.indexOf(leaveRow) === -1) {
      soft.push(
        "Soft note: leaving row is not from the minimum ratio set for the chosen entering variable (ties are valid).",
      );
    }

    return {
      phase: prev.phase,
      cols: cols,
      cj: cjValues,
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

  function tableauOptimal(problem, tab) {
    return (
      tab.cols.length === tab.cjz.length &&
      tab.cjz.every(function (v) {
        return v && !v.isPos();
      })
    );
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

  function buildColumns(n, relations) {
    var cols = [];
    var i;

    for (i = 1; i <= n; i++) {
      cols.push({ key: "x" + i, type: "x" });
    }
    for (i = 0; i < relations.length; i++) {
      if (relations[i] === "<=") cols.push({ key: "s" + (i + 1), type: "s" });
      else if (relations[i] === ">=")
        cols.push({ key: "e" + (i + 1), type: "e" });
    }
    for (i = 0; i < relations.length; i++) {
      if (relations[i] !== "<=")
        cols.push({ key: "a" + (i + 1), type: "a" });
    }

    return cols;
  }

  function columnIndex(cols, key) {
    return cols.findIndex(function (col) {
      return col.key === key;
    });
  }

  function columnLabel(col) {
    return sb(col.type, parseInt(col.key.slice(1), 10));
  }

  function costsForColumns(xCosts, cols) {
    return cols.map(function (col) {
      if (col.type !== "x") return Fraction.zero();
      return xCosts[parseInt(col.key.slice(1), 10) - 1];
    });
  }

  function phaseOneModel(problem) {
    return {
      phase: "1",
      cols: problem.cols,
      cj: problem.cols.map(function (col) {
        return col.type === "a" ? "-1" : "0";
      }),
    };
  }

  function buildInitialTableau(problem, model) {
    var cols = model.cols;
    var cj = getCjFractions(problem, model.cj);
    var basis = problem.relations.map(function (relation, i) {
      return relation === "<=" ? "s" + (i + 1) : "a" + (i + 1);
    });
    var A = problem.A.map(function (row, rowIndex) {
      return cols.map(function (col) {
        var index = parseInt(col.key.slice(1), 10) - 1;
        if (col.type === "x") return Fraction.parse(row[index]);
        if (col.type === "s")
          return new Fraction(
            col.key === "s" + (rowIndex + 1) ? 1n : 0n,
            1n,
          );
        if (col.type === "e")
          return new Fraction(
            col.key === "e" + (rowIndex + 1) ? -1n : 0n,
            1n,
          );
        return new Fraction(
          col.key === "a" + (rowIndex + 1) ? 1n : 0n,
          1n,
        );
      });
    });
    var b = problem.b.map(function (value) {
      return Fraction.parse(value);
    });
    var cb = basis.map(function (key) {
      var index = columnIndex(cols, key);
      return cj[index] || Fraction.zero();
    });
    var zj = cols.map(function (_col, j) {
      return cb.reduce(function (sum, cost, i) {
        return sum.add(cost.mul(A[i][j]));
      }, Fraction.zero());
    });
    var zval = cb.reduce(function (sum, cost, i) {
      return sum.add(cost.mul(b[i]));
    }, Fraction.zero());

    return {
      phase: model.phase,
      cols: cols,
      cj: model.cj,
      basis: basis,
      cb: cb,
      A: A,
      b: b,
      zj: zj,
      cjz: cj.map(function (cost, j) {
        return cost.sub(zj[j]);
      }),
      zval: zval,
    };
  }

  function gen() {
    var f = readForm();
    var n = f.z.length;
    var m = f.cons.length;
    var i;
    var j;

    var z = f.z.map(function (v) {
      return (v || "0").trim() || "0";
    });

    var xCosts = parseObjective(z);
    if (!xCosts) {
      $("msg").textContent = "Invalid objective coefficient format.";
      return;
    }
    if (
      xCosts.every(function (v) {
        return v.isZero();
      })
    ) {
      $("msg").textContent =
        "Enter at least one non-zero objective coefficient.";
      return;
    }

    var A = [];
    var b = [];
    var relations = [];
    for (i = 0; i < m; i++) {
      var normalized = normalizeConstraint(f.cons[i]);
      if (["<=", ">=", "="].indexOf(normalized.rel) === -1) {
        $("msg").textContent = "Invalid constraint relation.";
        return;
      }
      var row = [];
      for (j = 0; j < n; j++) {
        var af = Fraction.parse(
          (normalized.a[j] || "0").trim() || "0",
        );
        if (!af) {
          $("msg").textContent = "Invalid constraint coefficient format.";
          return;
        }
        row.push(af.toString());
      }
      var bf = Fraction.parse((normalized.b || "0").trim() || "0");
      if (!bf) {
        $("msg").textContent = "Invalid right-hand side format.";
        return;
      }
      relations.push(normalized.rel);
      A.push(row);
      b.push(bf.toString());
    }

    if (
      getTableSections().length > 0 &&
      !window.confirm("Generate a new tableau and discard the existing tableaux?")
    ) {
      return;
    }

    var cols = buildColumns(n, relations);
    S = {
      n: n,
      m: m,
      cols: cols,
      cj: costsForColumns(xCosts, cols).map(function (x) {
        return x.toString();
      }),
      relations: relations,
      A: A,
      b: b,
      st: document.querySelector('input[name="st"]:checked').value,
    };

    var hasArtificials = cols.some(function (col) {
      return col.type === "a";
    });
    var model = hasArtificials
      ? phaseOneModel(S)
      : { phase: "single", cols: cols, cj: S.cj };
    var initial = buildInitialTableau(S, model);

    $("msg").textContent = "";
    k = 0;
    $("out").innerHTML = "";
    $("resultBox").hidden = true;
    $("startPhase2").hidden = true;
    addTable(true, model, initial);
    $("bar").hidden = false;
    if (model.phase === "1" && tableauOptimal(S, initial))
      analyse(S, getTableSections().slice(-1)[0], true);
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

  function addTable(first, model, initial, prefillSeed, prefillRoles) {
    k++;
    var previous = getTableSections().slice(-1)[0];
    if (!model && previous) model = getTableModel(previous, S);
    if (!model)
      model = { phase: "single", cols: S.cols, cj: S.cj };

    var m = S.m;
    var N = model.cols.length;
    var B = S.st === "B";
    var h;
    var i;
    var j;
    var phaseLabel =
      model.phase === "1"
        ? " — Phase 1"
        : model.phase === "2"
          ? " — Phase 2"
          : "";
    var seedText = prefillSeed ? JSON.stringify(prefillSeed) : "";

    var tctl =
      '<div class="tctl">' +
      (!first
        ? '<button class="ghost" data-act="check">Check my work</button><button class="ghost" data-act="reveal">Reveal tableau</button>'
        : "") +
      (prefillSeed
        ? '<button class="ghost" data-act="toggle-prefill">' +
          (prefillRoles ? "Hide Phase 2 prefill" : "Show Phase 2 prefill") +
          "</button>"
        : "") +
      '<button class="ghost" data-act="remove">Remove</button></div>';

    h =
      '<section class="tableau" data-phase="' +
      esc(model.phase) +
      '" data-cols="' +
      esc(JSON.stringify(model.cols)) +
      '" data-cj="' +
      esc(JSON.stringify(model.cj)) +
      '"' +
      (seedText
        ? ' data-prefill-seed="' +
          esc(seedText) +
          '" data-prefilled="' +
          (prefillRoles ? "true" : "false") +
          '"'
        : "") +
      '><div class="tt"><b>Tableau ' +
      k +
      phaseLabel +
      "</b>" +
      tctl +
      '</div><div class="wrap"><table>';

    var vh = model.cols
      .map(function (col, idx) {
        return (
          "<th" +
          (idx === 0 && !B ? ' class="sepl"' : "") +
          ">" +
          columnLabel(col) +
          "</th>"
        );
      })
      .join("");

    if (B) {
      h +=
        '<tr><th>Max</th><th colspan="2">C<sub>j</sub></th>' +
        model.cj
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
        vals.push("");
      }
      var cb = "";
      var bs = "";
      var bv = "";
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
      zr.push("");
      cr.push("");
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
        cell("", "", { role: "zval" }) +
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
        cell("", "sepl", { role: "zval" }) +
        "<td></td></tr>";
      h +=
        '<tr><td></td><td class="lab">c<sub>j</sub> - z<sub>j</sub></td>' +
        cc +
        '<td class="sepl"></td><td></td></tr>';
    }

    h += '</table></div><div class="note" data-note></div></section>';
    $("out").insertAdjacentHTML("beforeend", h);
    var section = getTableSections().slice(-1)[0];
    if (initial) fillTableau(section, initial, prefillRoles, false);
    else updateHints();
    renumber();
    updatePhaseControls();
    saveStateMaybe();
  }

  function renumber() {
    var sections = getTableSections();
    sections.forEach(function (sec, idx) {
      var b = sec.querySelector(".tt > b");
      var phase = sec.getAttribute("data-phase");
      var phaseLabel =
        phase === "1" ? " - Phase 1" : phase === "2" ? " - Phase 2" : "";
      if (b) b.textContent = "Tableau " + (idx + 1) + phaseLabel;
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
    var m = S.m;
    var N = expected.cols.length;
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
          var marker = String(ratioInp.value || "")
            .trim()
            .toLowerCase();
          var okMarker = ["-", "—", "∞", "inf", "n/a"].indexOf(marker) !== -1;
          if (!okMarker) wrong++;
          mark(ratioInp, okMarker, "— (a_ie <= 0)");
        }
      }
    }

    return { checked: checked, wrong: wrong };
  }

  function fillTableau(section, exp, roles, showNote) {
    var m = S.m;
    var N = exp.cols.length;
    var i;
    var j;

    function includes(role) {
      return !roles || roles.indexOf(role) !== -1;
    }

    for (i = 0; i < m; i++) {
      if (includes("basis"))
        getInput(section, "basis", i).value = exp.basis[i];
      if (includes("cb"))
        getInput(section, "cb", i).value = exp.cb[i].toString();
      if (includes("b")) getInput(section, "b", i).value = exp.b[i].toString();
      if (includes("ratio")) getInput(section, "ratio", i).value = "";
      if (includes("a")) {
        for (j = 0; j < N; j++)
          getInput(section, "a", i, j).value = exp.A[i][j].toString();
      }
    }

    if (includes("zval"))
      getInput(section, "zval").value = exp.zval.toString();
    if (includes("zj") || includes("cjz")) {
      for (j = 0; j < N; j++) {
        if (includes("zj"))
          getInput(section, "zj", null, j).value = exp.zj[j].toString();
        if (includes("cjz"))
          getInput(section, "cjz", null, j).value = exp.cjz[j].toString();
      }
    }

    clearMarks(section);
    var note = section.querySelector("[data-note]");
    if (showNote !== false)
      note.textContent =
        "Revealed from your chosen pivot." + (exp.soft ? " " + exp.soft : "");
    updateHints();
    updatePhaseControls();
    saveStateMaybe();
  }

  function togglePhase2Prefill(section, button) {
    var seed = JSON.parse(section.getAttribute("data-prefill-seed") || "{}");
    var isPrefilled = section.getAttribute("data-prefilled") === "true";
    if (isPrefilled) {
      section.querySelectorAll(
        'input[data-role="basis"], input[data-role="a"], input[data-role="b"]',
      ).forEach(function (input) {
        input.value = "";
      });
      section.setAttribute("data-prefilled", "false");
      button.textContent = "Show Phase 2 prefill";
      clearMarks(section);
      updateHints();
      saveStateMaybe();
      return;
    }

    var model = getTableModel(section, S);
    fillTableau(
      section,
      {
        cols: model.cols,
        basis: seed.basis,
        A: seed.A,
        b: seed.b,
      },
      ["basis", "a", "b"],
      false,
    );
    section.setAttribute("data-prefilled", "true");
    button.textContent = "Hide Phase 2 prefill";
    saveStateMaybe();
  }

  function updatePhaseControls() {
    var button = $("startPhase2");
    if (!button) return;
    button.hidden = true;
    if (!S) return;

    var section = getTableSections().slice(-1)[0];
    if (!section || getTableModel(section, S).phase !== "1") return;
    var tab = parseTableau(S, section, true);
    if (
      tab &&
      tableauOptimal(S, tab) &&
      tab.zval &&
      tab.zval.isZero()
    ) {
      button.hidden = false;
    }
  }

  function startPhase2() {
    if (!S) return;
    var section = getTableSections().slice(-1)[0];
    if (!section) return;
    var tab = parseTableau(S, section, true);
    if (!tab || tab.phase !== "1" || !tableauOptimal(S, tab)) {
      $("msg").textContent = "Complete an optimal Phase 1 tableau first.";
      return;
    }
    if (!tab.zval || !tab.zval.isZero()) {
      analyse(S, section, true);
      $("startPhase2").hidden = true;
      return;
    }

    var artificialBasic = tab.basis.filter(function (key) {
      var index = columnIndex(tab.cols, key);
      return index >= 0 && tab.cols[index].type === "a";
    });
    if (artificialBasic.length) {
      analyse(S, section, true);
      $("startPhase2").hidden = true;
      return;
    }

    var cols = tab.cols.filter(function (col) {
      return col.type !== "a";
    });
    var cj = cols.map(function (col) {
      return S.cj[columnIndex(S.cols, col.key)];
    });
    var model = { phase: "2", cols: cols, cj: cj };
    var initial = {
      phase: "2",
      cols: cols,
      cj: cj,
      basis: tab.basis.slice(),
      A: tab.A.map(function (row) {
        return row.filter(function (_value, index) {
          return tab.cols[index].type !== "a";
        });
      }),
      b: tab.b.slice(),
    };
    var seed = {
      basis: initial.basis.slice(),
      A: initial.A.map(function (row) {
        return row.map(function (value) {
          return value.toString();
        });
      }),
      b: initial.b.map(function (value) {
        return value.toString();
      }),
    };

    $("startPhase2").hidden = true;
    $("resultBox").hidden = true;
    $("msg").textContent = "";
    addTable(true, model, initial, seed, ["basis", "a", "b"]);
  }

  /* ==========================================================================
   * §11  ANALYSIS & HINTS
   * --------------------------------------------------------------------------
   * analyse(problem, section, forced)
   *                             optimality, unbounded, multi-optima, degenerate
   * updateHints()              highlight the standard-rule pivot (col + row)
   *
   * SCALE HERE: sensitivity analysis, shadow prices, dual solution, reduced
   *   costs, per-tableau history summary. All "what does this tableau mean"
   *   logic belongs here. Keep it read-only against S + tab.
   * ========================================================================== */

  function analyse(problem, section, forced) {
    if (!problem) {
      if ($("msg")) $("msg").textContent = "Generate a tableau first.";
      return;
    }

    var sec = section || getTableSections().slice(-1)[0];
    if (!sec) return;

    var tab = parseTableau(problem, sec, true);
    if (!tab) {
      var issue = "Fill this tableau with valid numbers before analysis.";
      if ($("msg")) $("msg").textContent = issue;
      var issueNote = sec.querySelector("[data-note]");
      if (issueNote) issueNote.textContent = issue;
      return;
    }

    var cols = tab.cols;
    var N = cols.length;
    var m = problem.m;
    var n = problem.n;
    var j;

    var nonBasic = [];
    for (j = 0; j < N; j++) {
      if (tab.basis.indexOf(cols[j].key) === -1) nonBasic.push(j);
    }

    var optimal = tableauOptimal(problem, tab);
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
    if (optimal && tab.phase !== "1") {
      nonBasic.forEach(function (col) {
        if (tab.cjz[col] && tab.cjz[col].isZero()) multi = true;
      });
    }

    var phaseOne = tab.phase === "1";
    var infeasible =
      phaseOne && optimal && tab.zval && !tab.zval.isZero();
    var phaseOneFeasible =
      phaseOne && optimal && tab.zval && tab.zval.isZero();
    var artificialBasic = phaseOneFeasible
      ? tab.basis.filter(function (key) {
          var col = cols.find(function (item) {
            return item.key === key;
          });
          return col && col.type === "a";
        })
      : [];

    var degBasic = tab.b.some(function (bv) {
      return bv && bv.isZero();
    });
    var std = computeStandardChoice(problem, tab);
    var degTie = std.ratioTie;
    var degenerate = degBasic || degTie;

    if (!forced && !optimal && !unbounded) return;

    var xVals = new Array(n).fill(Fraction.zero());
    for (var r = 0; r < m; r++) {
      var bidx = cols.findIndex(function (col) {
        return col.key === tab.basis[r];
      });
      if (bidx >= 0 && cols[bidx].type === "x") {
        var xidx = parseInt(cols[bidx].key.slice(1), 10) - 1;
        if (xidx >= 0 && xidx < n) xVals[xidx] = tab.b[r];
      }
    }

    var z = tab.zval;
    if (!z) {
      z = Fraction.zero();
      var cj = getCjFractions(problem, tab.cj);
      for (j = 0; j < N; j++) {
        if (cols[j].type === "x") {
          var xidx = parseInt(cols[j].key.slice(1), 10) - 1;
          z = z.add(cj[j].mul(xVals[xidx]));
        }
      }
    }

    var status = infeasible
      ? "INFEASIBLE"
      : unbounded
        ? "Unbounded"
        : phaseOneFeasible
          ? "Phase 1 feasible (w = 0)"
          : optimal
            ? "Optimal tableau"
            : "Not yet optimal";
    var objectiveLabel = phaseOne ? "w" : "z";
    var lines = [];
    lines.push("<h2>Analysis</h2>");
    lines.push('<div><span class="pill">' + status + "</span></div>");

    lines.push(
      "<div><b>Solution:</b> " +
        xVals
          .map(function (v, idx) {
            return "x" + (idx + 1) + " = " + v.toString();
          })
          .join(", ") +
        "</div>",
    );
    lines.push(
      "<div><b>" + objectiveLabel + "</b> = " + z.toString() + "</div>",
    );
    if (phaseOneFeasible && artificialBasic.length) {
      lines.push(
        '<div class="note">Phase 1 is feasible, but artificial variable' +
          (artificialBasic.length > 1 ? "s " : " ") +
          artificialBasic.join(", ") +
          (artificialBasic.length > 1 ? " remain" : " remains") +
          " basic at 0. Phase 2 cannot start yet.</div>",
      );
    }
    lines.push(
      "<div><b>Cases:</b> " +
        [
          infeasible
            ? "INFEASIBLE"
            : unbounded
              ? "Unbounded"
              : "Bounded at this tableau",
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

    var note = sec.querySelector("[data-note]");
    if (note) {
      note.textContent =
        "Analysis: " +
        status +
        ". Solution: " +
        xVals
          .map(function (v, idx) {
            return "x" + (idx + 1) + " = " + v.toString();
          })
          .join(", ") +
        "; " +
        objectiveLabel +
        " = " +
        z.toString() +
        ". Flags: " +
        [
          unbounded ? "Unbounded" : "Bounded at this tableau",
          multi ? "Multiple optima" : "No multiple-optima flag",
          degenerate ? "Degenerate" : "Non-degenerate",
        ].join(" | ") +
        ".";
    }
    updatePhaseControls();
  }

  function updateHints() {
    var on = $("hint").checked;
    getTableSections().forEach(function (sec) {
      sec.querySelectorAll("td").forEach(function (td) {
        td.classList.remove("hint-col", "hint-row");
      });
      if (!on) return;
      var tab = parseTableau(S, sec, true);
      if (!tab) return;
      var std = computeStandardChoice(S, tab);
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
      for (var j = 0; j < tab.cols.length; j++) {
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
    ex3: {
      label: "Ex3",
      z: ["2", "3", "1"],
      cons: [
        { a: ["1", "1", "1"], b: "40", rel: "<=" },
        { a: ["2", "1", "-1"], b: "10", rel: ">=" },
        { a: ["0", "-1", "1"], b: "10", rel: ">=" },
      ],
    },
    ex4: {
      label: "Ex4",
      z: ["1", "-1", "1"],
      cons: [
        { a: ["2", "-1", "-2"], b: "4", rel: "<=" },
        { a: ["2", "-3", "1"], b: "-5", rel: "<=" },
        { a: ["-1", "1", "-2"], b: "-1", rel: "<=" },
      ],
    },
    ex5: {
      label: "Ex5",
      z: ["3", "1"],
      cons: [
        { a: ["1", "-1"], b: "4", rel: "<=" },
        { a: ["-1", "-1"], b: "-3", rel: "<=" },
        { a: ["2", "1"], b: "2", rel: "<=" },
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
      var relation = rows[i].querySelector("select");
      if (relation) relation.value = c.rel || "<=";
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
      var model = getTableModel(sec, S);
      var seed = sec.getAttribute("data-prefill-seed");
      return {
        phase: model.phase,
        cols: model.cols,
        cj: model.cj,
        prefillSeed: seed ? JSON.parse(seed) : null,
        prefilled: sec.getAttribute("data-prefilled") === "true",
        cells: [].map
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
          }),
      };
    });
  }

  function rebuildProblemFromSaved(prob, fallbackStyle) {
    if (!prob || typeof prob.n !== "number" || typeof prob.m !== "number")
      return false;
    var n = prob.n;
    var m = prob.m;
    var i;
    var j;
    var rawCj = Array.isArray(prob.cj) ? prob.cj.slice(0, n) : [];
    while (rawCj.length < n) rawCj.push("0");
    var xCosts = parseObjective(rawCj);
    if (!xCosts) return false;

    var relations = Array.isArray(prob.relations)
      ? prob.relations.slice(0, m)
      : new Array(m).fill("<=");
    while (relations.length < m) relations.push("<=");
    if (
      relations.some(function (relation) {
        return ["<=", ">=", "="].indexOf(relation) === -1;
      })
    )
      return false;

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

    var cols = buildColumns(n, relations);

    S = {
      n: n,
      m: m,
      cols: cols,
      cj: costsForColumns(xCosts, cols).map(function (x) {
        return x.toString();
      }),
      relations: relations,
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
            relations: S.relations.slice(),
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
          for (var t = 0; t < tables.length; t++) {
            var item = Array.isArray(tables[t])
              ? { cells: tables[t] }
              : tables[t] || {};
            var previous = t > 0 ? tables[t - 1] : null;
            var previousPhase =
              previous && !Array.isArray(previous)
                ? previous.phase || "single"
                : "single";
            var phase = item.phase || "single";
            var model = {
              phase: phase,
              cols: item.cols || S.cols,
              cj: item.cj || S.cj,
            };
            addTable(
              t === 0 || phase !== previousPhase,
              model,
              null,
              item.prefillSeed,
              item.prefilled ? ["basis", "a", "b"] : null,
            );
          }
        } else {
          var hasArtificials = S.cols.some(function (col) {
            return col.type === "a";
          });
          var initialModel = hasArtificials
            ? phaseOneModel(S)
            : { phase: "single", cols: S.cols, cj: S.cj };
          addTable(
            true,
            initialModel,
            buildInitialTableau(S, initialModel),
          );
        }
        getTableSections().forEach(function (sec, idx) {
          var tableData = Array.isArray(tables[idx])
            ? tables[idx]
            : (tables[idx] && tables[idx].cells) || [];
          tableData.forEach(function (item) {
            var inp = getInput(sec, item.role, item.row, item.col);
            if (inp) inp.value = item.value || "";
          });
        });
        $("bar").hidden = false;
        $("hint").checked = !!st.hint;
        updateHints();
        updatePhaseControls();
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
    function bind(id, eventName, handler) {
      var element = $(id);
      if (element) element.addEventListener(eventName, handler);
    }

    var renderChangedForm = function () {
      renderForm();
      notifyStaleTableaux();
    };
    bind("nv", "change", renderChangedForm);
    bind("mc", "change", renderChangedForm);

    var formChanged = function () {
      preview();
      notifyStaleTableaux();
      saveStateMaybe();
    };
    bind("form", "input", formChanged);
    bind("form", "change", formChanged);

    document.querySelectorAll('input[name="st"]').forEach(function (r) {
      r.addEventListener("change", function () {
        notifyStaleTableaux();
        saveStateMaybe();
      });
    });

    bind("gen", "click", gen);
    bind("startPhase2", "click", startPhase2);

    bind("next", "click", function () {
      if (!S) {
        if ($("msg")) $("msg").textContent = "Generate first tableau first.";
        return;
      }
      addTable(false);
      $("out").lastElementChild.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });

    bind("analyse", "click", function () {
      analyse(S, null, true);
    });

    bind("printBtn", "click", function () {
      window.print();
    });

    bind("hint", "change", function () {
      updateHints();
      saveStateMaybe();
    });

    bind("autosave", "change", function (event) {
      if (!event.currentTarget.checked) safeRemoveStorage();
      else saveStateMaybe();
    });

    bind("presets", "click", function (e) {
      var btn = e.target.closest("button[data-preset]");
      if (!btn) return;
      loadPreset(btn.getAttribute("data-preset"));
    });

    bind("out", "click", function (e) {
      var btn = e.target.closest("button[data-act]");
      if (!btn) return;

      var sec = btn.closest("section.tableau");
      var act = btn.getAttribute("data-act");

      if (act === "toggle-prefill") {
        togglePhase2Prefill(sec, btn);
        return;
      }

      if (act === "remove") {
        sec.remove();
        renumber();
        updateHints();
        updatePhaseControls();
        saveStateMaybe();
        return;
      }

      var all = getTableSections();
      var idx = all.indexOf(sec);
      if (idx <= 0) return;

      var prevSec = all[idx - 1];
      var prev = parseTableau(S, prevSec, true);
      if (!prev) {
        sec.querySelector("[data-note]").textContent =
          "Previous tableau must be fully and validly filled first.";
        return;
      }

      var currentModel = getTableModel(sec, S);
      if (
        prev.phase !== currentModel.phase ||
        prev.cols.length !== currentModel.cols.length ||
        prev.cols.some(function (col, colIndex) {
          return (
            col.key !== currentModel.cols[colIndex].key ||
            col.type !== currentModel.cols[colIndex].type
          );
        })
      ) {
        sec.querySelector("[data-note]").textContent =
          "The current and previous tableaux must use the same phase and columns.";
        return;
      }

      var curr = parseTableau(S, sec, false);
      var exp = buildExpectedNext(
        S,
        prev,
        curr.basis,
        prev.cj,
        prev.cols,
      );
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
      if (cmp.wrong === 0) analyse(S, sec, false);
      updateHints();
      updatePhaseControls();
      saveStateMaybe();
    });

    bind("out", "input", function (e) {
      var sec = e.target.closest("section.tableau");
      if (!sec || !S) {
        saveStateMaybe();
        return;
      }
      updateHints();
      updatePhaseControls();
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

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      Fraction: Fraction,
      PRESETS: PRESETS,
      buildColumns: buildColumns,
      buildExpectedNext: buildExpectedNext,
      buildInitialTableau: buildInitialTableau,
      computeStandardChoice: computeStandardChoice,
      costsForColumns: costsForColumns,
      getCjFractions: getCjFractions,
      normBasisLabel: normBasisLabel,
      normalizeConstraint: normalizeConstraint,
      phaseOneModel: phaseOneModel,
      tableauOptimal: tableauOptimal,
    };
  }

  if (typeof document !== "undefined") init();
})();
