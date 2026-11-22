# SimplexSheet

Blank-tableau worksheets for practicing the simplex method, so you spend your time solving, not drawing tables.

> Status: early development. Built for the *Techniques d'optimisation* TD exercises.

## What it does

- You enter a maximisation LP with `≤`, `≥`, or `=` constraints.
- Negative right-hand sides are normalized and shown in the preview.
- Problems needing artificial variables start in Phase 1; feasible problems can continue to Phase 2.
- You fill in the following tableaux yourself, in one of two layouts (Style A or Style B).
- Optional helpers: check your work, reveal a tableau, load preset exercises, highlight the pivot hint.

Exact fractions are used for all checking (no floating-point errors).

## Scope

In: Max problems, `≤` / `≥` / `=` constraints, `x ≥ 0`, standard and two-phase simplex.
Out for now: Min problems and Big M.

## Run it

No install needed. Open `index.html` in a browser.

Run the exact-arithmetic core and preset tests with `node --test test/simplex-core.test.js`.

## Project layout

```
index.html   page structure
style.css    styling
script.js    all the logic (fractions, pivot rules, checking)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). New to Git? Read [GIT_GUIDE.md](GIT_GUIDE.md).

## License

MIT, see [LICENSE](LICENSE).
