import { useState } from 'react';
import { AssistantTab } from './components/AssistantTab';
import { IngestTab } from './components/IngestTab';

type Tab = 'assistant' | 'ingest';

export default function App() {
  const [tab, setTab] = useState<Tab>('assistant');

  return (
    <div className="desktop-shell">
      <header className="desktop-header">
        <div className="drag-region" />
        <nav className="tab-bar">
          <button
            type="button"
            className={`tab-btn${tab === 'assistant' ? ' active' : ''}`}
            onClick={() => setTab('assistant')}
          >
            Assistant
          </button>
          <button
            type="button"
            className={`tab-btn${tab === 'ingest' ? ' active' : ''}`}
            onClick={() => setTab('ingest')}
          >
            Ingest
          </button>
        </nav>
        <button
          type="button"
          className="close-btn"
          title="Minimize"
          onClick={() => window.electronAPI.minimizeWindow()}
        >
          _
        </button>
      </header>

      <main className="desktop-workspace workspace">
        {tab === 'assistant' ? <AssistantTab /> : <IngestTab />}
      </main>
    </div>
  );
}
