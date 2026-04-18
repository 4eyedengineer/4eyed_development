import { useState, useEffect } from 'react'
import { TerminalCard, TerminalDivider } from '../components/TerminalCard'
import { StatusIndicator } from '../components/StatusIndicator'
import { ErrorDisplay } from '../components/ErrorDisplay'
import TerminalButton from '../components/TerminalButton'
import TerminalSpinner from '../components/TerminalSpinner'
import TerminalTabs from '../components/TerminalTabs'
import { useToast } from '../components/Toast'
import { CloneServiceModal } from '../components/CloneServiceModal'
import { useServiceData } from '../hooks/useServiceData'
import { useServiceActions } from '../hooks/useServiceActions'
import { useCopyToClipboard, formatDate, getStatusText } from '../utils'

// Sub-components
import { ServiceOverview } from './service/ServiceOverview'
import { ServiceConfig } from './service/ServiceConfig'
import { ServiceEnvironment } from './service/ServiceEnvironment'
import { ServiceLogs } from './service/ServiceLogs'
import { ServiceHistory } from './service/ServiceHistory'

const SERVICE_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'config', label: 'Config' },
  { id: 'env', label: 'Environment' },
  { id: 'logs', label: 'Logs' },
  { id: 'history', label: 'History' }
]

export function ServiceDetail({ serviceId, activeTab = 'overview', onTabChange, onBack }) {
  // Core service data + realtime deployment status (via useServiceData)
  const {
    service,
    envVars,
    setEnvVars,
    deployments,
    debugSession,
    setDebugSession,
    isLoading,
    error,
    refetch,
    latestDeploymentId,
    hasActiveDeployment,
    deploymentStatus
  } = useServiceData(serviceId)

  // UI-only state
  const [showCloneModal, setShowCloneModal] = useState(false)
  const [showBuildLogs, setShowBuildLogs] = useState(false)
  const [showRestartMenu, setShowRestartMenu] = useState(false)

  const toast = useToast()
  const { copy, copied } = useCopyToClipboard()

  // Actions — collapses per-action pending flags; keeps validation internal
  const { actions, pending, validation } = useServiceActions(serviceId, {
    refetch,
    service,
    latestDeploymentId,
    setActiveDebugSession: setDebugSession,
    onShowBuildLogs: () => setShowBuildLogs(true)
  })

  // Auto-show build logs when a deployment is active
  useEffect(() => {
    if (hasActiveDeployment()) {
      setShowBuildLogs(true)
    }
  }, [hasActiveDeployment])

  const handleRestart = async () => {
    await actions.restart()
    setShowRestartMenu(false)
  }

  const getServiceStatusIndicator = () => {
    if (service?.latest_deployment) {
      const status = service.latest_deployment.status
      if (status === 'live') return 'online'
      if (status === 'failed') return 'error'
      if (['building', 'deploying', 'pending'].includes(status)) return 'pending'
    }
    return 'offline'
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <TerminalSpinner className="text-2xl" />
          <p className="font-mono text-terminal-muted mt-4">Loading service...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <ErrorDisplay
        error={error}
        onRetry={refetch}
        onBack={onBack}
        title="Service Error"
      />
    )
  }

  if (!service) {
    return null
  }

  const isRunning = service?.latest_deployment?.status === 'live'
  const wsDeploymentStatus = deploymentStatus.status
  const wsIsConnected = deploymentStatus.isConnected

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <div>
          <div className="flex items-center gap-4 mb-2">
            <button
              onClick={onBack}
              className="font-mono text-terminal-secondary hover:text-terminal-primary transition-colors"
            >
              &lt; BACK
            </button>
            <h1 className="font-mono text-xl text-terminal-primary text-glow-green uppercase tracking-terminal-wide">
              {service.name}
            </h1>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <StatusIndicator
              status={getServiceStatusIndicator()}
              label={getStatusText(wsDeploymentStatus || service.latest_deployment?.status || 'pending')}
            />
            {hasActiveDeployment() && (
              <span className="font-mono text-xs text-terminal-cyan animate-pulse flex items-center gap-1">
                <span className="inline-block w-2 h-2 bg-terminal-cyan rounded-full animate-ping" />
                {wsIsConnected ? 'DEPLOYING (LIVE)' : 'DEPLOYING'}
              </span>
            )}
            {service.url && (
              <a
                href={service.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-terminal-green hover:underline"
              >
                {service.url}
              </a>
            )}
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          <TerminalButton
            variant="secondary"
            onClick={actions.validate}
            disabled={pending.validate}
          >
            {pending.validate ? '[ VALIDATING... ]' : '[ VALIDATE ]'}
          </TerminalButton>
          <TerminalButton
            variant="secondary"
            onClick={() => setShowCloneModal(true)}
          >
            [ CLONE ]
          </TerminalButton>
          <TerminalButton
            variant={isRunning ? 'danger' : 'secondary'}
            onClick={actions.toggleState}
            disabled={pending.changingState || hasActiveDeployment()}
          >
            {pending.changingState ? '[ ... ]' : isRunning ? '[ STOP ]' : '[ START ]'}
          </TerminalButton>
          <TerminalButton
            variant="primary"
            onClick={actions.deploy}
            disabled={pending.deploy || hasActiveDeployment()}
          >
            {pending.deploy ? '[ DEPLOYING... ]' : '[ DEPLOY ]'}
          </TerminalButton>
          <div className="relative">
            <TerminalButton
              variant="secondary"
              onClick={() => setShowRestartMenu(!showRestartMenu)}
              disabled={pending.restart}
            >
              {pending.restart ? '[ RESTARTING... ]' : '[ RESTART ]'}
            </TerminalButton>
            {showRestartMenu && (
              <div className="absolute right-0 mt-1 z-10 border border-terminal-border bg-terminal-bg-secondary p-2">
                <button
                  onClick={handleRestart}
                  className="font-mono text-xs text-terminal-primary hover:text-terminal-green whitespace-nowrap"
                >
                  Confirm Restart?
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <TerminalDivider variant="double" color="green" />

      {/* Tab Navigation */}
      {onTabChange && (
        <TerminalTabs
          tabs={SERVICE_TABS}
          activeTab={activeTab}
          onTabChange={onTabChange}
          className="mb-6"
        />
      )}

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <ServiceOverview
          service={service}
          latestDeployment={deployments[0]}
          latestDeploymentId={latestDeploymentId}
          showBuildLogs={showBuildLogs}
          hasActiveDeployment={hasActiveDeployment()}
          validation={validation}
          onFixPort={actions.fixPort}
          fixingPort={pending.fixPort}
          onDeploy={actions.deploy}
          deploying={pending.deploy}
          onRefresh={refetch}
          activeDebugSession={debugSession}
          onStartDebug={actions.startDebug}
          startingDebug={pending.startingDebug}
          onDebugRetry={actions.handleDebugRetry}
        />
      )}

      {activeTab === 'config' && (
        <ServiceConfig
          service={service}
          serviceId={serviceId}
        />
      )}

      {activeTab === 'env' && (
        <ServiceEnvironment
          serviceId={serviceId}
          envVars={envVars}
          setEnvVars={setEnvVars}
        />
      )}

      {activeTab === 'logs' && (
        <ServiceLogs
          serviceId={serviceId}
          latestDeploymentId={latestDeploymentId}
          onRefresh={refetch}
        />
      )}

      {activeTab === 'history' && (
        <ServiceHistory
          serviceId={serviceId}
          deployments={deployments}
          hasActiveDeployment={hasActiveDeployment()}
          onDeploy={actions.deploy}
          deploying={pending.deploy}
          onRefresh={refetch}
        />
      )}

      {/* Service Info - Always visible */}
      <TerminalDivider variant="single" color="muted" className="my-6" />

      <TerminalCard title="Service Info" variant="green">
        <div className="grid grid-cols-1 gap-4">
          {service.url && (
            <div className="flex justify-between font-mono text-sm items-center">
              <span className="text-terminal-muted">URL:</span>
              <div className="flex items-center gap-2">
                <a
                  href={service.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-terminal-cyan hover:text-terminal-primary hover:underline transition-colors"
                >
                  {service.url}
                </a>
                <button
                  onClick={() => copy(service.url, 'info_url')}
                  className="text-terminal-muted hover:text-terminal-primary text-xs"
                >
                  {copied === 'info_url' ? '[OK]' : '[COPY]'}
                </button>
              </div>
            </div>
          )}
          <div className="flex justify-between font-mono text-sm">
            <span className="text-terminal-muted">SUBDOMAIN:</span>
            <span className="text-terminal-secondary">{service.subdomain}</span>
          </div>
          <div className="flex justify-between font-mono text-sm">
            <span className="text-terminal-muted">CREATED:</span>
            <span className="text-terminal-secondary">{formatDate(service.created_at)}</span>
          </div>
        </div>
      </TerminalCard>

      {/* Clone Service Modal */}
      {showCloneModal && (
        <CloneServiceModal
          service={service}
          onClose={() => setShowCloneModal(false)}
          onCloned={(newService) => {
            setShowCloneModal(false)
            toast.success(`Service "${newService.name}" cloned successfully. Navigate to the project to view it.`)
          }}
        />
      )}
    </div>
  )
}

export default ServiceDetail
