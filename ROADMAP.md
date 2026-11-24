# Roadmap & Upcoming Patches

Planned bug fixes , documentation updates, and features for **LinearProgrammingSheet**.

## 🐛 Bug Fixes (`fix`)
- [ ] **Phase 2 Initial Tableau:** Add the missing "Check answer" and "Reveal Tableau" buttons to the first tableau of Phase 2.

- [ ] **"Clean" Table Style Layout:** Move the decision variables row ($x_1, x_2, \dots$) (the one between $C_B$ and $b$) up, and use the freed space to display the objective $x$ coefficients (matching the "Academic" style for better clarity).


- [ ] **Manually Removing first generated tableau  :** Deleting first generated tableau (through "Generate first tableau" button and deleting it with "Remove" button) doesn't allow the user to <u>check his work </u> or <u>Reveal Tableau</U> . 
## 📖 Documentation & UX (`doc`)
- [ ] **Pivot Hint Disclaimer:** Add a clear warning/tooltip informing users that the "Pivot hint" highlights the standard textbook pivot rule and does not necessarily reflect their personal pivot path.

## ♻️ Refactoring (`refactor`)
- [ ] **Refactor script.js :** split the single script.js into ES modules without any behaviour changes . This is very necessary for easier future scalability and readability.

## ✨ New Features (`feat`)
- [ ] **Standard form explanation :** Allow for an option to demonstration on how constraints where normalized 
- [ ] **Equivalent values of $C_j - Z_j$:** Treat the case when we have 2 or more choices of pivots by following the **Greatest Improvement Rule (Largest Objective Change Tie-Breaker)**:

  When two or more entering variables $x_j$ have equal $C_j - Z_j$ values in the Simplex method:

  1. **Minimum Ratio for each tied column $j$:**

     $$\theta_j = \min_{a_{ij} > 0} \left( \frac{b_i}{a_{ij}} \right)$$

  2. **Total Objective Improvement for column $j$:**

     $$\Delta Z_j = |C_j - Z_j| \times \theta_j$$

  3. **Pivot Column Selection Rule** *(since $|C_j - Z_j|$ is equal for all tied columns)*:

     $$j^* = \arg\max_{j \in \{\text{tied}\}} \left( \theta_j \right) = \arg\max_{j \in \{\text{tied}\}} \left[ \min_{a_{ij} > 0} \left( \frac{b_i}{a_{ij}} \right) \right]$$

  * **Pivot Column:** $j^*$ *(the tied column with the **maximum** minimum-ratio $\theta_j$)*
  * **Pivot Row:** $i^*$ *(the row that produced $\theta_{j^*}$)*
  * **Pivot Element:** $a_{i^* j^*}$

- [ ] **Equivalent values of Ratio (Degeneracy Tie-Breaker):** Treat the case when two or more rows produce the same minimum ratio $\theta_{\min}$ by following the **Minimum Row Coefficient Sum Rule**:

  When two or more leaving rows $i$ tie for the minimum ratio $\theta_{\min} = \min_{a_{ik} > 0} \left( \frac{b_i}{a_{ik}} \right)$ in pivot column $k$:

  1. **Sum of Coefficients for each tied row $i$:**

     $$S_i = \sum_{j=1}^{n} a_{ij}$$

     *(Sum all constraint coefficients $a_{ij}$ across row $i$, excluding the RHS $b_i$ and the ratio column).*

  2. **Leaving Row Selection Rule:**

     $$i^* = \arg\min_{i \in \{\text{tied}\}} \left( S_i \right) = \arg\min_{i \in \{\text{tied}\}} \left( \sum_{j=1}^{n} a_{ij} \right)$$


  * **Pivot Column:** $k$ *(the selected entering variable column)*
  * **Pivot Row (Leaving Variable):** $i^*$ *(the tied row with the **minimum** sum of coefficients $S_i$)*
  * **Pivot Element:** $a_{i^* k}$

- [ ] **Big-M Method:** Add support for solving LP problems using the Big-M method alongside Two-Phase Simplex.
