# Third-party skills in `vendor/`

These folders are copies of other people's open-source skills, redistributed
under their own licenses (the LICENSE file is kept in each folder). They are
included so the [engineering workflow](skills/engineering-workflow) works out
of the box. All credit goes to their authors; please star and contribute
upstream.

| Folder | Upstream | License | Local changes |
|---|---|---|---|
| `vendor/agent-pods` | [jgharbieh/agent-pods](https://github.com/jgharbieh/agent-pods) | MIT | none |
| `vendor/caveman` | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) | MIT | `skills-lock.json` lists the installed caveman skills; LF line endings |
| `vendor/claude-browser-stack` | [jgharbieh/claude-browser-stack](https://github.com/jgharbieh/claude-browser-stack) | MIT | none |
| `vendor/claude-collab` | [maarudth/claude-collab](https://github.com/maarudth/claude-collab) | Apache-2.0 | 3 lines added to `package.json`; LF line endings |
| `vendor/coleam00-skills` | [coleam00/skills](https://github.com/coleam00/skills) | MIT | `build-dark-factory/scripts/_test_audit_runner.py` finds its folder from `__file__` instead of the author's hard-coded path |
| `vendor/taste-skill` | [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | MIT | none |
| `vendor/web-scraping` | [bcharleson/webscraping-skill](https://github.com/bcharleson/webscraping-skill) | MIT | none |
| `vendor/graphify` | [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify) | Apache-2.0 | skill folder only; LICENSE fetched from upstream |
| `vendor/error-analysis` | [hamelsmu/evals-skills](https://github.com/hamelsmu/evals-skills) | MIT | skill folder only; LICENSE fetched from upstream |
| `vendor/refactor-safely` | [tirth8205/code-review-graph](https://github.com/tirth8205/code-review-graph) | MIT | skill folder only; LICENSE fetched from upstream |
| `vendor/repo-story-time` | [github/awesome-copilot](https://github.com/github/awesome-copilot) | MIT | skill folder only; LICENSE fetched from upstream |

Nothing was removed from these copies. Version-control metadata and
dependency folders (`node_modules`) are not included.

Some skills are not bundled, because their license does not allow
redistribution, the license is unclear, or the skill was not reviewed. Install
those from source; see [COLLECTION.md](COLLECTION.md).

Copyright holders who prefer not to be redistributed here can open an issue,
and the copy will be replaced with an install link.
