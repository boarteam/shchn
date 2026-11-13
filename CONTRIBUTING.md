# Contributing

Thanks for helping. shchn is small, and the goal is to keep it easy to run, measure and change.

- **Start here:** [docs/development.md](docs/development.md) covers setup, the code layout, and how to test a change.
- **Something misbehaves?** [docs/debugging.md](docs/debugging.md) has the tools and the known problems. Please include the output of `./shchn mic` and `npm run debug:session` in audio or latency bug reports, and attach a `--save-audio` recording if you can share it.
- **Pull requests:** `npm test` and `npm run typecheck` pass, behavior changes come with a replay score (`./shchn replay … --expect …`), and docs are updated in the same pull request.

By contributing you agree that your work is released under the [MIT License](LICENSE).
