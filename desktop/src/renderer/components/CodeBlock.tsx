import { useState } from 'react';

interface CodeBlockProps {
  code: string;
  language: string;
  onApply?: (code: string, language: string) => Promise<void>;
  applyLabel?: string;
}

export function CodeBlock({ code, language, onApply, applyLabel = 'Apply in VS Code' }: CodeBlockProps) {
  const [applyState, setApplyState] = useState<'idle' | 'applying' | 'ok' | 'err'>('idle');
  const [applyError, setApplyError] = useState('');

  const handleApply = async () => {
    if (!onApply || applyState === 'applying') return;
    setApplyState('applying');
    setApplyError('');
    try {
      await onApply(code, language);
      setApplyState('ok');
    } catch (err) {
      setApplyState('err');
      setApplyError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setTimeout(() => setApplyState('idle'), 3000);
    }
  };

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-lang">{language || 'code'}</span>
        {onApply && (
          <button
            type="button"
            className={`apply-btn ${applyState}`}
            onClick={handleApply}
            disabled={applyState === 'applying'}
          >
            {applyState === 'idle' && applyLabel}
            {applyState === 'applying' && 'Applying…'}
            {applyState === 'ok' && 'Applied!'}
            {applyState === 'err' && (applyError || 'Failed')}
          </button>
        )}
      </div>
      <pre className="code-block-body"><code>{code}</code></pre>
    </div>
  );
}
