import PropTypes from 'prop-types';
import { useState, useEffect } from 'react';
import { TerminalCard } from './TerminalCard';
import { SimpleDiffViewer } from './DiffViewer';
import { fetchDebugAttempts } from '../api/debug';

/**
 * DebugAttemptHistory - Modal displaying all debug attempts with expandable details
 *
 * Shows a list of all attempts made during a debug session, each expandable to reveal:
 * - Success/failure status
 * - AI explanation of changes
 * - File changes with diff viewer
 */
export function DebugAttemptHistory({ sessionId, onClose }) {
  const [attempts, setAttempts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedAttempt, setExpandedAttempt] = useState(null);

  useEffect(() => {
    if (!sessionId) return;

    fetchDebugAttempts(sessionId)
      .then(data => {
        setAttempts(data.attempts || []);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });
  }, [sessionId]);

  const toggleAttempt = (attemptNumber) => {
    setExpandedAttempt(expandedAttempt === attemptNumber ? null : attemptNumber);
  };

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Handle backdrop click
  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="attempt-history-title"
    >
      <TerminalCard
        title="DEBUG ATTEMPT HISTORY"
        variant="amber"
        className="max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col"
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-4 font-mono text-terminal-muted hover:text-terminal-secondary transition-colors"
          aria-label="Close"
        >
          [X]
        </button>

        {/* Scrollable content area */}
        <div className="overflow-y-auto flex-1 pr-2">
          {loading ? (
            <div className="font-mono text-terminal-muted text-sm">
              Loading attempts...
            </div>
          ) : error ? (
            <div className="font-mono text-terminal-red text-sm">
              Error: {error}
            </div>
          ) : attempts.length === 0 ? (
            <div className="font-mono text-terminal-muted text-sm">
              No attempts recorded.
            </div>
          ) : (
            <div className="space-y-3">
              {attempts.map((attempt) => (
                <div
                  key={attempt.attemptNumber}
                  className="border border-terminal-border"
                >
                  {/* Attempt header - clickable */}
                  <button
                    onClick={() => toggleAttempt(attempt.attemptNumber)}
                    className="w-full p-3 flex items-center justify-between hover:bg-terminal-bg-alt transition-colors text-left"
                    aria-expanded={expandedAttempt === attempt.attemptNumber}
                  >
                    <span className="font-mono text-sm flex items-center gap-2">
                      <span className={attempt.succeeded ? 'text-terminal-primary' : 'text-terminal-red'}>
                        {attempt.succeeded ? '✓' : '✗'}
                      </span>
                      <span className="text-terminal-primary">
                        Attempt {attempt.attemptNumber}
                      </span>
                    </span>
                    <span className="font-mono text-xs text-terminal-muted flex items-center gap-3">
                      <span>
                        {attempt.fileChanges?.length || 0} file(s) modified
                      </span>
                      <span className="text-terminal-secondary">
                        {expandedAttempt === attempt.attemptNumber ? '▼' : '►'}
                      </span>
                    </span>
                  </button>

                  {/* Expanded content */}
                  {expandedAttempt === attempt.attemptNumber && (
                    <div className="p-3 pt-0 border-t border-terminal-border mt-0">
                      {/* Explanation */}
                      <div className="mb-3">
                        <div className="font-mono text-xs text-terminal-cyan uppercase mb-1">
                          Explanation
                        </div>
                        <pre className="font-mono text-sm text-terminal-muted whitespace-pre-wrap">
                          {attempt.explanation || 'No explanation provided.'}
                        </pre>
                      </div>

                      {/* File changes */}
                      {attempt.fileChanges && attempt.fileChanges.length > 0 && (
                        <div>
                          <div className="font-mono text-xs text-terminal-cyan uppercase mb-2">
                            File Changes
                          </div>
                          <SimpleDiffViewer fileChanges={attempt.fileChanges} />
                        </div>
                      )}

                      {/* Build logs excerpt if available */}
                      {attempt.buildLogs && (
                        <div className="mt-3">
                          <div className="font-mono text-xs text-terminal-cyan uppercase mb-1">
                            Build Output
                          </div>
                          <pre className="font-mono text-xs text-terminal-muted bg-terminal-bg-alt p-2 overflow-x-auto max-h-32">
                            {attempt.buildLogs.slice(-500)}
                          </pre>
                        </div>
                      )}

                      {/* Git diff (unified patch) — the human-readable artifact */}
                      {attempt.gitDiff && (
                        <div className="mt-3">
                          <div className="font-mono text-xs text-terminal-cyan uppercase mb-1">
                            Git Diff
                          </div>
                          <pre className="font-mono text-xs bg-terminal-bg-alt p-2 overflow-x-auto max-h-96 border border-terminal-border">
                            {attempt.gitDiff.split('\n').map((line, idx) => {
                              let color = 'text-terminal-muted';
                              if (line.startsWith('+++') || line.startsWith('---')) {
                                color = 'text-terminal-cyan';
                              } else if (line.startsWith('@@')) {
                                color = 'text-terminal-secondary';
                              } else if (line.startsWith('+')) {
                                color = 'text-terminal-primary';
                              } else if (line.startsWith('-')) {
                                color = 'text-terminal-red';
                              } else if (line.startsWith('diff --git') || line.startsWith('index ')) {
                                color = 'text-terminal-secondary';
                              }
                              return (
                                <span key={idx} className={color}>
                                  {line}
                                  {'\n'}
                                </span>
                              );
                            })}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </TerminalCard>
    </div>
  );
}

DebugAttemptHistory.propTypes = {
  sessionId: PropTypes.string.isRequired,
  onClose: PropTypes.func.isRequired,
};

export default DebugAttemptHistory;
