# SimplexSheet

Blank-tableau worksheets for practicing the simplex method, so you spend your time solving, not drawing tables.

> Status: early development. Built for the *Techniques d'optimisation* TD exercises.

## What it does

- You enter a maximisation LP with `≤` constraints.
- It shows the problem in a readable form and builds the first tableau for you.
- You fill in the following tableaux yourself, in one of two layouts (Style A or Style B).
- Optional helpers: check your work, reveal a tableau, load preset exercises, highlight the pivot hint.

Exact fractions are used for all checking (no floating-point errors).

## Scope

In: Max problems, `≤` constraints, `x ≥ 0`, standard simplex.
Out for now: Min, `≥` / `=` constraints, Big M, two-phase.

## Run it

No install needed. Open `index.html` in a browser.

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
