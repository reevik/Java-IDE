# Reevik Java ADE

**A glossy, native macOS Java IDE with a built-in AI coding agent.**

Reevik Java ADE is a fast, focused desktop IDE for Java and Spring projects.
It pairs a clean editor and a full Maven/Gradle build & debug experience with
first-class AI: an agent that works your tickets in the repo, an assistant that
understands your code, and tooling that plugs into the Claude CLI, MCP servers,
and your own agent skills.

Built with [Tauri 2](https://tauri.app/) (Rust) + React + TypeScript, and the
[Eclipse JDT language server](https://github.com/eclipse-jdtls/eclipse.jdt.ls)
for real Java intelligence.

---

## Purpose

Modern Java IDEs are powerful but heavy, and AI features are usually bolted on.
Reevik Java ADE is built the other way around: a lightweight, native app where
AI is a native citizen — you can hand a ticket to an agent that edits files and
runs your tests, generate a commit message from your staged diff, or review a
file before you commit — while still getting the everyday essentials of a Java
IDE: code completion, go-to-definition, refactoring, a proper debugger, Git, and
Spring support. It targets everyday Java and Spring Boot development, including
multi-module (reactor) projects.

## Major features

### AI
- **Agentic Task Board** — a Trello-style board with **immutable, versioned
  specs**; the AI breaks a spec into tasks with dependencies, and a coding agent
  works each ticket in the repo, runs the build/tests to verify, and streams its
  progress into the ticket's comment thread.
- **AI Assistant** — a project-aware chat grounded in the open file and codebase.
- **Intelligent Review** — review a file for issues with individually-applicable
  suggestions.
- **AI-generated commit messages** — one click writes a Conventional-Commits
  message from your staged diff.
- **MCP servers panel** — see the Model Context Protocol servers available to
  the Claude CLI and their live connection status.
- **Skills panel** — toggle agent skills from `~/.claude`, the project's
  `.claude`, and external folders.
- **AI Connectors** — auto-detect the AI backends on the machine (Claude Code
  CLI, Anthropic API) and choose the default.

### Java, build & debug
- **Java language intelligence** via jdtls — completion, go-to-definition, find
  usages, hover, rename, and JDT-powered **refactorings**.
- **Typed run configurations** — Java Application, **Spring Boot**
  (`spring-boot:run` / `bootRun`), **Remote JVM Debug** (JDWP attach), Maven,
  Gradle, and JUnit.
- **Debugger** — breakpoints, stepping, variables, call stack, and expression
  evaluation.
- **Spring support** — a **Beans & Endpoints** panel, with reactor-aware
  detection so Spring is recognized even when it lives in submodules.
- **JDK auto-discovery** and a selectable JDK that drives build, run, debug, the
  language server, and formatting.
- **Maven auto-detection** — finds Homebrew / SDKMAN / `MAVEN_HOME` installs on
  the filesystem (so it works even without a login-shell `PATH`), with a picker
  under Settings → Tools → Maven.

### Editors & diagrams
- **YAML** and **Gradle** highlighting + validation/completion.
- **Markdown** live preview with local images, GFM tables, and **mermaid /
  PlantUML diagrams**.
- **PlantUML split editor** — open a `.puml` file to edit the source on the left
  with a live-rendered diagram on the right (fit-to-width, zoom, pan).
- **Configurable code styles** (Google / AOSP / imported Eclipse profiles) and
  actions-on-save.

### Git
- Full Git panel: **history, working-tree changes, staging, and a branch graph**.
- **Merge-conflict tooling** — conflicts surface in the Changes tab with a 3-way
  merge tool plus quick *Accept theirs / Accept mine*.
- **Remote sync** — Fetch, Pull (rebase), and Push with ahead/behind indicators.

### Project & workspace
- File tree with **cut / copy / paste, drag-to-move, undo**, multi-select, and a
  toggle to reveal normally-hidden build/tooling files.
- **External-change watcher** — files created or changed outside the IDE appear
  automatically.
- **Problems panel** (virtualized for large diagnostic counts) and a
  language-server **indexing indicator** in the status bar.
- Auto-detected source/resource roots; Maven/Gradle **build panel**.

### Settings & keymap
- IntelliJ-style **settings tree** with search.
- **Configurable keymap** — Default / IntelliJ IDEA / NetBeans templates, custom
  per-action overrides, and JSON import/export.

## Getting started

Requirements: **macOS**, [Node.js](https://nodejs.org/) 20+, the
[Rust toolchain](https://rustup.rs/), and a **JDK** (e.g. `brew install openjdk@21`).
The Claude CLI is optional but required for the AI agent features.

```bash
# Install dependencies
npm install

# Run the app in development
npm run tauri dev

# Build a release bundle (.app + .dmg)
npm run tauri build
```

## Contributing

Contributions are welcome! Bug reports, feature ideas, and pull requests all help.

- **Found a bug or have an idea?** Open an
  [issue](https://github.com/reevik/Java-IDE/issues).
- **Sending a pull request?** Fork the repo, create a feature branch, and open a
  PR against `main`. Please keep changes focused, run `npm run tauri dev` to
  verify locally, and make sure the frontend typechecks (`npx tsc --noEmit`) and
  the backend builds (`cargo check` in `src-tauri`).
- Match the surrounding code style and keep commits scoped and well-described.

By contributing, you agree that your contributions will be licensed under the
project's Apache 2.0 license.

## License

Licensed under the **Apache License, Version 2.0**. See [LICENSE](LICENSE) for
the full text.

```
Copyright 2026 Erhan Bağdemir

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
