import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchProject } from '../api/projects'
import { ApiError } from '../api/utils'
import { useToast } from '../components/Toast'
import { useWebSocket } from './useWebSocket'

/**
 * Hook for loading a project and subscribing to WebSocket deployment-status
 * updates for each of its services. Maintains `serviceStatuses` keyed by
 * service id, and refetches the project when a service transitions to a
 * terminal state (live/failed).
 *
 * @param {string} projectId
 * @returns {{
 *   project: object|null,
 *   serviceStatuses: Record<string, string>,
 *   isLoading: boolean,
 *   error: string|null,
 *   refetch: Function
 * }}
 */
export function useProjectData(projectId) {
  const [project, setProject] = useState(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState(null)
  const [serviceStatuses, setServiceStatuses] = useState({})

  const toast = useToast()
  const { subscribe } = useWebSocket()
  const unsubscribesRef = useRef([])

  const refetch = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    setProject(null)
    try {
      const data = await fetchProject(projectId)
      setProject(data)
      return data
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load project')
      toast.error('Failed to load project')
    } finally {
      setIsLoading(false)
    }
  }, [projectId, toast])

  // Initial load
  useEffect(() => {
    if (projectId) {
      refetch()
    }
  }, [projectId])

  // Subscribe to deployment status updates for all services
  useEffect(() => {
    if (!project?.services?.length) return

    unsubscribesRef.current.forEach(unsub => unsub())
    unsubscribesRef.current = []

    for (const service of project.services) {
      if (service.latest_deployment_id) {
        const channel = `deployment:${service.latest_deployment_id}:status`

        const unsubscribe = subscribe(channel, (event) => {
          const { payload } = event

          setServiceStatuses(prev => ({
            ...prev,
            [service.id]: payload.status
          }))

          if (payload.status === 'live') {
            toast.success(`Service "${service.name}" is now live`)
          } else if (payload.status === 'failed') {
            toast.error(`Deployment failed for "${service.name}"`)
          }
        })

        unsubscribesRef.current.push(unsubscribe)
      }
    }

    return () => {
      unsubscribesRef.current.forEach(unsub => unsub())
      unsubscribesRef.current = []
    }
  }, [project?.services, subscribe, toast])

  return {
    project,
    setProject,
    serviceStatuses,
    isLoading,
    error,
    refetch
  }
}

export default useProjectData
