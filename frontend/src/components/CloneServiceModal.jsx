import { useState, useEffect } from 'react'
import TerminalButton from './TerminalButton'
import TerminalInput from './TerminalInput'
import TerminalSelect from './TerminalSelect'
import TerminalCheckbox from './TerminalCheckbox'
import { fetchProjects } from '../api/projects'
import { cloneService } from '../api/services'
import { ApiError } from '../api/utils'

export function CloneServiceModal({ service, onClose, onCloned }) {
  const [name, setName] = useState(`${service.name}-copy`)
  const [projectId, setProjectId] = useState(service.project_id)
  const [includeEnv, setIncludeEnv] = useState(false)
  const [autoDeploy, setAutoDeploy] = useState(false)
  const [projects, setProjects] = useState([])
  const [loading, setLoading] = useState(false)
  const [loadingProjects, setLoadingProjects] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const loadProjects = async () => {
      try {
        const projectList = await fetchProjects()
        setProjects(projectList)
      } catch (err) {
        console.error('Failed to load projects:', err)
      } finally {
        setLoadingProjects(false)
      }
    }
    loadProjects()
  }, [])

  const handleClone = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const result = await cloneService(service.id, {
        name: name.trim(),
        project_id: projectId,
        include_env: includeEnv,
        auto_deploy: autoDeploy,
      })
      onCloned(result.service)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to clone service')
    } finally {
      setLoading(false)
    }
  }

  const projectOptions = projects.map(p => ({
    value: p.id,
    label: p.id === service.project_id ? `${p.name} (current)` : p.name
  }))

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="w-full max-w-md mx-4">
        <div className="font-mono whitespace-pre text-terminal-cyan select-none">
          +-- CLONE SERVICE ---------------------------+
        </div>
        <div className="border-l border-r border-terminal-cyan bg-terminal-bg-secondary px-6 py-6">
          <form onSubmit={handleClone}>
            {/* Source Info */}
            <div className="mb-4 pb-3 border-b border-terminal-border">
              <span className="font-mono text-xs text-terminal-muted">CLONING FROM: </span>
              <span className="font-mono text-sm text-terminal-primary">{service.name}</span>
            </div>

            {/* New Name */}
            <div className="mb-4">
              <label className="block font-mono text-xs text-terminal-muted uppercase mb-2">
                New Name
              </label>
              <TerminalInput
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder="service-name"
                className="w-full"
                autoFocus
              />
            </div>

            {/* Target Project */}
            <div className="mb-4">
              <label className="block font-mono text-xs text-terminal-muted uppercase mb-2">
                Target Project
              </label>
              {loadingProjects ? (
                <div className="font-mono text-sm text-terminal-muted py-2">Loading projects...</div>
              ) : (
                <TerminalSelect
                  options={projectOptions}
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="w-full"
                />
              )}
            </div>

            {/* Options */}
            <div className="mb-4 space-y-3">
              <TerminalCheckbox
                checked={includeEnv}
                onChange={(e) => setIncludeEnv(e.target.checked)}
                label="Copy environment variables"
              />

              <TerminalCheckbox
                checked={autoDeploy}
                onChange={(e) => setAutoDeploy(e.target.checked)}
                label="Deploy immediately after creation"
              />
            </div>

            {/* Warning for env vars */}
            {includeEnv && (
              <div className="mb-4 p-3 border border-terminal-yellow bg-terminal-yellow/10">
                <span className="font-mono text-xs text-terminal-yellow">
                  ! Environment variables will be copied with their current values. Review and update secrets in the new service.
                </span>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="mb-4 p-3 border border-terminal-red bg-terminal-red/10">
                <span className="font-mono text-xs text-terminal-red">! {error}</span>
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-3 mt-6">
              <TerminalButton
                type="button"
                variant="secondary"
                onClick={onClose}
                disabled={loading}
              >
                [ CANCEL ]
              </TerminalButton>
              <TerminalButton
                type="submit"
                variant="primary"
                disabled={loading || !name.trim()}
              >
                {loading ? '[ CLONING... ]' : '[ CLONE ]'}
              </TerminalButton>
            </div>
          </form>
        </div>
        <div className="font-mono whitespace-pre text-terminal-cyan select-none">
          +--------------------------------------------+
        </div>
      </div>
    </div>
  )
}

export default CloneServiceModal
