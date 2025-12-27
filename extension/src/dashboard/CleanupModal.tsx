import { useState, useEffect, useRef } from 'react';
import { api } from '../shared/api';

interface CleanupModalProps {
  onClose: () => void;
  onComplete: () => void;
}

export function CleanupModal({ onClose, onComplete }: CleanupModalProps) {
  const [minPosts, setMinPosts] = useState(5);
  const [status, setStatus] = useState<'idle' | 'analyzing' | 'confirming' | 'cleaning' | 'done' | 'error'>('idle');
  const [analysis, setAnalysis] = useState<{ toKeep: any[], toDelete: any[], orphanedPosts: number } | null>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const pollIntervalRef = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when logs change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    const checkExistingStatus = async () => {
      try {
        const data = await api.getCategoryCleanupStatus();
        if (data.status === 'running') {
          setStatus('cleaning');
          setProgress(data.progress);
          setLogs(data.logs || []);
          startPolling();
        }
      } catch (err) {
        console.error('Failed to check existing cleanup status:', err);
      }
    };
    checkExistingStatus();

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  const handleAnalyze = async () => {
    setStatus('analyzing');
    try {
      const data = await api.analyzeCategoryCleanup(minPosts);
      setAnalysis(data);
      setStatus('confirming');
    } catch (err) {
      console.error(err);
      setError('Failed to analyze categories. Make sure backend is running.');
      setStatus('error');
    }
  };

  const startPolling = () => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

    pollIntervalRef.current = window.setInterval(async () => {
      try {
        const data = await api.getCategoryCleanupStatus();
        setProgress(data.progress);
        if (data.logs) setLogs(data.logs);

        if (data.status === 'done') {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setResult(data.result);
          setStatus('done');
        } else if (data.status === 'error') {
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          setError(data.error || 'Cleanup failed');
          setStatus('error');
        }
      } catch (err) {
        console.error('Polling failed:', err);
      }
    }, 1000);
  };

  const handleCleanup = async () => {
    setStatus('cleaning');
    setProgress(0);
    setLogs(['Starting cleanup...']);
    try {
      await api.executeCategoryCleanup(minPosts);
      startPolling();
    } catch (err) {
      console.error(err);
      setError('Cleanup failed to start. Check backend logs.');
      setStatus('error');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '500px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h3 style={{ margin: 0 }}>🧹 Category Cleanup & Hierarchy</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: 'var(--text-secondary)' }}>&times;</button>
        </div>

        {status === 'idle' && (
          <div style={{ marginTop: '16px' }}>
            <p style={{ fontSize: '14px', marginBottom: '24px', lineHeight: '1.5', color: 'var(--text-secondary)' }}>
              This will consolidate your categories into a manageable 2-level hierarchy using AI clustering.
              Categories with very few posts will be deleted, and their names will be added as <strong>#hashtags</strong> to the posts so you don't lose information.
            </p>

            <div style={{ background: 'var(--background)', padding: '16px', borderRadius: '8px', marginBottom: '24px' }}>
              <label style={{ display: 'block', marginBottom: '12px', fontSize: '14px', fontWeight: '600' }}>
                Minimum posts to keep a category: <span style={{ color: 'var(--primary)', fontSize: '18px' }}>{minPosts}</span>
              </label>
              <input
                type="range" min="1" max="20" value={minPosts}
                onChange={e => setMinPosts(parseInt(e.target.value))}
                style={{ width: '100%', cursor: 'pointer' }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#999', marginTop: '4px' }}>
                <span>Aggressive (1)</span>
                <span>Conservative (20)</span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAnalyze}>Preview Cleanup</button>
            </div>
          </div>
        )}

        {status === 'analyzing' && (
          <div style={{ padding: '40px', textAlign: 'center' }}>
            <div className="spinner" style={{ margin: '0 auto 16px' }}></div>
            <p>Analyzing categories...</p>
          </div>
        )}

        {status === 'confirming' && analysis && (
          <div style={{ marginTop: '16px' }}>
            <div style={{ background: 'var(--background)', padding: '20px', borderRadius: '12px', marginBottom: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', paddingBottom: '12px', borderBottom: '1px solid var(--border)' }}>
                <span>Categories to keep:</span>
                <strong style={{ color: 'var(--success)' }}>{analysis.toKeep.length}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Categories to consolidate:</span>
                <strong style={{ color: 'var(--error)' }}>{analysis.toDelete.length}</strong>
              </div>
            </div>

            <div style={{ padding: '16px', background: 'rgba(0, 149, 246, 0.1)', borderRadius: '12px', marginBottom: '24px', fontSize: '13px', color: 'var(--primary)', lineHeight: '1.6' }}>
              <div style={{ fontWeight: '700', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                🚀 AI Organization Step
              </div>
              This involves generating embeddings for <strong>{analysis.toKeep.length}</strong> categories and <strong>LLM calls - currently using Claude Sonnet 4.5</strong> to cluster and build your new hierarchy.
            </div>

            <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setStatus('idle')}>Back</button>
              <button className="btn btn-primary" onClick={handleCleanup}>Execute Full Cleanup</button>
            </div>
          </div>
        )}

        {status === 'cleaning' && (
          <div style={{ padding: '20px', textAlign: 'center' }}>
            <div className="spinner" style={{ margin: '0 auto 16px' }}></div>

            <div
              ref={scrollRef}
              style={{
                height: '120px',
                overflowY: 'auto',
                background: 'var(--background)',
                borderRadius: '8px',
                padding: '12px',
                textAlign: 'left',
                marginBottom: '20px',
                border: '1px solid var(--border)',
                fontSize: '13px',
                fontFamily: 'monospace',
                display: 'flex',
                flexDirection: 'column',
                gap: '4px'
              }}
            >
              {logs.map((log, i) => (
                <div key={i} style={{
                  color: i === logs.length - 1 ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontWeight: i === logs.length - 1 ? '600' : '400'
                }}>
                  <span style={{ color: 'var(--primary)', marginRight: '8px' }}>›</span>
                  {log}
                </div>
              ))}
            </div>

            <div style={{
              width: '100%',
              height: '10px',
              background: 'var(--background)',
              borderRadius: '5px',
              overflow: 'hidden',
              marginBottom: '12px',
              border: '1px solid var(--border)'
            }}>
              <div style={{
                width: `${progress}%`,
                height: '100%',
                background: 'var(--primary)',
                transition: 'width 0.3s ease-out'
              }}></div>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between' }}>
              <span>Step {logs.length} / 12</span>
              <span>{progress}%</span>
            </div>
          </div>
        )}

        {status === 'done' && result && (
          <div style={{ marginTop: '16px' }}>
            <div style={{ textAlign: 'center', marginBottom: '24px' }}>
              <div style={{ fontSize: '48px', marginBottom: '16px' }}>✨</div>
              <h4 style={{ margin: 0, fontSize: '20px' }}>Cleanup Successful!</h4>
            </div>

            <div style={{ background: 'var(--background)', padding: '20px', borderRadius: '12px', marginBottom: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span>Parent categories:</span>
                <strong>{result.parentCount}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                <span>Organized children:</span>
                <strong>{result.childCount}</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-secondary)', fontSize: '13px', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border)' }}>
                <span>Categories deleted:</span>
                <span>{result.deletedCount}</span>
              </div>
            </div>

            <button
              className="btn btn-primary"
              style={{ width: '100%', padding: '14px' }}
              onClick={() => { onComplete(); onClose(); }}
            >
              Back to Categories
            </button>
          </div>
        )}

        {status === 'error' && (
          <div style={{ marginTop: '16px', textAlign: 'center' }}>
            <div style={{ fontSize: '40px', marginBottom: '16px' }}>❌</div>
            <div style={{ color: 'var(--error)', marginBottom: '24px', fontWeight: '500' }}>{error}</div>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
              <button className="btn" onClick={onClose}>Close</button>
              <button className="btn btn-primary" onClick={() => setStatus('idle')}>Try Again</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

