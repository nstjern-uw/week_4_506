Answer these questions. Two to four sentences per answer, in your own words, grounded in your experience on this assignment. We're not looking for textbook definitions — we want to see that you understood what you just did and why it mattered.

On building the apparatus:

1. Why do we create a harness? Why is it worth the time, instead of just asking AI to fix the bug directly?

    Race conditions can be difficult to reporduce. The harness is used to make the bug reporducible in conditions that guarantee the outcome. 

2. Why is isolation important? Why does the harness drive the failing code path under controlled conditions instead of running the full app and hoping the bug fires?

    Software can be complex and non-deterministic. If we hold certain variables constant and then test, we can be more granular with our overall testing. This is helpful when bugs only happen some of the time. 

3. How does modular design help in debugging? This bug had a clear seam between "save" and "publish." How would the debugging have been different if the same logic were buried in a 500-line monolithic handler with no clear boundaries?

    Modular design helps us sequester the part of the application that is not functioning as intended. This reduces the overall complexity. If we had a monolith, then it would make trying to understand what was happening where very difficult. 

On the review:

4. What kinds of problems with a fix can a code review catch that an automated test cannot? Be specific — name a category of issue.

    The code review is where someone reasons about a fix as it relates to the overall system. Tests are focused on inputs and outputs and often don't involve inputs you didn't write, invariants you didn't encode, or design choices. 

5. Quote from your review. Paste 1–3 lines from your actual review session — the most useful or interesting point your reviewer raised — and explain why testing alone wouldn't have surfaced it. If your reviewer's response was thin and didn't surface anything substantive, paste what they did say and describe what you'd hope a stronger review would catch on a fix like this.

    This is correctness-by-microtask-ordering. Any future refactor — moving the
`.then` registration above the `add()`, switching to `await` style, or
wrapping in a helper — silently reintroduces the original race.

    This seemed to be the most powerful of all the recommendations because it sounds like it is saying the AI created a condition that solved for the short-term, but not for the long-term. I imagine this is some type of programming fallacy or antipattern, but it serves as a reminder that the AI is still just a next token generator. We still need to have an overall vision -- or at least ask it to evaluate itself critically -- as we are leveraging these new tools. 