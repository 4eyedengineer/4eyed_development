import PropTypes from 'prop-types';
import { useState, useEffect } from 'react';
import { TerminalCard, TerminalSection } from './TerminalCard';
import { TerminalProgress } from './TerminalProgress';
import TerminalButton from './TerminalButton';
import { SimpleDiffViewer } from './DiffViewer';
import { DebugAttemptHistory } from './DebugAttemptHistory';
import { useDebugSession } from '../hooks/useDebugSession';
import {
  fetchDebugSession,
  cancelDebugSession,
  retryDebugSession,
  rollbackDebugSession,
} from '../api/debug';

/**
 * DebugSessionViewer - Displays AI debug session progress and results
 *
 * States:
 * 1. FIXING - Shows attempt N/10, explanation, progress bar, CANCEL button
 * 2. FIXED & DEPLOYED - Shows diff viewer, VIEW SERVICE + COPY CHANGES buttons
 * 3. COULD NOT AUTO-FIX - Shows explanation, TRY AGAIN + VIEW ATTEMPTS buttons
 */
export function DebugSessionViewer({
  sessionId,
  serviceUrl = null,
  onComplete = () => {},
  onRetry = () => {},
  className = '',
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
const [copySuccess, setCopySuccess] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [rolledBack, setRolledBack] = useState(false);

  // WebSocket hook for real-time updates
  const session = useDebugSession(sessionId);

  // Fetch initial session data
  useEffect(() => {
    if (!sessionId) return;

    async function loadSession() {
      try {
        setLoading(true);
        await fetchDebugSession(sessionId);
        setLoading(false);
      } catch (err) {
        setError(err.message);
        setLoading(false);
      }
    }

    loadSession();
  }, [sessionId]);


  // Notify parent when session reaches terminal state
  useEffect(() => {
    if (session.isComplete()) {
      onComplete(session);
    }
  }, [session.status, onComplete, session]);

  // Handle cancel
  const handleCancel = async () => {
    try {
      setCancelling(true);
      await cancelDebugSession(sessionId);
    } catch (err) {
      setError(err.message);
    } finally {
      setCancelling(false);
    }
  };

  // Handle retry
  const handleRetry = async () => {
    try {
      setRetrying(true);
      const result = await retryDebugSession(sessionId);
      onRetry(result.sessionId);
    } catch (err) {
      setError(err.message);
    } finally {
      setRetrying(false);
    }
  };

  // Copy changes to clipboard
  const handleCopyChanges = async () => {
    if (!session.fileChanges || session.fileChanges.length === 0) return;

    const text = session.fileChanges.map(file =>
      `=== ${file.path} ===\n${file.content}`
    ).join('\n\n');

    try {
      await navigator.clipboard.writeText(text);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Handle rollback
  const handleRollback = async () => {
    try {
      setRollingBack(true);
      await rollbackDebugSession(sessionId);
      setRolledBack(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setRollingBack(false);
    }
  };

  if (loading) {
    return (
      <TerminalCard title="AI DEBUG" variant="cyan" className={className}>
        <div className="text-terminal-muted font-mono text-sm">
          Loading debug session...
        </div>
      </TerminalCard>
    );
  }

  if (error) {
    return (
      <TerminalCard title="DEBUG ERROR" variant="red" className={className}>
        <div className="text-terminal-red font-mono text-sm">
          {error}
        </div>
      </TerminalCard>
    );
  }

  // RUNNING STATE
  if (session.isRunning()) {
    return (
      <TerminalCard title="FIXING" variant="cyan" glow className={className}>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-terminal-cyan font-mono text-sm uppercase">
              Attempt {session.currentAttempt}/{session.maxAttempts}
            </span>
            <TerminalProgress
              value={session.currentAttempt}
              max={session.maxAttempts}
              variant="cyan"
              width={12}
            />
          </div>

          {session.explanation && (
            <TerminalSection
              title="AI ANALYSIS"
              variant="cyan"
              defaultCollapsed={false}
            >
              <pre className="text-terminal-muted text-xs whitespace-pre-wrap">
                {session.explanation}
              </pre>
            </TerminalSection>
          )}

          {session.message && (
            <div className="text-terminal-muted font-mono text-xs">
              {session.message}
            </div>
          )}

          <div className="flex justify-center pt-2">
            <TerminalButton
              variant="danger"
              onClick={handleCancel}
              disabled={cancelling}
            >
              {cancelling ? '[ CANCELLING... ]' : '[ CANCEL ]'}
            </TerminalButton>
          </div>
        </div>
      </TerminalCard>
    );
  }

  // Helper to render token/cost info
  const renderTokenInfo = () => {
    if (!session.totalTokens || session.totalTokens === 0) return null;
    return (
      <div className="font-mono text-xs text-terminal-muted border-t border-terminal-border pt-2 mt-2">
        Tokens: {session.totalTokens.toLocaleString()} | Est. cost: ${session.estimatedCost}
      </div>
    );
  };

  // SUCCESS STATE
  if (session.isSucceeded()) {
    // Show rolled back confirmation
    if (rolledBack) {
      return (
        <TerminalCard title="CHANGES ROLLED BACK" variant="amber" className={className}>
          <div className="space-y-4">
            <div className="text-terminal-secondary font-mono text-sm">
              Original files have been restored. Deploy again to apply.
            </div>
          </div>
        </TerminalCard>
      );
    }

    return (
      <TerminalCard title="FIXED & DEPLOYED" variant="green" glow className={className}>
        <div className="space-y-4">
          <div className="text-terminal-primary font-mono text-sm">
            Fixed in {session.currentAttempt} attempt{session.currentAttempt !== 1 ? 's' : ''}.
          </div>

          {session.explanation && (
            <TerminalSection
              title="CHANGES MADE"
              variant="green"
              defaultCollapsed={false}
            >
              <pre className="text-terminal-muted text-xs whitespace-pre-wrap mb-4">
                {session.explanation}
              </pre>
              {session.fileChanges && session.fileChanges.length > 0 && (
                <SimpleDiffViewer fileChanges={session.fileChanges} />
              )}
            </TerminalSection>
          )}

          <div className="flex justify-center gap-4 pt-2">
            {serviceUrl && (
              <TerminalButton
                variant="primary"
                onClick={() => window.open(serviceUrl, '_blank')}
              >
                [ VIEW SERVICE ]
              </TerminalButton>
            )}
            <TerminalButton
              variant="secondary"
              onClick={handleCopyChanges}
            >
              {copySuccess ? '[ COPIED! ]' : '[ COPY CHANGES ]'}
            </TerminalButton>
            <TerminalButton
              variant="danger"
              onClick={handleRollback}
              disabled={rollingBack}
            >
              {rollingBack ? '[ ROLLING BACK... ]' : '[ ROLLBACK ]'}
            </TerminalButton>
          </div>

          {renderTokenInfo()}
        </div>
      </TerminalCard>
    );
  }

  // NEEDS MANUAL FIX STATE
  if (session.needsManualFix()) {
    return (
      <TerminalCard title="MANUAL FIX REQUIRED" variant="amber" glow className={className}>
        <div className="space-y-4">
          <div className="text-terminal-secondary font-mono text-sm">
            The AI determined this issue requires manual intervention.
          </div>

          {session.explanation && (
            <TerminalSection
              title="ANALYSIS"
              variant="amber"
              defaultCollapsed={false}
            >
              <pre className="text-terminal-muted text-xs whitespace-pre-wrap">
                {session.explanation}
              </pre>
            </TerminalSection>
          )}

          {session.suggestedActions && session.suggestedActions.length > 0 && (
            <TerminalSection
              title="SUGGESTED ACTIONS"
              variant="cyan"
              defaultCollapsed={false}
            >
              <ul className="text-terminal-muted text-xs space-y-1 list-disc list-inside">
                {session.suggestedActions.map((action, idx) => (
                  <li key={idx}>{action}</li>
                ))}
              </ul>
            </TerminalSection>
          )}

          <div className="flex justify-center gap-4 pt-2">
            <TerminalButton
              variant="secondary"
              onClick={() => setShowHistoryModal(true)}
            >
              [ VIEW ATTEMPTS ]
            </TerminalButton>
          </div>

          {renderTokenInfo()}
        </div>
      </TerminalCard>
    );
  }

  // FAILED STATE
  if (session.isFailed()) {
    return (
      <>
        <TerminalCard title="COULD NOT AUTO-FIX" variant="red" className={className}>
          <div className="space-y-4">
            <div className="text-terminal-red font-mono text-sm">
              After {session.maxAttempts} attempts, automatic repair was unsuccessful.
            </div>

            {session.finalExplanation && (
              <TerminalSection
                title="ANALYSIS"
                color="red"
              >
                <pre className="text-terminal-muted text-xs whitespace-pre-wrap">
                  {session.finalExplanation}
                </pre>
              </TerminalSection>
            )}

            <div className="flex justify-center gap-4 pt-2">
              <TerminalButton
                variant="primary"
                onClick={handleRetry}
                disabled={retrying}
              >
                {retrying ? '[ STARTING... ]' : '[ TRY AGAIN ]'}
              </TerminalButton>
              <TerminalButton
                variant="secondary"
                onClick={() => setShowHistoryModal(true)}
              >
                [ VIEW ALL {session.maxAttempts} ATTEMPTS ]
              </TerminalButton>
            </div>

            {renderTokenInfo()}
          </div>
        </TerminalCard>

        {showHistoryModal && (
          <DebugAttemptHistory
            sessionId={sessionId}
            onClose={() => setShowHistoryModal(false)}
          />
        )}
      </>
    );
  }

  // CANCELLED STATE
  if (session.isCancelled()) {
    return (
      <TerminalCard title="DEBUG CANCELLED" variant="amber" className={className}>
        <div className="space-y-4">
          <div className="text-terminal-secondary font-mono text-sm">
            Debug session was cancelled after {session.currentAttempt} attempt{session.currentAttempt !== 1 ? 's' : ''}.
          </div>
          <div className="flex justify-center pt-2">
            <TerminalButton
              variant="primary"
              onClick={handleRetry}
              disabled={retrying}
            >
              {retrying ? '[ STARTING... ]' : '[ TRY AGAIN ]'}
            </TerminalButton>
          </div>

          {renderTokenInfo()}
        </div>
      </TerminalCard>
    );
  }

  // No meaningful state to show — render nothing rather than a confusing
  // "Status: unknown" stub. This happens when the WS hook hasn't hydrated
  // and the session is in a terminal/unknown state with no live updates.
  return null;
}

DebugSessionViewer.propTypes = {
  sessionId: PropTypes.string.isRequired,
  serviceUrl: PropTypes.string,
  onComplete: PropTypes.func,
  onRetry: PropTypes.func,
  className: PropTypes.string,
};

export default DebugSessionViewer;
