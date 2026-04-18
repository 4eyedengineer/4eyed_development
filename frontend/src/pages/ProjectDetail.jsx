import { useState, useEffect, useCallback } from 'react'
import { TerminalCard, TerminalDivider, TerminalSection, TerminalModal } from '../components/TerminalCard'
import { StatusIndicator, ProgressGauge } from '../components/StatusIndicator'
import { ErrorDisplay } from '../components/ErrorDisplay'
import TerminalButton from '../components/TerminalButton'
import TerminalSpinner from '../components/TerminalSpinner'
import TerminalTabs from '../components/TerminalTabs'
import TerminalInput from '../components/TerminalInput'
import { useToast } from '../components/Toast'
import { fetchServiceLogs } from '../api/services'
import { useWebSocket } from '../hooks/useWebSocket'
import { useProjectData } from '../hooks/useProjectData'
import { useProjectActions } from '../hooks/useProjectActions'
import { useCopyToClipboard, formatDate, getStatusText, getStatusIndicator } from '../utils'

const PROJECT_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'services', label: 'Services' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Settings' }
]

export function ProjectDetail({ projectId, activeTab = 'overview', onTabChange, onServiceClick, onNewService, onBack }) {
  // Data + realtime status via hook
  const { project, serviceStatuses, isLoading, error, refetch } = useProjectData(projectId)

  // Actions + collapsed pending flags via hook
  const { actions, pending } = useProjectActions(projectId, {
    refetch,
    onDeleted: onBack
  })

  // UI-only state
  const [servicesCollapsed, setServicesCollapsed] = useState(false)
  const [discoveryCollapsed, setDiscoveryCollapsed] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(null)
  const [projectState, setProjectState] = useState('running')

  // Settings tab UI state
  const [editingName, setEditingName] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [showDeleteProjectModal, setShowDeleteProjectModal] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')

  // Logs tab UI state
  const [selectedServiceForLogs, setSelectedServiceForLogs] = useState('all')
  const [logs, setLogs] = useState([])
  const [logsLoading, setLogsLoading] = useState(false)

  const toast = useToast()
  const { copy, copied } = useCopyToClipboard()
  const { isConnected } = useWebSocket()

  // Seed the inline-edit name field when the project loads
  useEffect(() => {
    if (project?.name) {
      setNewProjectName(project.name)
    }
  }, [project?.name])

  // Load logs when the logs tab is active (or service filter changes)
  useEffect(() => {
    if (activeTab === 'logs' && project?.services?.length > 0) {
      loadLogs()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedServiceForLogs, project?.services])

  const getRealtimeStatus = useCallback((service) => {
    return serviceStatuses[service.id] || service.current_status
  }, [serviceStatuses])

  const hasActiveDeployments = useCallback(() => {
    if (!project?.services) return false
    return project.services.some(service => {
      const status = getRealtimeStatus(service)
      return ['pending', 'building', 'deploying'].includes(status)
    })
  }, [project?.services, getRealtimeStatus])

  const loadLogs = async () => {
    if (!project?.services?.length) return

    setLogsLoading(true)
    try {
      const servicesToFetch = selectedServiceForLogs === 'all'
        ? project.services
        : project.services.filter(s => s.id.toString() === selectedServiceForLogs)

      const allLogs = []
      for (const service of servicesToFetch) {
        try {
          const serviceLogs = await fetchServiceLogs(service.id)
          if (serviceLogs?.logs) {
            allLogs.push(...serviceLogs.logs.map(log => ({
              ...log,
              serviceName: service.name,
              serviceId: service.id
            })))
          }
        } catch (err) {
          // Continue loading other services even if one fails
          console.error(`Failed to load logs for ${service.name}:`, err)
        }
      }

      // Sort by timestamp descending
      allLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      setLogs(allLogs.slice(0, 200)) // Limit to 200 most recent
    } catch (err) {
      toast.error('Failed to load logs')
    } finally {
      setLogsLoading(false)
    }
  }

  const handleDeleteService = async (service) => {
    const ok = await actions.deleteService(service)
    if (ok) {
      setShowDeleteModal(null)
    }
  }

  const handleToggleProjectState = async () => {
    if (pending.changingState || !project?.services?.length) return

    const newState = projectState === 'running' ? 'stopped' : 'running'
    if (newState === 'stopped') {
      await actions.stopProject()
    } else {
      await actions.startProject()
    }
    setProjectState(newState)
  }

  const handleRenameProject = async () => {
    if (!newProjectName.trim() || newProjectName === project.name) {
      setEditingName(false)
      return
    }

    const ok = await actions.updateProject(newProjectName.trim())
    if (ok) {
      setEditingName(false)
    }
  }

  const handleDeleteProject = async () => {
    if (deleteConfirmText !== project.name) return
    await actions.deleteProject(project.name)
    setShowDeleteProjectModal(false)
  }

  const getServiceStatus = useCallback((service) => {
    const currentStatus = getRealtimeStatus(service)
    if (currentStatus) {
      if (currentStatus === 'live') return 'online'
      if (currentStatus === 'failed') return 'error'
      if (currentStatus === 'building' || currentStatus === 'deploying') return 'pending'
      return currentStatus
    }
    return 'offline'
  }, [getRealtimeStatus])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <TerminalSpinner className="text-2xl" />
          <p className="font-mono text-terminal-muted mt-4">Loading project...</p>
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
        title="Project Error"
      />
    )
  }

  if (!project) {
    return null
  }

  const endpoints = {
    namespace: project.namespace,
    internal: `http://${project.name}.${project.namespace}.svc.cluster.local`
  }

  // Services table component (shared between overview and services tab)
  const renderServicesTable = () => (
    <div className="mt-4">
      {project.services?.length === 0 ? (
        <div className="text-center py-12 border border-terminal-border bg-terminal-bg-secondary">
          <p className="font-mono text-terminal-muted mb-4">No services in this project.</p>
          <TerminalButton variant="primary" onClick={onNewService}>
            [ ADD YOUR FIRST SERVICE ]
          </TerminalButton>
        </div>
      ) : (
        <>
          <div className="font-mono text-xs text-terminal-muted border-b border-terminal-border pb-2 mb-2">
            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-1">STS</div>
              <div className="col-span-3">SERVICE</div>
              <div className="col-span-2">PORT</div>
              <div className="col-span-2">BRANCH</div>
              <div className="col-span-2">STATUS</div>
              <div className="col-span-2">ACTION</div>
            </div>
          </div>

          <div className="space-y-1">
            {project.services.map((service) => {
              const status = getServiceStatus(service)
              return (
                <div
                  key={service.id}
                  className="font-mono text-sm hover:bg-terminal-bg-secondary transition-colors cursor-pointer py-2"
                  onClick={() => onServiceClick?.(service)}
                >
                  <div className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-1">
                      <StatusIndicator status={status} showLabel={false} size="sm" />
                    </div>
                    <div className="col-span-3 text-terminal-primary truncate">
                      {service.name}
                    </div>
                    <div className="col-span-2 text-terminal-secondary">
                      :{service.port}
                    </div>
                    <div className="col-span-2 text-terminal-muted">
                      {service.branch || 'main'}
                    </div>
                    <div className="col-span-2 text-terminal-muted">
                      {getStatusText(getRealtimeStatus(service) || 'pending')}
                    </div>
                    <div className="col-span-2 flex gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onServiceClick?.(service)
                        }}
                        className="text-terminal-secondary hover:text-terminal-primary transition-colors text-xs"
                      >
                        [VIEW]
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setShowDeleteModal(service)
                        }}
                        className="text-terminal-red hover:text-terminal-red/80 transition-colors text-xs"
                      >
                        [DEL]
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="font-mono text-xs text-terminal-muted border-t border-terminal-border pt-2 mt-2 flex justify-between items-center">
            <span>Total: {project.services.length} service(s)</span>
            {isConnected() ? (
              <span className="flex items-center gap-1 text-terminal-green">
                <span className="inline-block w-1.5 h-1.5 bg-terminal-green rounded-full" />
                Live updates
              </span>
            ) : (
              <span className="text-terminal-muted">Refresh for updates</span>
            )}
          </div>
        </>
      )}
    </div>
  )

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
              {project.name}
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <StatusIndicator
              status={project.services?.length > 0 ? 'online' : 'offline'}
              label={project.services?.length > 0 ? 'ACTIVE' : 'NO SERVICES'}
            />
            {hasActiveDeployments() && (
              <span className="font-mono text-xs text-terminal-cyan animate-pulse flex items-center gap-1">
                <span className="inline-block w-2 h-2 bg-terminal-cyan rounded-full animate-ping" />
                {isConnected() ? 'DEPLOYING (LIVE)' : 'DEPLOYING'}
              </span>
            )}
            <span className="font-mono text-xs text-terminal-muted">
              Created: {formatDate(project.created_at)}
            </span>
          </div>
        </div>

        <div className="flex gap-2">
          <TerminalButton variant="primary" onClick={onNewService}>
            [ ADD SERVICE ]
          </TerminalButton>
        </div>
      </div>

      <TerminalDivider variant="double" color="green" />

      {/* Tab Navigation */}
      {onTabChange && (
        <TerminalTabs
          tabs={PROJECT_TABS}
          activeTab={activeTab}
          onTabChange={onTabChange}
          className="mb-6"
        />
      )}

      {/* === OVERVIEW TAB === */}
      {activeTab === 'overview' && (
        <>
          {/* Live Service URLs */}
          {project.services?.some(s => s.url && s.current_status === 'live') && (
            <TerminalCard title="Live URLs" variant="green" className="border-terminal-green/50 bg-terminal-bg-secondary">
              <div className="space-y-3">
                {project.services
                  .filter(s => s.url && s.current_status === 'live')
                  .map((service) => (
                    <div key={service.id} className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <StatusIndicator status="online" showLabel={false} size="sm" />
                        <span className="font-mono text-xs text-terminal-muted uppercase w-20 flex-shrink-0">
                          {service.name}:
                        </span>
                        <a
                          href={service.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-sm text-terminal-green hover:text-terminal-green/80 underline truncate"
                        >
                          {service.url}
                        </a>
                      </div>
                      <button
                        onClick={() => copy(service.url, `url-${service.id}`)}
                        className="font-mono text-xs text-terminal-secondary hover:text-terminal-primary transition-colors flex-shrink-0"
                      >
                        {copied === `url-${service.id}` ? '[COPIED]' : '[COPY]'}
                      </button>
                    </div>
                  ))}
              </div>
            </TerminalCard>
          )}

          {/* Service Discovery */}
          <TerminalSection
            title="SERVICE DISCOVERY"
            collapsed={discoveryCollapsed}
            onToggle={() => setDiscoveryCollapsed(!discoveryCollapsed)}
            color="cyan"
          />

          {!discoveryCollapsed && (
            <TerminalCard title="Endpoints" variant="cyan" className="mt-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-xs text-terminal-muted uppercase w-24">NAMESPACE:</span>
                    <span className="font-mono text-sm text-terminal-primary truncate">{endpoints.namespace}</span>
                  </div>
                  <button
                    onClick={() => copy(endpoints.namespace, 'namespace')}
                    className="font-mono text-xs text-terminal-secondary hover:text-terminal-primary transition-colors flex-shrink-0"
                  >
                    {copied === 'namespace' ? '[COPIED]' : '[COPY]'}
                  </button>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-xs text-terminal-muted uppercase w-24">INTERNAL:</span>
                    <span className="font-mono text-sm text-terminal-primary truncate">{endpoints.internal}</span>
                  </div>
                  <button
                    onClick={() => copy(endpoints.internal, 'internal')}
                    className="font-mono text-xs text-terminal-secondary hover:text-terminal-primary transition-colors flex-shrink-0"
                  >
                    {copied === 'internal' ? '[COPIED]' : '[COPY]'}
                  </button>
                </div>
              </div>
            </TerminalCard>
          )}

          {/* Services List */}
          <TerminalSection
            title="SERVICES"
            collapsed={servicesCollapsed}
            onToggle={() => setServicesCollapsed(!servicesCollapsed)}
            color="amber"
          />

          {!servicesCollapsed && renderServicesTable()}

          {/* Project Info */}
          <TerminalDivider variant="single" color="muted" className="my-6" />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <TerminalCard title="Project Info" variant="green">
              <div className="space-y-2">
                <div className="flex justify-between font-mono text-sm">
                  <span className="text-terminal-muted">NAME:</span>
                  <span className="text-terminal-primary">{project.name}</span>
                </div>
                <div className="flex justify-between font-mono text-sm">
                  <span className="text-terminal-muted">NAMESPACE:</span>
                  <span className="text-terminal-secondary">{project.namespace}</span>
                </div>
                <div className="flex justify-between font-mono text-sm">
                  <span className="text-terminal-muted">SERVICES:</span>
                  <span className="text-terminal-secondary">{project.services?.length || 0}</span>
                </div>
                <div className="flex justify-between font-mono text-sm">
                  <span className="text-terminal-muted">CREATED:</span>
                  <span className="text-terminal-secondary">{formatDate(project.created_at)}</span>
                </div>
              </div>
            </TerminalCard>

            <TerminalCard title="Quick Actions" variant="amber">
              <div className="space-y-3">
                {project.services?.length > 0 && (
                  <TerminalButton
                    variant={projectState === 'running' ? 'danger' : 'primary'}
                    onClick={handleToggleProjectState}
                    disabled={pending.changingState}
                    className="w-full justify-center"
                  >
                    {pending.changingState
                      ? '[ PROCESSING... ]'
                      : projectState === 'running'
                        ? '[ STOP ALL ]'
                        : '[ START ALL ]'
                    }
                  </TerminalButton>
                )}
                <TerminalButton
                  variant="secondary"
                  onClick={refetch}
                  className="w-full justify-center"
                >
                  [ REFRESH ]
                </TerminalButton>
              </div>
            </TerminalCard>
          </div>
        </>
      )}

      {/* === SERVICES TAB === */}
      {activeTab === 'services' && (
        <>
          <h2 className="font-mono text-lg text-terminal-primary uppercase mb-4">
            Services ({project.services?.length || 0})
          </h2>
          {renderServicesTable()}
        </>
      )}

      {/* === LOGS TAB === */}
      {activeTab === 'logs' && (
        <>
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-mono text-lg text-terminal-primary uppercase">
              Project Logs
            </h2>
            <div className="flex gap-4 items-center">
              <select
                value={selectedServiceForLogs}
                onChange={(e) => setSelectedServiceForLogs(e.target.value)}
                className="font-mono text-sm bg-terminal-bg-secondary border border-terminal-border text-terminal-primary px-3 py-1"
              >
                <option value="all">All Services</option>
                {project.services?.map(s => (
                  <option key={s.id} value={s.id.toString()}>{s.name}</option>
                ))}
              </select>
              <TerminalButton variant="secondary" onClick={loadLogs} disabled={logsLoading}>
                {logsLoading ? '[ LOADING... ]' : '[ REFRESH ]'}
              </TerminalButton>
            </div>
          </div>

          {project.services?.length === 0 ? (
            <div className="text-center py-12 border border-terminal-border bg-terminal-bg-secondary">
              <p className="font-mono text-terminal-muted mb-4">No services to show logs for.</p>
              <TerminalButton variant="primary" onClick={onNewService}>
                [ ADD YOUR FIRST SERVICE ]
              </TerminalButton>
            </div>
          ) : logsLoading ? (
            <div className="flex items-center justify-center py-12">
              <TerminalSpinner className="text-xl" />
              <span className="font-mono text-terminal-muted ml-3">Loading logs...</span>
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center py-12 border border-terminal-border bg-terminal-bg-secondary">
              <p className="font-mono text-terminal-muted">No logs available.</p>
              <p className="font-mono text-xs text-terminal-muted mt-2">
                Logs appear after services are deployed and running.
              </p>
            </div>
          ) : (
            <div className="border border-terminal-border bg-terminal-bg-secondary font-mono text-xs overflow-auto max-h-[500px]">
              {logs.map((log, index) => (
                <div
                  key={index}
                  className={`px-3 py-1 border-b border-terminal-border/50 hover:bg-terminal-bg-elevated ${
                    log.level === 'error' ? 'text-terminal-red' :
                    log.level === 'warn' ? 'text-terminal-yellow' :
                    'text-terminal-primary'
                  }`}
                >
                  <span className="text-terminal-muted">{formatDate(log.timestamp)}</span>
                  <span className="text-terminal-cyan mx-2">[{log.serviceName}]</span>
                  <span>{log.message}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* === SETTINGS TAB === */}
      {activeTab === 'settings' && (
        <>
          <h2 className="font-mono text-lg text-terminal-primary uppercase mb-6">
            Project Settings
          </h2>

          {/* Rename Project */}
          <TerminalCard title="Project Name" variant="cyan" className="mb-6">
            <div className="space-y-4">
              {editingName ? (
                <div className="flex gap-3 items-center">
                  <TerminalInput
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value.toLowerCase())}
                    placeholder="project-name"
                    className="flex-1"
                    autoFocus
                  />
                  <TerminalButton
                    variant="primary"
                    onClick={handleRenameProject}
                    disabled={pending.savingName || !newProjectName.trim() || newProjectName === project.name}
                  >
                    {pending.savingName ? '[ SAVING... ]' : '[ SAVE ]'}
                  </TerminalButton>
                  <TerminalButton
                    variant="secondary"
                    onClick={() => {
                      setEditingName(false)
                      setNewProjectName(project.name)
                    }}
                    disabled={pending.savingName}
                  >
                    [ CANCEL ]
                  </TerminalButton>
                </div>
              ) : (
                <div className="flex justify-between items-center">
                  <span className="font-mono text-terminal-primary">{project.name}</span>
                  <TerminalButton variant="secondary" onClick={() => setEditingName(true)}>
                    [ RENAME ]
                  </TerminalButton>
                </div>
              )}
              <p className="font-mono text-xs text-terminal-muted">
                Project names must be lowercase and can only contain letters, numbers, and hyphens.
              </p>
            </div>
          </TerminalCard>

          {/* Project Info */}
          <TerminalCard title="Project Information" variant="green" className="mb-6">
            <div className="space-y-2">
              <div className="flex justify-between font-mono text-sm">
                <span className="text-terminal-muted">NAMESPACE:</span>
                <span className="text-terminal-secondary">{project.namespace}</span>
              </div>
              <div className="flex justify-between font-mono text-sm">
                <span className="text-terminal-muted">SERVICES:</span>
                <span className="text-terminal-secondary">{project.services?.length || 0}</span>
              </div>
              <div className="flex justify-between font-mono text-sm">
                <span className="text-terminal-muted">CREATED:</span>
                <span className="text-terminal-secondary">{formatDate(project.created_at)}</span>
              </div>
            </div>
          </TerminalCard>

          {/* Danger Zone */}
          <TerminalCard title="Danger Zone" variant="red">
            <div className="space-y-4">
              <p className="font-mono text-sm text-terminal-muted">
                Deleting this project will permanently remove all services, deployments, and associated data.
                This action cannot be undone.
              </p>
              <TerminalButton
                variant="danger"
                onClick={() => setShowDeleteProjectModal(true)}
              >
                [ DELETE PROJECT ]
              </TerminalButton>
            </div>
          </TerminalCard>
        </>
      )}

      {/* Delete Service Modal */}
      {showDeleteModal && (
        <TerminalModal title="CONFIRM DELETE" variant="red">
          <p className="font-mono text-terminal-primary mb-2">
            Delete service "{showDeleteModal.name}"?
          </p>
          <p className="font-mono text-xs text-terminal-muted mb-6">
            This will delete the service, its environment variables, and deployment history.
            This action cannot be undone.
          </p>
          <div className="flex justify-end gap-3">
            <TerminalButton
              variant="secondary"
              onClick={() => setShowDeleteModal(null)}
              disabled={pending.deletingService}
            >
              [ CANCEL ]
            </TerminalButton>
            <TerminalButton
              variant="danger"
              onClick={() => handleDeleteService(showDeleteModal)}
              disabled={pending.deletingService}
            >
              {pending.deletingService ? '[ DELETING... ]' : '[ DELETE ]'}
            </TerminalButton>
          </div>
        </TerminalModal>
      )}

      {/* Delete Project Modal */}
      {showDeleteProjectModal && (
        <TerminalModal title="DELETE PROJECT" variant="red">
          <p className="font-mono text-terminal-primary mb-2">
            Are you sure you want to delete "{project.name}"?
          </p>
          <p className="font-mono text-xs text-terminal-muted mb-4">
            This will permanently delete all {project.services?.length || 0} service(s) and their data.
            This action cannot be undone.
          </p>
          <div className="mb-6">
            <label className="font-mono text-xs text-terminal-muted block mb-2">
              Type <span className="text-terminal-red">{project.name}</span> to confirm:
            </label>
            <TerminalInput
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={`type the project name to confirm`}
              className="w-full"
            />
          </div>
          <div className="flex justify-end gap-3">
            <TerminalButton
              variant="secondary"
              onClick={() => {
                setShowDeleteProjectModal(false)
                setDeleteConfirmText('')
              }}
              disabled={pending.deletingProject}
            >
              [ CANCEL ]
            </TerminalButton>
            <TerminalButton
              variant="danger"
              onClick={handleDeleteProject}
              disabled={pending.deletingProject || deleteConfirmText !== project.name}
            >
              {pending.deletingProject ? '[ DELETING... ]' : '[ DELETE PROJECT ]'}
            </TerminalButton>
          </div>
        </TerminalModal>
      )}
    </div>
  )
}

export default ProjectDetail
