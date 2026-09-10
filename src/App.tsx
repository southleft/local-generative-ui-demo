/**
 * Top-level application composition for Local UI Composer. State and generation
 * orchestration live in the workbench controller hook; this module owns shell
 * layout and the default export used by tests.
 */

import { ControlPanel } from './control-panel';
import { InspectorSection } from './inspector-section';
import { PreviewPanel } from './preview-panel';
import { useComposerWorkbench, type ComposerWorkbenchOptions } from './use-composer-workbench';

export type AppProps = ComposerWorkbenchOptions;

export default function App(props: AppProps) {
  const { controlPanel, previewPanel, inspectorSection } = useComposerWorkbench(props);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Local UI Composer home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span>Local UI Composer</span></a>
        <div className="topbar-meta"><span className="privacy-pill"><span />Browser-local inference</span><span>Official @a2ui/react v0.9 renderer</span></div>
      </header>
      <main id="top">
        <section className="hero hero--compact">
          <p className="overline">FREE-FORM GENERATIVE UI · A2UI V0.9 · ZERO SERVERS</p>
          <h1>Describe any interface.<br /><span>A local model composes it live.</span></h1>
        </section>
        <section className="workbench" aria-label="Generative UI workbench">
          <ControlPanel {...controlPanel} />
          <PreviewPanel {...previewPanel} />
        </section>
        <InspectorSection {...inspectorSection} />
      </main>
      <footer><span>EXPERIMENT 001 · LOCAL GENERATIVE UI</span><span>Chrome Prompt API · LiteRT-LM 0.14 · @a2ui/react 0.10 · A2UI v0.9</span></footer>
    </div>
  );
}
