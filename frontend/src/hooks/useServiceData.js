import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchService } from '../api/services'
import { fetchEnvVars } from '../api/envVars'
import { fetchDeployments } from '../api/deployments'
import { fetchServiceDebugSession } from '../api/debug'
import { ApiError } from '../api/utils'
import { useToast } from '../components/Toast'
import { useDeploymentStatus } from './useDeploymentStatus'
import { useWebSocket } from './useWebSocket'

/**
 * Hook for loading service data and subscribing to real-time deployment status.
 *
 * Fetches service, env vars, deployments, and debug session in parallel.
 * Service is critical; others gracefully degrade with toast warnings.
 * Subscribes to WebSocket deployment status updates with internal dedup on
 * status-change toasts, auto-refetches on live/failed transitions, and falls
 * back to 5s polling when the WebSocket is disconnected AND a deployment is
 * active.
 *
 * @param {string} serviceId - The service ID to load
 * @returns {{
 *   service: object|null,
 *   envVars: Array,
 *   deployments: Array,
 *   debugSession: object|null,
 *   setDebugSession: Function,
 *   setEnvVars: Function,
 *   isLoading: boolean,
 *   error: string|null,
 *   refetch: Function,
 *   latestDeploymentId: string|undefined,
 *   deploymentStatus: {
 *     status: string|null,
 *     message: string|null,
 *     isActive: Function,
 *     isComplete: Function,
 *     isFailed: Function,
 *     isConnected: boolean
 *   }
 * }}
 */
export function useServiceData(serviceId) {
  const [service, setService] = useState(null)
  const [envVars, setEnvVars] = useState([])
  const [deployments, setDeployments] = useState([])
  const [debugSession, setDebugSession] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastNotifiedStatus, setLastNotifiedStatus] = useState(null)

  const toast = useToast()
  const { isConnected: wsIsConnected } = useWebSocket()

  const latestDeploymentId = deployments[0]?.id

  const {
    status: wsDeploymentStatus,
    message: wsDeploymentMessage,
    isActive: wsIsActive,
    isComplete: wsIsComplete,
    isFailed: wsIsFailed
  } = useDeploymentStatus(latestDeploymentId, deployments[0])

  const refetch = useCallback(async () => {
    try {
      const [serviceResult, envResult, deploymentsResult, debugResult] = await Promise.allSettled([
        fetchService(serviceId),
        fetchEnvVars(serviceId),
        fetchDeployments(serviceId),
        fetchServiceDebugSession(serviceId)
      ])

      // Service data is critical - if it fails, show error
      if (serviceResult.status === 'rejected') {
        const err = serviceResult.reason
        setError(err instanceof ApiError ? err.message : 'Failed to load service')
        toast.error('Failed to load service data')
        return
      }

      setService(serviceResult.value)
      setError(null)

      // Env vars - graceful degradation with warning
      if (envResult.status === 'fulfilled') {
        setEnvVars(envResult.value)
      } else {
        setEnvVars([])
        toast.warning('Failed to load environment variables')
      }

      // Deployments - graceful degradation with warning
      if (deploymentsResult.status === 'fulfilled') {
        setDeployments(deploymentsResult.value.deployments || [])
      } else {
        setDeployments([])
        toast.warning('Failed to load deployment history')
      }

      // Debug session - graceful degradation (no warning, not critical)
      if (debugResult.status === 'fulfilled') {
        setDebugSession(debugResult.value.session)
      } else {
        setDebugSession(null)
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load service')
      toast.error('Failed to load service data')
    } finally {
      setIsLoading(false)
    }
  }, [serviceId, toast])

  // Initial load
  useEffect(() => {
    if (serviceId) {
      refetch()
    }
  }, [serviceId])

  // Check if any deployment is in progress (uses realtime WS status when present)
  const hasActiveDeployment = useCallback(() => {
    if (!deployments.length) return false
    const latestStatus = wsDeploymentStatus || deployments[0]?.status
    return ['pending', 'building', 'deploying'].includes(latestStatus)
  }, [deployments, wsDeploymentStatus])

  // Handle WebSocket status updates: update deployments list, toast + refetch on terminal states
  useEffect(() => {
    if (!wsDeploymentStatus || !latestDeploymentId) return

    setDeployments(prev => {
      if (prev.length === 0) return prev
      const updated = [...prev]
      if (updated[0]?.id === latestDeploymentId) {
        updated[0] = { ...updated[0], status: wsDeploymentStatus }
      }
      return updated
    })

    const notifyKey = `${latestDeploymentId}-${wsDeploymentStatus}`
    if (notifyKey !== lastNotifiedStatus) {
      if (wsDeploymentStatus === 'live') {
        toast.success('Deployment completed successfully!')
        setLastNotifiedStatus(notifyKey)
        refetch()
      } else if (wsDeploymentStatus === 'failed') {
        toast.error('Deployment failed')
        setLastNotifiedStatus(notifyKey)
        refetch()
      }
    }
  }, [wsDeploymentStatus, latestDeploymentId, lastNotifiedStatus, toast, refetch])

  // Fallback polling when WebSocket is not connected and a deployment is active
  useEffect(() => {
    if (!serviceId || isLoading) return
    if (wsIsConnected()) return

    const hasActive = hasActiveDeployment()
    if (!hasActive) return

    const interval = setInterval(() => {
      refetch()
    }, 5000)

    return () => clearInterval(interval)
  }, [serviceId, isLoading, hasActiveDeployment, wsIsConnected, refetch])

  const deploymentStatus = {
    status: wsDeploymentStatus,
    message: wsDeploymentMessage,
    isActive: wsIsActive,
    isComplete: wsIsComplete,
    isFailed: wsIsFailed,
    isConnected: wsIsConnected()
  }

  return {
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
  }
}

export default useServiceData
