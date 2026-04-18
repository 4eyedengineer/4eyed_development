import { useState, useCallback } from 'react'
import {
  triggerDeploy,
  restartService,
  validateDockerfile,
  fixServicePort,
  startService,
  stopService
} from '../api/services'
import { startDebugSession } from '../api/debug'
import { ApiError } from '../api/utils'
import { useToast } from '../components/Toast'

/**
 * Hook for service action handlers (deploy, restart, validate, fixPort, toggleState,
 * startDebug, handleDebugRetry). Collapses the per-action boolean pending flags into
 * a single `pending` object and keeps validation result state internal.
 *
 * @param {string} serviceId - Service ID the actions target
 * @param {object} opts
 * @param {Function} opts.refetch - Refetch service data after successful mutations
 * @param {Function} [opts.onShowBuildLogs] - Called after a successful deploy trigger
 * @param {object} [opts.service] - Current service (used to decide start vs stop)
 * @param {string} [opts.latestDeploymentId] - Current latest deployment id (for debug)
 * @param {Function} [opts.setActiveDebugSession] - Setter for the page's active debug session
 * @returns {{
 *   actions: {
 *     deploy: Function,
 *     restart: Function,
 *     validate: Function,
 *     fixPort: Function,
 *     toggleState: Function,
 *     startDebug: Function,
 *     handleDebugRetry: Function
 *   },
 *   pending: {
 *     deploy: boolean,
 *     restart: boolean,
 *     validate: boolean,
 *     fixPort: boolean,
 *     changingState: boolean,
 *     startingDebug: boolean
 *   },
 *   validation: object|null
 * }}
 */
export function useServiceActions(serviceId, { refetch, onShowBuildLogs, service, latestDeploymentId, setActiveDebugSession } = {}) {
  const toast = useToast()

  const [pending, setPending] = useState({
    deploy: false,
    restart: false,
    validate: false,
    fixPort: false,
    changingState: false,
    startingDebug: false
  })
  const [validation, setValidation] = useState(null)

  const setFlag = useCallback((key, value) => {
    setPending(prev => ({ ...prev, [key]: value }))
  }, [])

  const deploy = useCallback(async () => {
    setFlag('deploy', true)
    try {
      await triggerDeploy(serviceId)
      toast.success('Deployment triggered')
      if (onShowBuildLogs) onShowBuildLogs()
      if (refetch) await refetch()
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to trigger deployment'
      toast.error(message)
    } finally {
      setFlag('deploy', false)
    }
  }, [serviceId, toast, refetch, onShowBuildLogs, setFlag])

  const restart = useCallback(async () => {
    setFlag('restart', true)
    try {
      await restartService(serviceId)
      toast.success('Service restarted')
      if (refetch) await refetch()
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to restart service'
      toast.error(message)
    } finally {
      setFlag('restart', false)
    }
  }, [serviceId, toast, refetch, setFlag])

  const validate = useCallback(async () => {
    setFlag('validate', true)
    setValidation(null)
    try {
      const result = await validateDockerfile(serviceId)
      setValidation(result)
      if (result.valid) {
        toast.success('Dockerfile validated successfully')
      } else {
        toast.warning('Dockerfile has issues')
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to validate Dockerfile'
      toast.error(message)
    } finally {
      setFlag('validate', false)
    }
  }, [serviceId, toast, setFlag])

  const fixPort = useCallback(async () => {
    setFlag('fixPort', true)
    try {
      await fixServicePort(serviceId)
      toast.success('Port updated successfully')
      if (refetch) await refetch()
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to fix port'
      toast.error(message)
    } finally {
      setFlag('fixPort', false)
    }
  }, [serviceId, toast, refetch, setFlag])

  const toggleState = useCallback(async () => {
    if (pending.changingState) return

    const isRunning = service?.latest_deployment?.status === 'live'
    setFlag('changingState', true)

    try {
      if (isRunning) {
        await stopService(serviceId)
        toast.success('Service stopped')
      } else {
        await startService(serviceId)
        toast.success('Service started')
      }
      if (refetch) await refetch()
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to change service state'
      toast.error(message)
    } finally {
      setFlag('changingState', false)
    }
  }, [serviceId, toast, refetch, service, pending.changingState, setFlag])

  const startDebug = useCallback(async () => {
    if (!latestDeploymentId) return

    setFlag('startingDebug', true)
    try {
      const result = await startDebugSession(latestDeploymentId)
      if (setActiveDebugSession) {
        setActiveDebugSession({ id: result.sessionId, status: 'running' })
      }
      toast.success('Debug session started')
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Failed to start debug session'
      toast.error(message)
    } finally {
      setFlag('startingDebug', false)
    }
  }, [latestDeploymentId, toast, setActiveDebugSession, setFlag])

  const handleDebugRetry = useCallback((newSessionId) => {
    if (setActiveDebugSession) {
      setActiveDebugSession({ id: newSessionId, status: 'running' })
    }
    toast.success('New debug session started')
  }, [toast, setActiveDebugSession])

  return {
    actions: {
      deploy,
      restart,
      validate,
      fixPort,
      toggleState,
      startDebug,
      handleDebugRetry
    },
    pending,
    validation
  }
}

export default useServiceActions
