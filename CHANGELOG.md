# Changelog

All notable changes to Reevik Java ADE are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-09-15

A large feature release: an agentic task board, Git conflict tooling, a Spring
panel, richer run/debug, a configurable keymap, and many editor and UI upgrades.

### Task Board & AI agents
- Trello-style **task boards** — multiple boards per project, customizable and
  freely reorderable columns, drag-and-drop cards, manual add, and **AI task
  generation** from a description.
- **Versioned, immutable specs** with the full markdown editor; editing creates a
  new version. Generated tasks are linked to the exact spec version they came
  from (a badge on the card jumps back to it).
- **Assign a ticket to a coding agent** that works in the repo and streams its
  progress into the ticket's **comment thread** (rendered as Markdown). The agent
  can ask for input or request human review, and **runs the build/tests to
  verify** its work.
- **Dependency-ordered execution** — tasks can depend on others and run in order;
  the AI determines dependencies during generation. Agents get **context from
  related tickets** so they build on prior findings.

### Git
- **Merge conflicts** surface in the Changes panel (red markers) with a
  **Resolve** action; a **3-way merge tool** and a simplified
  *3-way / Accept theirs / Accept mine* menu.
- Git panel opens on **Changes** by default.

### Run & Debug
- **Typed run configurations**: Java Application, **Spring Boot**,
  **Remote JVM Debug**, Maven, Gradle, JUnit — chosen from an Add menu.
- Java applications launch via a **resolved classpath** (compiling `target/classes`
  only when stale) instead of `exec:java`, and the **JVM in use is printed** to
  the output.
- **Spring Boot** runs through `spring-boot:run` / `bootRun` with the detected
  `@SpringBootApplication` main class.
- **Remote JVM Debug** attaches over JDWP; the agent snippet is shell-safe and
  attach failures report the real reason.
- Debugger controls restyled to match the toolbar's fused button group.

### Spring
- **Beans & Endpoints panel** — stereotype beans and `@Bean` methods, plus REST
  endpoints (method + resolved path → handler), each clickable to the source.

### Editors & languages
- **Refactoring** menu (JDT-powered) from right-click and the Code palette.
- **YAML** syntax highlighting + validation; **Gradle** highlighting + DSL
  completion.
- Markdown live preview: HTML blocks, local images, badge rows, per-language
  fenced-code highlighting, GFM tables, hidden link-reference definitions.
- Markdown **diagrams**: **mermaid** (local) and **PlantUML** rendering with
  fit-to-width default, zoom controls, and drag-to-pan.
- **Type-specific icons** for Java files (class / interface / enum / record /
  annotation).

### AI
- **AI Connectors** — auto-detect the AI agents on the machine (Claude Code,
  Anthropic API) and choose the default.
- **Skills** panel — default skills from `~/.claude`/project `.claude` plus
  external folders, each toggled on/off.
- Long code blocks in chat collapse by default.

### Project & files
- File tree: **cut / copy / paste**, **drag-to-move**, **undo** (⌘Z), and
  contiguous multi-selection rendered as one cluster.
- Auto-detect source/resource roots; a **Detect source paths** action; folder
  icons in the Project Structure lists.
- **JDK auto-discovery**; the selected JDK drives build, run, and debug.
- **Maven/Gradle build panel** with lifecycle goals in the left rail.
- Async, collapsed-by-default project tree with a loading indicator; open-tab cap.

### Settings & keymap
- IntelliJ-style **settings tree** with a search box.
- **Configurable keymap** — Default / IntelliJ IDEA / NetBeans templates, custom
  per-action overrides, and JSON import/export.
- Manage **code styles** (Google / AOSP / imported Eclipse XML) and **actions on
  save** (organize imports, reformat).
- Native `<select>` dropdowns replaced with custom ones; the command palette and
  native menu updated to surface the new features.

## [0.1.0]

- Initial public release.
