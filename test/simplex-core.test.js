"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  Fraction,
  PRESETS,
  buildColumns,
  buildExpectedNext,
  buildInitialTableau,
  computeStandardChoice,
  costsForColumns,
  normBasisLabel,
  normalizeConstraint,
  phaseOneModel,
  tableauOptimal,
} = require("../src/script.js");

const expectedPresets = {
  p1: {
    x: ["1", "3"],
    z: "9",
    flags: {
      optimal: true,
      unbounded: false,
      multipleOptima: false,
      degenerate: false,
    },
  },
  p2: {
    x: ["2", "0", "1"],
    z: "13",
    flags: {
      optimal: true,
      unbounded: false,
      multipleOptima: false,
      degenerate: false,
    },
  },
  p3: {
    x: ["40", "110"],
    z: "26000",
    flags: {
      optimal: true,
      unbounded: false,
      multipleOptima: false,
      degenerate: false,
    },
  },
  p4: {
    x: ["9", "0", "0"],
    z: "540",
    flags: {
      optimal: true,
      unbounded: false,
      multipleOptima: true,
      degenerate: false,
    },
  },
  unb: {
    x: ["8", "11/3"],
    z: "83/3",
    flags: {
      optimal: false,
      unbounded: true,
      multipleOptima: false,
      degenerate: false,
    },
  },
  mul: {
    x: ["0", "5"],
    z: "10",
    flags: {
      optimal: true,
      unbounded: false,
      multipleOptima: true,
      degenerate: false,
    },
  },
  deg: {
    x: ["0", "2"],
    z: "18",
    flags: {
      optimal: true,
      unbounded: false,
      multipleOptima: false,
      degenerate: true,
    },
  },
};

const lessOrEqual = (left, right) => left.lt(right) || left.eq(right);

function makeProblem(preset) {
  const n = preset.z.length;
  const m = preset.cons.length;
  const normalized = preset.cons.map(normalizeConstraint);
  const relations = normalized.map((constraint) => constraint.rel);
  const cols = buildColumns(n, relations);
  const xCosts = preset.z.map((value) => Fraction.parse(value));
  const problem = {
    n,
    m,
    relations,
    cols,
    cj: costsForColumns(xCosts, cols).map((value) => value.toString()),
    A: normalized.map((constraint) =>
      constraint.a.map((value) => Fraction.parse(value || "0").toString()),
    ),
    b: normalized.map((constraint) => Fraction.parse(constraint.b).toString()),
  };
  const hasArtificial = cols.some((col) => col.type === "a");
  const model = hasArtificial
    ? phaseOneModel(problem)
    : { phase: "single", cols, cj: problem.cj };
  return { problem, model, tableau: buildInitialTableau(problem, model) };
}

function solveTableau(problem, initial) {
  let tableau = initial;
  let unbounded = false;
  for (let step = 0; step < 100; step++) {
    const choice = computeStandardChoice(problem, tableau);
    if (choice.entering === null) break;
    if (choice.leavingSet.length === 0) {
      unbounded = true;
      break;
    }

    const basis = tableau.basis.slice();
    basis[choice.leavingSet[0]] = tableau.cols[choice.entering].key;
    const next = buildExpectedNext(
      problem,
      tableau,
      basis,
      tableau.cj,
      tableau.cols,
    );
    assert.ok(!next.error, next.error);
    tableau = next;
    if (step === 99) assert.fail("Simplex did not terminate within 100 pivots");
  }
  return { tableau, unbounded };
}

function makePhaseTwo(problem, tableau) {
  const cols = tableau.cols.filter((col) => col.type !== "a");
  const cj = cols.map((col) => problem.cj[problem.cols.findIndex((x) => x.key === col.key)]);
  const initial = {
    phase: "2",
    cols,
    cj,
    basis: tableau.basis.slice(),
    A: tableau.A.map((row) =>
      row.filter((_value, index) => tableau.cols[index].type !== "a"),
    ),
    b: tableau.b.slice(),
  };
  return { cols, cj, initial };
}

function terminalFlags(problem, tableau, unbounded) {
  const optimal = tableauOptimal(problem, tableau);
  const nonBasic = tableau.cols
    .map((col, index) => ({ col, index }))
    .filter(({ col }) => !tableau.basis.includes(col.key));
  const multipleOptima =
    optimal &&
    tableau.phase !== "1" &&
    nonBasic.some(({ index }) => tableau.cjz[index].isZero());
  const choice = computeStandardChoice(problem, tableau);
  const degenerate =
    tableau.b.some((value) => value.isZero()) || choice.ratioTie;
  return { optimal, unbounded, multipleOptima, degenerate };
}

function solutionFromTableau(problem, tableau, unbounded = false) {
  const x = Array.from({ length: problem.n }, (_, index) => {
    const row = tableau.basis.indexOf(`x${index + 1}`);
    return row === -1 ? "0" : tableau.b[row].toString();
  });
  return {
    x,
    z: tableau.zval.toString(),
    flags: terminalFlags(problem, tableau, unbounded),
  };
}

function solveSinglePhase(preset) {
  const { problem, tableau: initial } = makeProblem(preset);
  const { tableau, unbounded } = solveTableau(problem, initial);
  return solutionFromTableau(problem, tableau, unbounded);
}

function solveTwoPhase(preset) {
  const { problem, tableau: initial } = makeProblem(preset);
  assert.equal(initial.phase, "1");
  assert.ok(initial.cb.some((value) => value.eq(new Fraction(-1n, 1n))));
  assert.ok(initial.zj.some((value) => !value.isZero()));
  const phaseOne = solveTableau(problem, initial);
  assert.equal(phaseOne.unbounded, false);
  assert.equal(tableauOptimal(problem, phaseOne.tableau), true);

  if (!phaseOne.tableau.zval.isZero()) {
    return { status: "INFEASIBLE", w: phaseOne.tableau.zval.toString() };
  }
  const artificialBasic = phaseOne.tableau.basis.some((key) => {
    const col = phaseOne.tableau.cols.find((item) => item.key === key);
    return col && col.type === "a";
  });
  if (artificialBasic) return { status: "ARTIFICIAL_BASIC_AT_ZERO" };

  const phaseTwo = makePhaseTwo(problem, phaseOne.tableau);
  assert.equal(phaseTwo.initial.phase, "2");
  assert.equal(phaseTwo.initial.cols.some((col) => col.type === "a"), false);
  const solved = solveTableau(
    problem,
    {
      ...phaseTwo.initial,
      ...recomputePhaseTwoStartingValues(phaseTwo.initial, phaseTwo.cj),
    },
  );
  return {
    status: solved.unbounded ? "UNBOUNDED" : "OPTIMAL",
    ...solutionFromTableau(problem, solved.tableau, solved.unbounded),
  };
}

function recomputePhaseTwoStartingValues(tableau, cj) {
  const costs = cj.map((value) => Fraction.parse(value));
  const cb = tableau.basis.map((key) => {
    const index = tableau.cols.findIndex((col) => col.key === key);
    return costs[index];
  });
  const zj = tableau.cols.map((_col, j) =>
    cb.reduce(
      (sum, cost, i) => sum.add(cost.mul(tableau.A[i][j])),
      Fraction.zero(),
    ),
  );
  const zval = cb.reduce(
    (sum, cost, i) => sum.add(cost.mul(tableau.b[i])),
    Fraction.zero(),
  );
  return {
    cj,
    cb,
    zj,
    cjz: costs.map((cost, j) => cost.sub(zj[j])),
    zval,
  };
}

function combinations(items, count) {
  if (count === 0) return [[]];
  if (items.length < count) return [];
  const [head, ...tail] = items;
  return [
    ...combinations(tail, count - 1).map((rest) => [head, ...rest]),
    ...combinations(tail, count),
  ];
}

function solveSquare(matrix, rhs) {
  const n = rhs.length;
  const rows = matrix.map((row, i) => [...row, rhs[i]]);
  let pivotRow = 0;
  for (let col = 0; col < n; col++) {
    const found = rows.findIndex(
      (row, index) => index >= pivotRow && !row[col].isZero(),
    );
    if (found === -1) return null;
    [rows[pivotRow], rows[found]] = [rows[found], rows[pivotRow]];
    const pivot = rows[pivotRow][col];
    rows[pivotRow] = rows[pivotRow].map((value) => value.div(pivot));
    for (let row = 0; row < n; row++) {
      if (row === pivotRow) continue;
      const factor = rows[row][col];
      rows[row] = rows[row].map((value, j) =>
        value.sub(factor.mul(rows[pivotRow][j])),
      );
    }
    pivotRow++;
  }
  return rows.map((row) => row[n]);
}

function oneDimensionalNullspace(matrix, n) {
  const rows = matrix.map((row) => row.slice());
  let pivotRow = 0;
  const pivots = [];
  for (let col = 0; col < n; col++) {
    const found = rows.findIndex(
      (row, index) => index >= pivotRow && !row[col].isZero(),
    );
    if (found === -1) continue;
    [rows[pivotRow], rows[found]] = [rows[found], rows[pivotRow]];
    const pivot = rows[pivotRow][col];
    rows[pivotRow] = rows[pivotRow].map((value) => value.div(pivot));
    for (let row = 0; row < rows.length; row++) {
      if (row === pivotRow) continue;
      const factor = rows[row][col];
      rows[row] = rows[row].map((value, j) =>
        value.sub(factor.mul(rows[pivotRow][j])),
      );
    }
    pivots[pivotRow] = col;
    pivotRow++;
  }
  if (n - pivotRow !== 1) return null;
  const pivotSet = new Set(pivots);
  const free = Array.from({ length: n }, (_, index) => index).find(
    (index) => !pivotSet.has(index),
  );
  const vector = Array.from({ length: n }, () => Fraction.zero());
  vector[free] = new Fraction(1n, 1n);
  for (let row = pivotRow - 1; row >= 0; row--) {
    const col = pivots[row];
    vector[col] = rows[row][free].mul(new Fraction(-1n, 1n));
  }
  return vector;
}

function independentExactSolve(preset) {
  const n = preset.z.length;
  const inequalities = [];
  for (const constraint of preset.cons) {
    const relation = constraint.rel || "<=";
    const a = constraint.a.map((value) => Fraction.parse(value));
    const b = Fraction.parse(constraint.b);
    if (relation === "<=" || relation === "=") inequalities.push({ a, b });
    if (relation === ">=" || relation === "=") {
      inequalities.push({
        a: a.map((value) => value.mul(new Fraction(-1n, 1n))),
        b: b.mul(new Fraction(-1n, 1n)),
      });
    }
  }
  for (let j = 0; j < n; j++) {
    const a = Array.from({ length: n }, (_, i) =>
      new Fraction(i === j ? -1n : 0n, 1n),
    );
    inequalities.push({ a, b: Fraction.zero() });
  }

  const feasible = (x) =>
    inequalities.every(({ a, b }) => {
      const lhs = a.reduce(
        (sum, value, index) => sum.add(value.mul(x[index])),
        Fraction.zero(),
      );
      return lessOrEqual(lhs, b);
    });
  const vertices = [];
  for (const active of combinations(inequalities, n)) {
    const point = solveSquare(
      active.map((item) => item.a),
      active.map((item) => item.b),
    );
    if (point && feasible(point)) vertices.push(point);
  }
  const uniqueVertices = [
    ...new Map(
      vertices.map((point) => [point.map((value) => value.toString()).join(","), point]),
    ).values(),
  ];
  if (!uniqueVertices.length) return { infeasible: true };

  const coneRows = inequalities.map(({ a }) => a);
  const rays = [];
  for (const active of combinations(coneRows, n - 1)) {
    const ray = oneDimensionalNullspace(active, n);
    if (!ray) continue;
    for (const candidate of [ray, ray.map((value) => value.mul(new Fraction(-1n, 1n)))]) {
      if (
        coneRows.every((a) => {
          const value = a.reduce(
            (sum, value, index) => sum.add(value.mul(candidate[index])),
            Fraction.zero(),
          );
          return lessOrEqual(value, Fraction.zero());
        })
      ) {
        rays.push(candidate);
      }
    }
  }
  const objective = preset.z.map((value) => Fraction.parse(value));
  const objectiveAt = (x) =>
    objective.reduce(
      (sum, value, index) => sum.add(value.mul(x[index])),
      Fraction.zero(),
    );
  const unbounded = rays.some((ray) => objectiveAt(ray).isPos());
  if (unbounded) return { infeasible: false, unbounded: true };

  const values = uniqueVertices.map((point) => ({
    point,
    value: objectiveAt(point),
  }));
  const optimum = values.reduce(
    (best, item) => (item.value.gt(best) ? item.value : best),
    values[0].value,
  );
  return {
    infeasible: false,
    unbounded: false,
    z: optimum.toString(),
    multiple: values.filter((item) => item.value.eq(optimum)).length > 1,
  };
}

test("basis labels accept every supported column type", () => {
  for (const type of ["x", "s", "e", "a"]) {
    assert.equal(normBasisLabel(`${type}_12`), `${type}12`);
  }
  assert.equal(normBasisLabel("b12"), "");
});

test("negative right-hand sides flip relation and normalize coefficients", () => {
  assert.deepEqual(normalizeConstraint({ a: ["2", "-1"], b: "-5", rel: "<=" }), {
    a: ["-2", "1"],
    b: "5",
    rel: ">=",
    normalized: true,
  });
});

test("typed columns keep inequality and equality auxiliaries in the required order", () => {
  const cols = buildColumns(1, ["<=", ">=", "="]);
  assert.deepEqual(
    cols.map((col) => col.key),
    ["x1", "s1", "e2", "a2", "a3"],
  );
  const problem = {
    n: 1,
    m: 3,
    relations: ["<=", ">=", "="],
    cols,
    A: [["1"], ["2"], ["3"]],
    b: ["4", "5", "6"],
    cj: costsForColumns([Fraction.parse("7")], cols).map((value) =>
      value.toString(),
    ),
  };
  const initial = buildInitialTableau(problem, phaseOneModel(problem));
  assert.deepEqual(initial.basis, ["s1", "a2", "a3"]);
  assert.deepEqual(initial.cb.map((value) => value.toString()), ["0", "-1", "-1"]);
  assert.deepEqual(
    initial.A.map((row) => row.map((value) => value.toString())),
    [
      ["1", "1", "0", "0", "0"],
      ["2", "0", "-1", "1", "0"],
      ["3", "0", "0", "0", "1"],
    ],
  );
  assert.ok(initial.zj.some((value) => !value.isZero()));
});

for (const [id, expected] of Object.entries(expectedPresets)) {
  test(`${PRESETS[id].label} reaches its expected terminal tableau`, () => {
    assert.deepEqual(solveSinglePhase(PRESETS[id]), expected);
  });
}

test("Ex3 two-phase simplex matches its exact multiple-optimum result", () => {
  const exact = independentExactSolve(PRESETS.ex3);
  assert.deepEqual(exact, {
    infeasible: false,
    unbounded: false,
    z: "70",
    multiple: true,
  });
  const result = solveTwoPhase(PRESETS.ex3);
  assert.equal(result.status, "OPTIMAL");
  assert.deepEqual(result.x, ["10", "10", "20"]);
  assert.equal(result.z, "70");
  assert.deepEqual(result.flags, {
    optimal: true,
    unbounded: false,
    multipleOptima: true,
    degenerate: false,
  });
});

test("Ex4 Phase 1 succeeds and its Phase 2 is unbounded", () => {
  const exact = independentExactSolve(PRESETS.ex4);
  assert.deepEqual(exact, {
    infeasible: false,
    unbounded: true,
  });
  const result = solveTwoPhase(PRESETS.ex4);
  assert.equal(result.status, "UNBOUNDED");
  assert.deepEqual(result.x, ["0", "11/5", "8/5"]);
  assert.equal(result.z, "-3/5");
  assert.deepEqual(result.flags, {
    optimal: false,
    unbounded: true,
    multipleOptima: false,
    degenerate: false,
  });
});

test("Ex5 is infeasible in the exact solver and Phase 1", () => {
  assert.deepEqual(independentExactSolve(PRESETS.ex5), { infeasible: true });
  assert.deepEqual(solveTwoPhase(PRESETS.ex5), {
    status: "INFEASIBLE",
    w: "-1",
  });
});
