# The Generation Pipeline: How a 2GB Browser Model Composes Real UI

This is the complete, honest account of what happens between a free-form prompt and a rendered interface in the Local UI Composer prototype — including everything the harness does to keep a small local model on track, and exactly where the model's authorship ends and the harness's guidance begins. All examples are from real captured runs of Gemma 4 E2B running in Chrome via LiteRT-LM.js 0.14 on WebGPU. The rendering protocol is A2UI v0.9 on its official packages, `@a2ui/react` + `@a2ui/web_core` — nothing about the protocol runtime is reimplemented here.

## The one-paragraph version

A free-form request is matched against intent keywords to pick a structural blueprint; the prompt hands the model an 18-component catalog, a compact rule block, and that blueprint. The model streams a flat array of **A2UI v0.9 components**, rendered live as it emits. The finished output then passes through a salvage layer that repairs JSON, interprets synonyms generously, reconstructs the structures small models routinely mis-serialize, and removes their repetitions — before strict schema validation, wrapping in the A2UI message envelopes, and rendering through the official processor and renderer over an owned React design system. No generated HTML, CSS, or JavaScript ever executes. The stance throughout: **guardrails that recover instead of reject, and reconstruction of intent, never invention of content.**

## Stage by stage

### 1. Prompt assembly (~3,100 characters)

The prompt contains, in order:

1. **The request**, verbatim.
2. **A creative-latitude framing** — the model is told it is the UI designer and chooses components, hierarchy, content, tones, and accent.
3. **The catalog guide** — an aligned table of all 18 components with their props as `prop=value` enums. Small models read aligned tables far better than JSON Schema prose.
4. **A compact rule block** (~6 lines) — flat-array transport shape, bind/action restrictions, plain-text-only content, "aim for 8–20 nodes."
5. **The pattern blueprint(s)** — last, because recency dominates a 2B model's attention.

**Blueprint selection** matches the raw request against per-pattern keyword lists (form, chat, dashboard, settings, compare — checkout and signup map to form). Up to two matching blueprints are injected, e.g.:

```
Form: Page [Heading, Text short intro, one Card [3-6 labeled TextField or
Select or TextArea fields, each with bind], Inline justify=end [Button
tone=secondary, Button tone=primary]]
```

The header instructs: *"copy the STRUCTURE, never the words."* Blueprints are written strictly in the catalog's own vocabulary — early drafts used notation like `Stack(lg)`, which greedy models copied into output as a literal component name. An unmatched creative request gets a single generic scaffold line, so free-form prompts stay free-form. The blueprints and keywords are user-editable in the app's **Prompt & guardrails** tab.

### 2. Transport constraint

Chrome's Prompt API enforces the outer JSON shape natively (`responseConstraint`): an object with a `root` ID and a flat `components` array whose `component` values come from the 18-name allowlist. LiteRT has no constrained decoding, so the same schema is appended to the prompt as text. Crucially, the schema constrains only the *transport* — component count, topology, content, props, and styling are all left to the model.

The shape it constrains is A2UI's own component syntax: props sit alongside `id` and `component`, bindings are `value: { path }`, and actions are `action: { event: { name } }` — the shapes the official schemas define. Only the message envelopes are withheld, and that is a measured decision, not a shortcut: on the same surface, A2UI component syntax costs **92%** of the bespoke `{root, nodes}` format it replaced (337 vs. 366 characters — the native form is *cheaper*), while asking the model to emit the full `createSurface`/`updateComponents`/`updateDataModel` stream costs **147%** and requires multi-message serialization a 2B model does not reliably survive. Supplying envelopes is what a transport does; the vocabulary and the composition are the model's.

### 3. Locked focused decoding

The prototype deliberately errs toward established patterns over creative variation. Chrome samples at temperature 0.4 / topK 3. LiteRT-LM 0.14 decodes greedily no matter what — a field finding: its WebGPU runtime rejects `top-k > 1` outright and aborts the WASM on TOP_P sampling — so on LiteRT the same prompt reproduces the same surface, byte for byte.

### 4. Streaming with a live preview

LiteRT emits ~1,000 small chunks over 30–60 seconds. Every ~140ms the accumulated partial output is run through `jsonrepair` (which closes unterminated JSON) and re-parsed. The live preview reconciles **append-only under stable model-declared IDs**: the root freezes once resolved, a node that has rendered is never removed mid-stream, prop updates happen in place, and single parenthood is enforced as claims arrive (the first parent whose children array mentions an id keeps it, except that the root yields to a more specific container — the same rule the final salvage applies, so the streaming layout matches the committed one). Text visibly grows and components accumulate instead of the canvas flickering. A ticker narrates arriving components. During a repair attempt, the previous partial surface stays visible under a "refining" banner rather than blanking.

### 5. Repetition cut-off

Greedy decoding's classic failure is the verbatim loop: the model re-emits the same nodes until the token budget dies. The stream watches itself — if a 400-character block repeats, or output passes 24,000 characters, the conversation is cancelled and the pipeline continues with what arrived. One real run logged 79 guardrail adjustments before this existed; the loop is now cut within ~20 chunks.

### 6. Salvage: the interpretation layer

The heart of the system. Strictness lives in the *validators*; the layer in front of them interprets generously, in this order:

1. **Fused-key splitting, delimiter balancing, jsonrepair** — Gemma habitually drops the closing brace of its last node, and sometimes fuses a key with its value inside one string in key position (`"value:12"`, `"tone:warning"`), which no generic repairer can guess; those are split back into pairs first.
2. **Fragment merging and re-splitting** — truncation makes jsonrepair split output into an envelope plus stray top-level nodes, which are merged back. The inverse failure also occurs: a stream that never closes any node object parses as *one* object whose repeated `"id"` keys overwrite each other; salvage detects the mismatch between id keys in the text and nodes that survived parsing, then re-splits the text at each `"id"` boundary into individual nodes. And when whole-document repair fails outright (children inlined four levels deep), the same per-`"id"` re-split repairs every fragment on its own — with one retry that strips the stray quote Gemma leaves after a closed inline child (`{}}"}`), since `}"` is never valid JSON. Each of these is disclosed as a logged adjustment.
3. **Synonym coercion** (~135 mappings) — `Title`→Heading, `error`→critical, `purple`→violet, `"75%"`→75, `[2]`→2 columns, `phone`→tel; stray top-level props are folded into `props`; unknown props are dropped rather than failing the node. `value` is A2UI's binding slot **only on TextField, TextArea, and Select**; on every other component it is an ordinary prop — a distinction that, when missed, silently deleted every Metric (see the field findings).
4. **Inline-child reconstruction** — the most surprising real-world pattern. Gemma frequently inlines whole components into a `children` array instead of emitting nodes:
   ```json
   "children": ["TextField", "label": "Full Name", "bind": "/state/fullName"]
   ```
   or `"children": ["Button": {"label": "Accept Solution", …}]`. jsonrepair flattens these into token streams; salvage parses them back into real child nodes. One run reconstructed 14 inline components across 5 containers and rendered first-try.
5. **Duplicate-ID dedup, with two readings** — an identical repeat is the greedy loop and drops. A leaf that reuses an earlier *container's* id is the model pointing at its parent (it lists a Card's children as type names, then emits each leaf under the Card's own id) and is re-homed under that container with a fresh id. A leaf that reuses another leaf's id with different content (four shipping fields all named `shippingAddressField`) is renamed and kept. Component type names written into `children` are annotations of the child that follows by id, not dangling references, and are dropped without being counted as pruning.
6. **Per-node strict validation with recovery** — invalid optional props are stripped before a node is given up on; a label-less Button takes its label from its action name (`submitIntake` → "Submit intake"); icon-only Headings keep their emoji; label-less fields render label-less.
7. **Semantic dedup** — repeated *content* under different IDs (two "Full Name" fields, twin submit buttons, a duplicated heading or metric) keeps only the first occurrence. Tags, badges, and dividers are exempt: short repeats of those are legitimate.
8. **Reference pruning, single parenthood, cycle breaking** — refs to missing nodes drop; a node the model lists under two parents (a real flagged case: `root` and a `Stack` both claiming the same card, rendering it twice) is settled to one parent, with **the root yielding to the more specific container**; cycles are cut.
9. **Orphan adoption** — small models emit depth-first without linking children to containers (or "link" them by component *type name*). Disconnected nodes are adopted into the nearest preceding layout container in emission order, which reconstructs the intended tree. Before this pass existed, one run lost 21 of 29 nodes.
10. **Cleanup** — empty layout containers are removed (they render as hollow borders); runs of consecutive Buttons/Tags/badges are grouped into an `Inline` row, and runs of consecutive Metrics into a `Grid` (columns = run length, capped at 4), so the flex-column containers don't stack side-by-side content into full-width rows.

Every adjustment is logged on the run and shown in the UI as "N guardrail adjustments," with repetitive families aggregated into single summaries.

### 7. Strict validation, compile, render

The salvaged graph must pass per-component Zod schemas (`.strict()`) and graph integrity checks (existing root, no cycles, full reachability). It is then wrapped in the **A2UI v0.9** message envelopes (`createSurface` → `updateComponents` → `updateDataModel`), handed to `@a2ui/web_core`'s official `MessageProcessor` — which owns surface state, the data model, binding resolution, and action dispatch — and rendered by `@a2ui/react`'s `A2uiSurface` over the shared React design system, declared as a real A2UI `Catalog`. The design system carries all visual opinion: spacing rhythm is built into Page and Card themselves (models rarely emit explicit layout wrappers), semantic tones map to the palette, and an 8-hue accent themes the surface. The model picks the knobs; the catalog decides what they look like.

### 8. The repair loop (rare by design)

Only when salvage cannot reach a renderable floor — a root plus at least one visible content component — is the model asked to try again, at most twice, with the concrete validation errors quoted. Post-salvage, most runs render on the first attempt with zero to two logged adjustments.

## The honest attribution

- **The model authors** every word on the surface, the selection and ordering of components (emission order is treated as design intent), grouping intent, tones, accent, icons, and action names. Salvage is prompt-blind — it sees only the parsed output, never the request or blueprint — so it can reattach what the model wrote but cannot steer toward what was asked.
- **The harness contributes** all visual design, the transport schema, the salvage layer, the blueprints, and the reliability machinery.
- **For blueprint-matched requests, macro-layout is substantially harness-guided** — a greedy model follows an injected skeleton closely; that is precisely why forms, chat, and dashboards land on the first try. Micro-composition and all content remain the model's. For unmatched creative prompts, structure is predominantly the model's own.
- Rough split: content ~100% model · visual design ~100% harness · structure ~40/60 model/harness on matched patterns, ~70/30 on creative ones.

Two clean experiments make the attribution measurable, and both are one click in the workbench:

1. **Blueprint contribution**: open the **Prompt & guardrails** tab, blank out a blueprint's keywords, and regenerate the same prompt. The difference between the two surfaces is exactly the blueprint's contribution.
2. **Salvage contribution**: flip the **Guardrails toggle** from Recover to Strict and regenerate. Strict mode applies no repair, coercion, or restructuring — raw output must survive plain `JSON.parse` and the strict schemas (the model-side repair loop still gets its two retries). On the rocket-launch prompt, Recover rendered 18 components with seven logged adjustments while Strict failed all three attempts at `JSON.parse`, from a byte-identical first attempt — with deterministic decoding, that difference *is* the salvage layer's contribution, reproducibly.

## Where each stage lives

| Stage | Module |
| --- | --- |
| Prompt assembly, blueprints, transport constraint | `src/prompt.ts` (the catalog guide is derived from `src/catalog.tsx`) |
| Decoding, streaming, repetition cut-off | `src/local-model.ts`, `src/chrome-language-model.ts`, unified in `src/model-provider.ts` |
| Live preview | `src/streaming.ts` (composer) and `src/streaming-preview.tsx` (renders through the catalog's own render functions) |
| Text repair | `src/repair.ts` |
| Salvage passes | `src/salvage.ts`, one named function per pass, in the order listed above |
| Coercion vocabulary and per-component rules | `src/vocabulary.ts` and the `props` rules in `src/catalog.tsx` |
| Strict validation | the catalog schemas in `src/catalog.tsx`, applied per node in `src/salvage.ts` |
| Compile, official processor, renderer | `src/a2ui-protocol.ts` |
| Repair loop and run orchestration | `src/use-composer-workbench.ts` (`src/App.tsx` only lays out the shell) |

The field findings that motivated each pass, with the measured before-and-after numbers, are collected in [`field-notes.md`](field-notes.md).
